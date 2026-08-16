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

  it('rejects every published live version that predates the current one', () => {
    const currentMinor = Number(LIVE_SCENARIO_VERSION.match(/\/0\.(\d+)\.0$/)?.[1])
    expect(currentMinor).toBeGreaterThanOrEqual(3)

    for (let minor = 3; minor < currentMinor; minor += 1) {
      const superseded = `hacken-live-router-context/0.${minor}.0`
      expect(reportMatchesCurrentPipeline({ ...report, scenarioVersion: superseded }, false), superseded).toBe(false)
    }
  })

  it('rejects a report built by an older adapter', () => {
    // Router recognition changed which pools can receive generated variants, so
    // a report from the previous adapter is not comparable.
    expect(reportMatchesCurrentPipeline({ ...report, adapterVersion: 'uniswap-v4/0.1.0' }, false)).toBe(false)
  })

  it('keeps deterministic fixtures separate from public-chain reports', () => {
    expect(reportMatchesCurrentPipeline({ ...report, blockTagPolicy: 'deterministic-fixture' }, true)).toBe(true)
    expect(reportMatchesCurrentPipeline(report, true)).toBe(false)
  })
})
