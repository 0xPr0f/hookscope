import { decodeErrorResult, parseAbi, type Address, type Hex } from 'viem'
import type { SelectorSignatureCandidate, SelectorSignatureLookup } from '../data/signatureDatabase'
import type { RevmExecutionProof } from './revmProof'
import { decodePoolManagerSwaps } from './poolEvents'

/**
 * Small, report-safe diagnostics for generated PoolManager scenarios.
 *
 * These values explain an already observed execution. Known protocol errors are
 * decoded authoritatively. An optional Sourcify 4byte result can label other
 * selectors, but it remains an explicit candidate because four-byte selectors
 * can collide and do not prove the target contract's ABI.
 */

const KNOWN_REVERTS = parseAbi([
  'error Error(string message)',
  'error Panic(uint256 code)',
  'error NoLiquidityToReceiveFees()',
  'error PoolAlreadyInitialized()',
  'error PoolNotInitialized()',
  'error PriceLimitAlreadyExceeded(uint160 sqrtPriceCurrentX96, uint160 sqrtPriceLimitX96)',
  'error PriceLimitOutOfBounds(uint160 sqrtPriceLimitX96)',
  'error InvalidFeeForExactOut()',
  'error CurrencyNotSettled()',
  'error SwapAmountCannotBeZero()',
  'error InvalidHookResponse()',
  'error HookCallFailed()',
  'error HookDeltaExceedsSwapAmount()',
  'error UnsettledDelta(address currency, int256 delta)',
  'error WrappedError(address target, bytes4 selector, bytes reason, bytes details)',
])

export type ProtocolRevertDiagnostic = {
  selector: Hex
  name: string
  summary: string
  data: Hex
  target?: Address
  nested?: ProtocolRevertDiagnostic
  signature?: string
  signatureSource?: 'sourcify-4byte'
  signatureCandidates?: string[]
  signatureFoundInVerifiedContract?: boolean
}

export type ProtocolSwapMovement = {
  events: number
  movedEvents: number
  zeroMovement: boolean
  deltas: { amount0: string; amount1: string }[]
}

function selectorOf(data: Hex) {
  return (data.length >= 10 ? data.slice(0, 10) : data) as Hex
}

function serializableArgs(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(serializableArgs)
  return value
}

function knownSummary(name: string, args: readonly unknown[]) {
  if (name === 'NoLiquidityToReceiveFees') {
    return 'The pool had zero active liquidity at the current tick, so Uniswap could not distribute the donation to in-range LPs.'
  }
  if (name === 'PoolAlreadyInitialized') return 'The selected PoolId was already initialized, so the second initialize call was rejected as expected.'
  if (name === 'PoolNotInitialized') return 'The PoolManager did not consider this PoolKey initialized at the pinned state.'
  if (name === 'PriceLimitAlreadyExceeded') return 'The generated swap price limit was already behind the pool price for this direction.'
  if (name === 'PriceLimitOutOfBounds') return 'The generated swap price limit was outside the protocol bounds.'
  if (name === 'InvalidFeeForExactOut') return 'This pool fee configuration does not permit that exact-output swap.'
  if (name === 'CurrencyNotSettled') return 'At least one PoolManager currency delta remained unsettled when unlock returned.'
  if (name === 'SwapAmountCannotBeZero') return 'The PoolManager rejected a zero-amount swap.'
  if (name === 'InvalidHookResponse') return 'The hook returned a selector or tuple shape the PoolManager did not accept.'
  if (name === 'HookCallFailed') return 'The PoolManager could not complete the configured hook callback.'
  if (name === 'HookDeltaExceedsSwapAmount') return 'The hook-returned delta exceeded the swap amount allowed by the PoolManager.'
  if (name === 'UnsettledDelta') return `The scenario harness still had currency delta ${String(args[1] ?? '?')} for ${String(args[0] ?? 'an unknown currency')} after settlement.`
  if (name === 'Error') return `The call reverted with message: ${String(args[0] ?? 'unknown')}`
  if (name === 'Panic') return `The EVM raised Solidity panic code ${String(args[0] ?? 'unknown')}.`
  return `The call reverted with ${name}${args.length ? `(${args.map((value) => String(serializableArgs(value))).join(', ')})` : '()'}.`
}

