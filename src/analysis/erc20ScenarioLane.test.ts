import { describe, expect, it, vi } from 'vitest'
import { getAddress, toHex, type Address, type Hex } from 'viem'
import { erc20LaneEvidence, runErc20Lane } from './erc20ScenarioLane'
import { ERC20_SELECTORS } from './erc20Provisioning'
import { POOL_EVENT_TOPICS } from './protocolScenarioValidation'
import { buildProtocolScenarioMatrix } from './protocolNativeScenarios'
import type { ForkReplayBlock, ForkReplayResult } from './revmProof'

const TOKEN = getAddress('0x3c4952ccf02d4dbb4c48077bbfe8296b3dfdb4bc')
const PAYER = getAddress('0xbbd64a6de020a1e2caf3eabe3781b8958d03c728')
const HARNESS = getAddress('0x0000000000000000000000000000000000005ce5')
const MANAGER = getAddress('0x000000000004444c5dc75cb358380d2e3de08a90')
const HOOK = getAddress('0x239732813d5f9b531abc736b1c9478f7088e0040')
const POOL_ID = `0x${'ab'.repeat(32)}` as Hex

const block: ForkReplayBlock = {
  number: 100n, beneficiary: MANAGER, timestamp: 1n, gasLimit: 30_000_000n,
  baseFee: 0n, difficulty: 0n, prevrandao: `0x${'0'.repeat(64)}` as Hex,
}

const scenario = buildProtocolScenarioMatrix({
  key: { currency0: '0x0000000000000000000000000000000000000000', currency1: TOKEN, fee: 0x800000, tickSpacing: 200, hooks: HOOK },
  currentTick: 0,
  actor: PAYER,
}).scenarios.find((item) => item.id === 'swap:exact-input:0-for-1:medium')!

function reply(output: Hex, success = true, extra: Partial<ForkReplayResult['proof']> = {}): ForkReplayResult {
  return {
    hydrationRequests: 0, hydratedAccounts: 0, hydratedStorageSlots: 0,
    proof: {
      engine: 'revm/36.0.0', success, gasUsed: 100, output,
      steps: [], storageOperations: [], storageDiffs: [], balanceChanges: [],
      calls: [], logs: [], logCount: 0, selfdestructs: [], truncated: false,
      ...extra,
    },
  }
}

/** A swap trace that really entered the PoolManager and emitted its event. */
function swapProof(success: boolean, tokenSelector: Hex) {
  return {
    success,
    calls: [
      { caller: PAYER, target: HARNESS, bytecodeAddress: HARNESS, scheme: 'Call', value: '0', inputLength: 100, selector: '0x543b46f9' as Hex },
      { caller: HARNESS, target: MANAGER, bytecodeAddress: MANAGER, scheme: 'Call', value: '0', inputLength: 100, selector: '0x48c89491' as Hex },
      { caller: HARNESS, target: TOKEN, bytecodeAddress: TOKEN, scheme: 'Call', value: '0', inputLength: 100, selector: tokenSelector },
    ],
    logs: [{ address: MANAGER, topics: [POOL_EVENT_TOPICS.swap, POOL_ID] as Hex[], data: '0x' as Hex }],
    logCount: 1,
  }
}

/**
 * Models the token and the harness together: allowance is real state, and pool
 * balances move by whatever the configured delivery ratio produces.
 */
function laneSession(options: {
  balance?: bigint
  delivered?: bigint
  requested?: bigint
  swapReverts?: boolean
  approveReverts?: boolean
  tokenSelector?: Hex
} = {}) {
  const balance = options.balance ?? 10n ** 21n
  const requested = options.requested ?? 1_000n
  const delivered = options.delivered ?? requested
  let allowance = 0n
  let swapped = false
  const tokenReadCallers: Address[] = []
  const balances: Record<string, bigint> = {
    [PAYER.toLowerCase()]: balance,
    [MANAGER.toLowerCase()]: 0n,
    [HARNESS.toLowerCase()]: 0n,
  }
  const execute = vi.fn(async (input: { transaction: { caller: Address; to: Address; calldata: Hex } }) => {
    const selector = input.transaction.calldata.slice(0, 10) as Hex
    if (input.transaction.to.toLowerCase() === TOKEN.toLowerCase()) {
      if (selector === ERC20_SELECTORS.balanceOf) {
        tokenReadCallers.push(input.transaction.caller)
        const owner = getAddress(`0x${input.transaction.calldata.slice(34, 74)}`)
        return reply(toHex(balances[owner.toLowerCase()] ?? 0n, { size: 32 }))
      }
      if (selector === ERC20_SELECTORS.allowance) return reply(toHex(allowance, { size: 32 }))
      if (selector === ERC20_SELECTORS.approve) {
        if (options.approveReverts) return reply('0x', false)
        allowance = BigInt(`0x${input.transaction.calldata.slice(74)}`)
        return reply(toHex(1n, { size: 32 }))
      }
    }
    // The scenario itself.
    if (!options.swapReverts) {
      swapped = true
      balances[PAYER.toLowerCase()] = (balances[PAYER.toLowerCase()] ?? 0n) - requested
      balances[MANAGER.toLowerCase()] = (balances[MANAGER.toLowerCase()] ?? 0n) + delivered
    }
    return reply('0x', !options.swapReverts, swapProof(!options.swapReverts, options.tokenSelector ?? ERC20_SELECTORS.transferFrom))
  })
  return { execute, session: { execute } as never, tokenReadCallers, get swapped() { return swapped } }
}

