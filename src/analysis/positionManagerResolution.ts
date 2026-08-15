import type { Address, Hex } from 'viem'
import {
  UNIVERSAL_ROUTER_COMMANDS,
  decodeUniswapV4Calldata,
  locateUniswapV4Operations,
  type DecodedUniswapV4Calldata,
  type UniversalRouterCommand,
  type V4ControlledOperation,
} from '../adapters/uniswapV4RouterCodec'
import type { RevmCallEvidence } from './revmProof'

/**
 * A PositionManager payload the Universal Router forwards verbatim.
 *
 * The router calls its immutable `V4_POSITION_MANAGER` with these exact bytes
 * (`address(V4_POSITION_MANAGER).call{value: ...}(inputs)`), so the forwarded
 * length identifies the call inside an observed execution trace.
 */
export type ForwardedPositionManagerCall = {
  commandPath: number[]
  calldata: Hex
  calldataBytes: number
  tokenIds: bigint[]
  /**
   * False when the codec refused to decode the payload into controlled
   * operations. Those stay opaque, so resolving their PositionManager would
   * spend a pinned read that no scenario can use.
   */
  attributable: boolean
}

function byteLength(value: Hex) {
  return (value.length - 2) / 2
}

function sameAddress(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase()
}

export function operationTokenId(operation: V4ControlledOperation): bigint | undefined {
  if (
    operation.kind === 'increase-liquidity'
    || operation.kind === 'decrease-liquidity'
    || operation.kind === 'burn-position'
    || operation.kind === 'increase-liquidity-from-deltas'
  ) return operation.tokenId
}

function tokenIdsOf(calldata: Hex): bigint[] {
  const nested = decodeUniswapV4Calldata(calldata)
  if (nested?.kind !== 'position-manager') return []
  const ids = locateUniswapV4Operations(nested)
    .map((item) => operationTokenId(item.operation))
    .filter((tokenId): tokenId is bigint => tokenId !== undefined)
  return [...new Set(ids)]
}

function walk(commands: UniversalRouterCommand[], path: number[], found: ForwardedPositionManagerCall[]) {
  for (const command of commands) {
    const commandPath = [...path, command.index]
    if (command.decoded?.kind === 'execute-sub-plan') {
      walk(command.decoded.inputs, commandPath, found)
      continue
    }
    if (command.commandType !== UNIVERSAL_ROUTER_COMMANDS.V4_POSITION_MANAGER_CALL) continue
    const tokenIds = tokenIdsOf(command.rawInput)
    if (!tokenIds.length) continue
    found.push({
      commandPath,
      calldata: command.rawInput,
      calldataBytes: byteLength(command.rawInput),
      tokenIds,
      attributable: command.decoded?.kind === 'v4-position-manager-call',
    })
  }
}

/** Every token-ID-bearing PositionManager payload nested inside a Universal Router call. */
export function forwardedPositionManagerCalls(
  decoded: DecodedUniswapV4Calldata,
): ForwardedPositionManagerCall[] {
  if (decoded.kind !== 'universal-router') return []
  const found: ForwardedPositionManagerCall[] = []
  walk(decoded.inputs, [], found)
  return found
}

/**
 * Recovers the PositionManager address a Universal Router actually called,
 * from the call trace of its receipt-matched historical replay.
 *
 * The address is never inferred from the token ID or from a assumed global
 * deployment. A candidate must have been called by the router itself with a
 * payload of exactly the forwarded length; the caller then still has to confirm
 * the contract answers `getPoolAndPositionInfo` with a PoolKey that rebuilds the
 * selected PoolId, so a coincidental length match cannot become an attribution.
 *
 * Returns every distinct candidate. More than one means the trace is ambiguous
 * and the action must stay unattributed.
 */
export function observedPositionManagerTargets(input: {
  router: Address
  calls: readonly RevmCallEvidence[]
  forwardedBytes: number
}): Address[] {
  const targets = new Map<string, Address>()
  for (const call of input.calls) {
    if (!sameAddress(call.caller, input.router)) continue
    if (call.inputLength !== input.forwardedBytes) continue
    if (sameAddress(call.target, input.router)) continue
    targets.set(call.target.toLowerCase(), call.target as Address)
  }
  return [...targets.values()]
}
