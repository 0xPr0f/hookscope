import { describe, expect, it } from 'vitest'
import { zeroAddress, type Address, type Hex } from 'viem'
import type { PoolDescriptor } from '../../domain/report'
import { defaultSelectedPoolIds, MAX_SELECTED_POOLS, toggleSelectedPoolId } from './poolSelection'

function pool(index: number, hooked = true): PoolDescriptor {
  return {
    poolId: `0x${index.toString(16).padStart(64, '0')}` as Hex,
    currency0: zeroAddress,
    currency1: '0x1111111111111111111111111111111111111111' as Address,
    fee: 3_000,
    tickSpacing: 60,
    hook: hooked ? '0x2222222222222222222222222222222222222280' as Address : zeroAddress,
    initializedAtBlock: '1',
    activity: index,
  }
}

describe('pool selection', () => {
  it('defaults to hooked pools so hookless decoys do not hide the relevant pool', () => {
    const pools = [pool(1, false), pool(2), pool(3)]
    expect(defaultSelectedPoolIds(pools)).toEqual([pools[1]?.poolId, pools[2]?.poolId])
  })

  it('falls back to the highest-ranked pool when every pool is hookless', () => {
    const pools = [pool(1, false), pool(2, false)]
    expect(defaultSelectedPoolIds(pools)).toEqual([pools[0]?.poolId])
  })

  it('never grows past the report pool limit', () => {
    const selected = Array.from({ length: MAX_SELECTED_POOLS }, (_, index) => pool(index + 1).poolId)
    expect(toggleSelectedPoolId(selected, pool(99).poolId)).toEqual(selected)
  })
})
