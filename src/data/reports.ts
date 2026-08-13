import type { Address } from 'viem'
import { analysisReportSchema, type AnalysisReport } from '../domain/report'
import { readLocalReports, saveLocalReport } from './localReports'

type ReportResponse = { newest?: unknown; history?: unknown[] }

export async function loadReports(chainId: number, token: Address): Promise<AnalysisReport[]> {
  const local = await readLocalReports(chainId, token).catch(() => [])
  let remote: AnalysisReport[] = []
  try {
    const response = await fetch(`/api/reports?chainId=${chainId}&token=${token}`, { headers: { accept: 'application/json' } })
    if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
      const body = (await response.json()) as ReportResponse
      remote = [body.newest, ...(body.history ?? [])]
        .filter(Boolean)
        .map((item) => analysisReportSchema.safeParse(item))
        .flatMap((result) => (result.success ? [result.data as AnalysisReport] : []))
    }
  } catch {
    // The static Vite build intentionally remains useful without the storage proxy.
  }
  const unique = new Map([...local, ...remote].map((report) => [report.id, report]))
  return [...unique.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function persistCompletedReport(report: AnalysisReport): Promise<'remote' | 'local-only'> {
  analysisReportSchema.parse(report)
  await saveLocalReport(report)
  try {
    const response = await fetch('/api/reports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
    })
    if (response.ok || response.status === 409) return 'remote'
  } catch {
    // IndexedDB is the explicit offline fallback; UI discloses that the report is local-only.
  }
  return 'local-only'
}
