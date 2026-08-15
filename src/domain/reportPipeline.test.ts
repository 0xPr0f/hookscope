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
    // A report can look identical while resting on weaker guarantees, so each
    // superseded orchestration has to stay explicitly invalid. Extend this list
    // rather than replacing it whenever the live version moves.
    for (const superseded of [
      'hacken-live-router-context/0.3.0',
      'hacken-live-router-context/0.4.0',
      'hacken-live-router-context/0.5.0',
      'hacken-live-router-context/0.6.0',
      'hacken-live-router-context/0.10.0',
      'hacken-live-router-context/0.7.0',
      'hacken-live-router-context/0.8.0',
      'hacken-live-router-context/0.9.0',
      'hacken-live-router-context/0.11.0',
      'hacken-live-router-context/0.12.0',
      'hacken-live-router-context/0.13.0',
      'hacken-live-router-context/0.14.0',
      'hacken-live-router-context/0.15.0',
      'hacken-live-router-context/0.16.0',
      'hacken-live-router-context/0.17.0',
      'hacken-live-router-context/0.18.0',
      'hacken-live-router-context/0.19.0',
      'hacken-live-router-context/0.20.0',
      'hacken-live-router-context/0.21.0',
      'hacken-live-router-context/0.22.0',
      'hacken-live-router-context/0.23.0',
      'hacken-live-router-context/0.24.0',
      'hacken-live-router-context/0.25.0',
      'hacken-live-router-context/0.26.0',
      'hacken-live-router-context/0.27.0',
      'hacken-live-router-context/0.28.0',
      'hacken-live-router-context/0.29.0',
    ]) {
      expect(superseded, 'a superseded version must not equal the current one').not.toBe(LIVE_SCENARIO_VERSION)
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
