import { describe, expect, it, vi } from 'vitest'
import { getAddress, toHex, type Address, type Hex } from 'viem'
import { runErc20RoundTrip, roundTripEvidence } from './erc20RoundTrip'
import { ERC20_SELECTORS } from './erc20Provisioning'
import { POOL_EVENT_TOPICS } from './protocolScenarioValidation'
import type { ForkReplayBlock, ForkReplayResult } from './revmProof'

const TOKEN_IN = getAddress('0x1111111111111111111111111111111111111111')
const TOKEN_OUT = getAddress('0x2222222222222222222222222222222222222222')
const NATIVE = getAddress('0x0000000000000000000000000000000000000000')
const PAYER = getAddress('0xbbd64a6de020a1e2caf3eabe3781b8958d03c728')
const HARNESS = getAddress('0x0000000000000000000000000000000000005ce6')
const MANAGER = getAddress('0x000000000004444c5dc75cb358380d2e3de08a90')
const HOOK = getAddress('0x239732813d5f9b531abc736b1c9478f7088e0040')
const POOL_ID = `0x${'ab'.repeat(32)}` as Hex

const poolKey = { currency0: TOKEN_IN, currency1: TOKEN_OUT, fee: 3000, tickSpacing: 60, hooks: HOOK }
const block: ForkReplayBlock = {
  number: 100n, beneficiary: MANAGER, timestamp: 1n, gasLimit: 30_000_000n,
  baseFee: 0n, difficulty: 0n, prevrandao: `0x${'0'.repeat(64)}` as Hex,
}

