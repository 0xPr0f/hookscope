import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { Activity, ArrowRight, Check, ChevronRight, CircleStop, Download, ExternalLink, Moon, RotateCcw, Settings, Sun } from 'lucide-react'
import { CHAINS, getChainConfig } from './config/chains'
import { toViemChain } from './data/rpc'
import { shortAddress } from './domain/address'
import { formatPoolFee } from './domain/poolFee'
import type { AnalysisReport, Severity } from './domain/report'
import type { CompletedReportCurrentness } from './data/reportCurrentness'
import { FIXTURE_SCAN_ADDRESS } from './fixtures/bytecode'
import { useAnalyzer } from './features/analyzer/useAnalyzer'
import { PoolPicker } from './features/analyzer/PoolPicker'
import { ScenarioResults } from './features/scenarios/ScenarioResults'
import { EvidenceLedger } from './features/evidence/EvidenceLedger'
import { ChainDropdown } from './components/ChainDropdown'
import { HowItWorksPage, MethodologyPage } from './pages/InformationPages'
import { informationPageForPath } from './pages/informationRoutes'
import { RpcSettingsDialog } from './features/settings/RpcSettingsDialog'

const ContractSourceWorkspace = lazy(() => import('./features/source/ContractSourceWorkspace').then((module) => ({ default: module.ContractSourceWorkspace })))

const impactOrder: Severity[] = ['critical', 'high', 'medium', 'low', 'info']

function strongestImpact(report: AnalysisReport): Severity {
  return impactOrder.find((impact) => report.findings.some((finding) => finding.severity === impact)) ?? 'info'
}

