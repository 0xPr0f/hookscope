import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import {
  currencyDeltaSlot,
  currencyDeltaSummary,
  decodeCurrencyDeltas,
  decodeSignedDelta,
  deltasFullySettled,
} from './currencyDeltas'
import type { RevmExecutionProof, RevmStorageAccess } from './revmProof'

const MANAGER = '0x5555555555555555555555555555555555555555' as Address
const ACTOR = '0x3333333333333333333333333333333333333333' as Address
const CURRENCY0 = '0x1111111111111111111111111111111111111111' as Address
const CURRENCY1 = '0x2222222222222222222222222222222222222222' as Address
const OTHER = '0x9999999999999999999999999999999999999999' as Address

function word(value: bigint): Hex {
  const raw = value < 0n ? (1n << 256n) + value : value
  return `0x${raw.toString(16).padStart(64, '0')}` as Hex
}

function proof(storageOperations: RevmStorageAccess[]): RevmExecutionProof {
  return {
    engine: 'revm/36.0.0',
    success: true,
    gasUsed: 21_000,
    output: '0x',
    steps: [],
    storageOperations,
    calls: [],
    storageDiffs: [],
    balanceChanges: [],
    logs: [],
    logCount: 0,
    selfdestructs: [],
    truncated: false,
  }
}

function tstore(slot: Hex, value: Hex, address: Address = MANAGER): RevmStorageAccess {
  return { address, pc: 1, opcode: 'TSTORE', slot, value }
}

describe('Uniswap v4 currency deltas', () => {
  it('matches the upstream transient slot derivation', () => {
    // Independently computed with `cast keccak $(cast abi-encode "f(address,address)" ...)`.
    expect(currencyDeltaSlot(ACTOR, CURRENCY0)).toBe(
      '0x29eef6000669835b4420869ab6b5061a6d9499a54782f78045db1ed87ea1167b',
    )
  })

  it('decodes a negative delta as two-complement int256', () => {
    expect(decodeSignedDelta(word(-1_500n))).toBe(-1_500n)
    expect(decodeSignedDelta(word(1_500n))).toBe(1_500n)
    expect(decodeSignedDelta(word(0n))).toBe(0n)
  })

  it('reports an unsettled debt owed to the PoolManager', () => {
    const deltas = decodeCurrencyDeltas({
      proof: proof([tstore(currencyDeltaSlot(ACTOR, CURRENCY0), word(-1_000n))]),
      poolManager: MANAGER,
      accounts: [ACTOR],
      currencies: [CURRENCY0, CURRENCY1],
    })

    expect(deltas).toHaveLength(1)
    expect(deltas[0]).toMatchObject({ account: ACTOR, currency: CURRENCY0, delta: '-1000', writes: 1 })
    expect(deltasFullySettled(deltas)).toBe(false)
    expect(currencyDeltaSummary(deltas)).toContain('1 still non-zero')
  })

  it('keeps the last write when a delta is applied then settled', () => {
    const slot = currencyDeltaSlot(ACTOR, CURRENCY0)
    const deltas = decodeCurrencyDeltas({
      proof: proof([tstore(slot, word(-1_000n)), tstore(slot, word(0n))]),
      poolManager: MANAGER,
      accounts: [ACTOR],
      currencies: [CURRENCY0],
    })

    expect(deltas).toHaveLength(1)
    expect(deltas[0]).toMatchObject({ delta: '0', writes: 2 })
    expect(deltasFullySettled(deltas)).toBe(true)
    expect(currencyDeltaSummary(deltas)).toContain('all settled to zero')
  })

  it('ignores transient writes that are not a known account/currency pair', () => {
    expect(decodeCurrencyDeltas({
      proof: proof([tstore(`0x${'ab'.repeat(32)}` as Hex, word(-5n))]),
      poolManager: MANAGER,
      accounts: [ACTOR],
      currencies: [CURRENCY0],
    })).toEqual([])
  })

  it('ignores transient writes made by a contract other than the PoolManager', () => {
    expect(decodeCurrencyDeltas({
      proof: proof([tstore(currencyDeltaSlot(ACTOR, CURRENCY0), word(-5n), OTHER)]),
      poolManager: MANAGER,
      accounts: [ACTOR],
      currencies: [CURRENCY0],
    })).toEqual([])
  })

  it('reports nothing when execution wrote no transient storage', () => {
    expect(decodeCurrencyDeltas({
      proof: proof([{ address: MANAGER, pc: 1, opcode: 'SSTORE', slot: '0x01', value: '0x02' }]),
      poolManager: MANAGER,
      accounts: [ACTOR],
      currencies: [CURRENCY0],
    })).toEqual([])
    expect(currencyDeltaSummary([])).toBeUndefined()
  })
})
