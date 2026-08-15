import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, type Address, type Hex } from 'viem'
import { computePoolId } from './uniswapV4Pool'
import {
  AMOUNT_LOW_OFFSET,
  AMOUNT_WORD_END,
  CUSTOM_V4_UNLOCK_CALLDATA_BYTES,
  CUSTOM_V4_UNLOCK_SELECTOR,
  decodeCustomV4UnlockCalldata,
  encodeCustomV4UnlockCalldata,
  MAX_SUPPORTED_AMOUNT,
} from './customV4UnlockRouterCodec'
import type { V4PoolKey } from './uniswapV4RouterCodec'

const NATIVE = '0x0000000000000000000000000000000000000000' as Address
const TOKEN = '0xD0a606aDf58b69a28D479aA510CE6FE96E0a1eb2' as Address
const HOOK = '0x1111111111111111111111111111111111111888' as Address
/** The observed family: native/token pair, dynamic fee flag, spacing 200. */
const poolKey: V4PoolKey = { currency0: NATIVE, currency1: TOKEN, fee: 0x800000, tickSpacing: 200, hooks: HOOK }
const poolId = computePoolId({ ...poolKey, hook: poolKey.hooks })
const AMOUNT = 1_500_000_000_000_000n

function build(overrides: Partial<{
  zeroForOne: boolean
  token: Address
  fee: number
  tickSpacing: number
  hooks: Address
  amountIn: bigint
  settlementCurrency: Address
}> = {}): Hex {
  const args = encodeAbiParameters(
    [{ type: 'bool' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }, { type: 'uint256' }, { type: 'address' }],
    [
      overrides.zeroForOne ?? false,
      overrides.token ?? TOKEN,
      overrides.fee ?? poolKey.fee,
      overrides.tickSpacing ?? poolKey.tickSpacing,
      overrides.hooks ?? HOOK,
      overrides.amountIn ?? AMOUNT,
      overrides.settlementCurrency ?? TOKEN,
    ],
  )
  return `${CUSTOM_V4_UNLOCK_SELECTOR}${args.slice(2)}` as Hex
}

const expectation = { poolKey, poolId, transactionValue: 0n }

