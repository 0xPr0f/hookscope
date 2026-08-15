import { describe, expect, it } from 'vitest'
import { toEventSelector, toFunctionSelector, type Address, type Hex } from 'viem'
import {
  attestCustomRouterExecution,
  POOL_MANAGER_SWAP_TOPIC,
  V4_SELECTORS,
} from './customRouterAttestation'
import type { RevmCallEvidence, RevmExecutionProof } from './revmProof'

const MANAGER = '0x000000000004444c5dc75cB358380D2e3dE08A90' as Address
const ROUTER = '0x5555555555555555555555555555555555555555' as Address
const HOOK = '0x1111111111111111111111111111111111111888' as Address
const TOKEN = '0xD0a606aDf58b69a28D479aA510CE6FE96E0a1eb2' as Address
const ACTOR = '0x9999999999999999999999999999999999999999' as Address
const POOL_ID = `0x${'ab'.repeat(32)}` as Hex

function call(caller: Address, target: Address, selector: string): RevmCallEvidence {
  return { caller, target, bytecodeAddress: target, scheme: 'Call', value: '0', inputLength: 68, selector: selector as Hex }
}

/** The observed spine of a custom-router unlock-and-swap. */
function tracedCalls(): RevmCallEvidence[] {
  return [
    call(ACTOR, ROUTER, '0x9409a78f'),
    call(ROUTER, TOKEN, V4_SELECTORS.transferFrom),
    call(ROUTER, MANAGER, V4_SELECTORS.unlock),
    call(MANAGER, ROUTER, V4_SELECTORS.unlockCallback),
    call(ROUTER, MANAGER, V4_SELECTORS.swap),
    call(MANAGER, HOOK, '0x575e24b4'),
    call(ROUTER, MANAGER, V4_SELECTORS.sync),
    call(ROUTER, TOKEN, V4_SELECTORS.transfer),
    call(ROUTER, MANAGER, V4_SELECTORS.settle),
    call(ROUTER, MANAGER, V4_SELECTORS.take),
  ]
}

function proof(overrides: Partial<RevmExecutionProof> = {}): RevmExecutionProof {
  return {
    engine: 'revm/36.0.0', success: true, gasUsed: 250_000, output: '0x',
    steps: [], storageOperations: [], calls: tracedCalls(), storageDiffs: [], balanceChanges: [],
    logs: [{ address: MANAGER, topics: [POOL_MANAGER_SWAP_TOPIC, POOL_ID], data: '0x' }],
    logCount: 1, selfdestructs: [], truncated: false,
    ...overrides,
  }
}

const subject = { poolManager: MANAGER, router: ROUTER, hook: HOOK, poolId: POOL_ID }

describe('custom router attestation', () => {
  it('pins its selectors and topic to the canonical signatures', () => {
    expect(V4_SELECTORS.unlock).toBe(toFunctionSelector('function unlock(bytes)'))
    expect(V4_SELECTORS.unlockCallback).toBe(toFunctionSelector('function unlockCallback(bytes)'))
    expect(V4_SELECTORS.swap).toBe(toFunctionSelector('function swap((address,address,uint24,int24,address),(bool,int256,uint160),bytes)'))
    expect(V4_SELECTORS.settle).toBe(toFunctionSelector('function settle()'))
    expect(V4_SELECTORS.take).toBe(toFunctionSelector('function take(address,address,uint256)'))
    expect(V4_SELECTORS.sync).toBe(toFunctionSelector('function sync(address)'))
    expect(POOL_MANAGER_SWAP_TOPIC)
      .toBe(toEventSelector('event Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)'))
  })

  it('attests a correctly ordered unlock-and-swap', () => {
    const result = attestCustomRouterExecution({ proof: proof(), ...subject })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.attestation.reachedHook).toBe(true)
    expect(result.attestation.swapLogPoolId).toBe(POOL_ID)
    expect(result.attestation.attestedCalls.map((item) => item.selector)).toContain(V4_SELECTORS.swap)
  })

  it('refuses a reverted execution', () => {
    expect(attestCustomRouterExecution({ proof: proof({ success: false }), ...subject }))
      .toMatchObject({ ok: false, reason: 'execution-failed' })
  })

  it('refuses when unlock, the callback or swap is missing', () => {
    for (const [selector, reason] of [
      [V4_SELECTORS.unlock, 'missing-sequence'],
      [V4_SELECTORS.unlockCallback, 'router-not-callback-target'],
      [V4_SELECTORS.swap, 'missing-sequence'],
    ] as const) {
      const calls = tracedCalls().filter((item) => item.selector !== selector)
      expect(attestCustomRouterExecution({ proof: proof({ calls }), ...subject }), selector)
        .toMatchObject({ ok: false, reason })
    }
  })

  it('refuses when settlement or take is missing', () => {
    for (const selector of [V4_SELECTORS.settle, V4_SELECTORS.take]) {
      const calls = tracedCalls().filter((item) => item.selector !== selector)
      expect(attestCustomRouterExecution({ proof: proof({ calls }), ...subject }), selector)
        .toMatchObject({ ok: false, reason: 'missing-settlement' })
    }
  })

  it('refuses correct calls in the wrong order', () => {
    const calls = tracedCalls()
    const unlock = calls.splice(2, 1)[0]!
    // Unlock now happens after swap, which cannot be what the trace did.
    calls.splice(5, 0, unlock)
    expect(attestCustomRouterExecution({ proof: proof({ calls }), ...subject }))
      .toMatchObject({ ok: false, reason: 'missing-sequence' })
  })

  it('refuses a callback that did not come from the PoolManager', () => {
    const calls = tracedCalls().map((item) =>
      item.selector === V4_SELECTORS.unlockCallback ? { ...item, caller: HOOK } : item)
    expect(attestCustomRouterExecution({ proof: proof({ calls }), ...subject }))
      .toMatchObject({ ok: false, reason: 'router-not-callback-target' })
  })

  it('refuses a different PoolManager or hook', () => {
    const uncalled = '0x4444444444444444444444444444444444444444' as Address
    expect(attestCustomRouterExecution({ proof: proof(), ...subject, poolManager: uncalled }))
      .toMatchObject({ ok: false, reason: 'pool-manager-not-called' })
    // The token is called by this trace but is not the PoolManager; it must
    // still be refused, on whichever check catches it first.
    expect(attestCustomRouterExecution({ proof: proof(), ...subject, poolManager: TOKEN }).ok).toBe(false)
    expect(attestCustomRouterExecution({ proof: proof(), ...subject, hook: ACTOR }))
      .toMatchObject({ ok: false, reason: 'hook-not-reached' })
  })

  it('refuses a missing Swap log or one naming a different pool', () => {
    expect(attestCustomRouterExecution({ proof: proof({ logs: [] }), ...subject }))
      .toMatchObject({ ok: false, reason: 'missing-swap-log' })
    const other = [{ address: MANAGER, topics: [POOL_MANAGER_SWAP_TOPIC, `0x${'cd'.repeat(32)}` as Hex], data: '0x' as Hex }]
    expect(attestCustomRouterExecution({ proof: proof({ logs: other }), ...subject }))
      .toMatchObject({ ok: false, reason: 'swap-log-pool-mismatch' })
  })

  it('refuses a Swap log emitted by something other than the PoolManager', () => {
    const spoofed = [{ address: ROUTER, topics: [POOL_MANAGER_SWAP_TOPIC, POOL_ID], data: '0x' as Hex }]
    expect(attestCustomRouterExecution({ proof: proof({ logs: spoofed }), ...subject }))
      .toMatchObject({ ok: false, reason: 'missing-swap-log' })
  })
})
