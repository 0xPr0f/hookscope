import type { AnalysisReport } from './report'

// 0.2.0: the adapter now recognizes a second historical router family from
// pinned runtime bytecode and reproduced execution, which changes which pools
// can receive controlled variants and bounded exploration at all.
export const ADAPTER_VERSION = 'uniswap-v4/0.2.0'
export const FIXTURE_SCENARIO_VERSION = 'hacken-browser-port/0.5.0'
// Bumped whenever the live path changes what a result means, not only when it
// changes what runs. 0.8.0 makes generated scenario and exploration
// transactions valid under a non-zero pinned base fee. Reports from 0.7.0 can
// show the same pool while every generated transaction was rejected before
// execution, so they must not be served as current.
export const LIVE_SCENARIO_VERSION = 'hacken-live-router-context/0.8.0'

/** Prevents a behavior report produced by older orchestration from masquerading as current. */
export function reportMatchesCurrentPipeline(report: AnalysisReport, fixture: boolean) {
  if (report.adapterVersion !== ADAPTER_VERSION) return false
  return fixture
    ? report.blockTagPolicy === 'deterministic-fixture'
    : report.scenarioVersion === LIVE_SCENARIO_VERSION
}
