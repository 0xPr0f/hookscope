import {
  decodeAbiParameters,
  encodeAbiParameters,
  getAddress,
  isAddressEqual,
  size,
  slice,
  type Address,
  type Hex,
} from 'viem'
import { computePoolId } from './uniswapV4Pool'
import type { V4PoolKey } from './uniswapV4RouterCodec'

/**
 * Codec for one observed custom v4 router family.
 *
 * This is deliberately separate from the Universal Router decoder. The template
 * is not an official Uniswap envelope, has no published ABI, and its meaning is
 * derived from pinned runtime bytecode plus a reproduced execution trace. Mixing
 * it into the official codec would let an unrecognized selector inherit the
 * official decoder's guarantees, which it has not earned.
 *
 * Recognition is intentionally over-constrained: every field is checked against
 * the pool that was actually selected, and the decode is only accepted when a
 * re-encode reproduces the calldata byte for byte. A selector match alone must
 * never activate this adapter.
 */

export const CUSTOM_V4_UNLOCK_TEMPLATE = 'custom-v4-unlock-9409-v1' as const
export const CUSTOM_V4_UNLOCK_SELECTOR = '0x9409a78f' as const
/** Selector plus seven 32-byte words. */
export const CUSTOM_V4_UNLOCK_CALLDATA_BYTES = 228

/** Byte offsets of the one field this family exposes as mutable. */
export const AMOUNT_WORD_OFFSET = 164
export const AMOUNT_WORD_END = 196
/** Low 16 bytes of the amount word: enough range to vary, never enough to overflow it. */
export const AMOUNT_LOW_OFFSET = 180

const ARGUMENT_TYPES = [
  { type: 'bool' },
  { type: 'address' },
  { type: 'uint24' },
  { type: 'int24' },
  { type: 'address' },
  { type: 'uint256' },
  { type: 'address' },
] as const

const NATIVE_CURRENCY = '0x0000000000000000000000000000000000000000' as Address
/** Upper bound on a plausible input amount, well below any uint256 wrap. */
export const MAX_SUPPORTED_AMOUNT = (1n << 128n) - 1n

export type CustomV4UnlockSwap = {
  kind: 'custom-v4-unlock-swap'
  template: typeof CUSTOM_V4_UNLOCK_TEMPLATE
  zeroForOne: boolean
  poolKey: V4PoolKey
  poolId: Hex
  amountIn: bigint
  settlementCurrency: Address
}

export type CustomV4UnlockRejection =
  | 'selector'
  | 'length'
  | 'abi-decode'
  | 'non-canonical-encoding'
  | 'amount-range'
  | 'pool-mismatch'
  | 'pool-id-mismatch'
  | 'settlement-currency'
  | 'transaction-value'

export type CustomV4UnlockDecodeResult =
  | { ok: true; decoded: CustomV4UnlockSwap }
  | { ok: false; reason: CustomV4UnlockRejection; detail: string }

export type CustomV4UnlockExpectation = {
  /** The pool the analyzer selected; the calldata must describe exactly this pool. */
  poolKey: V4PoolKey
  poolId: Hex
  /** Native value carried by the historical transaction, when it is known. */
  transactionValue?: bigint
}

/**
 * The seven words as they sit in calldata.
 *
 * Kept separate from the decoded swap so the re-encode check compares like for
 * like: the same tuple, encoded by the same encoder, against the original bytes.
 */
type RawArguments = readonly [boolean, Address, number, number, Address, bigint, Address]

function encodeArguments(args: RawArguments): Hex {
  return `${CUSTOM_V4_UNLOCK_SELECTOR}${encodeAbiParameters(ARGUMENT_TYPES, args).slice(2)}` as Hex
}

/**
 * Rejects an address word carrying dirty high-order bytes.
 *
 * viem's decoder masks them away, so two different calldatas could decode to the
 * same address. Requiring canonical padding keeps the decode one-to-one, which
 * is what makes the re-encode check meaningful.
 */
function hasCanonicalAddressPadding(calldata: Hex, wordIndex: number): boolean {
  const start = 4 + wordIndex * 32
  return slice(calldata, start, start + 12) === `0x${'00'.repeat(12)}`
}

function sameAddress(left: Address, right: Address) {
  return isAddressEqual(getAddress(left), getAddress(right))
}

function keysMatch(left: V4PoolKey, right: V4PoolKey) {
  return sameAddress(left.currency0, right.currency0)
    && sameAddress(left.currency1, right.currency1)
    && left.fee === right.fee
    && left.tickSpacing === right.tickSpacing
    && sameAddress(left.hooks, right.hooks)
}

/**
 * Decodes one custom-router swap, or explains precisely why it refused.
 *
 * The rejection reason is returned rather than thrown: an unrecognized payload
 * is an ordinary outcome that must leave exact historical replay untouched, and
 * a named reason is what lets a report say why controlled variants were not
 * generated for a pool.
 */
