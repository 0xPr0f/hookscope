import { describe, expect, it } from 'vitest'
import { zeroAddress, type Address, type Hex } from 'viem'
import type { PoolDescriptor } from '../domain/report'
import { selectDiscoveredPools, type PoolDiscoverySnapshot } from './loadScan'

function pool(index: number): PoolDescriptor {
  return {
    poolId: `0x${index.toString(16).padStart(64, '0')}` as Hex,
    currency0: zeroAddress,
    currency1: '0x1111111111111111111111111111111111111111' as Address,
    fee: 3_000,
    tickSpacing: 60,
    hook: zeroAddress,
    initializedAtBlock: String(index),
    activity: index,
  }
}

function snapshot(pools: PoolDescriptor[]): PoolDiscoverySnapshot {
  return {
    chainId: 1,
    token: '0x1111111111111111111111111111111111111111' as Address,
    block: { number: 10n, hash: `0x${'10'.padStart(64, '0')}` as Hex, policy: 'finalized' },
    tokenMetadata: { symbol: 'TKN', decimals: 18 },
    pools,
    discovery: { source: 'index+tail', requests: 2, completeHistory: true },
  }
}

describe('selectDiscoveredPools', () => {
  it('preserves verified discovery rank rather than checkbox click order', () => {
    const pools = [pool(1), pool(2), pool(3)]
    expect(selectDiscoveredPools(snapshot(pools), [pools[2]!.poolId, pools[0]!.poolId])).toEqual([pools[0], pools[2]])
  })

  it('rejects a pool outside the pinned token snapshot', () => {
    expect(() => selectDiscoveredPools(snapshot([pool(1)]), [pool(99).poolId])).toThrow(/do not belong/)
  })

  it('requires at least one pool and enforces the report limit', () => {
    const pools = Array.from({ length: 21 }, (_, index) => pool(index + 1))
    expect(() => selectDiscoveredPools(snapshot(pools), [])).toThrow(/at least one/)
    expect(() => selectDiscoveredPools(snapshot(pools), pools.map((item) => item.poolId))).toThrow(/no more than 20/)
  })
})
