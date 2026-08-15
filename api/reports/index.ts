import type { VercelRequest, VercelResponse } from '@vercel/node'
import type postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import { getAddress, isAddress } from 'viem'
import { analysisReportSchema } from '../../src/domain/report.js'
import { canonicalReportHash } from '../_lib/canonical.js'
import { database } from '../_lib/database.js'
import { allowMethods, bodyBytes, requestIp, submissionAllowed } from '../_lib/http.js'

const MAX_REPORT_BYTES = 2_000_000

function storageUnavailable(response: VercelResponse, operation: 'list' | 'append', error: unknown) {
  const incidentId = randomUUID()
  console.error(JSON.stringify({ event: 'report-storage-unavailable', operation, incidentId }), error)
  return response.status(503).json({ error: 'Report storage is unavailable.', incidentId })
}

async function listReports(request: VercelRequest, response: VercelResponse) {
  const chainId = Number(request.query.chainId)
  const tokenInput = Array.isArray(request.query.token) ? request.query.token[0] : request.query.token
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || !tokenInput || !isAddress(tokenInput, { strict: true })) {
    return response.status(400).json({ error: 'A positive chainId and 20-byte token address are required.' })
  }
  const token = getAddress(tokenInput)
  try {
    const sql = database()
    const rows = await sql<{
      report: unknown
      id: string
      block_number: string
      block_hash: string
      created_at: Date
      severity_counts: Record<string, number>
      report_hash: string
    }[]>`
      SELECT id, report, block_number, block_hash, created_at, severity_counts, report_hash
      FROM analysis_reports
      WHERE chain_id = ${chainId} AND token = ${token.toLowerCase()}
      ORDER BY created_at DESC
      LIMIT 21
    `
    const [newest, ...older] = rows
    response.setHeader('Cache-Control', 'private, max-age=15')
    return response.status(200).json({
      newest: newest?.report,
      history: older.map((row) => ({
        id: row.id,
        blockNumber: row.block_number,
        blockHash: row.block_hash,
        createdAt: row.created_at.toISOString(),
        severityCounts: row.severity_counts,
        reportHash: row.report_hash,
      })),
    })
  } catch (error) {
    return storageUnavailable(response, 'list', error)
  }
}

async function appendReport(request: VercelRequest, response: VercelResponse) {
  if (bodyBytes(request) > MAX_REPORT_BYTES) return response.status(413).json({ error: 'Report exceeds the 2 MB limit.' })
  if (!submissionAllowed(requestIp(request))) return response.status(429).json({ error: 'Submission limit reached. Retry in one minute.' })
  let body: unknown = request.body
  if (typeof body === 'string') {
    try { body = JSON.parse(body) } catch { return response.status(400).json({ error: 'Body must be valid JSON.' }) }
  }
  const parsed = analysisReportSchema.safeParse(body)
  if (!parsed.success) return response.status(422).json({ error: 'Report schema validation failed.', issues: parsed.error.issues.slice(0, 20) })
  if (parsed.data.phases.some((phase) => ['pending', 'running', 'cancelled', 'failed'].includes(phase.status))) {
    return response.status(422).json({ error: 'Only completed reports with explicit capability downgrades can be stored.' })
  }
  const reportHash = canonicalReportHash(parsed.data as unknown as Record<string, unknown>)
  const report = { ...parsed.data, reportHash }
  const reportJson = JSON.parse(JSON.stringify(report)) as postgres.JSONValue
  const severityCounts = Object.fromEntries(['critical', 'high', 'medium', 'low', 'info'].map((severity) => [severity, report.findings.filter((finding) => finding.severity === severity).length]))
  try {
    const sql = database()
    const inserted = await sql<{ id: string }[]>`
      INSERT INTO analysis_reports (
        id, report_hash, chain_id, token, block_number, block_hash,
        pool_hook_identity, adapter_version, engine_versions, scenario_version,
        severity_counts, report, created_at
      ) VALUES (
        ${report.id}, ${reportHash}, ${report.chainId}, ${report.token.toLowerCase()},
        ${report.blockNumber}, ${report.blockHash},
        ${report.pools.map((pool) => `${pool.poolId}:${pool.hook}`).sort()},
        ${report.adapterVersion}, ${sql.json(report.engineVersions)}, ${report.scenarioVersion},
        ${sql.json(severityCounts)}, ${sql.json(reportJson)}, ${report.createdAt}
      )
      ON CONFLICT (report_hash) DO NOTHING
      RETURNING id
    `
    if (!inserted.length) return response.status(409).json({ error: 'An identical completed report already exists.', reportHash })
    return response.status(201).json({ id: report.id, reportHash })
  } catch (error) {
    return storageUnavailable(response, 'append', error)
  }
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  allowMethods(response, ['GET', 'POST'])
  if (request.method === 'GET') return listReports(request, response)
  if (request.method === 'POST') return appendReport(request, response)
  return response.status(405).json({ error: 'Method not allowed.' })
}
