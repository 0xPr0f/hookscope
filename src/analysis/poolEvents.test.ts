import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, pad, type Address, type Hex } from 'viem'
import {
  DYNAMIC_FEE_FLAG,
  POOL_MANAGER_EVENT_TOPICS,
  decodePoolManagerSwaps,
  dynamicFeeSummary,
  summarizeDynamicFees,
} from './poolEvents'
import type { RevmExecutionProof, RevmLogEvidence } from './revmProof'

const MANAGER = '0x5555555555555555555555555555555555555555' as Address
const HOOK = '0x2222222222222222222222222222222222222222' as Address
const SENDER = '0x3333333333333333333333333333333333333333' as Address
const POOL_ID = `0x${'ab'.repeat(32)}` as Hex
const OTHER_POOL = `0x${'cd'.repeat(32)}` as Hex

function swapLog(input: { poolId?: Hex; fee: number; amount0?: bigint; address?: Address }): RevmLogEvidence {
  return {
    address: input.address ?? MANAGER,
    topics: [POOL_MANAGER_EVENT_TOPICS.swap as Hex, input.poolId ?? POOL_ID, pad(SENDER, { size: 32 })],
    data: encodeAbiParameters(
      [{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }],
      [input.amount0 ?? -1_000n, 900n, 79_228_162_514_264_337_593_543_950_336n, 5_000n, -120, input.fee],
    ),
  }
}

function proof(logs: RevmLogEvidence[]): RevmExecutionProof {
  return {
    engine: 'revm/36.0.0',
    success: true,
    gasUsed: 21_000,
    output: '0x',
    steps: [],
    storageOperations: [],
    calls: [],
    storageDiffs: [],
    balanceChanges: [],
    logs,
    logCount: logs.length,
    selfdestructs: [],
    truncated: false,
  }
}

describe('PoolManager event observations', () => {
  it('decodes a swap including the fee actually charged', () => {
    const [swap] = decodePoolManagerSwaps(proof([swapLog({ fee: 3_000 })]), MANAGER)
    expect(swap).toMatchObject({
      poolId: POOL_ID,
      sender: SENDER.toLowerCase(),
      amount0: -1_000n,
      amount1: 900n,
      tick: -120,
      fee: 3_000,
    })
  })

  it('ignores swap-shaped logs emitted by another contract', () => {
    expect(decodePoolManagerSwaps(proof([swapLog({ fee: 3_000, address: HOOK })]), MANAGER)).toEqual([])
  })

  it('reports a dynamic-fee pool charging one fee', () => {
    const observation = summarizeDynamicFees({
      proof: proof([swapLog({ fee: 500 })]),
      poolManager: MANAGER,
      poolId: POOL_ID,
      poolFee: DYNAMIC_FEE_FLAG,
    })!
    expect(observation.poolAdvertisesDynamicFee).toBe(true)
    expect(observation.observedFees).toEqual([500])
    expect(observation.feeVaried).toBe(false)
    expect(dynamicFeeSummary(observation)).toBe('dynamic-fee pool charged 500')
  })

  it('flags a fee that varied within one execution', () => {
    const observation = summarizeDynamicFees({
      proof: proof([swapLog({ fee: 500 }), swapLog({ fee: 10_000 })]),
      poolManager: MANAGER,
      poolId: POOL_ID,
      poolFee: DYNAMIC_FEE_FLAG,
    })!
    expect(observation.feeVaried).toBe(true)
    expect(observation.observedFees).toEqual([500, 10_000])
    expect(dynamicFeeSummary(observation)).toContain('2 different fees')
  })

  it('only counts swaps for the selected pool', () => {
    const observation = summarizeDynamicFees({
      proof: proof([swapLog({ fee: 500 }), swapLog({ poolId: OTHER_POOL, fee: 10_000 })]),
      poolManager: MANAGER,
      poolId: POOL_ID,
      poolFee: 3_000,
    })!
    expect(observation.observedFees).toEqual([500])
    expect(observation.poolAdvertisesDynamicFee).toBe(false)
  })

  it('reports nothing when the execution produced no swap for this pool', () => {
    expect(summarizeDynamicFees({
      proof: proof([]),
      poolManager: MANAGER,
      poolId: POOL_ID,
      poolFee: 3_000,
    })).toBeUndefined()
    expect(dynamicFeeSummary(undefined)).toBeUndefined()
  })
})
