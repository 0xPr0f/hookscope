import type { VercelRequest, VercelResponse } from '@vercel/node'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { database } from '../_lib/database'
import { allowMethods } from '../_lib/http'

const idSchema = z.string().uuid()

export default async function handler(request: VercelRequest, response: VercelResponse) {
  allowMethods(response, ['GET'])
  if (request.method !== 'GET') return response.status(405).json({ error: 'Method not allowed.' })
  const raw = Array.isArray(request.query.id) ? request.query.id[0] : request.query.id
  const parsed = idSchema.safeParse(raw)
  if (!parsed.success) return response.status(400).json({ error: 'A report UUID is required.' })
  try {
    const sql = database()
    const rows = await sql<{ report: unknown }[]>`SELECT report FROM analysis_reports WHERE id = ${parsed.data} LIMIT 1`
    if (!rows[0]) return response.status(404).json({ error: 'Report not found.' })
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    return response.status(200).json(rows[0].report)
  } catch (error) {
    const incidentId = randomUUID()
    console.error(JSON.stringify({ event: 'report-storage-unavailable', operation: 'read-by-id', incidentId }), error)
    return response.status(503).json({ error: 'Report storage is unavailable.', incidentId })
  }
}