export function decodeCustomV4UnlockCalldata(
  calldata: Hex,
  expectation: CustomV4UnlockExpectation,
): CustomV4UnlockDecodeResult {
  if (size(calldata) < 4 || slice(calldata, 0, 4).toLowerCase() !== CUSTOM_V4_UNLOCK_SELECTOR) {
    return { ok: false, reason: 'selector', detail: 'Calldata does not carry the recognized template selector.' }
  }
  if (size(calldata) !== CUSTOM_V4_UNLOCK_CALLDATA_BYTES) {
    return {
      ok: false,
      reason: 'length',
      detail: `Recognized template is exactly ${CUSTOM_V4_UNLOCK_CALLDATA_BYTES} bytes; this payload is ${size(calldata)}.`,
    }
  }

  let args: RawArguments
  try {
    args = decodeAbiParameters(ARGUMENT_TYPES, slice(calldata, 4)) as unknown as RawArguments
  } catch (error) {
    return { ok: false, reason: 'abi-decode', detail: error instanceof Error ? error.message : String(error) }
  }

  // Address words are 1, 4 and 6 in the tuple.
  for (const wordIndex of [1, 4, 6]) {
    if (!hasCanonicalAddressPadding(calldata, wordIndex)) {
      return {
        ok: false,
        reason: 'non-canonical-encoding',
        detail: `Address word ${wordIndex} carries non-zero padding, so the payload is not canonically encoded.`,
      }
    }
  }
  if (encodeArguments(args).toLowerCase() !== calldata.toLowerCase()) {
    return {
      ok: false,
      reason: 'non-canonical-encoding',
      detail: 'Re-encoding the decoded arguments did not reproduce the calldata byte for byte.',
    }
  }

  const [zeroForOne, token, fee, tickSpacing, hooks, amountIn, settlementCurrency] = args
  if (amountIn <= 0n || amountIn > MAX_SUPPORTED_AMOUNT) {
    return { ok: false, reason: 'amount-range', detail: `Amount ${amountIn} is outside the supported range.` }
  }

  // The template encodes the non-native side of the pair, so the key is
  // reconstructed from the pool's own ordering rather than assumed.
  const poolKey: V4PoolKey = {
    currency0: expectation.poolKey.currency0,
    currency1: expectation.poolKey.currency1,
    fee,
    tickSpacing,
    hooks: getAddress(hooks),
  }
  const encodedToken = getAddress(token)
  const nonNative = sameAddress(expectation.poolKey.currency0, NATIVE_CURRENCY)
    ? expectation.poolKey.currency1
    : expectation.poolKey.currency0
  if (!sameAddress(encodedToken, nonNative) || !keysMatch(poolKey, expectation.poolKey)) {
    return {
      ok: false,
      reason: 'pool-mismatch',
      detail: 'Encoded token, fee, tick spacing or hook does not match the selected pool.',
    }
  }

  const poolId = computePoolId({
    currency0: poolKey.currency0,
    currency1: poolKey.currency1,
    fee: poolKey.fee,
    tickSpacing: poolKey.tickSpacing,
    hook: poolKey.hooks,
  })
  if (poolId.toLowerCase() !== expectation.poolId.toLowerCase()) {
    return { ok: false, reason: 'pool-id-mismatch', detail: 'Reconstructed PoolId does not equal the selected PoolId.' }
  }

  // Exact input is paid in the currency being sold, which the direction fixes.
  const expectedSettlement = zeroForOne ? poolKey.currency0 : poolKey.currency1
  if (!sameAddress(getAddress(settlementCurrency), expectedSettlement)) {
    return {
      ok: false,
      reason: 'settlement-currency',
      detail: 'Settlement currency is not the currency this direction spends.',
    }
  }

  // Native settlement must be funded by transaction value; token settlement must not be.
  if (expectation.transactionValue !== undefined) {
    const nativeSettlement = sameAddress(expectedSettlement, NATIVE_CURRENCY)
    if (nativeSettlement && expectation.transactionValue < amountIn) {
      return {
        ok: false,
        reason: 'transaction-value',
        detail: 'Native settlement is not covered by the transaction value.',
      }
    }
    if (!nativeSettlement && expectation.transactionValue !== 0n) {
      return {
        ok: false,
        reason: 'transaction-value',
        detail: 'Token settlement carried non-zero native value.',
      }
    }
  }

  return {
    ok: true,
    decoded: {
      kind: 'custom-v4-unlock-swap',
      template: CUSTOM_V4_UNLOCK_TEMPLATE,
      zeroForOne,
      poolKey,
      poolId,
      amountIn,
      settlementCurrency: getAddress(settlementCurrency),
    },
  }
}

/**
 * Re-encodes a previously decoded swap, optionally with a different amount.
 *
 * There is deliberately no general call builder: every field except the amount
 * is carried straight through from a decode that already matched the selected
 * pool, so this cannot be used to synthesize a call to some other pool.
 */
export function encodeCustomV4UnlockCalldata(
  decoded: CustomV4UnlockSwap,
  overrides?: { amountIn?: bigint },
): Hex {
  const amountIn = overrides?.amountIn ?? decoded.amountIn
  if (amountIn <= 0n || amountIn > MAX_SUPPORTED_AMOUNT) {
    throw new Error(`Refusing to encode an amount outside the supported range: ${amountIn}.`)
  }
  const nonNative = sameAddress(decoded.poolKey.currency0, NATIVE_CURRENCY)
    ? decoded.poolKey.currency1
    : decoded.poolKey.currency0
  return encodeArguments([
    decoded.zeroForOne,
    getAddress(nonNative),
    decoded.poolKey.fee,
    decoded.poolKey.tickSpacing,
    getAddress(decoded.poolKey.hooks),
    amountIn,
    getAddress(decoded.settlementCurrency),
  ])
}
