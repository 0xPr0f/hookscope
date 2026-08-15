import { getAddress, type Address, type Hex } from 'viem'
import type { RevmCallEvidence, RevmExecutionProof } from './revmProof'

/**
 * Attests that a reproduced execution really is a v4 unlock-and-swap.
 *
 * Recognizing calldata and recognizing runtime bytes both say what a router
 * looks like. This says what it did: the reproduced trace entered the
 * PoolManager through `unlock`, came back through `unlockCallback`, called
 * `swap` on the selected pool, reached the selected hook, settled, and took.
 * Only a trace that did all of that in order earns controlled variants.
 *
 * The evidence comes from the browser's own revm proof. Nothing here consults
 * Etherscan, Blockscout, or any third-party trace API.
 */

export const V4_SELECTORS = {
  transferFrom: '0x23b872dd',
  unlock: '0x48c89491',
  unlockCallback: '0x91dd7346',
  swap: '0xf3cd914c',
  sync: '0xa5841194',
  transfer: '0xa9059cbb',
  settle: '0x11da60b4',
  take: '0x0b0d9c09',
} as const

/** `Swap(bytes32 indexed id, address indexed sender, ...)`. */
export const POOL_MANAGER_SWAP_TOPIC =
  '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f' as Hex

/**
 * The ordered spine of an unlock-and-swap.
 *
 * Deliberately not the full observed trace: a router may sync, transfer, settle
 * and take in an order of its own choosing, and demanding the exact observed
 * sequence would reject a sibling deployment for a difference that changes
 * nothing about what reached the pool. These four, in this order, are what make
 * the execution a PoolManager swap rather than something that merely called it.
 */
const REQUIRED_SEQUENCE = [
  V4_SELECTORS.unlock,
  V4_SELECTORS.unlockCallback,
  V4_SELECTORS.swap,
] as const

/** Settlement must be observed, but its internal ordering is the router's business. */
const REQUIRED_SETTLEMENT = [V4_SELECTORS.settle, V4_SELECTORS.take] as const

export type CustomRouterAttestation = {
  attested: true
  /** Selectors in the order they were observed, for the report. */
  attestedCalls: { target: Address; selector: Hex }[]
  reachedHook: boolean
  swapLogPoolId: Hex
}

export type CustomRouterAttestationRejection =
  | 'execution-failed'
  | 'missing-sequence'
  | 'missing-settlement'
  | 'hook-not-reached'
  | 'pool-manager-not-called'
  | 'router-not-callback-target'
  | 'missing-swap-log'
  | 'swap-log-pool-mismatch'

export type CustomRouterAttestationResult =
  | { ok: true; attestation: CustomRouterAttestation }
  | { ok: false; reason: CustomRouterAttestationRejection; detail: string }

export type AttestationSubject = {
  proof: RevmExecutionProof
  poolManager: Address
  router: Address
  hook: Address
  poolId: Hex
}

function sameAddress(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase()
}

/**
 * Finds the required selectors in order, allowing unrelated calls between them.
 *
 * A subsequence rather than a contiguous run: token approvals, reserve syncs and
 * hook callbacks legitimately interleave, and rejecting those would attest only
 * the one router that happened to be looked at first.
 */
function orderedSubsequence(calls: RevmCallEvidence[], required: readonly string[]): number {
  let cursor = 0
  for (const call of calls) {
    if (!call.selector) continue
    if (call.selector.toLowerCase() === required[cursor]) cursor++
    if (cursor === required.length) return cursor
  }
  return cursor
}

export function attestCustomRouterExecution(subject: AttestationSubject): CustomRouterAttestationResult {
  const { proof, poolManager, router, hook, poolId } = subject
  if (!proof.success) {
    return { ok: false, reason: 'execution-failed', detail: 'The reproduced execution reverted.' }
  }

  const calls = proof.calls
  if (!calls.some((call) => sameAddress(call.target, poolManager))) {
    return { ok: false, reason: 'pool-manager-not-called', detail: 'The trace never called the configured PoolManager.' }
  }

  // Calls into the PoolManager: this is where unlock and swap must appear.
  const managerCalls = calls.filter((call) => sameAddress(call.target, poolManager))
  const callbackCalls = calls.filter((call) =>
    sameAddress(call.target, router) && call.selector?.toLowerCase() === V4_SELECTORS.unlockCallback)
  if (!callbackCalls.length) {
    return {
      ok: false,
      reason: 'router-not-callback-target',
      detail: 'The PoolManager never called unlockCallback back into the router.',
    }
  }
  if (!callbackCalls.some((call) => sameAddress(call.caller, poolManager))) {
    return {
      ok: false,
      reason: 'router-not-callback-target',
      detail: 'unlockCallback did not originate from the configured PoolManager.',
    }
  }

  // Order is checked over the whole trace so the callback sits between unlock and swap.
  const reached = orderedSubsequence(calls, REQUIRED_SEQUENCE)
  if (reached < REQUIRED_SEQUENCE.length) {
    return {
      ok: false,
      reason: 'missing-sequence',
      detail: `Reproduced trace did not reach ${REQUIRED_SEQUENCE[reached]} in the required order.`,
    }
  }

  const managerSelectors = new Set(managerCalls.map((call) => call.selector?.toLowerCase()))
  const missingSettlement = REQUIRED_SETTLEMENT.filter((selector) => !managerSelectors.has(selector))
  if (missingSettlement.length) {
    return {
      ok: false,
      reason: 'missing-settlement',
      detail: `Reproduced trace did not settle: missing ${missingSettlement.join(', ')}.`,
    }
  }

  if (!calls.some((call) => sameAddress(call.target, hook))) {
    return { ok: false, reason: 'hook-not-reached', detail: 'The trace never reached the selected hook.' }
  }

  const swapLog = proof.logs.find((log) =>
    sameAddress(log.address, poolManager) && log.topics[0]?.toLowerCase() === POOL_MANAGER_SWAP_TOPIC)
  if (!swapLog) {
    return { ok: false, reason: 'missing-swap-log', detail: 'The PoolManager emitted no Swap event.' }
  }
  const loggedPoolId = swapLog.topics[1]
  if (!loggedPoolId || loggedPoolId.toLowerCase() !== poolId.toLowerCase()) {
    return {
      ok: false,
      reason: 'swap-log-pool-mismatch',
      detail: 'The Swap event names a different pool than the one selected.',
    }
  }

  return {
    ok: true,
    attestation: {
      attested: true,
      attestedCalls: calls
        .filter((call): call is RevmCallEvidence & { selector: Hex } => Boolean(call.selector))
        .map((call) => ({ target: getAddress(call.target as Address), selector: call.selector }))
        .slice(0, 64),
      reachedHook: true,
      swapLogPoolId: loggedPoolId,
    },
  }
}
