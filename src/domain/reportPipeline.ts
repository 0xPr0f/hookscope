import type { AnalysisReport } from './report'

export const ADAPTER_VERSION = 'uniswap-v4/0.1.0'
export const FIXTURE_SCENARIO_VERSION = 'hacken-browser-port/0.5.0'
// Bumped when generated PoolManager scenarios joined the live path, so a report
// produced by the previous orchestration is not reused as if it covered them.
export const LIVE_SCENARIO_VERSION = 'hacken-live-router-context/0.5.0'

/** Prevents a behavior report produced by older orchestration from masquerading as current. */
export function reportMatchesCurrentPipeline(report: AnalysisReport, fixture: boolean) {
  if (report.adapterVersion !== ADAPTER_VERSION) return false
  return fixture
    ? report.blockTagPolicy === 'deterministic-fixture'
    : report.scenarioVersion === LIVE_SCENARIO_VERSION
}