function decodeSignatureCandidate(data: Hex, candidate: SelectorSignatureCandidate) {
  try {
    // Sourcify names arrive at runtime, while viem's human-readable ABI helper
    // normally validates literals at compile time. The fetch boundary already
    // constrains the string; parseAbi remains the runtime syntax validator.
    const abi = parseAbi([`error ${candidate.name}`] as never)
    const decoded = decodeErrorResult({ abi, data })
    return {
      name: decoded.errorName,
      args: Array.isArray(decoded.args) ? decoded.args : [],
    }
  } catch {
    return undefined
  }
}

function candidateDiagnostic(
  data: Hex,
  selector: Hex,
  signatures: SelectorSignatureLookup | undefined,
): ProtocolRevertDiagnostic | undefined {
  const candidates = signatures?.[selector.toLowerCase()] ?? []
  if (!candidates.length) return undefined
  const decoded = candidates.flatMap((candidate) => {
    const result = decodeSignatureCandidate(data, candidate)
    return result ? [{ candidate, ...result }] : []
  })
  const selected = decoded[0]
  const names = candidates.map((candidate) => candidate.name)
  if (!selected) {
    return {
      selector,
      name: 'UnknownRevert',
      summary: `The call reverted with selector ${selector}; Sourcify 4byte candidates are ${names.join(', ')}, but none matched the returned data shape.`,
      data,
      signatureSource: 'sourcify-4byte',
      signatureCandidates: names,
      signatureFoundInVerifiedContract: candidates.some((candidate) => candidate.hasVerifiedContract),
    }
  }
  const renderedArgs = selected.args.length
    ? ` with decoded values (${selected.args.map((value) => String(serializableArgs(value))).join(', ')})`
    : ''
  return {
    selector,
    name: selected.name,
    summary: `The call reverted with ${selected.candidate.name}${renderedArgs} (selector ${selector}; Sourcify 4byte${selected.candidate.hasVerifiedContract ? ' verified-contract' : ''} candidate).`,
    data,
    signature: selected.candidate.name,
    signatureSource: 'sourcify-4byte',
    signatureCandidates: names,
    signatureFoundInVerifiedContract: selected.candidate.hasVerifiedContract,
  }
}

export function decodeProtocolRevert(
  data: Hex | undefined,
  signatures?: SelectorSignatureLookup,
  depth = 0,
): ProtocolRevertDiagnostic | undefined {
  if (!data || data === '0x') return undefined
  const selector = selectorOf(data)
  try {
    const decoded = decodeErrorResult({ abi: KNOWN_REVERTS, data })
    const args = Array.isArray(decoded.args) ? decoded.args : []
    if (decoded.errorName === 'WrappedError') {
      const [target, , reason] = args as readonly [Address, Hex, Hex, Hex]
      const nested = depth < 2 ? decodeProtocolRevert(reason, signatures, depth + 1) : undefined
      return {
        selector,
        name: decoded.errorName,
        summary: nested
          ? `A PoolManager callback on ${target} reverted: ${nested.summary}`
          : `A PoolManager callback on ${target} reverted with selector ${selectorOf(reason)}.`,
        data,
        target,
        nested,
      }
    }
    return {
      selector,
      name: decoded.errorName,
      summary: knownSummary(decoded.errorName, args),
      data,
    }
  } catch {
    return candidateDiagnostic(data, selector, signatures) ?? {
      selector,
      name: 'UnknownRevert',
      summary: `The call reverted with unrecognized selector ${selector}; no error name was guessed.`,
      data,
    }
  }
}

export function unresolvedProtocolRevertSelectors(data: Hex | undefined): Hex[] {
  const diagnostic = decodeProtocolRevert(data)
  if (!diagnostic) return []
  const selectors: Hex[] = []
  let current: ProtocolRevertDiagnostic | undefined = diagnostic
  while (current) {
    if (current.name === 'UnknownRevert' && current.selector.length === 10) selectors.push(current.selector)
    current = current.nested
  }
  return [...new Set(selectors)]
}

export function summarizeProtocolSwapMovement(input: {
  proof: RevmExecutionProof
  poolManager: Address
  poolId: Hex
}): ProtocolSwapMovement | undefined {
  const swaps = decodePoolManagerSwaps(input.proof, input.poolManager)
    .filter((swap) => swap.poolId.toLowerCase() === input.poolId.toLowerCase())
  if (!swaps.length) return undefined
  const movedEvents = swaps.filter((swap) => swap.amount0 !== 0n || swap.amount1 !== 0n).length
  return {
    events: swaps.length,
    movedEvents,
    zeroMovement: movedEvents === 0,
    deltas: swaps.slice(0, 8).map((swap) => ({
      amount0: swap.amount0.toString(),
      amount1: swap.amount1.toString(),
    })),
  }
}