const base = {
  scenario,
  calldata: '0xdeadbeef' as Hex,
  harness: HARNESS,
  token: TOKEN,
  payer: PAYER,
  recipient: PAYER,
  poolManager: MANAGER,
  poolId: POOL_ID,
  hook: HOOK,
  block,
  chainId: 1,
  signal: new AbortController().signal,
  provisioning: 'receipt-derived' as const,
  requestedAmount: -1_000n,
}

describe('ERC-20 settlement lane', () => {
  it('prepares, executes, and reports an exact settlement beside the claims baseline', async () => {
    const harness = laneSession()
    const outcome = await runErc20Lane({ ...base, session: harness.session, claimsOutcome: 'completed' })

    expect(outcome.status).toBe('completed')
    expect(outcome.preparation.status).toBe('prepared')
    expect(outcome.classifications).toEqual(['settled-exactly'])
    expect(outcome.comparison.reading).toBe('both-lanes-agree')
    expect(outcome.observations!.poolManagerMoved).toBe(1_000n)
    // Reading the harness and PoolManager balances must not originate calls
    // from those contracts; EIP-3607 rejects deployed-code transaction senders.
    expect(new Set(harness.tokenReadCallers)).toEqual(new Set([PAYER]))
  })

  it('reports a fee-taking token as a shortfall, not as hook behavior', async () => {
    const harness = laneSession({ delivered: 990n })
    const outcome = await runErc20Lane({ ...base, session: harness.session, claimsOutcome: 'completed' })

    expect(outcome.status).toBe('completed')
    expect(outcome.observations!.shortfall).toBe(10n)
    expect(outcome.classifications).toEqual(['pool-received-less-than-requested'])

    const evidence = erc20LaneEvidence({ outcome, poolId: POOL_ID, hook: HOOK, token: TOKEN, stateBlockNumber: 100n })
    expect(evidence.title).toContain('shortfall')
    expect(evidence.claim).toContain('10 less was delivered')
    expect(evidence.technical!.settlement).toBe('erc20-transfers')
    expect(evidence.technical).not.toHaveProperty('historicalTransaction')
  })

  it('localizes a token-only revert to the settlement path', async () => {
    const harness = laneSession({ swapReverts: true })
    const outcome = await runErc20Lane({ ...base, session: harness.session, claimsOutcome: 'completed' })

    expect(outcome.status).toBe('behavior-reverted')
    expect(outcome.comparison.reading).toBe('token-settlement-specific')
    expect(outcome.classifications).toContain('input-transfer-reverted')
  })

  it('points at the pool when both lanes revert', async () => {
    const harness = laneSession({ swapReverts: true })
    const outcome = await runErc20Lane({ ...base, session: harness.session, claimsOutcome: 'reverted' })
    expect(outcome.comparison.reading).toBe('pool-or-hook-behavior')
  })

  it('stops at preparation when the payer holds nothing, and claims nothing', async () => {
    const harness = laneSession({ balance: 0n })
    const outcome = await runErc20Lane({ ...base, session: harness.session, claimsOutcome: 'completed' })

    expect(outcome.status).toBe('preparation-unavailable')
    expect(outcome.comparison.reading).toBe('token-lane-not-comparable')
    expect(outcome.observations).toBeUndefined()
    // The scenario never ran, so nothing about the token's swap path is claimed.
    expect(harness.swapped).toBe(false)

    const evidence = erc20LaneEvidence({ outcome, poolId: POOL_ID, hook: HOOK, token: TOKEN, stateBlockNumber: 100n })
    expect(evidence.title).toContain('unavailable')
    expect(evidence.severity).toBe('info')
    expect(evidence.claim).toContain('could not be prepared')
    expect(evidence.claim).toContain('No settlement transaction was executed')
    expect(evidence.claim).not.toContain('Settlement ran against')
  })

  it('reports an approval refusal without claiming settlement executed', async () => {
    const harness = laneSession({ approveReverts: true })
    const outcome = await runErc20Lane({ ...base, session: harness.session, claimsOutcome: 'completed' })
    const evidence = erc20LaneEvidence({ outcome, poolId: POOL_ID, hook: HOOK, token: TOKEN, stateBlockNumber: 100n })

    expect(outcome.status).toBe('behavior-reverted')
    expect(harness.swapped).toBe(false)
    expect(evidence.title).toContain('approval')
    expect(evidence.claim).toContain('settlement was not executed')
    expect(evidence.claim).not.toContain('Settlement ran against')
  })

  it('does not blame the token for a revert that never reached the pool', async () => {
    // The harness reverted before calling unlock — a setup fault, not token
    // behavior. Previously this only applied to successful runs, so a revert
    // like this was reported as a token-path observation.
    const harness = {
      execute: vi.fn(async (input: { transaction: { to: Address; calldata: Hex } }) => {
        const selector = input.transaction.calldata.slice(0, 10) as Hex
        if (input.transaction.to.toLowerCase() === TOKEN.toLowerCase()) {
          if (selector === ERC20_SELECTORS.balanceOf) return reply(toHex(10n ** 21n, { size: 32 }))
          if (selector === ERC20_SELECTORS.allowance) return reply(toHex(10n ** 19n, { size: 32 }))
          if (selector === ERC20_SELECTORS.approve) return reply(toHex(1n, { size: 32 }))
        }
        // Reverts with only the outer call recorded: unlock was never reached.
        return reply('0x', false, {
          calls: [{ caller: PAYER, target: HARNESS, bytecodeAddress: HARNESS, scheme: 'Call', value: '0', inputLength: 100, selector: '0x89aca655' as Hex }],
          logs: [], logCount: 0,
        })
      }),
    }
    const outcome = await runErc20Lane({ ...base, session: harness as never, claimsOutcome: 'completed' })

    expect(outcome.status).toBe('execution-failed')
    expect(outcome.status).not.toBe('behavior-reverted')
    expect(outcome.reason).toContain('unlock')
    expect(outcome.comparison.reading).toBe('token-lane-not-comparable')
  })

  it('separates a worker failure from a token revert', async () => {
    const failing = { execute: vi.fn(async (input: { transaction: { to: Address; calldata: Hex } }) => {
      const selector = input.transaction.calldata.slice(0, 10) as Hex
      if (input.transaction.to.toLowerCase() === TOKEN.toLowerCase()) {
        if (selector === ERC20_SELECTORS.balanceOf) return reply(toHex(10n ** 21n, { size: 32 }))
        if (selector === ERC20_SELECTORS.allowance) return reply(toHex(10n ** 19n, { size: 32 }))
        if (selector === ERC20_SELECTORS.approve) return reply(toHex(1n, { size: 32 }))
      }
      throw new Error('worker died')
    }) }
    const outcome = await runErc20Lane({ ...base, session: failing as never, claimsOutcome: 'completed' })

    expect(outcome.status).toBe('execution-failed')
    expect(outcome.reason).toBe('worker died')
    expect(outcome.comparison.reading).toBe('token-lane-not-comparable')
  })

  it('refuses to treat a run that missed the PoolManager as a token observation', async () => {
    const harness = {
      execute: vi.fn(async (input: { transaction: { to: Address; calldata: Hex } }) => {
        const selector = input.transaction.calldata.slice(0, 10) as Hex
        if (input.transaction.to.toLowerCase() === TOKEN.toLowerCase()) {
          if (selector === ERC20_SELECTORS.balanceOf) return reply(toHex(10n ** 21n, { size: 32 }))
          if (selector === ERC20_SELECTORS.allowance) return reply(toHex(10n ** 19n, { size: 32 }))
          if (selector === ERC20_SELECTORS.approve) return reply(toHex(1n, { size: 32 }))
        }
        // Succeeds without ever calling unlock.
        return reply('0x', true, { calls: [], logs: [], logCount: 0 })
      }),
    }
    const outcome = await runErc20Lane({ ...base, session: harness as never, claimsOutcome: 'completed' })
    expect(outcome.status).toBe('execution-failed')
    expect(outcome.reason).toContain('unlock')
  })
})
