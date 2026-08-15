import { toEventSelector, type Address, type Hex } from 'viem'
import type { RevmExecutionProof } from './revmProof'
import type { ProtocolScenario } from './protocolNativeScenarios'

/**
 * Decides whether a generated execution is evidence about a pool at all.
 *
 * `proof.success` alone cannot answer this. A harness that reverts while ABI
 * decoding its own arguments, or a call that never reaches the deployed
 * PoolManager, produces `success: false` exactly like a hook rejecting a swap —
 * and reporting the first as the second would attribute an analyzer fault to
 * someone's contract. So an outcome is only classed as an observation once the
 * trace is shown to have entered the PoolManager, and only classed as a
 * completed operation once the emitted event names the selected pool.
 */

export const POOL_EVENT_TOPICS = {
  swap: toEventSelector('event Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)'),
  donate: toEventSelector('event Donate(bytes32,address,uint256,uint256)'),
  modifyLiquidity: toEventSelector('event ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)'),
} as const

/** `unlock(bytes)` on the PoolManager: the entry point every scenario must reach. */
export const UNLOCK_SELECTOR = '0x48c89491' as Hex

export type ScenarioValidation =
  | { status: 'completed' }
  | { status: 'reverted' }
  | { status: 'failed'; reason: string }

/**
 * Which pool events a completed scenario must have emitted.
 *
 * A single-operation scenario must emit that operation's event. A sequence
 * mixes operations, so it must emit at least one of them — enough to prove the
 * work landed on the selected pool, without demanding an event the particular
 * step order need not produce.
 */
function requiredTopics(operation: ProtocolScenario['operation']): Hex[] {
  if (operation === 'swap') return [POOL_EVENT_TOPICS.swap]
  if (operation === 'donate') return [POOL_EVENT_TOPICS.donate]
  if (operation === 'liquidity') return [POOL_EVENT_TOPICS.modifyLiquidity]
  return [POOL_EVENT_TOPICS.swap, POOL_EVENT_TOPICS.donate, POOL_EVENT_TOPICS.modifyLiquidity]
}

function sameAddress(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase()
}

export function validateScenarioExecution(input: {
  proof: RevmExecutionProof
  scenario: ProtocolScenario
  poolManager: Address
  hook: Address
  poolId: Hex
  /** The harness instance the scenario was sent to. */
  router: Address
}): ScenarioValidation {
  const { proof, poolManager, poolId } = input

  const enteredPoolManager = proof.calls.some((call) =>
    sameAddress(call.target, poolManager) && call.selector?.toLowerCase() === UNLOCK_SELECTOR)
  if (!enteredPoolManager) {
    // Nothing about the pool or the hook was exercised, whatever the status.
    return {
      status: 'failed',
      reason: proof.success
        ? 'The generated call succeeded without ever calling unlock on the deployed PoolManager.'
        : 'The generated call reverted before reaching unlock on the deployed PoolManager, so it says nothing about the pool.',
    }
  }

  if (!proof.success) {
    // A revert after entering the PoolManager is a fact about the pool: the
    // hook, the pool state or settlement rejected the operation.
    return { status: 'reverted' }
  }

  const topics = requiredTopics(input.scenario.operation).map((topic) => topic.toLowerCase())
  const emitted = proof.logs.filter((log) =>
    sameAddress(log.address, poolManager) && topics.includes(log.topics[0]?.toLowerCase() ?? ''))
  if (!emitted.length) {
    return {
      status: 'failed',
      reason: `The generated ${input.scenario.operation} completed without the PoolManager emitting a matching pool event.`,
    }
  }
  if (!emitted.some((log) => log.topics[1]?.toLowerCase() === poolId.toLowerCase())) {
    return {
      status: 'failed',
      reason: 'The PoolManager event names a different pool than the one selected.',
    }
  }

  return { status: 'completed' }
}

/**
 * Whether the trace reached the pool's hook.
 *
 * Reported rather than enforced: a hook only receives the callbacks its address
 * flags enable, so a pool whose hook has no swap permission legitimately
 * completes a swap without the hook appearing in the trace.
 */
export function reachedHook(proof: RevmExecutionProof, hook: Address): boolean {
  return proof.calls.some((call) => sameAddress(call.target, hook))
}
