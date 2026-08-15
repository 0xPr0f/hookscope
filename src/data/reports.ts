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

/**
 * Stores a completed report locally.
 *
 * Remote persistence is intentionally disabled. Writes to the shared store are
 * anonymous and unauthenticated, and the integrity question that raises — who
 * may write, and how a reader tells a genuine report from an injected one — has
 * not been decided. Until it is, a browser keeps its own reports in IndexedDB
 * and publishes nothing, so no unresolved trust boundary is crossed by default.
 *
 * The upload path below is kept rather than deleted: it is the shape the eventual
 * authenticated write will take, and re-deriving it later would risk losing the
 * 409-means-already-stored handling. Re-enable it together with whatever write
 * integrity scheme is chosen.
 */
export async function persistCompletedReport(report: AnalysisReport): Promise<'remote' | 'local-only'> {
  // Validation still runs: a report that could not be published must not be
  // stored locally in a shape the schema would later reject either.
  analysisReportSchema.parse(report)
  await saveLocalReport(report)

  // Disabled pending the anonymous-write integrity decision.
  //
  // try {
  //   const response = await fetch('/api/reports', {
  //     method: 'POST',
  //     headers: { 'content-type': 'application/json' },
  //     body: JSON.stringify(report),
  //   })
  //   if (response.ok || response.status === 409) return 'remote'
  // } catch {
  //   // IndexedDB is the explicit offline fallback; UI discloses that the report is local-only.
  // }

  return 'local-only'
}
