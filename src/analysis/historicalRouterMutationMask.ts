import { hexToBytes, type Hex } from 'viem'
import {
  AMOUNT_LOW_OFFSET,
  AMOUNT_WORD_END,
  CUSTOM_V4_UNLOCK_TEMPLATE,
  decodeCustomV4UnlockCalldata,
  MAX_SUPPORTED_AMOUNT,
  type CustomV4UnlockExpectation,
  type CustomV4UnlockSwap,
} from '../adapters/customV4UnlockRouterCodec'
import {
  uniswapV4MutationDistance,
  type UniswapV4MutationMask,
} from './uniswapV4MutationMask'

/**
 * Mutation masks for recognized historical routers, as a discriminated union.
 *
 * The official Universal Router envelope and this custom template have nothing
 * structural in common, so forcing the custom payload into the official
 * operation model would mean inventing operations the calldata does not contain.
 * A union keeps each codec's validator with its own mask, and lets the
 * exploration coordinator ask the mask which validator applies.
 */

export type OfficialRouterMutationMask = UniswapV4MutationMask & { codec: 'official' }

export type CustomRouterMutationMask = {
  codec: typeof CUSTOM_V4_UNLOCK_TEMPLATE
  calldata: Hex
  calldataBytes: number
  byteIndices: number[]
  /** Field names for report text, so evidence never overstates what was mutated. */
  fields: ['amountIn']
  seed: CustomV4UnlockSwap
  expectation: CustomV4UnlockExpectation
}

export type HistoricalRouterMutationMask = OfficialRouterMutationMask | CustomRouterMutationMask

/**
 * Masks the low 16 bytes of the amount word and nothing else.
 *
 * Everything that decides which pool is reached — selector, direction, token,
 * fee, tick spacing, hook, settlement currency — stays fixed, and the high-order
 * amount bytes stay zero so a mutation cannot walk the amount into a range the
 * codec would refuse or the router cannot fund.
 */
export function deriveCustomRouterMutationMask(input: {
  calldata: Hex
  expectation: CustomV4UnlockExpectation
}): CustomRouterMutationMask | null {
  const decoded = decodeCustomV4UnlockCalldata(input.calldata, input.expectation)
  if (!decoded.ok) return null
  return {
    codec: CUSTOM_V4_UNLOCK_TEMPLATE,
    calldata: input.calldata,
    calldataBytes: (input.calldata.length - 2) / 2,
    byteIndices: Array.from(
      { length: AMOUNT_WORD_END - AMOUNT_LOW_OFFSET },
      (_, offset) => AMOUNT_LOW_OFFSET + offset,
    ),
    fields: ['amountIn'],
    seed: decoded.decoded,
    expectation: input.expectation,
  }
}

/**
 * Accepts a candidate only if it is the seed with masked bytes changed.
 *
 * Both checks are kept: the byte comparison catches a mutator that reached
 * outside the mask, and a full re-decode against the same expectation catches a
 * masked-but-invalid amount. Either alone would let something through.
 */
export function isCustomRouterMaskedDerivative(mask: CustomRouterMutationMask, candidate: Hex): boolean {
  if ((candidate.length - 2) / 2 !== mask.calldataBytes) return false

  const original = hexToBytes(mask.calldata)
  const mutated = hexToBytes(candidate)
  const allowed = new Set(mask.byteIndices)
  for (let index = 0; index < original.length; index++) {
    if (original[index] !== mutated[index] && !allowed.has(index)) return false
  }

  const decoded = decodeCustomV4UnlockCalldata(candidate, mask.expectation)
  if (!decoded.ok) return false
  return decoded.decoded.poolId.toLowerCase() === mask.seed.poolId.toLowerCase()
    && decoded.decoded.zeroForOne === mask.seed.zeroForOne
    && decoded.decoded.settlementCurrency.toLowerCase() === mask.seed.settlementCurrency.toLowerCase()
    && decoded.decoded.amountIn > 0n
    && decoded.decoded.amountIn <= MAX_SUPPORTED_AMOUNT
}

/**
 * Distance from the seed, used to order a corpus for the next round.
 *
 * Byte-level Hamming distance would treat a one-bit amount change as trivially
 * close regardless of magnitude; ranking by how far the amount actually moved
 * keeps the exchanged corpus near the historical input.
 */
export function customRouterMutationDistance(mask: CustomRouterMutationMask, candidate: Hex): number {
  if (!isCustomRouterMaskedDerivative(mask, candidate)) return Number.POSITIVE_INFINITY
  const decoded = decodeCustomV4UnlockCalldata(candidate, mask.expectation)
  if (!decoded.ok) return Number.POSITIVE_INFINITY
  const seed = mask.seed.amountIn
  const delta = decoded.decoded.amountIn > seed
    ? decoded.decoded.amountIn - seed
    : seed - decoded.decoded.amountIn
  // Log-scaled so an enormous amount does not overflow the ordering, and a
  // candidate identical to the seed sorts first.
  return delta === 0n ? 0 : Math.log2(Number(delta) + 1)
}

/** Dispatches to the distance function belonging to the mask's own codec. */
export function mutationDistance(mask: HistoricalRouterMutationMask, candidate: Hex): number {
  return mask.codec === 'official'
    ? uniswapV4MutationDistance(mask, candidate)
    : customRouterMutationDistance(mask, candidate)
}
