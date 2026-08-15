import { describe, expect, it } from 'vitest'
import { getAddress, type Address, type Hex } from 'viem'
import { encodeErrorResult, parseAbi } from 'viem'
import {
  classifyTokenObservations,
  compareLanes,
  decodeUnsettledDelta,
  summarizeTokenObservations,
} from './erc20Observations'
import { ERC20_SELECTORS, ERC20_TOPICS } from './erc20Provisioning'
import type { RevmExecutionProof } from './revmProof'

const TOKEN = getAddress('0x3c4952ccf02d4dbb4c48077bbfe8296b3dfdb4bc')
const ACTOR = getAddress('0xbbd64a6de020a1e2caf3eabe3781b8958d03c728')
const HARNESS = getAddress('0x0000000000000000000000000000000000005ce4')
const MANAGER = getAddress('0x000000000004444c5dc75cb358380d2e3de08a90')

function call(target: Address, selector: Hex) {
  return { caller: HARNESS, target, bytecodeAddress: target, scheme: 'Call', value: '0', inputLength: 68, selector }
}

function transferLog(from: Address, to: Address, value: bigint) {
  const pad = (address: Address) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}` as Hex
  return { address: TOKEN, topics: [ERC20_TOPICS.transfer, pad(from), pad(to)] as Hex[], data: `0x${value.toString(16).padStart(64, '0')}` as Hex }
}

function proof(options: { success?: boolean; calls?: ReturnType<typeof call>[]; logs?: ReturnType<typeof transferLog>[]; output?: Hex } = {}): RevmExecutionProof {
  return {
    engine: 'revm/36.0.0', success: options.success ?? true, gasUsed: 100, output: options.output ?? '0x',
    steps: [], storageOperations: [], storageDiffs: [], balanceChanges: [], selfdestructs: [], truncated: false,
    calls: options.calls ?? [], logs: options.logs ?? [], logCount: (options.logs ?? []).length,
  }
}

const addresses = { token: TOKEN, actor: ACTOR, recipient: ACTOR, harness: HARNESS, poolManager: MANAGER }

function balances(actor: bigint, manager: bigint) {
  return { [ACTOR.toLowerCase()]: actor, [MANAGER.toLowerCase()]: manager, [HARNESS.toLowerCase()]: 0n }
}

describe('token observations', () => {
  it('recovers the shortfall from the revert, since a revert rolls balances back', () => {
    // This is what the real harness does: a fee makes settlement come up short,
    // it reverts naming the exact amount still owed, and every balance change is
    // rolled back. Reading balances afterwards therefore shows no movement at
    // all, so the revert payload is the only place the number survives.
    const revert = encodeErrorResult({
      abi: parseAbi(['error UnsettledDelta(address currency, int256 delta)']),
      errorName: 'UnsettledDelta',
      args: [TOKEN, -10n],
    })
    const observations = summarizeTokenObservations({
      ...addresses,
      proof: proof({ success: false, calls: [call(TOKEN, ERC20_SELECTORS.transferFrom)], output: revert }),
      // Unchanged either side: the revert undid everything.
      balancesBefore: balances(10_000n, 0n),
      balancesAfter: balances(10_000n, 0n),
      allowanceBefore: 5_000n, allowanceAfter: 5_000n,
      requestedAmount: -1_000n,
    })

    expect(observations.shortfall).toBe(10n)
    expect(observations.shortfallSource).toBe('unsettled-delta-revert')
    expect(observations.unsettledDelta).toEqual({ currency: TOKEN, delta: -10n })
    // A fee is a delivery shortfall, not the token refusing the transfer.
    expect(classifyTokenObservations(observations)).toEqual(['settlement-short-by-fee'])
  })

  it('decodes only its own settlement error', () => {
    expect(decodeUnsettledDelta('0xdeadbeef')).toBeUndefined()
    expect(decodeUnsettledDelta(undefined)).toBeUndefined()
    expect(decodeUnsettledDelta('0x')).toBeUndefined()
  })

  it('still measures a shortfall from balances when settlement succeeded', () => {
    const observations = summarizeTokenObservations({
      ...addresses,
      proof: proof({ calls: [call(TOKEN, ERC20_SELECTORS.transferFrom)], logs: [transferLog(ACTOR, MANAGER, 1_000n)] }),
      balancesBefore: balances(10_000n, 0n),
      balancesAfter: balances(9_000n, 990n),
      allowanceBefore: 5_000n, allowanceAfter: 4_000n,
      requestedAmount: -1_000n,
    })
    expect(observations.shortfall).toBe(10n)
    expect(observations.shortfallSource).toBe('balance-movement')
    expect(classifyTokenObservations(observations)).toEqual(['pool-received-less-than-requested'])
  })

  it('reports an exact settlement plainly', () => {
    const observations = summarizeTokenObservations({
      ...addresses,
      proof: proof({ calls: [call(TOKEN, ERC20_SELECTORS.transferFrom)] }),
      balancesBefore: balances(10_000n, 0n),
      balancesAfter: balances(9_000n, 1_000n),
      allowanceBefore: 5_000n, allowanceAfter: 4_000n,
      requestedAmount: -1_000n,
    })
    expect(observations.shortfall).toBe(0n)
    expect(classifyTokenObservations(observations)).toEqual(['settled-exactly'])
  })

  it('records zero output as the full shortfall for an exact token request', () => {
    const observations = summarizeTokenObservations({
      ...addresses,
      tokenRole: 'output',
      proof: proof({ calls: [call(TOKEN, ERC20_SELECTORS.transfer)] }),
      balancesBefore: balances(0n, 10_000n),
      balancesAfter: balances(0n, 10_000n),
      allowanceBefore: 0n,
      allowanceAfter: 0n,
      requestedAmount: 1_000n,
    })

    expect(observations.recipientReceived).toBe(0n)
    expect(observations.shortfall).toBe(1_000n)
    expect(classifyTokenObservations(observations)).toEqual(['recipient-received-less-than-sent'])
  })

  it('names an input transfer revert distinctly from an output one', () => {
    const input = summarizeTokenObservations({
      ...addresses,
      proof: proof({ success: false, calls: [call(TOKEN, ERC20_SELECTORS.transferFrom)], output: '0xdeadbeef' }),
      balancesBefore: balances(10_000n, 0n), balancesAfter: balances(10_000n, 0n),
      allowanceBefore: 5_000n, allowanceAfter: 5_000n, requestedAmount: -1_000n,
    })
    expect(classifyTokenObservations(input)).toContain('input-transfer-reverted')
    expect(input.revertData).toBe('0xdeadbeef')

    const output = summarizeTokenObservations({
      ...addresses,
      proof: proof({ success: false, calls: [call(TOKEN, ERC20_SELECTORS.transfer)] }),
      balancesBefore: balances(10_000n, 0n), balancesAfter: balances(10_000n, 0n),
      allowanceBefore: 5_000n, allowanceAfter: 5_000n, requestedAmount: -1_000n,
    })
    expect(classifyTokenObservations(output)).toContain('output-transfer-reverted')
  })

  it('flags an insufficient approval alongside the revert', () => {
    const observations = summarizeTokenObservations({
      ...addresses,
      proof: proof({ success: false, calls: [call(TOKEN, ERC20_SELECTORS.transferFrom)] }),
      balancesBefore: balances(10_000n, 0n), balancesAfter: balances(10_000n, 0n),
      allowanceBefore: 0n, allowanceAfter: 0n, requestedAmount: -1_000n,
    })
    expect(classifyTokenObservations(observations)).toEqual(['input-transfer-reverted', 'approval-insufficient'])
  })
})

describe('lane comparison', () => {
  it('localizes to the token when claims pass and ERC-20 does not', () => {
    const result = compareLanes({
      claims: 'completed', token: 'behavior-reverted', classifications: ['input-transfer-reverted'],
    })
    expect(result.reading).toBe('token-settlement-specific')
    expect(result.detail).toContain('pool and hook accepted the operation')
    expect(result.detail).toContain('input-transfer-reverted')
  })

  it('points at the pool or hook when both lanes refuse', () => {
    const result = compareLanes({ claims: 'reverted', token: 'behavior-reverted' })
    expect(result.reading).toBe('pool-or-hook-behavior')
    expect(result.detail).toContain('never calls the token')
  })

  it('refuses to compare when the actor could not be prepared', () => {
    const result = compareLanes({ claims: 'completed', token: 'preparation-unavailable' })
    expect(result.reading).toBe('token-lane-not-comparable')
    expect(result.detail).toContain('could not be prepared')
    // Crucially, no claim about the token is made.
    expect(result.detail).not.toContain('revert')
  })

  it('refuses to compare when the lane crashed rather than reverted', () => {
    const result = compareLanes({ claims: 'completed', token: 'execution-failed' })
    expect(result.reading).toBe('token-lane-not-comparable')
    expect(result.detail).toContain('did not execute')
  })

  it('reports plain agreement when both complete', () => {
    const result = compareLanes({ claims: 'completed', token: 'completed', classifications: ['settled-exactly'] })
    expect(result.reading).toBe('both-lanes-agree')
  })

  it('notes a funding difference when only the claims lane reverts', () => {
    const result = compareLanes({ claims: 'reverted', token: 'completed' })
    expect(result.reading).toBe('pool-or-hook-behavior')
    expect(result.detail).toContain('how settlement was funded')
  })
})
