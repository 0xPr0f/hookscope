import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { solidity } from '@replit/codemirror-lang-solidity'
import { Check, Code2, Copy, ExternalLink, FileCode2, Search } from 'lucide-react'
import type { AnalysisReport, ContractNode } from '../../domain/report'
import { shortAddress } from '../../domain/address'
import { AppDropdown } from '../../components/AppDropdown'
import {
  fetchSourcifyCompilationBundle,
  type SourcifyCompilationBundle,
} from '../../data/source'
import { selectPrimarySourcePath, sourceOutline } from './sourceSelection'
import {
  clampSourceSidebarWidth,
  SOURCE_SIDEBAR_DEFAULT_WIDTH,
  SOURCE_SIDEBAR_MAX_WIDTH,
  SOURCE_SIDEBAR_MIN_WIDTH,
} from './sourcePaneSize'

type SourceLoadState =
  | { status: 'loading' }
  | { status: 'loaded'; bundle: SourcifyCompilationBundle }
  | { status: 'error'; message: string }

const sourceCache = new Map<string, SourcifyCompilationBundle>()

type SourceIdeStyle = CSSProperties & { '--source-sidebar-width': string }

function contractLabel(node: ContractNode) {
  if (node.role === 'token') return 'Token'
  if (node.role === 'hook') return 'Hook'
  return 'Contract'
}

function sourcifyUrl(chainId: number, address: string) {
  return `https://repo.sourcify.dev/${chainId}/${address}`
}

function fileLabel(path: string) {
  const parts = path.split('/')
  return parts.at(-1) ?? path
}

function UnverifiedContract({ node }: { node: ContractNode }) {
  return (
    <div className="source-ide-empty">
      <div className="source-empty-icon"><FileCode2 size={22} /></div>
      <strong>{node.role === 'hook' ? 'Hook source not verified by Sourcify' : 'Token source not verified by Sourcify'}</strong>
      <p>No source text is presented for this deployed identity. The report still includes its bytecode interface, callback permissions and reachable paths without implying source verification.</p>
      <div className="source-empty-facts">
        <span>{node.bytecodeSize.toLocaleString()} runtime bytes</span>
        <span>{node.selectors.length} inferred selector{node.selectors.length === 1 ? '' : 's'}</span>
        <code>{node.codeHash.slice(0, 22)}…</code>
      </div>
    </div>
  )
}

