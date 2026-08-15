import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Blocks,
  Braces,
  Check,
  CircleDot,
  Code2,
  Database,
  FileSearch,
  Fingerprint,
  Gauge,
  GitBranch,
  Layers3,
  MonitorCog,
  Network,
  Play,
  RefreshCw,
  Server,
  ShieldCheck,
  TimerReset,
} from 'lucide-react'

const phases = [
  {
    number: '01',
    title: 'Pin one chain snapshot',
    icon: Fingerprint,
    copy: 'The selected chain is pinned to a block number and hash. Code, storage, pool state, sources, and executions are associated with that same snapshot.',
    output: 'Block identity and capability policy',
  },
  {
    number: '02',
    title: 'Discover the token’s v4 pools',
    icon: Network,
    copy: 'Index and subgraph candidates are loaded first, followed by a bounded recent Initialize-log tail. Every PoolKey is reconstructed and checked against the configured PoolManager.',
    output: 'Verified PoolIds and replay references',
  },
  {
    number: '03',
    title: 'Resolve deployed contracts',
    icon: Layers3,
    copy: 'Token, hook, proxy implementation, PoolManager, and observed dependencies are joined into a contract graph. Sourcify metadata is accepted only when it matches pinned runtime code.',
    output: 'Code identities, sources, ABI hints, proxy graph',
  },
  {
    number: '04',
    title: 'Map code mechanics',
    icon: Code2,
    copy: 'Dedicated workers inspect deployed bytecode and exact verified source where available. Callback permissions, selectors, control flow, state access, caller gates, and call sites remain separate facts.',
    output: 'Deterministic and reachable evidence',
  },
  {
    number: '05',
    title: 'Reproduce recorded activity',
    icon: RefreshCw,
    copy: 'A recent indexed pool transaction is executed at its parent block in a hydrated browser fork. Outcome, gas, logs, PoolManager calls, and hook calls must agree with its receipt.',
    output: 'Receipt-matched concrete observation',
  },
  {
    number: '06',
    title: 'Run pool scenarios',
    icon: Play,
    copy: 'When the chain and context qualify, controlled swap, liquidity, callback, sequence, and hook-data variants run through real PoolManager execution semantics.',
    output: 'Scenario outcomes and state differences',
  },
  {
    number: '07',
    title: 'Explore bounded inputs',
    icon: GitBranch,
    copy: 'Pool-attributed router fields are mutated inside strict masks. Coverage-guided workers share compact inputs under one recorded time and execution budget without changing unrelated envelope fields.',
    output: 'Coverage, executions, and minimized samples',
  },
  {
    number: '08',
    title: 'Normalize and record',
    icon: Braces,
    copy: 'All results enter one evidence schema. Only complete runs are saved; cancellation, timeout, worker failure, and missing capabilities remain visible and never become silent passes.',
    output: 'Reproducible browser report',
  },
] as const

const evidenceRows = [
  ['Deterministic fact', 'Decoded directly from an address, bytecode, source metadata, or pinned chain state.', 'Permission bits, code identity, proxy target'],
  ['Static reachability', 'A code path or operation is structurally reachable; this does not claim that a concrete transaction reached it.', 'Call path, state write, external call site'],
  ['Concrete observation', 'A particular transaction or scenario reached the behavior in the pinned execution environment.', 'Receipt replay, logs, balances, storage changes'],
  ['Bounded exploration', 'A generated input reached a distinct outcome within the report’s explicit time and execution budget.', 'Coverage edge, triggering input, minimized sample'],
  ['Solver-derived', 'Reserved for a formal solver result. Version one does not silently substitute heuristics for this class.', 'Solver, assumptions, derived condition'],
] as const

const engines = [
  ['WhatsABI', 'Interface inference and common proxy resolution', 'Static worker'],
  ['Sourcify', 'Verified source, compiler identity, ABI and signatures', 'Bounded browser fetch'],
  ['EVMole', 'Fast Wasm selector, argument, storage and control-flow extraction', 'Static worker'],
  ['Exact solc', 'Compact AST facts from the compiler version recorded by verified metadata', 'Lazy compiler worker'],
  ['revm', 'Pinned fork execution, replay, state overlays and execution observations', 'Execution worker'],
  ['LibAFL + revm', 'Coverage-guided mutation of pool-attributed execution inputs', 'Bounded exploration workers'],
  ['Foundry / Anvil', 'Native differential oracle for fixtures and chain conformance', 'CI only'],
] as const

