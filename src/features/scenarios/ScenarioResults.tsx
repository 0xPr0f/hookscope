import { ChevronDown, ExternalLink } from 'lucide-react'
import type { AnalysisReport } from '../../domain/report'
import {
  buildScenarioConsoleSuites,
  HACKEN_UPSTREAM_COMMIT,
  SCENARIO_STATUS_LABELS,
  type ScenarioConsoleLine,
  type ScenarioConsoleSuite,
} from './scenarioTranscript'

const PUBLIC_EXECUTION_LANES = [
  {
    number: '01',
    title: 'Hacken assertions',
    description: 'Evaluates each portable Hacken expectation against pinned executions. Compatible means the named predicate held; Behavior differs and Contradicted identify the exact operation. Observation-only and unavailable cases remain explicit.',
  },
  {
    number: '02',
    title: 'Generated protocol',
    description: 'Runs swaps, liquidity changes, and donations through the deployed PoolManager with the reviewed browser harness. It needs no historical router or calldata. Reverts remain visible pool observations.',
  },
  {
    number: '03',
    title: 'ERC-20 settlement',
    description: 'Repeats eligible scenarios through the token’s real transfer and allowance path. Native pairs use a measured buy-and-sell round trip; ERC-20 pairs require verified holders. Compare this lane with claims settlement to locate the behavior.',
  },
  {
    number: '04',
    title: 'Historical replay',
    description: 'Replays receipt-matched transactions and controlled variants independently. An unknown historical router does not block the generated suites.',
  },
] as const

const FIXTURE_EXECUTION_LANES = [
  {
    number: '01',
    title: 'Fixture conformance',
    description: 'Runs the complete 40-case port against deterministic expected outcomes. It validates the browser execution engine—not a public pool—and appears only on the fixture report.',
  },
] as const

function ResultLine({ line }: { line: ScenarioConsoleLine }) {
  return (
    <div className="test-console-line" data-status={line.status.toLowerCase()}>
      <span className={`test-result test-result-${line.status.toLowerCase()}`}>{SCENARIO_STATUS_LABELS[line.status]}</span>
      <div className="test-console-copy">
        <div className="test-console-title">
          <strong>{line.name}</strong>
          {line.gasUsed && <span className="test-gas">gas {Number(line.gasUsed).toLocaleString()}</span>}
        </div>
        {line.description && <p className="test-description">{line.description}</p>}
        {line.detail && <p className="test-detail"><span>Result</span>{line.detail}</p>}
      </div>
    </div>
  )
}