describe('custom v4 unlock codec', () => {
  it('decodes the observed field layout', () => {
    const result = decodeCustomV4UnlockCalldata(build(), expectation)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.decoded).toMatchObject({
      kind: 'custom-v4-unlock-swap',
      template: 'custom-v4-unlock-9409-v1',
      zeroForOne: false,
      amountIn: AMOUNT,
      settlementCurrency: TOKEN,
      poolId,
    })
    // Direction false spends currency1, which is the token side of this pair.
    expect(result.decoded.poolKey).toEqual(poolKey)
  })

  it('is exactly 228 bytes and re-encodes byte-identically', () => {
    const calldata = build()
    expect((calldata.length - 2) / 2).toBe(CUSTOM_V4_UNLOCK_CALLDATA_BYTES)
    const result = decodeCustomV4UnlockCalldata(calldata, expectation)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(encodeCustomV4UnlockCalldata(result.decoded).toLowerCase()).toBe(calldata.toLowerCase())
  })

  it('re-encodes a changed amount into the declared word only', () => {
    const calldata = build()
    const result = decodeCustomV4UnlockCalldata(calldata, expectation)
    if (!result.ok) throw new Error('seed did not decode')
    const smaller = encodeCustomV4UnlockCalldata(result.decoded, { amountIn: AMOUNT / 2n })
    expect((smaller.length - 2) / 2).toBe(CUSTOM_V4_UNLOCK_CALLDATA_BYTES)
    const before = Buffer.from(calldata.slice(2), 'hex')
    const after = Buffer.from(smaller.slice(2), 'hex')
    const changed = [...before.keys()].filter((index) => before[index] !== after[index])
    expect(Math.min(...changed)).toBeGreaterThanOrEqual(AMOUNT_LOW_OFFSET)
    expect(Math.max(...changed)).toBeLessThan(AMOUNT_WORD_END)
  })

  it('rejects a wrong selector', () => {
    const calldata = `0xdeadbeef${build().slice(10)}` as Hex
    expect(decodeCustomV4UnlockCalldata(calldata, expectation)).toMatchObject({ ok: false, reason: 'selector' })
  })

  it('rejects a wrong length', () => {
    expect(decodeCustomV4UnlockCalldata(`${build()}00` as Hex, expectation)).toMatchObject({ ok: false, reason: 'length' })
  })

  it('rejects non-canonical address padding', () => {
    const bytes = Buffer.from(build().slice(2), 'hex')
    // Word 1 is the token; dirty its high-order padding.
    bytes[4 + 32] = 0xff
    const dirty = `0x${bytes.toString('hex')}` as Hex
    expect(decodeCustomV4UnlockCalldata(dirty, expectation)).toMatchObject({ ok: false, reason: 'non-canonical-encoding' })
  })

  it('rejects a zero or oversized amount', () => {
    expect(decodeCustomV4UnlockCalldata(build({ amountIn: 0n }), expectation)).toMatchObject({ ok: false, reason: 'amount-range' })
    expect(decodeCustomV4UnlockCalldata(build({ amountIn: MAX_SUPPORTED_AMOUNT + 1n }), expectation)).toMatchObject({ ok: false, reason: 'amount-range' })
  })

  it('rejects a payload that describes a different pool', () => {
    for (const override of [
      { token: '0x2222222222222222222222222222222222222222' as Address },
      { fee: 3_000 },
      { tickSpacing: 60 },
      { hooks: '0x3333333333333333333333333333333333333333' as Address },
    ]) {
      const result = decodeCustomV4UnlockCalldata(build(override), expectation)
      expect(result.ok, JSON.stringify(override)).toBe(false)
      if (!result.ok) expect(['pool-mismatch', 'pool-id-mismatch']).toContain(result.reason)
    }
  })

  it('rejects a PoolId that does not match the selected pool', () => {
    const other = { ...expectation, poolId: `0x${'ee'.repeat(32)}` as Hex }
    expect(decodeCustomV4UnlockCalldata(build(), other)).toMatchObject({ ok: false, reason: 'pool-id-mismatch' })
  })

  it('rejects a settlement currency inconsistent with the direction', () => {
    // Selling currency1 must settle currency1, not the native side.
    expect(decodeCustomV4UnlockCalldata(build({ settlementCurrency: NATIVE }), expectation))
      .toMatchObject({ ok: false, reason: 'settlement-currency' })
    // And the mirrored direction must settle native.
    expect(decodeCustomV4UnlockCalldata(build({ zeroForOne: true, settlementCurrency: TOKEN }), expectation))
      .toMatchObject({ ok: false, reason: 'settlement-currency' })
  })

  it('requires transaction value to match the settlement currency', () => {
    // Token settlement with native value attached is inconsistent.
    expect(decodeCustomV4UnlockCalldata(build(), { ...expectation, transactionValue: 5n }))
      .toMatchObject({ ok: false, reason: 'transaction-value' })
    // Native settlement must be funded.
    const native = build({ zeroForOne: true, settlementCurrency: NATIVE })
    expect(decodeCustomV4UnlockCalldata(native, { ...expectation, transactionValue: 0n }))
      .toMatchObject({ ok: false, reason: 'transaction-value' })
    expect(decodeCustomV4UnlockCalldata(native, { ...expectation, transactionValue: AMOUNT }))
      .toMatchObject({ ok: true })
  })

  it('refuses to encode an amount outside the supported range', () => {
    const result = decodeCustomV4UnlockCalldata(build(), expectation)
    if (!result.ok) throw new Error('seed did not decode')
    expect(() => encodeCustomV4UnlockCalldata(result.decoded, { amountIn: 0n })).toThrow(/supported range/)
  })
})