function PageIntro({ eyebrow, title, copy, facts }: {
  eyebrow: string
  title: string
  copy: string
  facts: readonly string[]
}) {
  return (
    <section className="info-hero">
      <a className="info-back" href="/"><ArrowLeft size={13} /> Back to analyzer</a>
      <p className="kicker"><Activity size={14} /> {eyebrow}</p>
      <h1>{title}</h1>
      <p className="info-hero-copy">{copy}</p>
      <div className="info-facts" aria-label="Page summary">
        {facts.map((fact) => <span key={fact}><Check size={12} /> {fact}</span>)}
      </div>
    </section>
  )
}

function PageContents({ items }: { items: readonly { href: string; label: string }[] }) {
  return (
    <aside className="info-contents" aria-label="On this page">
      <span>On this page</span>
      {items.map((item, index) => <a href={item.href} key={item.href}><small>{String(index + 1).padStart(2, '0')}</small>{item.label}</a>)}
      <a className="info-contents-action" href="/">Analyze a token <ArrowRight size={12} /></a>
    </aside>
  )
}

export function HowItWorksPage() {
  return (
    <main className="info-page" id="top">
      <PageIntro
        eyebrow="Product walkthrough"
        title="From token address to evidence."
        copy="Hookscope turns one token address into a pinned, pool-specific account of what its Uniswap v4 mechanism exposes and what the browser was able to reproduce. Every stage has a visible output and an explicit failure state."
        facts={['No wallet required', 'Runs in browser workers', 'Pinned and reproducible']}
      />

      <div className="info-layout">
        <PageContents items={[
          { href: '#input', label: 'Start a scan' },
          { href: '#pipeline', label: 'The eight phases' },
          { href: '#runtime', label: 'Where work runs' },
          { href: '#report', label: 'Read the report' },
          { href: '#availability', label: 'Unavailable stages' },
        ]} />

        <article className="info-article">
          <section id="input" className="info-section info-section-lead">
            <p className="eyebrow">Start with two fields</p>
            <h2>Select a chain. Paste a token address.</h2>
            <p>Hookscope discovers the pools rather than asking you for a PoolId or hook address. It validates a 20-byte address before any chain request and analyzes up to 20 discovered pool/hook combinations in one completed report.</p>
            <div className="input-flow" aria-label="Analyzer input and output">
              <div><span>Input</span><strong>Chain + token</strong></div>
              <ArrowRight size={17} aria-hidden="true" />
              <div><span>Resolved context</span><strong>Pools + hooks</strong></div>
              <ArrowRight size={17} aria-hidden="true" />
              <div><span>Output</span><strong>Evidence report</strong></div>
            </div>
          </section>

          <section id="pipeline" className="info-section">
            <p className="eyebrow">Analysis lifecycle</p>
            <h2>Eight phases, each reported separately.</h2>
            <p>No single engine is treated as an answer. Discovery, code mapping, concrete execution, and bounded exploration produce different kinds of evidence and remain separately visible.</p>
            <div className="phase-explainer-list">
              {phases.map(({ number, title, icon: Icon, copy, output }) => (
                <div className="phase-explainer" key={number}>
                  <span className="phase-explainer-number">{number}</span>
                  <span className="phase-explainer-icon"><Icon size={17} /></span>
                  <div><h3>{title}</h3><p>{copy}</p><small>Produces · {output}</small></div>
                </div>
              ))}
            </div>
          </section>

          <section id="runtime" className="info-section">
            <p className="eyebrow">Runtime boundary</p>
            <h2>The browser analyzes. The server stores.</h2>
            <p>The heavy execution path stays on the user’s device. A narrow server boundary protects infrastructure credentials and stores only schema-valid completed reports.</p>
            <div className="runtime-grid">
              <div>
                <MonitorCog size={20} />
                <span>Your browser</span>
                <h3>Analysis runtime</h3>
                <ul><li>Pool and source reads</li><li>Static Wasm engines</li><li>Pinned revm sessions</li><li>Scenario and bounded workers</li></ul>
              </div>
              <div>
                <Server size={20} />
                <span>Vercel boundary</span>
                <h3>Discovery and storage proxy</h3>
                <ul><li>Protects the Graph API key</li><li>Validates completed reports</li><li>Recomputes canonical hashes</li><li>Performs no chain analysis</li></ul>
              </div>
            </div>
          </section>

          <section id="report" className="info-section">
            <p className="eyebrow">Reading the output</p>
            <h2>A report describes coverage, not a blanket verdict.</h2>
            <div className="report-reading-grid">
              <div><FileSearch size={18} /><h3>Overview</h3><p>Pool coverage, strongest observed impact, callbacks, capabilities, and limitations.</p></div>
              <div><CircleDot size={18} /><h3>Evidence</h3><p>Claim, subject, evidence class, confidence, affected pool, trace details, and replay status.</p></div>
              <div><Code2 size={18} /><h3>Contracts</h3><p>Resolved token, hook and implementation graph with verified-source workspace where available.</p></div>
              <div><Blocks size={18} /><h3>Tests</h3><p>Foundry-style output that keeps passed, failed, observed, reverted, and skipped outcomes distinct.</p></div>
            </div>
          </section>

          <section id="availability" className="info-section">
            <p className="eyebrow">Honest downgrade behavior</p>
            <h2>Missing infrastructure does not become a pass.</h2>
            <p>A chain may support discovery and static mapping while archive replay remains unavailable. A custom historical router may reproduce exactly but offer no safe mutation envelope. Hookscope marks those stages as degraded or unsupported, explains why, and still preserves the evidence that did complete.</p>
            <div className="status-key">
              <span><i className="status-dot passed" /> Passed <small>Required work completed</small></span>
              <span><i className="status-dot degraded" /> Degraded <small>Some evidence, explicit limitation</small></span>
              <span><i className="status-dot unsupported" /> Unsupported <small>Not claimed or silently inferred</small></span>
            </div>
          </section>

          <a className="info-end-cta" href="/">Open the analyzer <ArrowRight size={15} /></a>
        </article>
      </div>
    </main>
  )
}

