import { describe, expect, it, vi } from 'vitest'
import { encodeFunctionData, parseAbi, toHex, type Address, type Hex } from 'viem'
import { prepareErc20Actor, preparationSummary } from './erc20ActorPreparation'
import { ERC20_SELECTORS } from './erc20Provisioning'
import type { ForkReplayBlock, ForkReplayResult } from './revmProof'

const ACTOR = '0xbbd64a6De020a1e2CaF3eABe3781B8958D03C728' as Address
const TOKEN = '0x3c4952CCF02d4dbB4C48077BBfe8296b3dfdb4bC' as Address
const SPENDER = '0x0000000000000000000000000000000000005ce4' as Address
const ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
])

const block: ForkReplayBlock = {
  number: 100n, beneficiary: TOKEN, timestamp: 1n, gasLimit: 30_000_000n,
  baseFee: 0n, difficulty: 0n, prevrandao: `0x${'0'.repeat(64)}` as Hex,
}

function reply(output: Hex, success = true): ForkReplayResult {
  return {
    hydrationRequests: 0, hydratedAccounts: 0, hydratedStorageSlots: 0,
    proof: {
      engine: 'revm/36.0.0', success, gasUsed: 100, output,
      steps: [], storageOperations: [], storageDiffs: [], balanceChanges: [],
      calls: [], logs: [], logCount: 0, selfdestructs: [], truncated: false,
    },
  }
}

/**
 * A token modelled as real calls: it holds an allowance, answers reads, and can
 * be configured to misbehave in the ways real tokens do.
 */
function tokenSession(options: {
  balance?: bigint
  approveReverts?: boolean
  approveReturnsFalse?: boolean
  recordAllowance?: boolean
  balanceUnreadable?: boolean
} = {}) {
  const balance = options.balance ?? 10n ** 21n
  let allowance = 0n
  const committed: boolean[] = []
  const calls: Hex[] = []
  const execute = vi.fn(async (input: { transaction: { calldata: Hex }; commit?: boolean }) => {
    const selector = input.transaction.calldata.slice(0, 10) as Hex
    calls.push(selector)
    if (selector === ERC20_SELECTORS.balanceOf) {
      return options.balanceUnreadable ? reply('0x', false) : reply(toHex(balance, { size: 32 }))
    }
    if (selector === ERC20_SELECTORS.allowance) return reply(toHex(allowance, { size: 32 }))
    if (selector === ERC20_SELECTORS.approve) {
      committed.push(Boolean(input.commit))
      if (options.approveReverts) return reply('0x', false)
      if (options.recordAllowance !== false) {
        allowance = BigInt(`0x${input.transaction.calldata.slice(74)}`)
      }
      return reply(toHex(options.approveReturnsFalse ? 0n : 1n, { size: 32 }))
    }
    throw new Error(`unexpected selector ${selector}`)
  })
  return { execute, calls, committed, session: { execute } as never }
}

const base = {
  actor: ACTOR, token: TOKEN, spender: SPENDER, block, chainId: 1,
  signal: new AbortController().signal, source: 'receipt-derived' as const,
}

describe('ERC-20 actor preparation', () => {
  it('reads the balance, approves through the token, and confirms the allowance', async () => {
    const harness = tokenSession()
    const result = await prepareErc20Actor({ ...base, session: harness.session })

    expect(result.status).toBe('prepared')
    expect(result.balance).toBe(10n ** 21n)
    // Bounded to a small share of the real balance, never the whole thing.
    expect(result.spendCeiling).toBe(10n ** 21n / 100n)
    expect(result.allowanceBefore).toBe(0n)
    expect(result.allowanceAfter).toBe(result.spendCeiling)
    expect(result.approveReturnedTrue).toBe(true)

    // Real calls in order: balanceOf, allowance, approve, allowance.
    expect(harness.calls).toEqual([
      ERC20_SELECTORS.balanceOf, ERC20_SELECTORS.allowance,
      ERC20_SELECTORS.approve, ERC20_SELECTORS.allowance,
    ])
  })

  it('commits the approval so the scenario that follows can see it', async () => {
    const harness = tokenSession()
    await prepareErc20Actor({ ...base, session: harness.session })
    expect(harness.committed).toEqual([true])
    // Reads must not commit, or they would leak into later scenarios.
    const readCommits = harness.execute.mock.calls
      .filter((call) => call[0].transaction.calldata.slice(0, 10) !== ERC20_SELECTORS.approve)
      .map((call) => call[0].commit)
    expect(readCommits.every((commit) => commit === false)).toBe(true)
  })

  it('reports an actor with no balance as unavailable, not as a finding', async () => {
    const harness = tokenSession({ balance: 0n })
    const result = await prepareErc20Actor({ ...base, session: harness.session })
    expect(result.status).toBe('preparation-unavailable')
    expect(result.reason).toContain('too little to fund')
    // It never reached approve: nothing about the token's behavior is claimed.
    expect(harness.calls).not.toContain(ERC20_SELECTORS.approve)
  })

  it('reports an unreadable token as unavailable', async () => {
    const harness = tokenSession({ balanceUnreadable: true })
    const result = await prepareErc20Actor({ ...base, session: harness.session })
    expect(result.status).toBe('preparation-unavailable')
    expect(result.reason).toContain('balanceOf')
  })

  it('records a reverting approve as a token observation', async () => {
    const harness = tokenSession({ approveReverts: true })
    const result = await prepareErc20Actor({ ...base, session: harness.session })
    expect(result.status).toBe('approval-refused')
    expect(result.reason).toContain('reverted')
  })

  it('catches a token that reports success but records nothing', async () => {
    // The dangerous case: approve returns true, allowance stays zero.
    const harness = tokenSession({ recordAllowance: false })
    const result = await prepareErc20Actor({ ...base, session: harness.session })
    expect(result.status).toBe('approval-refused')
    expect(result.approveReturnedTrue).toBe(true)
    expect(result.allowanceAfter).toBe(0n)
    expect(result.reason).toContain('below the requested')
  })

  it('catches a token that silently returns false', async () => {
    const harness = tokenSession({ approveReturnsFalse: true, recordAllowance: false })
    const result = await prepareErc20Actor({ ...base, session: harness.session })
    expect(result.status).toBe('approval-refused')
    expect(result.approveReturnedTrue).toBe(false)
    expect(result.reason).toContain('returning false')
  })

  it('honours an explicit requested amount', async () => {
    const harness = tokenSession()
    const result = await prepareErc20Actor({ ...base, session: harness.session, amount: 12_345n })
    expect(result.status).toBe('prepared')
    expect(result.allowanceAfter).toBe(12_345n)
  })

  it('summarizes preparation for the report', async () => {
    const harness = tokenSession()
    const result = await prepareErc20Actor({ ...base, session: harness.session })
    const summary = preparationSummary(result)
    expect(summary).toMatchObject({
      provisioning: 'receipt-derived',
      status: 'prepared',
      actor: ACTOR,
      approveReturnedTrue: true,
      approvalSelector: ERC20_SELECTORS.approve,
    })
    // Amounts are strings so a report can carry them without bigint loss.
    expect(typeof summary.balanceAtPinnedBlock).toBe('string')
  })

  it('uses the token ABI encoders rather than hand-built calldata', () => {
    // Guards the shape the session double asserts on.
    expect(encodeFunctionData({ abi: ABI, functionName: 'approve', args: [SPENDER, 1n] }).slice(0, 10))
      .toBe(ERC20_SELECTORS.approve)
  })
})
