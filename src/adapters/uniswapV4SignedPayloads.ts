import { toFunctionSelector, type Hex } from 'viem'
import type {
  DecodedUniswapV4Calldata,
  PositionManagerCall,
  UniversalRouterCommand,
} from './uniswapV4RouterCodec'

/**
 * Universal Router commands whose input carries an EIP-712 signature.
 * Pinned to https://github.com/Uniswap/universal-router/blob/2.2.0/contracts/libraries/Commands.sol
 */
export const UNIVERSAL_ROUTER_SIGNED_COMMANDS = {
  PERMIT2_PERMIT_BATCH: 0x03,
  PERMIT2_PERMIT: 0x0a,
  V3_POSITION_MANAGER_PERMIT: 0x11,
} as const

export type SignedPayloadStandard =
  | 'permit2-permit'
  | 'permit2-permit-batch'
  | 'v3-position-manager-permit'
  | 'erc721-permit'
  | 'erc721-permit-for-all'
  | 'permit2-forwarder-permit'
  | 'permit2-forwarder-permit-batch'

/**
 * What each signed message commits to. A mutation that stays outside these
 * fields leaves the original signature valid; a mutation inside them does not.
 */
const COMMITMENTS: Record<SignedPayloadStandard, string> = {
  'permit2-permit': 'token, amount, expiration, nonce, spender, and signature deadline',
  'permit2-permit-batch': 'a batch of token/amount/expiration/nonce entries, spender, and signature deadline',
  'v3-position-manager-permit': 'spender, token ID, nonce, and deadline of a v3 position',
  'erc721-permit': 'spender, token ID, nonce, and deadline',
  'erc721-permit-for-all': 'operator, approval flag, nonce, and deadline',
  'permit2-forwarder-permit': 'token, amount, expiration, nonce, spender, and signature deadline',
  'permit2-forwarder-permit-batch': 'a batch of token/amount/expiration/nonce entries, spender, and signature deadline',
}

const PERMIT_DETAILS = '(address,uint160,uint48,uint48)'

/** PositionManager entrypoints that verify a signature, reachable directly or inside `multicall`. */
const SIGNED_SELECTORS: Record<string, SignedPayloadStandard> = {
  [toFunctionSelector('permit(address,uint256,uint256,uint256,bytes)').toLowerCase()]: 'erc721-permit',
  [toFunctionSelector('permitForAll(address,address,bool,uint256,uint256,bytes)').toLowerCase()]: 'erc721-permit-for-all',
  [toFunctionSelector(`permit(address,(${PERMIT_DETAILS},address,uint256),bytes)`).toLowerCase()]: 'permit2-forwarder-permit',
  [toFunctionSelector(`permitBatch(address,(${PERMIT_DETAILS}[],address,uint256),bytes)`).toLowerCase()]: 'permit2-forwarder-permit-batch',
}

const SIGNED_COMMAND_STANDARDS: Record<number, SignedPayloadStandard> = {
  [UNIVERSAL_ROUTER_SIGNED_COMMANDS.PERMIT2_PERMIT_BATCH]: 'permit2-permit-batch',
  [UNIVERSAL_ROUTER_SIGNED_COMMANDS.PERMIT2_PERMIT]: 'permit2-permit',
  [UNIVERSAL_ROUTER_SIGNED_COMMANDS.V3_POSITION_MANAGER_PERMIT]: 'v3-position-manager-permit',
}

export type SignedPayloadLocation = {
  root: 'universal-router' | 'position-manager'
  /** Command index path, following `EXECUTE_SUB_PLAN` nesting. */
  commandPath?: number[]
  /** Multicall item index path inside a PositionManager call. */
  multicallPath?: number[]
}

export type SignedPayload = {
  standard: SignedPayloadStandard
  location: SignedPayloadLocation
  /** The exact authorization bytes. Mutating them would invalidate the original signature. */
  bytes: Hex
  /** Plain-language description of what the EIP-712 message commits to. */
  covers: string
}

function selectorOf(calldata: Hex): string {
  return calldata.length >= 10 ? calldata.slice(0, 10).toLowerCase() : ''
}

function payload(
  standard: SignedPayloadStandard,
  location: SignedPayloadLocation,
  bytes: Hex,
): SignedPayload {
  return { standard, location, bytes, covers: COMMITMENTS[standard] }
}

function fromPositionManagerCall(
  call: PositionManagerCall,
  root: SignedPayloadLocation['root'],
  commandPath: number[] | undefined,
  multicallPath: number[],
): SignedPayload[] {
  if (call.kind !== 'multicall') return []
  return call.calls.flatMap((item) => {
    const path = [...multicallPath, item.index]
    const standard = SIGNED_SELECTORS[selectorOf(item.rawCalldata)]
    if (standard) {
      return [payload(standard, { root, ...(commandPath ? { commandPath } : {}), multicallPath: path }, item.rawCalldata)]
    }
    return item.call ? fromPositionManagerCall(item.call, root, commandPath, path) : []
  })
}

function fromCommands(commands: UniversalRouterCommand[], commandPath: number[]): SignedPayload[] {
  return commands.flatMap((command) => {
    const path = [...commandPath, command.index]
    const standard = SIGNED_COMMAND_STANDARDS[command.commandType]
    if (standard) return [payload(standard, { root: 'universal-router', commandPath: path }, command.rawInput)]
    if (command.decoded?.kind === 'execute-sub-plan') return fromCommands(command.decoded.inputs, path)
    if (command.decoded?.kind === 'v4-position-manager-call') {
      return fromPositionManagerCall(command.decoded.call, 'universal-router', path, [])
    }
    return []
  })
}

/**
 * Finds every signature-bearing payload inside a decoded v4 call.
 *
 * These bytes are treated as immutable. The codec already preserves them
 * byte-for-byte because it never decodes them into mutable fields; this pass
 * makes them visible so a report can state what was deliberately left untouched
 * instead of leaving it implicit.
 */
export function collectSignedPayloads(decoded: DecodedUniswapV4Calldata): SignedPayload[] {
  if (decoded.kind === 'universal-router') return fromCommands(decoded.inputs, [])
  return fromPositionManagerCall(decoded.call, 'position-manager', undefined, [])
}

/** Stable identity of every signed payload, for asserting they survive a mutation unchanged. */
export function signedPayloadDigest(decoded: DecodedUniswapV4Calldata): string {
  return collectSignedPayloads(decoded)
    .map((item) => `${item.standard}:${item.bytes.toLowerCase()}`)
    .join('|')
}

/** True when a generated candidate carries byte-identical signed payloads. */
export function signedPayloadsPreserved(
  original: DecodedUniswapV4Calldata,
  candidate: DecodedUniswapV4Calldata,
): boolean {
  return signedPayloadDigest(original) === signedPayloadDigest(candidate)
}

/** One report-ready sentence, or undefined when the call carries no signatures. */
export function signedPayloadLimitation(payloads: SignedPayload[]): string | undefined {
  if (!payloads.length) return undefined
  const standards = [...new Set(payloads.map((item) => item.standard))].sort().join(', ')
  return `${payloads.length} signed payload${payloads.length === 1 ? '' : 's'} (${standards}) were replayed byte-identically and were never mutated, so each original signature stayed valid. Generated variants changed only fields outside the signed messages, which commit to ${[...new Set(payloads.map((item) => item.covers))].join('; ')}.`
}
