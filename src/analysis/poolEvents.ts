import { decodeAbiParameters, type Address, type Hex } from 'viem'
import type { RevmExecutionProof, RevmLogEvidence } from './revmProof'

/**
 * PoolManager events decoded from an execution's own logs.
 *
 * The `Swap` event carries the fee that was actually charged, which is the only
 * place a hook's dynamic-fee override becomes observable: the override travels
 * in `beforeSwap`'s return value and is applied in memory, never written to
 * storage. Reading it from the emitted event makes it a decoded observation
 * rather than something inferred.
 *
 * Topics are pinned from Uniswap/v4-core `IPoolManager`.
 */
export const POOL_MANAGER_EVENT_TOPICS = {
  swap: '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f',
  modifyLiquidity: '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec',
} as const

/** `LPFeeLibrary`: a pool key advertises a dynamic fee with this exact value. */
export const DYNAMIC_FEE_FLAG = 0x800_000
/** `LPFeeLibrary`: a hook returning this flag overrides the fee for one swap. */
export const OVERRIDE_FEE_FLAG = 0x400_000

const SWAP_DATA = [
  { type: 'int128' },
  { type: 'int128' },
  { type: 'uint160' },
  { type: 'uint128' },
  { type: 'int24' },
  { type: 'uint24' },
] as const

export type ObservedSwap = {
  poolId: Hex
  sender: Address
  amount0: bigint
  amount1: bigint
  sqrtPriceX96: bigint
  liquidity: bigint
  tick: number
  /** The fee actually charged, in hundredths of a bip. */
  fee: number
}

function isFrom(log: RevmLogEvidence, poolManager: Address, topic: string) {
  return log.address.toLowerCase() === poolManager.toLowerCase()
    && log.topics[0]?.toLowerCase() === topic
}

export function decodePoolManagerSwaps(proof: RevmExecutionProof, poolManager: Address): ObservedSwap[] {
  const swaps: ObservedSwap[] = []
  for (const log of proof.logs) {
    if (!isFrom(log, poolManager, POOL_MANAGER_EVENT_TOPICS.swap)) continue
    const [poolId, sender] = [log.topics[1], log.topics[2]]
    if (!poolId || !sender) continue
    try {
      const [amount0, amount1, sqrtPriceX96, liquidity, tick, fee] = decodeAbiParameters(SWAP_DATA, log.data)
      swaps.push({
        poolId,
        // An indexed address is right-aligned in its 32-byte topic.
        sender: `0x${sender.slice(-40)}` as Address,
        amount0,
        amount1,
        sqrtPriceX96,
        liquidity,
        tick,
        fee,
      })
    } catch {
      // A malformed log is not evidence; skip it rather than guessing its shape.
    }
  }
  return swaps
}

export type DynamicFeeObservation = {
  poolId: Hex
  /** Distinct fees observed across this execution's swaps, in first-seen order. */
  observedFees: number[]
  /** True when the pool key advertises a dynamic fee rather than a fixed one. */
  poolAdvertisesDynamicFee: boolean
  /** True when more than one distinct fee was charged in a single execution. */
  feeVaried: boolean
}

/**
 * Summarizes what the hook actually charged.
 *
 * A pool whose key carries `DYNAMIC_FEE_FLAG` has no fixed fee, so each swap's
 * fee is whatever the hook returned. Reporting the observed values is the only
 * honest way to describe that: the key alone says the fee is dynamic, not what
 * it will be.
 */
export function summarizeDynamicFees(input: {
  proof: RevmExecutionProof
  poolManager: Address
  poolId: Hex
  poolFee: number
}): DynamicFeeObservation | undefined {
  const swaps = decodePoolManagerSwaps(input.proof, input.poolManager)
    .filter((swap) => swap.poolId.toLowerCase() === input.poolId.toLowerCase())
  if (!swaps.length) return undefined
  const observedFees = [...new Set(swaps.map((swap) => swap.fee))]
  return {
    poolId: input.poolId,
    observedFees,
    poolAdvertisesDynamicFee: input.poolFee === DYNAMIC_FEE_FLAG,
    feeVaried: observedFees.length > 1,
  }
}

export function dynamicFeeSummary(observation: DynamicFeeObservation | undefined): string | undefined {
  if (!observation) return undefined
  const fees = observation.observedFees.map((fee) => `${fee}`).join(', ')
  if (observation.poolAdvertisesDynamicFee) {
    return observation.feeVaried
      ? `dynamic-fee pool charged ${observation.observedFees.length} different fees in one execution (${fees})`
      : `dynamic-fee pool charged ${fees}`
  }
  return observation.feeVaried
    ? `fixed-fee pool charged ${observation.observedFees.length} different fees in one execution (${fees})`
    : `charged ${fees}`
}
