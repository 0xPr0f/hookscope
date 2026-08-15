import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, type Address, type Hex } from 'viem'
import { computePoolId } from '../adapters/uniswapV4Pool'
import {
  AMOUNT_LOW_OFFSET,
  AMOUNT_WORD_END,
  CUSTOM_V4_UNLOCK_SELECTOR,
  encodeCustomV4UnlockCalldata,
  decodeCustomV4UnlockCalldata,
} from '../adapters/customV4UnlockRouterCodec'
import {
  customRouterMutationDistance,
  deriveCustomRouterMutationMask,
  isCustomRouterMaskedDerivative,
  mutationDistance,
} from './historicalRouterMutationMask'
import type { V4PoolKey } from '../adapters/uniswapV4RouterCodec'

const NATIVE = '0x0000000000000000000000000000000000000000' as Address
const TOKEN = '0xD0a606aDf58b69a28D479aA510CE6FE96E0a1eb2' as Address
const HOOK = '0x1111111111111111111111111111111111111888' as Address
const poolKey: V4PoolKey = { currency0: NATIVE, currency1: TOKEN, fee: 0x800000, tickSpacing: 200, hooks: HOOK }
const poolId = computePoolId({ ...poolKey, hook: poolKey.hooks })
const expectation = { poolKey, poolId, transactionValue: 0n }
const AMOUNT = 1_500_000_000_000_000n

function seedCalldata(amountIn = AMOUNT): Hex {
  const args = encodeAbiParameters(
    [{ type: 'bool' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }, { type: 'uint256' }, { type: 'address' }],
    [false, TOKEN, poolKey.fee, poolKey.tickSpacing, HOOK, amountIn, TOKEN],
  )
  return `${CUSTOM_V4_UNLOCK_SELECTOR}${args.slice(2)}` as Hex
}

function mask() {
  const derived = deriveCustomRouterMutationMask({ calldata: seedCalldata(), expectation })
  if (!derived) throw new Error('seed did not produce a mask')
  return derived
}

function withByte(calldata: Hex, index: number, value: number): Hex {
  const bytes = Buffer.from(calldata.slice(2), 'hex')
  bytes[index] = value
  return `0x${bytes.toString('hex')}` as Hex
}

describe('custom router mutation mask', () => {
  it('masks only the low 16 bytes of the amount word', () => {
    const derived = mask()
    expect(derived.codec).toBe('custom-v4-unlock-9409-v1')
    expect(derived.byteIndices[0]).toBe(AMOUNT_LOW_OFFSET)
    expect(derived.byteIndices.at(-1)).toBe(AMOUNT_WORD_END - 1)
    expect(derived.byteIndices).toHaveLength(16)
    expect(derived.fields).toEqual(['amountIn'])
  })

  it('returns nothing for calldata that is not the recognized template', () => {
    expect(deriveCustomRouterMutationMask({ calldata: '0xdeadbeef', expectation })).toBeNull()
    // Right shape, wrong pool: the mask must not form for a payload the codec rejects.
    expect(deriveCustomRouterMutationMask({
      calldata: seedCalldata(),
      expectation: { ...expectation, poolId: `0x${'ee'.repeat(32)}` as Hex },
    })).toBeNull()
  })

  it('accepts an amount-only mutation', () => {
    const derived = mask()
    const smaller = encodeCustomV4UnlockCalldata(derived.seed, { amountIn: AMOUNT / 2n })
    expect(isCustomRouterMaskedDerivative(derived, smaller)).toBe(true)
    const decoded = decodeCustomV4UnlockCalldata(smaller, expectation)
    expect(decoded.ok && decoded.decoded.poolId).toBe(poolId)
  })

  it('rejects a changed selector, token, fee, hook or settlement currency', () => {
    const derived = mask()
    // Selector byte.
    expect(isCustomRouterMaskedDerivative(derived, withByte(derived.calldata, 1, 0xff))).toBe(false)
    // Direction word.
    expect(isCustomRouterMaskedDerivative(derived, withByte(derived.calldata, 35, 0x01))).toBe(false)
    // Token word.
    expect(isCustomRouterMaskedDerivative(derived, withByte(derived.calldata, 60, 0xff))).toBe(false)
    // Fee word.
    expect(isCustomRouterMaskedDerivative(derived, withByte(derived.calldata, 99, 0x01))).toBe(false)
    // Hook word.
    expect(isCustomRouterMaskedDerivative(derived, withByte(derived.calldata, 155, 0xff))).toBe(false)
    // Settlement currency word.
    expect(isCustomRouterMaskedDerivative(derived, withByte(derived.calldata, 227, 0xff))).toBe(false)
  })

  it('rejects a high-order amount byte, which is outside the mask', () => {
    const derived = mask()
    expect(isCustomRouterMaskedDerivative(derived, withByte(derived.calldata, AMOUNT_LOW_OFFSET - 1, 0x01))).toBe(false)
  })

  it('rejects a masked mutation that zeroes the amount', () => {
    const derived = mask()
    const zeroed = Buffer.from(derived.calldata.slice(2), 'hex')
    zeroed.fill(0, AMOUNT_LOW_OFFSET, AMOUNT_WORD_END)
    expect(isCustomRouterMaskedDerivative(derived, `0x${zeroed.toString('hex')}` as Hex)).toBe(false)
  })

  it('rejects a candidate of a different length', () => {
    const derived = mask()
    expect(isCustomRouterMaskedDerivative(derived, `${derived.calldata}00` as Hex)).toBe(false)
  })

  it('orders a corpus by how far the amount moved', () => {
    const derived = mask()
    const near = encodeCustomV4UnlockCalldata(derived.seed, { amountIn: AMOUNT - 1n })
    const far = encodeCustomV4UnlockCalldata(derived.seed, { amountIn: AMOUNT / 4n })
    expect(customRouterMutationDistance(derived, derived.calldata)).toBe(0)
    expect(customRouterMutationDistance(derived, near)).toBeLessThan(customRouterMutationDistance(derived, far))
    // A non-derivative is unreachable, never merely distant.
    expect(customRouterMutationDistance(derived, withByte(derived.calldata, 1, 0xff))).toBe(Number.POSITIVE_INFINITY)
  })

  it('dispatches distance by the mask codec', () => {
    const derived = mask()
    expect(mutationDistance(derived, derived.calldata)).toBe(0)
  })
})
