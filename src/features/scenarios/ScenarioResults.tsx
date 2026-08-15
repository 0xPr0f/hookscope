import { ExternalLink } from 'lucide-react'
import type { AnalysisReport } from '../../domain/report'
import {
  buildScenarioConsoleSuites,
  HACKEN_UPSTREAM_COMMIT,
  SCENARIO_STATUS_LABELS,
  type ScenarioConsoleLine,
  type ScenarioConsoleSuite,
} from './scenarioTranscript'

function ResultLine({ line }: { line: ScenarioConsoleLine }) {
  return (
    <div className="test-console-line">
      <span className={`test-result test-result-${line.status.toLowerCase()}`}>[{SCENARIO_STATUS_LABELS[line.status]}]</span>
      <strong>{line.name}</strong>
      {line.gasUsed && <span className="test-gas">(gas: {Number(line.gasUsed).toLocaleString()})</span>}
      {line.detail && <span className="test-detail">— {line.detail}</span>}
    </div>
  )
}

function SuiteConsole({ suite }: { suite: ScenarioConsoleSuite }) {
  const sections = [...new Set(suite.lines.map((line) => line.section))]
  // An analyzer error is a malfunction and fails the suite; a revert is not.
  const result = suite.failed > 0 || suite.errored > 0 ? 'FAILED' : suite.ran ? 'OK' : 'SKIPPED'
  const executedTests = suite.ran ? suite.lines.length : 0
  return (
    <article className="test-suite-card">
      <div className="test-suite-heading">
        <div>
          <span>{suite.ran ? 'Executed in browser' : 'Not executed for this report'}</span>
          <h3>{suite.name}</h3>
        </div>
        <code>{suite.version}</code>
      </div>
      <div className="foundry-console" aria-label={`${suite.name} scenario output`}>
        <div className="test-console-run">Ran {executedTests} test{executedTests === 1 ? '' : 's'} for {suite.name}</div>
        {sections.map((section) => (
          <div className="test-console-section" key={section}>
            <span className="test-section-label">{section}</span>
            {suite.lines.filter((line) => line.section === section).map((line) => <ResultLine line={line} key={line.id} />)}
          </div>
        ))}
        <div className={`test-console-summary test-summary-${result.toLowerCase()}`}>
          Suite result: {result}. {suite.passed} passed; {suite.failed} failed; {suite.observed} observed
          {suite.unavailable > 0 ? `; ${suite.unavailable} unavailable` : ''}
          {suite.errored > 0 ? `; ${suite.errored} errored` : ''}; {suite.skipped} skipped
          {suite.elapsedMs !== undefined ? `; finished in ${suite.elapsedMs} ms` : ''}.
        </div>
      </div>
      {suite.reason && <p className="test-suite-reason">{suite.reason}</p>}
    </article>
  )
}

export function ScenarioResults({ report }: { report: AnalysisReport }) {
  const suites = buildScenarioConsoleSuites(report)
  return (
    <section className="scenario-results">
      <div className="report-section-heading">
        <div>
          <p className="eyebrow">PoolManager scenarios</p>
          <h2>Foundry-style execution results</h2>
        </div>
        <a
          className="text-button"
          href={`https://github.com/hknio/uni-v4-hooks-checker/tree/${HACKEN_UPSTREAM_COMMIT}`}
          target="_blank"
          rel="noreferrer"
        >
          Pinned upstream <ExternalLink size={13} />
        </a>
      </div>
      <div className="scenario-explainer">
        <p><strong>Full port.</strong> The 40-scenario port runs against Hookscope’s generated real-PoolManager fixture on desktop. It validates the browser execution engine against deterministic expected outcomes.</p>
        <p><strong>Generated scenarios.</strong> A small, pinned, reviewed Uniswap-derived scenario harness is injected at pinned state and drives swaps, liquidity changes and donations through the deployed PoolManager’s real unlock and settlement flow. This suite needs only a discovered pool: no historical transaction, router, or calldata. A revert is an observation about the pool, not a failure.</p>
        <p><strong>Live context.</strong> A public pool is counted only when a receipt-matched router trace reaches the real PoolManager and selected hook. Recognized historical routers receive controlled variants: an official Uniswap envelope is decoded from its published ABI, while an attested custom router template is derived from pinned runtime bytecode and reproduced execution — never from verified source. An unrecognized envelope stays a byte-identical observation. Direct hook calls are not tests.</p>
      </div>
      <div className="test-suite-list">{suites.map((suite) => <SuiteConsole suite={suite} key={suite.id} />)}</div>
      <div className="scenario-gates">
        <p className="eyebrow">Why a live suite may be skipped</p>
        <ul>
          <li>Mobile v1 intentionally stops after discovery and static mapping.</li>
          <li>The selected chain must have certified deep execution and a configured PoolManager.</li>
          <li>At least one discovered pool must have a non-zero hook and a replayable historical transaction.</li>
          <li>The historical receipt, actor, router calldata and parent-block state must be available from the configured data sources.</li>
          <li>Controlled mutations require a supported router envelope; a custom envelope may still receive an exact unchanged replay observation.</li>
          <li>None of the above gates the generated suite: it degrades only when the pinned PoolManager state itself cannot be read.</li>
        </ul>
      </div>
    </section>
  )
}