export function MethodologyPage() {
  return (
    <main className="info-page" id="top">
      <PageIntro
        eyebrow="Technical methodology"
        title="Claims are only as strong as their evidence."
        copy="Hookscope combines independent discovery, source, bytecode, execution, and input-exploration passes. The methodology keeps those results distinct, pins them to one chain snapshot, and records exactly where coverage stops."
        facts={['Multiple independent engines', 'One evidence schema', 'Explicit capability limits']}
      />

      <div className="info-layout">
        <PageContents items={[
          { href: '#principles', label: 'Method principles' },
          { href: '#evidence-classes', label: 'Evidence classes' },
          { href: '#engine-placement', label: 'Engine placement' },
          { href: '#execution-method', label: 'Execution method' },
          { href: '#integrity', label: 'Report integrity' },
          { href: '#limits', label: 'Limits and interpretation' },
        ]} />

        <article className="info-article">
          <section id="principles" className="info-section info-section-lead">
            <p className="eyebrow">Principles</p>
            <h2>Mechanics first. Claims second.</h2>
            <div className="principle-grid">
              <div><Fingerprint size={19} /><strong>Snapshot consistency</strong><p>Every result belongs to one pinned block number and hash.</p></div>
              <div><Layers3 size={19} /><strong>Independent passes</strong><p>Source, bytecode, and execution results do not overwrite one another.</p></div>
              <div><Gauge size={19} /><strong>Measured coverage</strong><p>Paths, executions, branches, pools, time, and unavailable work are recorded.</p></div>
              <div><ShieldCheck size={19} /><strong>Reproducibility</strong><p>Concrete claims carry enough context to repeat or validate their outcome.</p></div>
            </div>
          </section>

          <section id="evidence-classes" className="info-section">
            <p className="eyebrow">Evidence model</p>
            <h2>Five classes prevent category errors.</h2>
            <p>A reachable operation is not presented as an executed transaction, and a bounded generated sample is not presented as a proof over every input.</p>
            <div className="method-table" role="table" aria-label="Evidence classes">
              <div className="method-table-head" role="row"><span>Class</span><span>What it means</span><span>Typical record</span></div>
              {evidenceRows.map(([name, meaning, record]) => (
                <div role="row" key={name}><strong>{name}</strong><span>{meaning}</span><small>{record}</small></div>
              ))}
            </div>
          </section>

          <section id="engine-placement" className="info-section">
            <p className="eyebrow">Open-source placement</p>
            <h2>Use each engine for the question it can answer.</h2>
            <p>Hookscope does not implement a custom EVM, compiler, cryptography stack, or solver. Custom code is limited to adapters, orchestration, normalization, declarative mechanics rules, and inspector wiring.</p>
            <div className="engine-list">
              {engines.map(([name, role, runtime]) => (
                <div key={name}><strong>{name}</strong><span>{role}</span><small>{runtime}</small></div>
              ))}
            </div>
          </section>

          <section id="execution-method" className="info-section">
            <p className="eyebrow">Concrete execution</p>
            <h2>Hydrate only the state the execution requests.</h2>
            <p>A synchronous revm database starts with the known transaction context. Missing accounts, code, storage slots, or ancestor block hashes are requested from the browser coordinator at the replay parent block, inserted into the reusable base state, and retried.</p>
            <ol className="execution-steps">
              <li><span>1</span><div><strong>Match a transaction to the pool</strong><p>Receipt, PoolManager, event type, PoolId, block, and transaction outcome are validated before execution evidence is accepted.</p></div></li>
              <li><span>2</span><div><strong>Reproduce before generating</strong><p>The canonical transaction must match its recorded outcome, logs, and gas before it becomes live context.</p></div></li>
              <li><span>3</span><div><strong>Change only owned fields</strong><p>Router-aware masks restrict changes to pool-attributed amount or existing hook-data bytes while preserving signatures and unrelated settlement fields.</p></div></li>
              <li><span>4</span><div><strong>Measure bounded exploration</strong><p>Dedicated workers share one ceiling of 30 seconds or 30,000 executions per selected pool and retain compact distinct outcomes.</p></div></li>
            </ol>
            <div className="method-note"><TimerReset size={18} /><p><strong>Deterministic scenarios and public-pool observations are distinct.</strong> The complete generated fixture matrix validates the browser engine against the official PoolManager context. A public pool receives only the portable scenarios supported by its certified chain and hydrated context.</p></div>
          </section>

          <section id="integrity" className="info-section">
            <p className="eyebrow">Completion and currentness</p>
            <h2>A saved report is immutable, but chain state can move.</h2>
            <div className="integrity-flow">
              <div><Database size={19} /><strong>Complete only</strong><p>Partial, cancelled, failed, or timed-out runs stay local and are not posted.</p></div>
              <ArrowRight size={17} aria-hidden="true" />
              <div><Braces size={19} /><strong>Canonical identity</strong><p>Schema, size, completion state, and canonical report hash are validated before append-only storage.</p></div>
              <ArrowRight size={17} aria-hidden="true" />
              <div><RefreshCw size={19} /><strong>Background check</strong><p>Saved block, token/hook/implementation code, proxy targets, and selected behavior samples are checked for currentness.</p></div>
            </div>
          </section>

          <section id="limits" className="info-section">
            <p className="eyebrow">Interpretation</p>
            <h2>What a completed report does and does not mean.</h2>
            <div className="interpretation-grid">
              <div className="does"><span>It does</span><ul><li>Identify the pools and code examined.</li><li>Separate facts, paths, and observed outcomes.</li><li>Record exact engine and scenario versions.</li><li>Expose pool, chain, execution, and time limits.</li><li>Preserve samples for reproducible observations.</li></ul></div>
              <div className="does-not"><span>It does not</span><ul><li>Claim every possible input or future state was tested.</li><li>Treat unavailable replay as successful replay.</li><li>Equate verified source with unchanged deployed code.</li><li>Mutate unknown or signature-bearing envelopes speculatively.</li><li>Describe a contract as universally safe.</li></ul></div>
            </div>
          </section>

          <a className="info-end-cta" href="/how">See the product walkthrough <ArrowRight size={15} /></a>
        </article>
      </div>
    </main>
  )
}
