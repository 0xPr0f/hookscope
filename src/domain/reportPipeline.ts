import type { AnalysisReport } from './report'

// 0.2.0: the adapter now recognizes a second historical router family from
// pinned runtime bytecode and reproduced execution, which changes which pools
// can receive controlled variants and bounded exploration at all.
export const ADAPTER_VERSION = 'uniswap-v4/0.2.0'
export const FIXTURE_SCENARIO_VERSION = 'hacken-browser-port/0.5.0'
export const LIVE_SCENARIO_VERSION = 'hacken-live-router-context/0.32.0'

/** Prevents a behavior report produced by older orchestration from masquerading as current. */
export function reportMatchesCurrentPipeline(report: AnalysisReport, fixture: boolean) {
  if (report.adapterVersion !== ADAPTER_VERSION) return false
  return fixture
    ? report.blockTagPolicy === 'deterministic-fixture'
    : report.scenarioVersion === LIVE_SCENARIO_VERSION
}
