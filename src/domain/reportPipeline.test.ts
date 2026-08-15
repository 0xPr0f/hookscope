import { describe, expect, it } from 'vitest'
import type { AnalysisReport } from './report'
import { ADAPTER_VERSION, LIVE_SCENARIO_VERSION, reportMatchesCurrentPipeline } from './reportPipeline'

const report = {
  adapterVersion: ADAPTER_VERSION,
  scenarioVersion: LIVE_SCENARIO_VERSION,
  blockTagPolicy: 'finalized',
} as AnalysisReport

describe('completed report pipeline identity', () => {
  it('accepts the current live pipeline', () => {
    expect(reportMatchesCurrentPipeline(report, false)).toBe(true)
  })

  it('rejects an older live scenario orchestrator', () => {
    expect(reportMatchesCurrentPipeline({ ...report, scenarioVersion: 'hacken-live-router-context/0.3.0' }, false)).toBe(false)
  })

  it('keeps deterministic fixtures separate from public-chain reports', () => {
    expect(reportMatchesCurrentPipeline({ ...report, blockTagPolicy: 'deterministic-fixture' }, true)).toBe(true)
    expect(reportMatchesCurrentPipeline(report, true)).toBe(false)
  })
})