function VerifiedCodeExplorer({ chainId, node, theme }: { chainId: number; node: ContractNode; theme: 'light' | 'dark' }) {
  const cacheKey = `${chainId}:${node.address.toLowerCase()}:${node.codeHash.toLowerCase()}`
  const cachedSource = sourceCache.get(cacheKey)
  const [loadState, setLoadState] = useState<SourceLoadState>(() => cachedSource
    ? { status: 'loaded', bundle: cachedSource }
    : { status: 'loading' })
  const [selectedPath, setSelectedPath] = useState<string | undefined>(() => cachedSource
    ? selectPrimarySourcePath(cachedSource, node.sourceMetadata?.fullyQualifiedName)
    : undefined)
  const [sideView, setSideView] = useState<'explorer' | 'search'>('explorer')
  const [mobilePane, setMobilePane] = useState<'files' | 'code'>('code')
  const [query, setQuery] = useState('')
  const [copied, setCopied] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(SOURCE_SIDEBAR_DEFAULT_WIDTH)
  const editorRef = useRef<ReactCodeMirrorRef>(null)
  const ideRef = useRef<HTMLDivElement>(null)
  const resizeRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)
  const sourceEditorId = useId()

  useEffect(() => {
    const element = ideRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      const containerWidth = entry?.contentRect.width ?? 0
      // The phone layout uses separate Files/Code panes and intentionally keeps
      // the last desktop width for when the viewport grows again.
      if (containerWidth > 640) {
        setSidebarWidth((current) => clampSourceSidebarWidth(current, containerWidth))
      }
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (cachedSource) return
    const controller = new AbortController()
    let active = true
    fetchSourcifyCompilationBundle(chainId, node.address, controller.signal)
      .then((bundle) => {
        if (!active) return
        if (!bundle) throw new Error('Sourcify no longer returns a verified source bundle for this identity.')
        if (bundle.runtimeCodeHash.toLowerCase() !== node.codeHash.toLowerCase()) {
          throw new Error('The returned source bundle does not match the runtime codehash recorded in this report.')
        }
        sourceCache.set(cacheKey, bundle)
        setSelectedPath(selectPrimarySourcePath(bundle, node.sourceMetadata?.fullyQualifiedName))
        setLoadState({ status: 'loaded', bundle })
      })
      .catch((error: unknown) => {
        if (!active || controller.signal.aborted) return
        setLoadState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [cacheKey, cachedSource, chainId, node.address, node.codeHash, node.sourceMetadata?.fullyQualifiedName])

  const sourcePaths = useMemo(() => loadState.status === 'loaded' ? Object.keys(loadState.bundle.sources).sort() : [], [loadState])
  const selectedSource = loadState.status === 'loaded' && selectedPath
    ? loadState.bundle.sources[selectedPath]?.content
    : undefined
  const visiblePaths = useMemo(() => {
    if (!query.trim()) return sourcePaths
    const normalized = query.trim().toLowerCase()
    return sourcePaths.filter((path) => path.toLowerCase().includes(normalized)
      || loadState.status === 'loaded' && loadState.bundle.sources[path]?.content.toLowerCase().includes(normalized))
  }, [loadState, query, sourcePaths])
  const outline = useMemo(() => selectedSource ? sourceOutline(selectedSource) : [], [selectedSource])

  const copySource = async () => {
    if (!selectedSource) return
    await navigator.clipboard.writeText(selectedSource)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1_500)
  }

  const jumpToLine = (lineNumber: number) => {
    const view = editorRef.current?.view
    if (!view) return
    const line = view.state.doc.line(Math.min(Math.max(lineNumber, 1), view.state.doc.lines))
    view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true })
    view.focus()
    setMobilePane('code')
  }

  const selectFile = (path: string) => {
    setSelectedPath(path)
    setMobilePane('code')
  }

  const resizeSidebar = (candidate: number) => {
    setSidebarWidth(clampSourceSidebarWidth(candidate, ideRef.current?.clientWidth))
  }

  const startSidebarResize = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    resizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: sidebarWidth }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const moveSidebarResize = (event: PointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current
    if (!resize || resize.pointerId !== event.pointerId) return
    resizeSidebar(resize.startWidth + event.clientX - resize.startX)
  }

  const stopSidebarResize = (event: PointerEvent<HTMLDivElement>) => {
    if (resizeRef.current?.pointerId !== event.pointerId) return
    resizeRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const resizeSidebarWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 16
    let candidate: number | undefined
    if (event.key === 'ArrowLeft') candidate = sidebarWidth - step
    if (event.key === 'ArrowRight') candidate = sidebarWidth + step
    if (event.key === 'Home') candidate = SOURCE_SIDEBAR_MIN_WIDTH
    if (event.key === 'End') candidate = SOURCE_SIDEBAR_MAX_WIDTH
    if (candidate === undefined) return
    event.preventDefault()
    resizeSidebar(candidate)
  }

  if (loadState.status === 'loading') return <div className="source-loading source-ide-loading" role="status"><span /> Loading and matching the verified source bundle…</div>
  if (loadState.status === 'error') return <div className="source-load-error source-ide-error" role="alert"><b>Source bundle unavailable</b><span>{loadState.message}</span></div>
  if (!selectedPath || selectedSource === undefined) return <div className="source-ide-empty"><strong>No source file selected</strong></div>

  return (
    <>
      <div className="source-mobile-switch" role="tablist" aria-label="Mobile source workspace">
        <button type="button" role="tab" aria-selected={mobilePane === 'files'} onClick={() => setMobilePane('files')}>
          <FileCode2 size={14} /> Files <span>{sourcePaths.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={mobilePane === 'code'} onClick={() => setMobilePane('code')}>
          <Code2 size={14} /> Code
        </button>
      </div>
      <div
        className={`source-ide source-mobile-${mobilePane}`}
        ref={ideRef}
        style={{ '--source-sidebar-width': `${sidebarWidth}px` } as SourceIdeStyle}
      >
      <aside className="source-ide-sidebar">
        <div className="source-side-tabs" role="tablist" aria-label="Source navigation">
          <button type="button" role="tab" aria-selected={sideView === 'explorer'} onClick={() => setSideView('explorer')}>Explorer</button>
          <button type="button" role="tab" aria-selected={sideView === 'search'} onClick={() => setSideView('search')}>Search</button>
        </div>
        {sideView === 'search' && (
          <label className="source-search">
            <Search size={13} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Files or source text" aria-label="Search verified source" />
          </label>
        )}
        <div className="source-tree-heading"><span>Files</span><small>{visiblePaths.length}</small></div>
        <div className="source-file-tree">
          {visiblePaths.map((path) => (
            <button type="button" className={path === selectedPath ? 'selected' : ''} onClick={() => selectFile(path)} title={path} key={path}>
              <Code2 size={13} /><span>{fileLabel(path)}</span><small>{path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''}</small>
            </button>
          ))}
          {!visiblePaths.length && <p>No matching files.</p>}
        </div>
        <div className="source-outline-heading">Outline <small>{outline.length}</small></div>
        <div className="source-outline">
          {outline.map((item, index) => (
            <button type="button" onClick={() => jumpToLine(item.line)} key={`${item.kind}:${item.name}:${item.line}:${index}`}>
              <span>{item.kind}</span><strong>{item.name}</strong><small>{item.line}</small>
            </button>
          ))}
          {!outline.length && <p>No declarations found.</p>}
        </div>
      </aside>
      <div
        className="source-resize-handle"
        role="separator"
        aria-label="Resize source explorer"
        aria-controls={sourceEditorId}
        aria-orientation="vertical"
        aria-valuemin={SOURCE_SIDEBAR_MIN_WIDTH}
        aria-valuemax={SOURCE_SIDEBAR_MAX_WIDTH}
        aria-valuenow={sidebarWidth}
        aria-valuetext={`${sidebarWidth} pixels`}
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        onDoubleClick={() => resizeSidebar(SOURCE_SIDEBAR_DEFAULT_WIDTH)}
        onKeyDown={resizeSidebarWithKeyboard}
        onPointerDown={startSidebarResize}
        onPointerMove={moveSidebarResize}
        onPointerUp={stopSidebarResize}
        onPointerCancel={stopSidebarResize}
      />
      <section id={sourceEditorId} className="source-editor-pane" aria-label={`Source code for ${fileLabel(selectedPath)}`}>
        <div className="source-open-tab"><Code2 size={13} /><span>{fileLabel(selectedPath)}</span></div>
        <div className="source-editor-toolbar">
          <div className="source-breadcrumbs">{selectedPath.split('/').map((part, index) => <span key={`${part}:${index}`}>{part}</span>)}</div>
          <span>{loadState.bundle.totalSourceBytes.toLocaleString()} bytes · {sourcePaths.length} files</span>
          <button type="button" onClick={copySource}><Copy size={12} /> {copied ? 'Copied' : 'Copy'}</button>
          <a href={sourcifyUrl(chainId, node.address)} target="_blank" rel="noreferrer">Sourcify <ExternalLink size={11} /></a>
        </div>
        <CodeMirror
          ref={editorRef}
          className="verified-source-editor"
          value={selectedSource}
          height="100%"
          theme={theme}
          editable={false}
          extensions={[solidity]}
          basicSetup={{
            lineNumbers: true,
            foldGutter: true,
            highlightActiveLine: false,
            highlightActiveLineGutter: false,
            autocompletion: false,
            closeBrackets: false,
          }}
        />
      </section>
      </div>
    </>
  )
}

