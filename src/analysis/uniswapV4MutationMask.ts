import { bytesToHex, hexToBytes, type Hex } from 'viem'
import { signedPayloadDigest } from '../adapters/uniswapV4SignedPayloads'
import {
  cloneAndMutateUniswapV4Operation,
  decodeUniswapV4Calldata,
  encodeUniswapV4Calldata,
  locateUniswapV4Operations,
  type DecodedUniswapV4Calldata,
  type LocatedV4Operation,
  type V4ControlledOperation,
  type V4OperationLocation,
} from '../adapters/uniswapV4RouterCodec'

export const UNISWAP_V4_MUTATION_MASK_LIMITS = {
  defaultOperations: 32,
  maximumOperations: 128,
  defaultHookDataFields: 32,
  maximumHookDataFields: 256,
  defaultHookDataBytesPerField: 256,
  maximumHookDataBytesPerField: 4_096,
  defaultMutableBytes: 4_096,
  maximumMutableBytes: 16_384,
  maximumCalldataBytes: 2_000_000,
} as const

export type UniswapV4MutationMaskOptions = {
  maxOperations?: number
  maxHookDataFields?: number
  maxHookDataBytesPerField?: number
  maxMutableBytes?: number
  /**
   * Restricts the mask to the operations this predicate keeps. The index follows
   * `locateUniswapV4Operations` order and is preserved on the retained regions,
   * so a scoped mask still identifies its operation inside the whole call.
   */
  keepOperation?: (located: LocatedV4Operation, operationIndex: number) => boolean
}

export type UniswapV4MutableField = 'amountIn' | 'amountOut' | 'liquidity' | 'hookData'

export type UniswapV4MutableRegion = {
  operationIndex: number
  operationKind: V4ControlledOperation['kind']
  location: V4OperationLocation
  field: UniswapV4MutableField
  pathIndex?: number
  /** Zero-based byte indices in the complete transaction calldata, including its four-byte selector. */
  byteIndices: number[]
  totalValueBytes: number
  truncated: boolean
}

export type UniswapV4MutationMask = {
  calldata: Hex
  calldataBytes: number
  byteIndices: number[]
  /** Identity of the seed's signature-bearing payloads; a derivative must reproduce it exactly. */
  signedPayloads: string
  regions: UniswapV4MutableRegion[]
  operationsSeen: number
  operationsConsidered: number
  /** Operations kept by `keepOperation`; equals `operationsConsidered` when no predicate is supplied. */
  operationsSelected: number
  hookDataFieldsSeen: number
  hookDataFieldsConsidered: number
  truncated: boolean
}

type NormalizedLimits = {
  maxOperations: number
  maxHookDataFields: number
  maxHookDataBytesPerField: number
  maxMutableBytes: number
}

type DiscoveredRegion = Omit<UniswapV4MutableRegion, 'byteIndices' | 'truncated'> & {
  allByteIndices: number[]
}

type HookDataField = {
  pathIndex?: number
  value: Hex
}

const UINT128_PATTERN_A = BigInt(`0x${'11'.repeat(16)}`)
const UINT128_PATTERN_B = BigInt(`0x${'ee'.repeat(16)}`)
const UINT256_PATTERN_A = BigInt(`0x${'11'.repeat(32)}`)
const UINT256_PATTERN_B = BigInt(`0x${'ee'.repeat(32)}`)