function reply(output: Hex, success = true, extra: Record<string, unknown> = {}): ForkReplayResult {
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

function swapProof(success: boolean) {
  return {
    calls: [
      { caller: PAYER, target: HARNESS, bytecodeAddress: HARNESS, scheme: 'Call', value: '0', inputLength: 100, selector: '0x89aca655' as Hex },
      { caller: HARNESS, target: MANAGER, bytecodeAddress: MANAGER, scheme: 'Call', value: '0', inputLength: 100, selector: '0x48c89491' as Hex },
      { caller: HARNESS, target: TOKEN_IN, bytecodeAddress: TOKEN_IN, scheme: 'Call', value: '0', inputLength: 100, selector: ERC20_SELECTORS.transferFrom },
    ],
    logs: [{ address: MANAGER, topics: [POOL_EVENT_TOPICS.swap, POOL_ID] as Hex[], data: '0x' as Hex }],
    logCount: 1,
    success,
  }
}

/**
 * Models a pool that pays out on the forward leg and can be configured to
 * refuse the reverse one, with real balances the trip must measure.
 */
function tripSession(options: { sellReverts?: boolean; feeBps?: bigint } = {}) {
  const balances: Record<string, bigint> = {
    [`${TOKEN_IN}:${PAYER}`.toLowerCase()]: 10n ** 21n,
    [`${TOKEN_OUT}:${PAYER}`.toLowerCase()]: 0n,
  }
  let allowance = 0n
  let swaps = 0
  const approvals: bigint[] = []
  const execute = vi.fn(async (input: { transaction: { to: Address; calldata: Hex } }) => {
    const selector = input.transaction.calldata.slice(0, 10) as Hex
    const to = input.transaction.to.toLowerCase()
    if (to === TOKEN_IN.toLowerCase() || to === TOKEN_OUT.toLowerCase()) {
      const token = to === TOKEN_IN.toLowerCase() ? TOKEN_IN : TOKEN_OUT
      if (selector === ERC20_SELECTORS.balanceOf) {
        const owner = getAddress(`0x${input.transaction.calldata.slice(34, 74)}`)
        return reply(toHex(balances[`${token}:${owner}`.toLowerCase()] ?? 0n, { size: 32 }))
      }
      if (selector === ERC20_SELECTORS.allowance) return reply(toHex(allowance, { size: 32 }))
      if (selector === ERC20_SELECTORS.approve) {
        allowance = BigInt(`0x${input.transaction.calldata.slice(74)}`)
        approvals.push(allowance)
        return reply(toHex(1n, { size: 32 }))
      }
    }
    swaps++
    if (swaps === 1) {
      // Forward leg: spend input, receive output minus any fee.
      const spent = 10n ** 19n
      const quoted = spent / 2n
      const delivered = quoted - (quoted * (options.feeBps ?? 0n)) / 10_000n
      balances[`${TOKEN_IN}:${PAYER}`.toLowerCase()] = (balances[`${TOKEN_IN}:${PAYER}`.toLowerCase()] ?? 0n) - spent
      balances[`${TOKEN_OUT}:${PAYER}`.toLowerCase()] = (balances[`${TOKEN_OUT}:${PAYER}`.toLowerCase()] ?? 0n) + delivered
      return reply('0x', true, swapProof(true))
    }
    if (options.sellReverts) return reply('0x', false, swapProof(false))
    balances[`${TOKEN_IN}:${PAYER}`.toLowerCase()] = (balances[`${TOKEN_IN}:${PAYER}`.toLowerCase()] ?? 0n) + 10n ** 18n
    return reply('0x', true, swapProof(true))
  })

  const readBalance = async (token: Address, owner: Address) =>
    balances[`${token}:${owner}`.toLowerCase()] ?? 0n

  return { session: { execute } as never, readBalance, approvals, get swaps() { return swaps } }
}

/** Models token -> native -> token and records the value on the reverse call. */
function nativeTripSession() {
  const balances: Record<string, bigint> = {
    [`${TOKEN_IN}:${PAYER}`.toLowerCase()]: 10n ** 21n,
  }
  let allowance = 0n
  let swaps = 0
  const transactionValues: bigint[] = []
  const nativeReceived = 4_321_000_000_000_000n
  const payerTokenBalanceKey = `${TOKEN_IN}:${PAYER}`.toLowerCase()
  const execute = vi.fn(async (input: {
    transaction: { caller: Address; to: Address; calldata: Hex; value: bigint }
  }) => {
    const selector = input.transaction.calldata.slice(0, 10) as Hex
    if (input.transaction.to.toLowerCase() === TOKEN_IN.toLowerCase()) {
      if (selector === ERC20_SELECTORS.balanceOf) {
        const owner = getAddress(`0x${input.transaction.calldata.slice(34, 74)}`)
        return reply(toHex(balances[`${TOKEN_IN}:${owner}`.toLowerCase()] ?? 0n, { size: 32 }))
      }
      if (selector === ERC20_SELECTORS.allowance) return reply(toHex(allowance, { size: 32 }))
      if (selector === ERC20_SELECTORS.approve) {
        allowance = BigInt(`0x${input.transaction.calldata.slice(74)}`)
        return reply(toHex(1n, { size: 32 }))
      }
    }

    swaps++
    transactionValues.push(input.transaction.value)
    if (swaps === 1) {
      balances[payerTokenBalanceKey] = (balances[payerTokenBalanceKey] ?? 0n) - 10n ** 19n
      return reply('0x', true, {
        ...swapProof(true),
        balanceChanges: [{ address: PAYER, before: '1000000000000000000', after: (1_000_000_000_000_000_000n + nativeReceived).toString() }],
      })
    }

    balances[payerTokenBalanceKey] = (balances[payerTokenBalanceKey] ?? 0n) + 2n * 10n ** 18n
    return reply('0x', true, {
      ...swapProof(true),
      calls: [
        { caller: PAYER, target: HARNESS, bytecodeAddress: HARNESS, scheme: 'Call', value: nativeReceived.toString(), inputLength: 100, selector: '0x89aca655' },
        { caller: HARNESS, target: MANAGER, bytecodeAddress: MANAGER, scheme: 'Call', value: nativeReceived.toString(), inputLength: 100, selector: '0x48c89491' },
        { caller: MANAGER, target: TOKEN_IN, bytecodeAddress: TOKEN_IN, scheme: 'Call', value: '0', inputLength: 100, selector: ERC20_SELECTORS.transfer },
      ],
    })
  })

  return {
    session: { execute } as never,
    readBalance: async (token: Address, owner: Address) => balances[`${token}:${owner}`.toLowerCase()] ?? 0n,
    transactionValues,
    nativeReceived,
  }
}

const base = {
  poolKey, poolId: POOL_ID, hook: HOOK, poolManager: MANAGER, harness: HARNESS,
  payer: PAYER, inputToken: TOKEN_IN, block, chainId: 1,
  signal: new AbortController().signal,
  provisioning: 'receipt-derived' as const,
  claimsOutcome: 'completed' as const,
}

describe('ERC-20 round trip', () => {
  it('carries the measured output forward into the reverse leg', async () => {
    const harness = tripSession()
    const result = await runErc20RoundTrip({ ...base, ...harness })

    expect(result.status).toBe('completed')
    expect(result.forwardZeroForOne).toBe(true)
    expect(result.outputToken).toBe(TOKEN_OUT)
    expect(result.forwardReceived).toBeGreaterThan(0n)
    // The reverse leg approves exactly what arrived, not what was quoted.
    expect(result.reverseApproved).toBe(result.forwardReceived)
    expect(harness.approvals.at(-1)).toBe(result.forwardReceived)
    expect(result.reverseReceived).toBeGreaterThan(0n)
    expect(harness.swaps).toBe(2)
  })

  it('approves the measured amount when a fee shrinks the delivery', async () => {
    // Quoted 5e18, 1% fee, so 4.95e18 actually arrives. Approving the quote
    // would authorize more than the actor holds.
    const harness = tripSession({ feeBps: 100n })
    const result = await runErc20RoundTrip({ ...base, ...harness })

    expect(result.forwardReceived).toBe(4_950_000_000_000_000_000n)
    expect(result.reverseApproved).toBe(result.forwardReceived)
  })

  it('reports an asymmetric token as bought-but-not-sellable', async () => {
    const harness = tripSession({ sellReverts: true })
    const result = await runErc20RoundTrip({ ...base, ...harness })

    expect(result.status).toBe('reverse-leg-failed')
    expect(result.forward!.status).toBe('completed')
    expect(result.forwardReceived).toBeGreaterThan(0n)

    const evidence = roundTripEvidence({ result, poolId: POOL_ID, hook: HOOK, stateBlockNumber: 100n })
    expect(evidence.severity).toBe('medium')
    expect(evidence.title).toContain('could not sell back')
    expect(evidence.claim).toContain('not the token in general')
    expect(evidence.technical!.settlement).toBe('erc20-transfers')
  })

  it('runs the forward leg in the direction the replay used', async () => {
    // Input leg is currency1 here, so the trip must start 1-for-0.
    const harness = tripSession()
    const result = await runErc20RoundTrip({ ...base, ...harness, inputToken: TOKEN_OUT })
    expect(result.forwardZeroForOne).toBe(false)
    expect(result.outputToken).toBe(TOKEN_IN)
  })

  it('does not attempt a reverse leg when the payer cannot fund the forward one', async () => {
    const harness = tripSession()
    const empty = { ...harness, readBalance: async () => 0n }
    const result = await runErc20RoundTrip({ ...base, ...empty })

    expect(result.status).toBe('preparation-unavailable')
    expect(result.reason).toContain('too little to fund')
    expect(harness.swaps).toBe(0)
  })

  it('carries exact native output as reverse call value without approving address zero', async () => {
    const harness = nativeTripSession()
    const result = await runErc20RoundTrip({
      ...base,
      ...harness,
      poolKey: { ...poolKey, currency0: NATIVE, currency1: TOKEN_IN },
      inputToken: TOKEN_IN,
    })

    expect(result.status).toBe('completed')
    expect(result.outputToken).toBe(NATIVE)
    expect(result.forwardReceived).toBe(harness.nativeReceived)
    expect(result.reverseFunding).toBe('native-value')
    expect(result.reverseApproved).toBe(0n)
    expect(harness.transactionValues).toEqual([0n, harness.nativeReceived])
    expect(result.reverse!.tokenRole).toBe('output')
    expect(result.reverse!.nativeValue).toBe(harness.nativeReceived)

    const evidence = roundTripEvidence({ result, poolId: POOL_ID, hook: HOOK, stateBlockNumber: 100n })
    expect(evidence.technical!.settlement).toBe('erc20-transfers-with-native-value')
    expect(evidence.claim).toContain('supplied that exact native amount as call value')
  })
})
