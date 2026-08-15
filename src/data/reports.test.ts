import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { AnalysisReport } from '../domain/report'

/**
 * Guards the decision that a completed report is never uploaded.
 *
 * Anonymous writes to the shared store are unauthenticated, and the integrity
 * question that raises is undecided. A refactor that quietly restores the POST
 * would cross that boundary without anyone choosing to, so the absence of the
 * write is asserted rather than left to code review.
 */
const saved: AnalysisReport[] = []
const saveLocalReport = vi.fn(async (report: AnalysisReport) => { saved.push(report) })
vi.mock('./localReports', () => ({
  saveLocalReport: (report: AnalysisReport) => saveLocalReport(report),
  readLocalReports: async () => [],
}))

const { persistCompletedReport } = await import('./reports')

function report(): AnalysisReport {
  return {
    schemaVersion: '1', id: crypto.randomUUID(), source: 'browser', status: 'completed', partial: false,
    chainId: 1, chainName: 'Ethereum', token: '0x0000000000000000000000000000000000000001',
    blockNumber: '1', blockHash: `0x${'1'.repeat(64)}`, blockTagPolicy: 'safe',
    createdAt: new Date().toISOString(), elapsedMs: 1,
    adapterVersion: 'test', scenarioVersion: 'test', engineVersions: {},
    capabilities: {
      discovery: { supported: true, status: 'passed' }, static: { supported: true, status: 'passed' },
      replay: { supported: false, status: 'degraded' }, fuzz: { supported: false, status: 'degraded' },
    },
    pools: [], poolCoverage: { discovered: 0, analyzed: 0, hasMore: false }, contractGraph: [], findings: [],
    phases: [], scenarios: { completed: 0, total: 0 },
    coverage: { uniqueCodeHashes: 0, paths: 0, executions: 0, branches: 0 }, limitations: [],
  }
}

describe('completed report persistence', () => {
  const fetchSpy = vi.fn()

  beforeEach(() => {
    fetchSpy.mockReset()
    saveLocalReport.mockClear()
    saved.length = 0
    vi.stubGlobal('fetch', fetchSpy)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('stores locally and reports the report as local-only', async () => {
    const subject = report()
    const result = await persistCompletedReport(subject)
    expect(result).toBe('local-only')
    expect(saveLocalReport).toHaveBeenCalledTimes(1)
    expect(saved.at(-1)!.id).toBe(subject.id)
  })

  it('makes no network request at all', async () => {
    await persistCompletedReport(report())
    // Not "no POST" — no request whatsoever from the save path.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('still validates the report before storing it', async () => {
    const invalid = { ...report(), chainId: -1 } as AnalysisReport
    await expect(persistCompletedReport(invalid)).rejects.toThrow()
    expect(saveLocalReport).not.toHaveBeenCalled()
  })
})
