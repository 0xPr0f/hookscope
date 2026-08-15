import { useState } from 'react'
import { ArrowRight, Check, ExternalLink, Layers3 } from 'lucide-react'
import { zeroAddress, type Address, type Hex } from 'viem'
import { getChainConfig } from '../../config/chains'
import type { PoolDiscoverySnapshot } from '../../data/loadScan'
import { shortAddress } from '../../domain/address'
import { formatPoolFee } from '../../domain/poolFee'
import type { PoolDescriptor } from '../../domain/report'
import { defaultSelectedPoolIds, MAX_SELECTED_POOLS, toggleSelectedPoolId } from './poolSelection'

function currencyLabel(address: Address, discovery: PoolDiscoverySnapshot) {
  if (address.toLowerCase() === zeroAddress) return 'ETH'
  if (address.toLowerCase() === discovery.token.toLowerCase()) {
    return discovery.tokenMetadata.symbol ?? shortAddress(address)
  }
  return shortAddress(address)
}

function poolPair(pool: PoolDescriptor, discovery: PoolDiscoverySnapshot) {
  return `${currencyLabel(pool.currency0, discovery)} / ${currencyLabel(pool.currency1, discovery)}`
}

export function PoolPicker({ discovery, onAnalyze }: {
  discovery: PoolDiscoverySnapshot
  onAnalyze: (poolIds: Hex[]) => void
}) {
  const [selected, setSelected] = useState<Hex[]>(() => defaultSelectedPoolIds(discovery.pools))
  const chain = getChainConfig(discovery.chainId)
  const selectedSet = new Set(selected.map((poolId) => poolId.toLowerCase()))
  const hookedPools = discovery.pools.filter((pool) => pool.hook.toLowerCase() !== zeroAddress)

  return (
    <section className="pool-picker" aria-labelledby="pool-picker-title">
      <div className="pool-picker-heading">
        <div>
          <p className="eyebrow">Verified pool discovery</p>
          <h2 id="pool-picker-title">Choose pools to analyze</h2>
          <p>
            {discovery.tokenMetadata.symbol ?? shortAddress(discovery.token)} has {discovery.pools.length} verified Uniswap v4 pool{discovery.pools.length === 1 ? '' : 's'} at block {discovery.block.number.toString()}.
            Analysis will use this exact pinned snapshot.
          </p>
        </div>
        <div className="pool-picker-count" aria-live="polite">
          <strong>{selected.length}</strong>
          <span>selected · max {MAX_SELECTED_POOLS}</span>
        </div>
      </div>

      {discovery.discovery.limitation && (
        <p className="pool-picker-limitation">Discovery note: {discovery.discovery.limitation}</p>
      )}

      {discovery.pools.length > 0 ? (
        <>
          <div className="pool-picker-toolbar">
            <span>{hookedPools.length} hooked · {discovery.pools.length - hookedPools.length} hookless</span>
            <div>
              {hookedPools.length > 0 && (
                <button type="button" onClick={() => setSelected(hookedPools.slice(0, MAX_SELECTED_POOLS).map((pool) => pool.poolId))}>Select hooked</button>
              )}
              <button type="button" onClick={() => setSelected(discovery.pools.slice(0, MAX_SELECTED_POOLS).map((pool) => pool.poolId))}>Select first {Math.min(MAX_SELECTED_POOLS, discovery.pools.length)}</button>
              <button type="button" onClick={() => setSelected([])}>Clear</button>
            </div>
          </div>

          <div className="pool-picker-list">
            {discovery.pools.map((pool, index) => {
              const checked = selectedSet.has(pool.poolId.toLowerCase())
              const hooked = pool.hook.toLowerCase() !== zeroAddress
              return (
                <label className={`pool-choice${checked ? ' selected' : ''}`} key={pool.poolId}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => setSelected((current) => toggleSelectedPoolId(current, pool.poolId))}
                    aria-label={`Analyze ${poolPair(pool, discovery)} pool ${pool.poolId}`}
                  />
                  <span className="pool-choice-check" aria-hidden="true">{checked ? <Check size={13} /> : null}</span>
                  <span className="pool-choice-rank">{String(index + 1).padStart(2, '0')}</span>
                  <span className="pool-choice-main">
                    <strong>{poolPair(pool, discovery)}</strong>
                    <small title={pool.poolId}>Pool {pool.poolId.slice(0, 12)}…</small>
                  </span>
                  <span className="pool-choice-facts">
                    <span>{formatPoolFee(pool.fee)} pool LP fee</span>
                    <span>{pool.activity.toLocaleString()} indexed actions</span>
                    <span className={hooked ? 'hooked' : 'hookless'}>{hooked ? `Hook ${shortAddress(pool.hook)}` : 'No hook'}</span>
                  </span>
                  <a
                    href={`https://app.uniswap.org/explore/pools/${chain.slug}/${pool.poolId}`}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(event) => event.stopPropagation()}
                    aria-label={`Open ${poolPair(pool, discovery)} pool in Uniswap`}
                    title="Open pool in Uniswap"
                  >
                    <ExternalLink size={13} />
                  </a>
                </label>
              )
            })}
          </div>

          <div className="pool-picker-actions">
            <span><Layers3 size={14} /> Static and execution work will be scoped to the selected pools.</span>
            <button className="primary-button" type="button" disabled={selected.length === 0} onClick={() => onAnalyze(selected)}>
              Analyze {selected.length || ''} selected pool{selected.length === 1 ? '' : 's'} <ArrowRight size={15} />
            </button>
          </div>
        </>
      ) : (
        <div className="pool-picker-empty">
          <Layers3 size={22} />
          <div><strong>No verified v4 pools found</strong><p>Try another token or review the discovery note above.</p></div>
        </div>
      )}
    </section>
  )
}