function SourceWorkspace({ report, nodes, theme }: { report: AnalysisReport; nodes: ContractNode[]; theme: 'light' | 'dark' }) {
  const [selectedKey, setSelectedKey] = useState(() => `${nodes[0]?.address ?? ''}:${nodes[0]?.codeHash ?? ''}`)
  const selected = nodes.find((node) => `${node.address}:${node.codeHash}` === selectedKey) ?? nodes[0]
  if (!selected) return <div className="source-ide-empty"><strong>No token or hook identity was resolved.</strong></div>

  return (
    <div className="source-workbench">
      <div className="source-contract-bar">
        <label>
          <span>Contract</span>
          <AppDropdown
            className="source-contract-select"
            ariaLabel="Contract source identity"
            density="compact"
            value={selectedKey}
            onChange={setSelectedKey}
            menuMaxHeight={240}
            options={nodes.map((node) => ({
              value: `${node.address}:${node.codeHash}`,
              label: `${contractLabel(node)} · ${node.sourceMetadata?.contractName ?? shortAddress(node.address)}`,
              description: node.verifiedSource ? 'Verified source' : 'Not verified',
              icon: <FileCode2 size={14} />,
            }))}
          />
        </label>
        <div className="source-contract-identity">
          <code>{selected.address}</code>
          <span className={`source-status ${selected.verifiedSource ? 'verified' : 'unverified'}`}>
            {selected.verifiedSource && <Check size={12} />}{selected.verifiedSource ? 'Verified source' : 'Not verified'}
          </span>
        </div>
      </div>
      {selected.verifiedSource
        ? <VerifiedCodeExplorer chainId={report.chainId} node={selected} theme={theme} key={`${selected.address}:${selected.codeHash}`} />
        : <UnverifiedContract node={selected} />}
    </div>
  )
}

