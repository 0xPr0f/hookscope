import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Eye, EyeOff, KeyRound, RotateCcw, Settings2, X } from 'lucide-react'
import { createPublicClient, http } from 'viem'
import type { ChainConfig } from '../../config/chains'
import { AppDropdown } from '../../components/AppDropdown'
import { resetPublicClient, toViemChain } from '../../data/rpc'
import {
  clearRpcOverrides,
  isValidRpcUrl,
  loadRpcOverrides,
  removeRpcOverride,
  saveRpcOverride,
  type RpcOverrides,
} from '../../data/rpcPreferences'
import { clearGraphApiKey, loadGraphApiKey, saveGraphApiKey } from '../../data/graphPreferences'

type CheckState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'passed'; message: string }
  | { status: 'failed'; message: string }

export function RpcSettingsDialog({ open, chains, onClose }: {
  open: boolean
  chains: readonly ChainConfig[]
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const deepChains = useMemo(() => chains.filter((chain) => chain.deepExecution && chain.poolManager), [chains])
  const [overrides, setOverrides] = useState<RpcOverrides>(() => loadRpcOverrides())
  const [chainId, setChainId] = useState(() => deepChains[0]?.id ?? 1)
  const [draft, setDraft] = useState('')
  const [check, setCheck] = useState<CheckState>({ status: 'idle' })
  const [graphKey, setGraphKey] = useState(() => loadGraphApiKey() ?? '')
  const [savedGraphKey, setSavedGraphKey] = useState(() => loadGraphApiKey())
  const [graphKeyVisible, setGraphKeyVisible] = useState(false)
  const [graphCheck, setGraphCheck] = useState<CheckState>({ status: 'idle' })
  const selected = deepChains.find((chain) => chain.id === chainId) ?? deepChains[0]
  const graphSubgraphCount = useMemo(() => chains.filter((chain) => chain.subgraphId).length, [chains])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  useEffect(() => {
    if (!open || !selected) return
    const current = loadRpcOverrides()
    setOverrides(current)
    setDraft(current[String(selected.id)] ?? '')
    setCheck({ status: 'idle' })
  }, [open, selected])

  useEffect(() => {
    if (!open) return
    const currentGraphKey = loadGraphApiKey()
    setGraphKey(currentGraphKey ?? '')
    setSavedGraphKey(currentGraphKey)
    setGraphKeyVisible(false)
    setGraphCheck({ status: 'idle' })
  }, [open])

  if (!selected) return null

  const chooseChain = (nextChainId: number) => {
    setChainId(nextChainId)
    setDraft(overrides[String(nextChainId)] ?? '')
    setCheck({ status: 'idle' })
  }

  const save = () => {
    try {
      const next = saveRpcOverride(selected.id, draft)
      setOverrides(next)
      resetPublicClient(selected.id)
      setCheck({ status: 'passed', message: 'Custom endpoint saved for this browser.' })
    } catch (error) {
      setCheck({ status: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
  }

  const restoreSelected = () => {
    setOverrides(removeRpcOverride(selected.id))
    setDraft('')
    resetPublicClient(selected.id)
    setCheck({ status: 'idle' })
  }

  const restoreAll = () => {
    setOverrides(clearRpcOverrides())
    setDraft('')
    clearGraphApiKey()
    setGraphKey('')
    setSavedGraphKey(undefined)
    setGraphCheck({ status: 'idle' })
    resetPublicClient()
    setCheck({ status: 'idle' })
  }

  const saveGraphKey = () => {
    try {
      const saved = saveGraphApiKey(graphKey)
      setGraphKey(saved)
      setSavedGraphKey(saved)
      setGraphCheck({ status: 'passed', message: 'Browser key saved. New scans will use The Graph gateway directly.' })
    } catch (error) {
      setGraphCheck({ status: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
  }

  const removeGraphKey = () => {
    clearGraphApiKey()
    setGraphKey('')
    setSavedGraphKey(undefined)
    setGraphCheck({ status: 'idle' })
  }

  const testEndpoint = async () => {
    if (!isValidRpcUrl(draft)) {
      setCheck({ status: 'failed', message: 'Enter a valid HTTP or HTTPS RPC endpoint first.' })
      return
    }
    setCheck({ status: 'checking' })
    try {
      const candidate = createPublicClient({
        chain: toViemChain(selected),
        transport: http(draft.trim(), { retryCount: 0, timeout: 12_000 }),
      })
      const observedChainId = await candidate.getChainId()
      if (observedChainId !== selected.id) throw new Error(`Endpoint returned chain ID ${observedChainId}, expected ${selected.id}.`)
      const code = selected.deploymentBlock === undefined || !selected.poolManager
        ? undefined
        : await candidate.getCode({ address: selected.poolManager, blockNumber: selected.deploymentBlock })
      if (selected.deploymentBlock !== undefined && (!code || code === '0x')) {
        throw new Error('Endpoint did not return PoolManager code at its deployment block.')
      }
      setCheck({ status: 'passed', message: 'Chain identity and historical PoolManager code read passed.' })
    } catch (error) {
      setCheck({ status: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="settings-dialog"
      aria-labelledby="network-settings-title"
      aria-describedby="network-settings-description"
      onCancel={(event) => { event.preventDefault(); onClose() }}
      onClose={() => { if (open) onClose() }}
      onClick={(event) => { if (event.target === dialogRef.current) onClose() }}
    >
      <div className="settings-surface">
        <header className="settings-heading">
          <div className="settings-heading-mark"><Settings2 size={17} aria-hidden="true" /></div>
          <div>
            <p className="eyebrow">Browser network settings</p>
            <h2 id="network-settings-title">Network sources</h2>
          </div>
          <button type="button" className="icon-button settings-close" onClick={onClose} aria-label="Close network settings"><X size={17} /></button>
        </header>

        <p className="settings-description" id="network-settings-description">
          Replace public RPC fallbacks and optionally use your own Graph gateway quota. Overrides stay in this browser and are never included in reports. Avoid shared devices when URLs or keys contain credentials.
        </p>

        <section className="settings-editor">
          <label>
            <span>Chain</span>
            <AppDropdown
              ariaLabel="Deep-execution chain"
              value={selected.id}
              options={deepChains.map((chain) => ({
                value: chain.id,
                label: chain.name,
                description: `Chain ${chain.id} · deep execution`,
              }))}
              onChange={chooseChain}
              menuMaxHeight={240}
            />
          </label>
          <label className="settings-url-field">
            <span>Custom archive RPC</span>
            <input
              type="url"
              value={draft}
              onChange={(event) => { setDraft(event.target.value); setCheck({ status: 'idle' }) }}
              placeholder={selected.rpcUrls[0] ?? 'https://…'}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <div className="settings-endpoint-actions">
            <button type="button" className="secondary-button" onClick={() => void testEndpoint()} disabled={check.status === 'checking' || !draft.trim()}>
              {check.status === 'checking' ? 'Checking…' : 'Check endpoint'}
            </button>
            <button type="button" className="primary-button" onClick={save} disabled={!draft.trim()}>Save replacement</button>
          </div>
          {check.status !== 'idle' && check.status !== 'checking' && (
            <div className={`settings-check settings-check-${check.status}`} role="status">
              {check.status === 'passed' ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
              <span>{check.message}</span>
            </div>
          )}
        </section>

        <section className="settings-chain-list" aria-label="RPC override status">
          <div className="settings-list-heading"><span>Deep execution chains</span><span>{Object.keys(overrides).length} custom</span></div>
          {deepChains.map((chain) => (
            <button type="button" onClick={() => chooseChain(chain.id)} aria-current={chain.id === selected.id ? 'true' : undefined} key={chain.id}>
              <span><strong>{chain.name}</strong><small>Chain {chain.id}</small></span>
              <span className={overrides[String(chain.id)] ? 'custom' : ''}>{overrides[String(chain.id)] ? 'Custom' : 'Public defaults'}</span>
            </button>
          ))}
        </section>

        <details className="settings-graph">
          <summary>
            <KeyRound size={16} aria-hidden="true" />
            <span><strong>The Graph API key</strong><small>Browser override for {graphSubgraphCount} configured pool indexes</small></span>
            <span className={savedGraphKey ? 'custom' : ''}>{savedGraphKey ? 'Browser key' : 'Server proxy'}</span>
          </summary>
          <div className="settings-graph-body">
            <p>The server-side proxy remains the default. A saved key sends only Hookscope's pool-discovery query directly to <code>gateway.thegraph.com</code>; it is not sent to Hookscope's report API.</p>
            <label className="settings-graph-field">
              <span>The Graph API key</span>
              <span className="settings-secret-input">
                <input
                  type={graphKeyVisible ? 'text' : 'password'}
                  value={graphKey}
                  onChange={(event) => { setGraphKey(event.target.value); setGraphCheck({ status: 'idle' }) }}
                  placeholder="Enter browser-only API key"
                  spellCheck={false}
                  autoComplete="off"
                />
                <button type="button" onClick={() => setGraphKeyVisible((value) => !value)} aria-label={`${graphKeyVisible ? 'Hide' : 'Show'} The Graph API key`}>
                  {graphKeyVisible ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </span>
            </label>
            <div className="settings-graph-actions">
              <button type="button" className="text-button" onClick={removeGraphKey} disabled={!savedGraphKey}>Remove browser key</button>
              <button type="button" className="primary-button" onClick={saveGraphKey} disabled={!graphKey.trim()}>Save browser key</button>
            </div>
            {graphCheck.status !== 'idle' && graphCheck.status !== 'checking' && (
              <div className={`settings-check settings-check-${graphCheck.status}`} role="status">
                {graphCheck.status === 'passed' ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
                <span>{graphCheck.message}</span>
              </div>
            )}
          </div>
        </details>

        <footer className="settings-footer">
          <button type="button" className="text-button" onClick={restoreSelected} disabled={!overrides[String(selected.id)]}><RotateCcw size={13} /> Restore {selected.name}</button>
          <button type="button" className="text-button" onClick={restoreAll} disabled={Object.keys(overrides).length === 0 && !savedGraphKey}>Reset all</button>
        </footer>
      </div>
    </dialog>
  )
}
