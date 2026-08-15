import { describe, expect, it } from 'vitest'
import { getAddress, toEventSelector, toFunctionSelector, type Address, type Hex } from 'viem'
import {
  ERC20_SELECTORS,
  ERC20_TOPICS,
  decodeTokenTransfers,
  identifyTokenPayer,
  maxSafeAmount,
} from './erc20Provisioning'
import { CUSTOM_ROUTER_POOL_MANAGER, CUSTOM_ROUTER_SAMPLES } from '../fixtures/customRouter9409'
import type { RevmExecutionProof } from './revmProof'

/** A proof carrying only the logs the real receipt carried. */
function proofFromSample(sample: (typeof CUSTOM_ROUTER_SAMPLES)[number]): RevmExecutionProof {
  return {
    engine: 'revm/36.0.0', success: true, gasUsed: sample.receipt.gasUsed, output: '0x',
    steps: [], storageOperations: [], storageDiffs: [], balanceChanges: [], selfdestructs: [], truncated: false,
    calls: [], logs: sample.receipt.logs, logCount: sample.receipt.logCount,
  }
}

function transferLog(token: Address, from: Address, to: Address, value = 1n) {
  const pad = (address: Address) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}` as Hex
  return {
    address: token,
    topics: [ERC20_TOPICS.transfer, pad(from), pad(to)] as Hex[],
    data: `0x${value.toString(16).padStart(64, '0')}` as Hex,
  }
}

function proofWithLogs(logs: ReturnType<typeof transferLog>[]): RevmExecutionProof {
  return {
    engine: 'revm/36.0.0', success: true, gasUsed: 1, output: '0x',
    steps: [], storageOperations: [], storageDiffs: [], balanceChanges: [], selfdestructs: [], truncated: false,
    calls: [], logs, logCount: logs.length,
  }
}

describe('ERC-20 constants', () => {
  it('pins selectors and topics to canonical signatures', () => {
    expect(ERC20_SELECTORS.balanceOf).toBe(toFunctionSelector('function balanceOf(address) view returns (uint256)'))
    expect(ERC20_SELECTORS.approve).toBe(toFunctionSelector('function approve(address,uint256) returns (bool)'))
    expect(ERC20_SELECTORS.transferFrom).toBe(toFunctionSelector('function transferFrom(address,address,uint256) returns (bool)'))
    expect(ERC20_SELECTORS.allowance).toBe(toFunctionSelector('function allowance(address,address) view returns (uint256)'))
    expect(ERC20_TOPICS.transfer).toBe(toEventSelector('event Transfer(address indexed from, address indexed to, uint256 value)'))
  })
})

describe('payer identification on real mainnet transactions', () => {
  it.each(CUSTOM_ROUTER_SAMPLES)('walks $id back past the router to the funded account', (sample) => {
    const result = identifyTokenPayer({
      proof: proofFromSample(sample),
      token: sample.expected.token,
      poolManager: CUSTOM_ROUTER_POOL_MANAGER,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // The router is the address that pays the PoolManager; it is not the payer.
    expect(result.payer).not.toBe(sample.router)
    expect(result.chain[1]).toBe(sample.router)
    expect(result.hops).toBe(2)
    // For these transactions the funded account also sent the transaction, but
    // that is a property of the sample, not an assumption the walk makes.
    expect(result.payer).toBe(sample.actor)
  })

  it('reads the real transfer chain in order', () => {
    const sample = CUSTOM_ROUTER_SAMPLES[0]!
    const transfers = decodeTokenTransfers(proofFromSample(sample), sample.expected.token)
    expect(transfers).toHaveLength(2)
    expect(transfers[0]!.from).toBe(sample.actor)
    expect(transfers[0]!.to).toBe(sample.router)
    expect(transfers[1]!.from).toBe(sample.router)
    expect(transfers[1]!.to).toBe(CUSTOM_ROUTER_POOL_MANAGER)
    expect(transfers[0]!.value).toBeGreaterThan(0n)
  })
})

describe('payer identification edge cases', () => {
  const TOKEN = '0x1111111111111111111111111111111111111111' as Address
  const MANAGER = CUSTOM_ROUTER_POOL_MANAGER
  // Checksummed, since identification normalizes every address it returns.
  const A = getAddress('0x000000000000000000000000000000000000000a')
  const B = getAddress('0x000000000000000000000000000000000000000b')
  const C = getAddress('0x000000000000000000000000000000000000000c')

  it('handles a direct payer with no intermediary', () => {
    const result = identifyTokenPayer({
      proof: proofWithLogs([transferLog(TOKEN, A, MANAGER)]), token: TOKEN, poolManager: MANAGER,
    })
    expect(result).toMatchObject({ ok: true, payer: A, hops: 1 })
  })

  it('walks an arbitrarily long chain back to its source', () => {
    const result = identifyTokenPayer({
      proof: proofWithLogs([
        transferLog(TOKEN, A, B), transferLog(TOKEN, B, C), transferLog(TOKEN, C, MANAGER),
      ]),
      token: TOKEN, poolManager: MANAGER,
    })
    expect(result).toMatchObject({ ok: true, payer: A, hops: 3 })
  })

  it('ignores transfers of a different token', () => {
    const other = '0x2222222222222222222222222222222222222222' as Address
    const result = identifyTokenPayer({
      proof: proofWithLogs([transferLog(other, B, MANAGER), transferLog(TOKEN, A, MANAGER)]),
      token: TOKEN, poolManager: MANAGER,
    })
    expect(result).toMatchObject({ ok: true, payer: A })
  })

  it('refuses when nothing reached the PoolManager', () => {
    const result = identifyTokenPayer({
      proof: proofWithLogs([transferLog(TOKEN, A, B)]), token: TOKEN, poolManager: MANAGER,
    })
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.reason).toContain('reached the PoolManager')
  })

  it('refuses when the token emitted no transfer at all', () => {
    const result = identifyTokenPayer({ proof: proofWithLogs([]), token: TOKEN, poolManager: MANAGER })
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.reason).toContain('no Transfer event')
  })

  it('terminates on a cyclic transfer graph instead of spinning', () => {
    const result = identifyTokenPayer({
      proof: proofWithLogs([
        transferLog(TOKEN, A, B), transferLog(TOKEN, B, A), transferLog(TOKEN, A, MANAGER),
      ]),
      token: TOKEN, poolManager: MANAGER,
    })
    // A was paid by B and B by A; the walk stops rather than looping.
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.payer).toBe(B)
  })
})

describe('spend bound', () => {
  it('caps a generated scenario at a small share of a real balance', () => {
    expect(maxSafeAmount(10_000n)).toBe(100n)
    expect(maxSafeAmount(0n)).toBe(0n)
    expect(maxSafeAmount(-5n)).toBe(0n)
    // Never more than the balance, however large.
    const huge = 10n ** 30n
    expect(maxSafeAmount(huge)).toBeLessThan(huge)
  })
})
