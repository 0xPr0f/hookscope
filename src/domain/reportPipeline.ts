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
// 0.11.0: controlled comparisons include branch/transient/fee/delta
// observations, correlate delegated target changes with writes in the selected
// contract's storage context, and require lexically proven source guards.
// 0.12.0: the real-token lane now executes native-input cases and carries the
// exact native output of a committed forward swap into the reverse leg. The
// harness refuses to consume pre-existing synthetic native funding.
// 0.13.0: delegated-call evidence records revm frame identity and only promotes
// storage effects whose final writes came from the exact compared frames.
// 0.14.0: native/token round trips can start from the declared funded EOA,
// buying the deployed token with bounded call value and selling exactly the
// measured output back. A replay-derived token holder is no longer required.
// 0.15.0: the native-funded forward leg requests a bounded exact token output;
// call value is a refundable ceiling, so zero-output successes no longer block
// an otherwise executable reverse leg.
// 0.16.0: an exact-output forward leg retains its known token denomination
// when event decoding is unavailable, so a completed swap with no recipient
// balance increase becomes explicit delivery evidence rather than "no data".
// 0.17.0: native-funded scenarios and the native-first round trip no longer
// depend on finding a historical ERC-20 holder. Currency selection is derived
// only from each PoolKey and scenario direction; no token identity is mapped.
// 0.18.0: zero delivery on an exact token-output request is recorded as a full
// delivery shortfall, and a timed-out reusable fork run is cancelled in its
// worker before the next scenario starts.
// 0.20.0: public reports map the expanded generated execution matrix onto the
// complete 40-case Hacken catalogue, explicitly separating portable,
// conditional, and fixture-only cases. Older reports cannot claim this public
// suite coverage.
// 0.21.0: a successful committed native → token → native round trip now
// satisfies token-input directional coverage without misreporting redundant,
// separately unfunded amounts as unavailable or independently executed.
// 0.22.0: the public generated suite records each test's intent, decodes known
// PoolManager reverts, distinguishes zero-movement Swap events from exchanges,
// and includes the direct existing-PoolId reinitialization observation.
// 0.23.0: every selector exposed by a completed report is collected into one
// provenance-bearing catalog. Exact verified ABIs and canonical interfaces
// outrank global Sourcify 4byte candidates in every UI surface.
// 0.24.0: public callback authorization now requires paired successful
// PoolManager mediation plus a comparable direct rejection. Runtime probes are
// independently degradable and share one bounded time/hydration budget.
// 0.25.0: zero-liquidity prerequisites no longer become public assertion
// contradictions, exact receipt-matched replays appear in the test transcript,
// and report-backed check/execution totals have unambiguous semantics.
// 0.27.0: hook charges are derived from the signed return-delta transition in
// one frame-attributed PoolManager swap. Positive returned deltas are charges,
// negative returned deltas are rebates, and duplicate exact replays are counted
// once in directional summaries.
// 0.28.0: bounded instruction-PC truncation no longer discards complete logs
// and storage observations, and one swap can be isolated from other bundled
// PoolManager operations. Reports from 0.27.0 can therefore under-report a
// settled hook charge as not quantified.
// 0.29.0: proof logs, storage writes, and destructive effects now reflect the
// final rollback-aware execution result. Attempted call frames remain visible
// with explicit outcome/commit status, but reverted child evidence can no
// longer be attributed as a settled hook charge. Directional summaries also
// preserve simultaneous input/output components instead of flattening them
// into a false across-execution percentage range.
// 0.30.0: hook charges use one comparable pool-trade denominator in both
// directions, retain input surcharges' all-in share separately, and never turn
// an execution without a positive quantified delta into a measured 0% rate.
export const LIVE_SCENARIO_VERSION = 'hacken-live-router-context/0.30.0'

/** Prevents a behavior report produced by older orchestration from masquerading as current. */
export function reportMatchesCurrentPipeline(report: AnalysisReport, fixture: boolean) {
  if (report.adapterVersion !== ADAPTER_VERSION) return false
  return fixture
    ? report.blockTagPolicy === 'deterministic-fixture'
    : report.scenarioVersion === LIVE_SCENARIO_VERSION
}