function SuiteConsole({ suite }: { suite: ScenarioConsoleSuite }) {
  const sections = [...new Set(suite.lines.map((line) => line.section))]
  const executedTests = suite.ran
    ? suite.lines.filter((line) => line.status !== 'UNAVAILABLE' && line.status !== 'SKIP').length
    : 0
  // An analyzer error is a malfunction and fails the suite; a revert is not.
  const result = suite.failed > 0 || suite.errored > 0
    ? 'FAILED'
    : (suite.warned ?? 0) > 0
      ? 'REVIEW'
    : suite.id === 'hacken-public' && suite.ran && suite.unavailable > 0
      ? 'PARTIAL'
    : executedTests > 0
      ? suite.id === 'hacken-port' || (suite.id === 'hacken-public' && suite.passed > 0) ? 'OK' : 'RECORDED'
      : 'SKIPPED'
  const suiteStats = suite.id === 'hacken-public'
    ? [
        { label: 'Checks', value: executedTests },
        { label: 'Compatible', value: suite.passed },
        { label: 'Review', value: suite.warned ?? 0 },
        { label: 'Contradicted', value: suite.failed },
      ]
    : [
        { label: 'Tests', value: executedTests },
        { label: 'EVM runs', value: suite.executions },
        { label: 'Outcomes', value: suite.passed + suite.observed + (suite.covered ?? 0) },
        { label: 'Unavailable', value: suite.unavailable },
      ]
  return (
    <article className="test-suite-card" data-result={result.toLowerCase()}>
      <div className="test-suite-heading">
        <div className="test-suite-identity">
          <span>{suite.ran ? 'Executed in browser' : 'Not executed for this report'}</span>
          <h3>{suite.name}</h3>
          <p>{suite.description}</p>
        </div>
        <div className="test-suite-meta">
          <span className={`test-suite-result test-suite-result-${result.toLowerCase()}`}>{result}</span>
          <code>{suite.version}</code>
        </div>
      </div>
      <div className="test-suite-stats" aria-label={`${suite.name} totals`}>
        {suiteStats.map((stat) => <div key={stat.label}><span>{stat.label}</span><strong>{stat.value}</strong></div>)}
      </div>
      <div className="foundry-console" aria-label={`${suite.name} scenario output`}>
        <div className="test-console-run">
          <span>Execution transcript</span>
          <strong>{executedTests} test{executedTests === 1 ? '' : 's'} · {suite.executions} EVM run{suite.executions === 1 ? '' : 's'}</strong>
        </div>
        <div className="test-console-sections">
          {sections.map((section) => {
            const lines = suite.lines.filter((line) => line.section === section)
            const issues = lines.filter((line) => ['WARN', 'CONTRADICTED', 'REVERT', 'NOOP', 'UNAVAILABLE', 'ERROR', 'FAIL'].includes(line.status)).length
            return (
              <details className="test-console-section" key={section} open>
                <summary>
                  <span className="test-section-label">{section}</span>
                  <span>{lines.length} check{lines.length === 1 ? '' : 's'}{issues ? ` · ${issues} need context` : ''}</span>
                  <ChevronDown size={14} aria-hidden="true" />
                </summary>
                <div className="test-console-rows">
                  {lines.map((line) => <ResultLine line={line} key={line.id} />)}
                </div>
              </details>
            )
          })}
        </div>
        <div className={`test-console-summary test-summary-${result.toLowerCase()}`}>
          <strong>Suite result: {result}</strong>
          <span>{suite.passed} passed · {suite.failed} failed · {suite.observed} observed
          {(suite.warned ?? 0) > 0 ? `; ${suite.warned} behavior differs` : ''}
          {suite.covered ? `; ${suite.covered} covered by round trip` : ''}
          {suite.unavailable > 0 ? `; ${suite.unavailable} unavailable` : ''}
          {suite.errored > 0 ? `; ${suite.errored} errored` : ''}; {suite.skipped} skipped
          {suite.elapsedMs !== undefined ? `; finished in ${suite.elapsedMs} ms` : ''}.</span>
        </div>
      </div>
      {suite.reason && <p className="test-suite-reason">{suite.reason}</p>}
    </article>
  )
}

export function ScenarioResults({ report }: { report: AnalysisReport }) {
  const suites = buildScenarioConsoleSuites(report)
  const fixtureReport = suites.some((suite) => suite.id === 'hacken-port' && suite.ran)
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
      <div className="scenario-guide" aria-label="How to read these execution suites">
        <div className="scenario-guide-heading">
          <strong>How to read these suites</strong>
          <span>{fixtureReport ? 'Deterministic fixture lane' : 'Four independent evidence lanes'}</span>
        </div>
        <div className={`scenario-guide-list${fixtureReport ? ' scenario-guide-list-single' : ''}`}>
          {(fixtureReport ? FIXTURE_EXECUTION_LANES : PUBLIC_EXECUTION_LANES).map((lane) => (
            <div className="scenario-guide-item" key={lane.number}>
              <span>{lane.number}</span>
              <div>
                <strong>{lane.title}</strong>
                <p>{lane.description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="test-suite-list">{suites.map((suite) => <SuiteConsole suite={suite} key={suite.id} />)}</div>
      {!fixtureReport && <div className="scenario-gates">
        <p className="eyebrow">Why a live suite may be skipped</p>
        <ul>
          <li>Mobile v1 intentionally stops after discovery and static mapping.</li>
          <li>The selected chain must have certified deep execution and a configured PoolManager.</li>
          <li>The generated and Hacken-adapted suites need a discovered pool with a non-zero hook and readable pinned PoolManager state.</li>
          <li>Conditional catalogue cases remain unavailable until their callback, interface, fee, or secondary-pool prerequisite is independently proven.</li>
          <li>Historical replay additionally needs a receipt, actor, calldata and parent-block state; those requirements do not gate generated scenarios.</li>
          <li>Historical controlled mutations require a supported router envelope; an unknown router does not gate generated scenarios.</li>
        </ul>
      </div>}
    </section>
  )
}
