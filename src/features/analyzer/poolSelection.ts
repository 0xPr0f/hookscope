import { zeroAddress, type Hex } from 'viem'
import type { PoolDescriptor } from '../../domain/report'

export const MAX_SELECTED_POOLS = 20

/** Prefer pools whose behavior actually includes a hook; fall back to the top-ranked pool. */
export function defaultSelectedPoolIds(pools: readonly PoolDescriptor[]): Hex[] {
  const hooked = pools
    .filter((pool) => pool.hook.toLowerCase() !== zeroAddress)
    .slice(0, MAX_SELECTED_POOLS)
    .map((pool) => pool.poolId)
  return hooked.length > 0 ? hooked : pools.slice(0, 1).map((pool) => pool.poolId)
}

export function toggleSelectedPoolId(selected: readonly Hex[], poolId: Hex): Hex[] {
  const normalized = poolId.toLowerCase()
  if (selected.some((candidate) => candidate.toLowerCase() === normalized)) {
    return selected.filter((candidate) => candidate.toLowerCase() !== normalized)
  }
  return selected.length < MAX_SELECTED_POOLS ? [...selected, poolId] : [...selected]
}