export function ContractSourceWorkspace({ report, theme = 'light' }: { report: AnalysisReport; theme?: 'light' | 'dark' }) {
  const [tab, setTab] = useState<'identities' | 'source'>('source')
  const sourceNodes = useMemo(() => report.contractGraph.filter((node) => node.role === 'token' || node.role === 'hook'), [report.contractGraph])
  const verifiedCount = sourceNodes.filter((node) => node.verifiedSource).length

  return (
    <section className="source-workspace">
      <div className="report-section-heading source-workspace-heading">
        <div><p className="eyebrow">Source / proxy graph</p><h2>Resolved contract identities</h2></div>
        <div className="source-tabs" role="tablist" aria-label="Contract source views">
          <button type="button" role="tab" aria-selected={tab === 'identities'} onClick={() => setTab('identities')}>Identities <span>{report.contractGraph.length}</span></button>
          <button type="button" role="tab" aria-selected={tab === 'source'} onClick={() => setTab('source')}>Source code <span>{verifiedCount}/{sourceNodes.length}</span></button>
        </div>
      </div>

      {tab === 'identities' ? (
        <div className="pool-list" role="tabpanel">
          {report.contractGraph.map((node) => (
            <div className="pool-row" key={`${node.address}:${node.codeHash}`}>
              <span><b>{node.role}</b> · {shortAddress(node.address)}</span>
              <span>{node.sourceMetadata
                ? `${node.sourceMetadata.contractName ?? 'Verified contract'} · ${node.sourceMetadata.compilerVersion ?? node.sourceMetadata.language ?? 'compiler recorded'}`
                : 'Bytecode interface inferred'}</span>
              <code>{node.selectors.length} selector{node.selectors.length === 1 ? '' : 's'}</code>
            </div>
          ))}
        </div>
      ) : (
        <div role="tabpanel">
          <div className="source-panel-intro">
            <div><strong>{verifiedCount}</strong><span>verified</span></div>
            <div><strong>{sourceNodes.length - verifiedCount}</strong><span>not verified</span></div>
            <p>Source is displayed only after Sourcify’s runtime bytecode hashes to the exact contract identity recorded at block {report.blockNumber}.</p>
          </div>
          <SourceWorkspace report={report} nodes={sourceNodes} theme={theme} />
        </div>
      )}
    </section>
  )
}