function boundedInteger(value: number | undefined, fallback: number, maximum: number, label: string) {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be a finite non-negative number.`)
  return Math.min(Math.floor(value), maximum)
}

function normalizeLimits(options: UniswapV4MutationMaskOptions): NormalizedLimits {
  const limits = UNISWAP_V4_MUTATION_MASK_LIMITS
  return {
    maxOperations: boundedInteger(
      options.maxOperations,
      limits.defaultOperations,
      limits.maximumOperations,
      'maxOperations',
    ),
    maxHookDataFields: boundedInteger(
      options.maxHookDataFields,
      limits.defaultHookDataFields,
      limits.maximumHookDataFields,
      'maxHookDataFields',
    ),
    maxHookDataBytesPerField: boundedInteger(
      options.maxHookDataBytesPerField,
      limits.defaultHookDataBytesPerField,
      limits.maximumHookDataBytesPerField,
      'maxHookDataBytesPerField',
    ),
    maxMutableBytes: boundedInteger(
      options.maxMutableBytes,
      limits.defaultMutableBytes,
      limits.maximumMutableBytes,
      'maxMutableBytes',
    ),
  }
}

function sameHex(left: Hex, right: Hex) {
  return left.toLowerCase() === right.toLowerCase()
}

function byteLength(value: Hex) {
  return (value.length - 2) / 2
}

function repeatedByte(byte: string, length: number): Hex {
  return `0x${byte.repeat(length)}` as Hex
}

function changedByteIndices(original: Hex, variants: readonly Hex[]): number[] {
  const originalBytes = hexToBytes(original)
  const variantBytes = variants.map((variant) => hexToBytes(variant))
  if (variantBytes.some((variant) => variant.length !== originalBytes.length)) {
    throw new Error('A mutation changed the canonical calldata length.')
  }

  const changed: number[] = []
  for (let index = 0; index < originalBytes.length; index++) {
    if (variantBytes.some((variant) => variant[index] !== originalBytes[index])) changed.push(index)
  }
  return changed
}

function primaryScalar(operation: V4ControlledOperation): { field: 'amountIn' | 'amountOut' | 'liquidity'; bytes: 16 | 32 } | undefined {
  switch (operation.kind) {
    case 'swap-exact-in-single':
    case 'swap-exact-in':
      return { field: 'amountIn', bytes: 16 }
    case 'swap-exact-out-single':
    case 'swap-exact-out':
      return { field: 'amountOut', bytes: 16 }
    case 'increase-liquidity':
    case 'decrease-liquidity':
    case 'mint-position':
      return { field: 'liquidity', bytes: 32 }
    default:
      return undefined
  }
}

function setPrimaryScalar(operation: V4ControlledOperation, value: bigint) {
  switch (operation.kind) {
    case 'swap-exact-in-single':
    case 'swap-exact-in':
      operation.amountIn = value
      return
    case 'swap-exact-out-single':
    case 'swap-exact-out':
      operation.amountOut = value
      return
    case 'increase-liquidity':
    case 'decrease-liquidity':
    case 'mint-position':
      operation.liquidity = value
      return
    default:
      throw new Error('The selected Uniswap v4 operation has no primary mutable scalar.')
  }
}

function hookDataFields(operation: V4ControlledOperation): HookDataField[] {
  if (operation.kind === 'swap-exact-in' || operation.kind === 'swap-exact-out') {
    return operation.path.map((path, pathIndex) => ({ pathIndex, value: path.hookData }))
  }
  if ('hookData' in operation) return [{ value: operation.hookData }]
  return []
}

function setHookData(operation: V4ControlledOperation, pathIndex: number | undefined, value: Hex) {
  if (operation.kind === 'swap-exact-in' || operation.kind === 'swap-exact-out') {
    if (pathIndex === undefined || !operation.path[pathIndex]) throw new Error('The selected v4 path does not exist.')
    operation.path[pathIndex].hookData = value
    return
  }
  if ('hookData' in operation && pathIndex === undefined) {
    operation.hookData = value
    return
  }
  throw new Error('The selected Uniswap v4 operation has no hook data at this location.')
}

function encodeMutation(
  decoded: DecodedUniswapV4Calldata,
  located: LocatedV4Operation,
  mutate: (operation: V4ControlledOperation) => void,
) {
  return encodeUniswapV4Calldata(cloneAndMutateUniswapV4Operation(decoded, located.location, mutate))
}

function discoverScalarRegion(
  calldata: Hex,
  decoded: DecodedUniswapV4Calldata,
  located: LocatedV4Operation,
  operationIndex: number,
): DiscoveredRegion | undefined {
  const scalar = primaryScalar(located.operation)
  if (!scalar) return undefined
  const patterns = scalar.bytes === 16
    ? [UINT128_PATTERN_A, UINT128_PATTERN_B]
    : [UINT256_PATTERN_A, UINT256_PATTERN_B]
  const variants = patterns.map((pattern) => encodeMutation(decoded, located, (operation) => setPrimaryScalar(operation, pattern)))
  const allByteIndices = changedByteIndices(calldata, variants)
  if (allByteIndices.length !== scalar.bytes) {
    throw new Error(`Expected ${scalar.bytes} mutable ${scalar.field} bytes, found ${allByteIndices.length}.`)
  }
  return {
    operationIndex,
    operationKind: located.operation.kind,
    location: structuredClone(located.location),
    field: scalar.field,
    totalValueBytes: allByteIndices.length,
    allByteIndices,
  }
}

function discoverHookDataRegion(input: {
  calldata: Hex
  decoded: DecodedUniswapV4Calldata
  located: LocatedV4Operation
  operationIndex: number
  field: HookDataField
}): DiscoveredRegion | undefined {
  const length = byteLength(input.field.value)
  if (length === 0) return undefined
  const variants = ['11', 'ee'].map((byte) => encodeMutation(input.decoded, input.located, (operation) => {
    setHookData(operation, input.field.pathIndex, repeatedByte(byte, length))
  }))
  const allByteIndices = changedByteIndices(input.calldata, variants)
  if (allByteIndices.length !== length) {
    throw new Error(`Expected ${length} mutable hook-data bytes, found ${allByteIndices.length}.`)
  }
  return {
    operationIndex: input.operationIndex,
    operationKind: input.located.operation.kind,
    location: structuredClone(input.located.location),
    field: 'hookData',
    ...(input.field.pathIndex === undefined ? {} : { pathIndex: input.field.pathIndex }),
    totalValueBytes: allByteIndices.length,
    allByteIndices,
  }
}

function evenlySpaced(values: readonly number[], maximum: number): number[] {
  if (maximum <= 0) return []
  if (values.length <= maximum) return [...values]
  if (maximum === 1) return [values[0]!]
  const selected: number[] = []
  for (let index = 0; index < maximum; index++) {
    selected.push(values[Math.floor(index * (values.length - 1) / (maximum - 1))]!)
  }
  return selected
}

/**
 * Proves the mask cannot reach a signature.
 *
 * Flipping every masked byte at once is the strongest mutation the mask can
 * ever authorize, so if the signed payloads survive that, no derived candidate
 * can invalidate an original signature. The codec already keeps signed bytes
 * out of mutable fields; this turns that inherited property into an enforced one.
 */
function assertSignedPayloadsOutsideMask(
  calldata: Hex,
  digest: string,
  byteIndices: readonly number[],
) {
  if (!byteIndices.length) return
  const probe = hexToBytes(calldata)
  for (const index of byteIndices) probe[index] = probe[index]! ^ 0xff
  const mutated = decodeUniswapV4Calldata(bytesToHex(probe))
  if (!mutated || signedPayloadDigest(mutated) !== digest) {
    throw new Error('The derived mutation mask overlaps a signed payload; refusing to produce it.')
  }
}

/**
 * Derives a conservative mutation mask from an already-canonical decoded call.
 *
 * Only the low-order value bytes of the primary swap amount, the complete value
 * bytes of a liquidity scalar, and existing hookData contents can enter the mask.
 * Dynamic lengths and padding are deliberately excluded. Byte indices include
 * the outer four-byte function selector.
 */
export function deriveUniswapV4MutationMaskFromDecoded(
  decoded: DecodedUniswapV4Calldata,
  options: UniswapV4MutationMaskOptions = {},
): UniswapV4MutationMask {
  const limits = normalizeLimits(options)
  const calldata = encodeUniswapV4Calldata(decoded)
  const calldataBytes = byteLength(calldata)
  if (calldataBytes > UNISWAP_V4_MUTATION_MASK_LIMITS.maximumCalldataBytes) {
    throw new RangeError('Canonical calldata is too large for the browser mutation-mask gate.')
  }
  const roundTrip = decodeUniswapV4Calldata(calldata)
  if (!roundTrip || !sameHex(encodeUniswapV4Calldata(roundTrip), calldata)) {
    throw new Error('The decoded Uniswap v4 call is not canonical.')
  }

  const operations = locateUniswapV4Operations(decoded)
  const considered = operations.slice(0, limits.maxOperations)
  const scalarRegions: DiscoveredRegion[] = []
  const hookRegions: DiscoveredRegion[] = []
  let hookDataFieldsSeen = 0
  let hookDataFieldsConsidered = 0

  let operationsSelected = 0

  considered.forEach((located, operationIndex) => {
    if (options.keepOperation && !options.keepOperation(located, operationIndex)) return
    operationsSelected += 1
    const scalar = discoverScalarRegion(calldata, decoded, located, operationIndex)
    if (scalar) scalarRegions.push(scalar)
    for (const field of hookDataFields(located.operation)) {
      hookDataFieldsSeen += 1
      if (hookDataFieldsConsidered >= limits.maxHookDataFields) continue
      hookDataFieldsConsidered += 1
      const region = discoverHookDataRegion({ calldata, decoded, located, operationIndex, field })
      if (region) hookRegions.push(region)
    }
  })

  let remaining = limits.maxMutableBytes
  const regions: UniswapV4MutableRegion[] = []
  for (const region of [...scalarRegions, ...hookRegions]) {
    const perField = region.field === 'hookData'
      ? evenlySpaced(region.allByteIndices, limits.maxHookDataBytesPerField)
      : [...region.allByteIndices].reverse()
    const selected = perField.slice(0, remaining).sort((left, right) => left - right)
    remaining -= selected.length
    if (selected.length > 0) {
      regions.push({
        operationIndex: region.operationIndex,
        operationKind: region.operationKind,
        location: region.location,
        field: region.field,
        ...(region.pathIndex === undefined ? {} : { pathIndex: region.pathIndex }),
        byteIndices: selected,
        totalValueBytes: region.totalValueBytes,
        truncated: selected.length < region.totalValueBytes,
      })
    }
  }

  const byteIndices = [...new Set(regions.flatMap((region) => region.byteIndices))].sort((left, right) => left - right)
  const signedPayloads = signedPayloadDigest(decoded)
  assertSignedPayloadsOutsideMask(calldata, signedPayloads, byteIndices)
  const candidateBytesWithinFieldLimits = scalarRegions.reduce((total, region) => total + region.totalValueBytes, 0)
    + hookRegions.reduce(
      (total, region) => total + Math.min(region.totalValueBytes, limits.maxHookDataBytesPerField),
      0,
    )
  const fieldLimitTruncated = hookRegions.some(
    (region) => region.totalValueBytes > limits.maxHookDataBytesPerField,
  )
  return {
    calldata,
    calldataBytes,
    byteIndices,
    signedPayloads,
    regions,
    operationsSeen: operations.length,
    operationsConsidered: considered.length,
    operationsSelected,
    hookDataFieldsSeen,
    hookDataFieldsConsidered,
    truncated: operations.length > considered.length
      || hookDataFieldsSeen > hookDataFieldsConsidered
      || fieldLimitTruncated
      || byteIndices.length < candidateBytesWithinFieldLimits
      || regions.some((region) => region.truncated),
  }
}

/** Returns null for an unrecognized or non-canonical calldata envelope. */
export function deriveUniswapV4MutationMask(
  calldata: Hex,
  options: UniswapV4MutationMaskOptions = {},
): UniswapV4MutationMask | null {
  const decoded = decodeUniswapV4Calldata(calldata)
  if (!decoded) return null
  const mask = deriveUniswapV4MutationMaskFromDecoded(decoded, options)
  return sameHex(mask.calldata, calldata) ? mask : null
}

/**
 * Verifies that a generated candidate keeps the exact canonical router
 * envelope and differs from its seed only at byte positions owned by the
 * conservative mutation mask.
 */
export function isUniswapV4MaskedDerivative(mask: UniswapV4MutationMask, candidate: Hex): boolean {
  if (byteLength(candidate) !== mask.calldataBytes) return false
  const decoded = decodeUniswapV4Calldata(candidate)
  if (!decoded || !sameHex(encodeUniswapV4Calldata(decoded), candidate)) return false
  if (signedPayloadDigest(decoded) !== mask.signedPayloads) return false

  const original = hexToBytes(mask.calldata)
  const mutated = hexToBytes(candidate)
  const allowed = new Set(mask.byteIndices)
  for (let index = 0; index < original.length; index++) {
    if (original[index] !== mutated[index] && !allowed.has(index)) return false
  }
  return true
}

/** Number of bytes whose values differ from the canonical seed. */
export function uniswapV4MutationDistance(mask: UniswapV4MutationMask, candidate: Hex): number {
  if (!isUniswapV4MaskedDerivative(mask, candidate)) return Number.POSITIVE_INFINITY
  const original = hexToBytes(mask.calldata)
  const mutated = hexToBytes(candidate)
  let distance = 0
  for (let index = 0; index < original.length; index++) {
    if (original[index] !== mutated[index]) distance += 1
  }
  return distance
}