function impactLabel(impact: Severity) {
  if (impact === 'info') return 'OBSERVED'
  return impact.toUpperCase()
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function downloadReport(report: AnalysisReport) {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `hookscope-${report.chainId}-${report.token}.json`
  link.click()
  URL.revokeObjectURL(link.href)
}

function PhaseRail({ report }: { report: AnalysisReport }) {
  return (
    <div className="phase-rail" aria-label="Analysis phase coverage">
      {report.phases.map((phase) => (
        <div className={`phase-node phase-${phase.status}`} key={phase.id} title={phase.detail}>
          <span aria-label={phase.status === 'completed' ? 'Completed' : phase.status === 'degraded' && phase.completed > 0 ? 'Observed with limits' : 'Unavailable'}>
            {phase.status === 'completed'
              ? <Check size={12} aria-hidden="true" />
              : phase.status === 'degraded' && phase.completed > 0
                ? <Activity size={12} aria-hidden="true" />
                : '—'}
          </span>
          <div className="phase-copy">
            <b>{phase.label}</b>
            {phase.detail && <small>{phase.detail}</small>}
          </div>
        </div>
      ))}
    </div>
  )
}

function ReportView({ report, history, currentnessStatus, currentness, theme, onRunAgain, onContinue }: {
  report: AnalysisReport
  history: AnalysisReport[]
  currentnessStatus?: 'checking' | 'checked'
  currentness?: CompletedReportCurrentness
  theme: 'light' | 'dark'
  onRunAgain: () => void
  onContinue: (cursor: string) => void
}) {
  const [tab, setTab] = useState<'overview' | 'evidence' | 'contracts' | 'tests'>('overview')
  const impact = strongestImpact(report)
  const materialFindings = report.findings.filter((finding) => finding.severity !== 'info')
  const callbackFacts = report.findings.filter((finding) => finding.detectorId === 'hook-permission-bits')
  const scenarioPhase = report.phases.find((phase) => phase.id === 'scenarios')
  const reportChainConfig = getChainConfig(report.chainId)
  const reportChain = toViemChain(reportChainConfig)
  const explorer = reportChain.blockExplorers?.default
  const explorerBaseUrl = explorer?.url.replace(/\/$/, '')
  const explorerName = explorer?.name ?? 'chain explorer'
  return (
    <section className="report" aria-live="polite">
      <div className="report-topline">
        <span className="completed-mark"><Check size={13} /> Completed browser report</span>
        <span>Block {report.blockNumber} · {report.blockTagPolicy}</span>
        <span>{formatDate(report.createdAt)}</span>
      </div>
      {currentnessStatus === 'checking' && (
        <div className="currentness-note currentness-checking" role="status">
          Checking the saved block, deployed code identities, and recorded behavior sample against current chain state…
        </div>
      )}
      {currentnessStatus === 'checked' && currentness?.status === 'current' && (
        <div className="currentness-note currentness-current">
          Saved report is current at block {currentness.runtime.checkedAtBlockNumber}; deployed code identities and {currentness.behavior.matchedSamples} recorded behavior sample{currentness.behavior.matchedSamples === 1 ? '' : 's'} matched.
        </div>
      )}
      {currentnessStatus === 'checked' && currentness?.status === 'stale' && (
        <div className="currentness-note currentness-stale" role="alert">
          This saved report is stale. {currentness.reason ?? 'A deployed code identity or recorded behavior outcome changed.'} Run the analysis again for a current report.
        </div>
      )}
      {currentnessStatus === 'checked' && currentness?.status === 'unavailable' && (
        <div className="currentness-note currentness-unavailable">
          Currentness could not be fully checked. {currentness.reason ?? 'Current pinned state or a recorded behavior sample was unavailable.'}
        </div>
      )}
      {currentnessStatus === 'checked' && !currentness && (
        <div className="currentness-note currentness-unavailable">Currentness could not be checked. Run the analysis again to create a fresh report.</div>
      )}
      <div className="report-tabs" role="tablist" aria-label="Report sections">
        <button type="button" role="tab" aria-selected={tab === 'overview'} aria-controls="report-panel-overview" onClick={() => setTab('overview')}>Overview</button>
        <button type="button" role="tab" aria-selected={tab === 'evidence'} aria-controls="report-panel-evidence" onClick={() => setTab('evidence')}>Evidence <span>{report.findings.length}</span></button>
        <button type="button" role="tab" aria-selected={tab === 'contracts'} aria-controls="report-panel-contracts" onClick={() => setTab('contracts')}>Contracts <span>{report.contractGraph.length}</span></button>
        <button type="button" role="tab" aria-selected={tab === 'tests'} aria-controls="report-panel-tests" onClick={() => setTab('tests')}>Tests <span>{report.scenarios.completed}</span></button>
      </div>

      {tab === 'overview' && (
        <div id="report-panel-overview" role="tabpanel" className="report-tab-panel">
          <PhaseRail report={report} />
          <div className="assessment-grid">
            <div className="assessment-primary">
              <p className="eyebrow">Behavior assessment</p>
              <div className={`impact-word impact-text-${impact}`}>{impactLabel(impact)}</div>
              <p>{materialFindings.length} material behavior{materialFindings.length === 1 ? '' : 's'} mapped across {report.poolCoverage.analyzed} pool{report.poolCoverage.analyzed === 1 ? '' : 's'} at a pinned block.</p>
            </div>
            <div className="assessment-stat">
              <span>Pool coverage</span>
              <strong>{report.poolCoverage.analyzed}<small> / {report.poolCoverage.discovered}</small></strong>
              <p>{report.poolCoverage.hasMore ? 'Additional pools require continuation.' : 'All discovered pools in this batch are represented.'}</p>
            </div>
            <div className="assessment-stat">
              <span>PoolManager scenarios</span>
              <strong>{report.scenarios.completed}<small> / {report.scenarios.total}</small></strong>
              <p>{scenarioPhase?.detail ?? `${report.coverage.uniqueCodeHashes} code identities · ${report.coverage.paths} mapped blocks`}</p>
            </div>
          </div>
          <div className="report-columns">
            <section>
              <p className="eyebrow">Pool / hook map</p>
              <h3>{report.pools.length} analyzed combinations</h3>
              <div className="pool-list">
                {report.pools.map((pool) => {
                  const poolTransactionHash = pool.transactionHash ?? pool.replayTransactions?.[0]?.transactionHash
                  return (
                    <div className="pool-row" key={pool.poolId}>
                      <span className="pool-fee"><b>{formatPoolFee(pool.fee)}</b> fee</span>
                      {explorerBaseUrl
                        ? (
                            <a
                              className="pool-explorer-link pool-hook-link"
                              href={`${explorerBaseUrl}/address/${pool.hook}`}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={`View hook ${pool.hook} on ${explorerName}`}
                              title={`View hook on ${explorerName}`}
                            >
                              Hook {shortAddress(pool.hook)} <ExternalLink size={11} aria-hidden="true" />
                            </a>
                          )
                        : <span className="pool-hook-link">Hook {shortAddress(pool.hook)}</span>}
                      {explorerBaseUrl
                        ? (
                            <a
                              className="pool-explorer-link pool-id-link"
                              href={poolTransactionHash
                                ? `${explorerBaseUrl}/tx/${poolTransactionHash}`
                                : reportChainConfig.poolManager
                                  ? `${explorerBaseUrl}/address/${reportChainConfig.poolManager}`
                                  : explorerBaseUrl}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={poolTransactionHash
                                ? `View a recorded transaction for pool ${pool.poolId} on ${explorerName}`
                                : `View the PoolManager for pool ${pool.poolId} on ${explorerName}`}
                              title={poolTransactionHash
                                ? `View pool transaction on ${explorerName}`
                                : `View PoolManager on ${explorerName}`}
                            >
                              <code>{pool.poolId.slice(0, 10)}…</code> <ExternalLink size={11} aria-hidden="true" />
                            </a>
                          )
                        : <code className="pool-id-link">{pool.poolId.slice(0, 10)}…</code>}
                    </div>
                  )
                })}
                {!report.pools.length && <p>No verified pool initialized with this token at the pinned block.</p>}
              </div>
            </section>
            <section>
              <p className="eyebrow">Callback behavior</p>
              <h3>{callbackFacts.length} permission record{callbackFacts.length === 1 ? '' : 's'}</h3>
              <p className="section-copy">Callback bits are decoded directly from each hook address. Open Evidence for exact permission names and affected pools.</p>
            </section>
            <section>
              <p className="eyebrow">Capability coverage</p>
              <h3>{Object.values(report.capabilities).filter((capability) => capability.status === 'passed').length} of {Object.keys(report.capabilities).length} passed</h3>
              <ul className="capability-list">
                {Object.entries(report.capabilities).map(([name, capability]) => <li key={name}><span className={capability.status}>{capability.status === 'passed' ? '●' : '○'}</span>{name}<small>{capability.status}</small></li>)}
              </ul>
            </section>
          </div>
          {report.limitations.length > 0 && (
            <div className="limitations"><b>Coverage limitations</b>{report.limitations.map((item) => <p key={item}>{item}</p>)}</div>
          )}
          <div className="report-actions">
            <button className="secondary-button" onClick={onRunAgain}><RotateCcw size={14} /> Run analysis again</button>
            {report.poolCoverage.hasMore && report.poolCoverage.nextCursor && (
              <button className="primary-button" onClick={() => onContinue(report.poolCoverage.nextCursor!)}>Continue remaining pools <ArrowRight size={15} /></button>
            )}
          </div>
          {history.length > 0 && (
            <div className="history">
              <p className="eyebrow">Previous completed reports</p>
              {history.map((item) => <div className="history-row" key={item.id}><span>{formatDate(item.createdAt)}</span><span>Block {item.blockNumber}</span><span>{item.findings.length} evidence records</span><ChevronRight size={14} /></div>)}
            </div>
          )}
        </div>
      )}

      {tab === 'evidence' && (
        <div id="report-panel-evidence" role="tabpanel" className="report-tab-panel">
          <div className="report-section-heading">
            <div><p className="eyebrow">Evidence ledger</p><h2>What the deployed mechanism can do</h2></div>
            <button className="text-button" onClick={() => downloadReport(report)}><Download size={14} /> Export JSON</button>
          </div>
          <EvidenceLedger findings={report.findings} />
        </div>
      )}

      {tab === 'contracts' && (
        <div id="report-panel-contracts" role="tabpanel" className="report-tab-panel">
          <Suspense fallback={<div className="source-loading source-ide-loading" role="status"><span /> Loading the source workspace…</div>}>
            <ContractSourceWorkspace report={report} theme={theme} />
          </Suspense>
        </div>
      )}
      {tab === 'tests' && <div id="report-panel-tests" role="tabpanel" className="report-tab-panel"><ScenarioResults report={report} /></div>}
    </section>
  )
}

function App() {
  const { state, discover, analyze, cancel } = useAnalyzer()
  const [chainId, setChainId] = useState(1)
  const [token, setToken] = useState('')
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (
    typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  ))
  const [settingsOpen, setSettingsOpen] = useState(false)
  const selectedChain = useMemo(() => CHAINS.find((chain) => chain.id === chainId)!, [chainId])
  const busy = state.status === 'discovering' || state.status === 'cache' || state.status === 'running'
  const informationPage = typeof window === 'undefined' ? undefined : informationPageForPath(window.location.pathname)
  const visiblePoolSelection = state.poolSelection
    && state.poolSelection.chainId === chainId
    && state.poolSelection.token.toLowerCase() === token.trim().toLowerCase()
    ? state.poolSelection
    : undefined

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
    document.title = informationPage === 'how'
      ? 'How Hookscope works — Hookscope'
      : informationPage === 'methodology'
        ? 'Methodology — Hookscope'
        : 'Hookscope — Uniswap v4 hook analyzer'
  }, [informationPage, theme])

  const findPools = () => discover({ chainId, token })
  const continuePools = (cursor: string) => analyze({ chainId, token, force: true, poolCursor: cursor })
  const loadFixture = () => {
    setChainId(1)
    setToken(FIXTURE_SCAN_ADDRESS)
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="/">
          <span className="brand-mark" aria-hidden="true">
            <img src="/brand/hookscope-transparent-v2-192.png" alt="" width="34" height="34" />
          </span>
          Hookscope
        </a>
        <div className="header-actions">
          <nav aria-label="Primary navigation">
            <a href="/how" aria-current={informationPage === 'how' ? 'page' : undefined}>How it works</a>
            <a href="/methodology" aria-current={informationPage === 'methodology' ? 'page' : undefined}>Methodology</a>
            <a href="https://github.com/Uniswap/v4-core" target="_blank" rel="noreferrer">v4 Core <ExternalLink size={12} /></a>
          </nav>
          <button
            type="button"
            className="header-icon-button"
            onClick={() => setSettingsOpen(true)}
            aria-label="Open network settings"
            title="Network settings"
          >
            <Settings size={15} />
          </button>
          <button
            type="button"
            className="theme-toggle"
            onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          >
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        </div>
      </header>

      <RpcSettingsDialog open={settingsOpen} chains={CHAINS} onClose={() => setSettingsOpen(false)} />

      {informationPage === 'how' && <HowItWorksPage />}
      {informationPage === 'methodology' && <MethodologyPage />}
      {!informationPage && <main id="top">
        <section className="hero">
          <p className="kicker"><Activity size={14} /> Uniswap v4 execution transparency</p>
          <h1>See what a hook actually does.</h1>
          <p className="hero-copy">Enter a token. Hookscope finds its v4 pools, maps callback and control mechanics, and records the exact evidence behind every claim—inside your browser.</p>

          <form className="scan-form" onSubmit={(event) => { event.preventDefault(); findPools() }}>
            <label>
              <span>Chain</span>
              <ChainDropdown chains={CHAINS} value={chainId} onChange={setChainId} disabled={busy} />
            </label>
            <label className="token-field">
              <span>Token address</span>
              <input value={token} onChange={(event) => setToken(event.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" disabled={busy} />
            </label>
            <button className="primary-button analyze-button" type="submit" disabled={busy || !token}>Find pools <ArrowRight size={15} /></button>
          </form>
          <div className="form-meta">
            <span>No wallet · pinned block · browser workers</span>
            <button type="button" className="example-button" onClick={loadFixture} disabled={busy}>Load deterministic example</button>
            {!selectedChain.poolManager && <span className="chain-note">{selectedChain.limitation}</span>}
          </div>
          {state.error && <div className="form-error" role="alert">{state.error}</div>}
        </section>

        {state.status === 'selecting' && visiblePoolSelection && (
          <PoolPicker
            key={`${visiblePoolSelection.chainId}:${visiblePoolSelection.token}:${visiblePoolSelection.block.hash}`}
            discovery={visiblePoolSelection}
            onAnalyze={(selectedPoolIds) => analyze({
              chainId,
              token,
              poolSelection: visiblePoolSelection,
              selectedPoolIds,
            })}
          />
        )}

        {busy && (
          <section className="running-panel" aria-live="polite">
            <div><p className="eyebrow">{state.status === 'discovering' ? 'Loading verified pool choices' : 'Browser analysis in progress'}</p><h2>{state.detail}</h2></div>
            <button className="stop-button" onClick={cancel}><CircleStop size={15} /> Cancel</button>
            <div className="progress-track"><span style={{ width: `${state.progress}%` }} /></div>
            <div className="live-phases">{state.phases.map((phase) => <span className={phase.status} key={phase.id}>{phase.label}</span>)}</div>
          </section>
        )}

        {state.status === 'cancelled' && <div className="state-message"><CircleStop size={16} /><span><b>Run cancelled.</b> No partial report was submitted.</span></div>}
        {state.report && <ReportView report={state.report} history={state.history} currentnessStatus={state.currentnessStatus} currentness={state.currentness} theme={theme} onRunAgain={findPools} onContinue={continuePools} />}

        {!state.report && !busy && state.status !== 'cancelled' && state.status !== 'selecting' && (
          <section className="method-strip" id="method">
            <div><span>01</span><h3>Discover</h3><p>Verify every v4 PoolId that contains the selected token.</p></div>
            <div><span>02</span><h3>Map</h3><p>Resolve hook code identities, callbacks, control paths, and state access.</p></div>
            <div><span>03</span><h3>Observe</h3><p>Separate decoded facts from reached paths and reproduced outcomes.</p></div>
            <div><span>04</span><h3>Record</h3><p>Publish only complete reports with explicit capability limits.</p></div>
          </section>
        )}
      </main>}

      <footer><span>Hookscope · protocol mechanics, with evidence</span><span>Runs locally in the browser</span></footer>
    </div>
  )
}

export default App
