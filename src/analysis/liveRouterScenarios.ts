import { getAddress, type Address, type Hex, type PublicClient } from 'viem'
import {
  cloneAndMutateUniswapV4Operation,
  decodeUniswapV4Calldata,
  encodeUniswapV4Calldata,
  locateUniswapV4Operations,
  type DecodedUniswapV4Calldata,
  type LocatedV4Operation,
  type V4ControlledOperation,
  type V4PathKey,
  type V4PoolKey,
} from '../adapters/uniswapV4RouterCodec'
import { computePoolId } from '../adapters/uniswapV4Pool'
import {
  decodeCustomV4UnlockCalldata,
  encodeCustomV4UnlockCalldata,
} from '../adapters/customV4UnlockRouterCodec'
import {
  contextKey,
  customRouterTechnical,
  type HistoricalRouterContext,
  type HistoricalRouterContexts,
} from '../data/historicalRouterContext'
import { collectSignedPayloads, signedPayloadLimitation, type SignedPayload } from '../adapters/uniswapV4SignedPayloads'
import { forwardedPositionManagerCalls, observedPositionManagerTargets } from './positionManagerResolution'
import { observationSummary, summarizeExecutionObservations } from './executionObservations'
import { currencyDeltaSummary, decodeCurrencyDeltas, deltasFullySettled } from './currencyDeltas'
import { dynamicFeeSummary, summarizeDynamicFees } from './poolEvents'
import { fetchPositionManagerPosition, type PositionManagerPosition } from '../data/positionManagerPosition'
import type { Evidence, PoolDescriptor } from '../domain/report'
import type { LivePoolReplayCoverage, PoolReplayOutcome } from './livePoolReplay'
import {
  ForkExecutionSession,
  type ForkReplayResult,
  type ForkSessionMetrics,
  type ForkStatePrefetch,
} from './revmProof'

const EMPTY_HOOK_DATA = '0x' as Hex
const MARKER_HOOK_DATA = '0x686f6f6b73636f7065' as Hex

export type LiveRouterScenario = {
  id: string
  description: string
  operationKind: V4ControlledOperation['kind'] | 'historical-envelope'
  mutation: 'hook-data-empty' | 'hook-data-marker' | 'smaller-amount' | 'flipped-direction' | 'widened-tick-range' | 'repeated-sequence' | 'historical-replay' | 'reduced-amount'
  calldata: Hex
}

export type LiveRouterScenarioResult = {
  scenario: LiveRouterScenario
  replay: ForkReplayResult
  /** Present only for the sequence probe: whether the committed first run succeeded. */
  sequenceFirstSucceeded?: boolean
}

export type LiveRouterScenarioOutcome = {
  poolId: Hex
  hook: Address
  actor?: Address
  router?: Address
  transactionHash?: Hex
  blockNumber?: string
  value?: string
  status: 'completed' | 'unsupported' | 'failed'
  reason?: string
  /** Pool currencies, retained so settlement deltas can be decoded from transient storage. */
  currencies?: [Address, Address]
  /** Pool key fee, so an observed fee can be compared with what the key advertises. */
  poolFee?: number
  /** Present when this pool's router was recognized as a pinned custom template. */
  recognizedTemplate?: HistoricalRouterContext
  results: LiveRouterScenarioResult[]
  metrics?: ForkSessionMetrics
}

export type LiveRouterScenarioCoverage = {
  status: 'passed' | 'degraded'
  eligiblePools: number
  recognizedPools: number
  scenarios: number
  executions: number
  hydrationReads: number
  positionLookups: {
    reads: number
    resolved: number
    unavailable: number
    nestedSkipped: number
    capped: number
    /** Nested PositionManager calls whose target was recovered from the replay trace. */
    observedTargets: number
    /** Nested token-ID actions left unattributed because the trace offered more than one candidate. */
    ambiguous: number
  }
  outcomes: LiveRouterScenarioOutcome[]
  findings: Evidence[]
  limitations: string[]
}

type RouterSession = Pick<ForkExecutionSession, 'prefetch' | 'execute' | 'metrics' | 'close'>
type SessionFactory = (input: { scanId: string; client: PublicClient; stateBlockNumber: bigint }) => RouterSession

function sameHex(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase()
}

function keyPoolId(key: V4PoolKey) {
  return computePoolId({
    currency0: key.currency0,
    currency1: key.currency1,
    fee: key.fee,
    tickSpacing: key.tickSpacing,
    hook: key.hooks,
  })
}

function pathPoolId(currentCurrency: Address, path: V4PathKey) {
  const currency0 = BigInt(currentCurrency) < BigInt(path.intermediateCurrency) ? currentCurrency : path.intermediateCurrency
  const currency1 = sameHex(currency0, currentCurrency) ? path.intermediateCurrency : currentCurrency
  return computePoolId({
    currency0,
    currency1,
    fee: path.fee,
    tickSpacing: path.tickSpacing,
    hook: path.hooks,
  })
}

export function matchingPathIndices(operation: V4ControlledOperation, poolId: Hex): number[] {
  if (operation.kind === 'swap-exact-in') {
    const matches: number[] = []
    let currency = operation.currencyIn
    operation.path.forEach((path, index) => {
      if (sameHex(pathPoolId(currency, path), poolId)) matches.push(index)
      currency = path.intermediateCurrency
    })
    return matches
  }
  if (operation.kind === 'swap-exact-out') {
    const matches: number[] = []
    let currency = operation.currencyOut
    for (let index = operation.path.length - 1; index >= 0; index--) {
      const path = operation.path[index]!
      if (sameHex(pathPoolId(currency, path), poolId)) matches.push(index)
      currency = path.intermediateCurrency
    }
    return matches
  }
  return []
}

export function operationMatchesPool(operation: V4ControlledOperation, poolId: Hex) {
  if (
    operation.kind === 'swap-exact-in-single'
    || operation.kind === 'swap-exact-out-single'
    || operation.kind === 'mint-position'
    || operation.kind === 'mint-position-from-deltas'
    || operation.kind === 'initialize-pool'
  ) return sameHex(keyPoolId(operation.poolKey), poolId)
  if (operation.kind === 'swap-exact-in' || operation.kind === 'swap-exact-out') {
    return matchingPathIndices(operation, poolId).length > 0
  }
  return false
}

function operationTokenId(operation: V4ControlledOperation): bigint | undefined {
  if (
    operation.kind === 'increase-liquidity'
    || operation.kind === 'decrease-liquidity'
    || operation.kind === 'burn-position'
    || operation.kind === 'increase-liquidity-from-deltas'
  ) return operation.tokenId
}

function operationMatchesResolvedPool(
  operation: V4ControlledOperation,
  poolId: Hex,
  positionPoolIds: ReadonlyMap<bigint, Hex>,
) {
  if (operationMatchesPool(operation, poolId)) return true
  const tokenId = operationTokenId(operation)
  const resolved = tokenId === undefined ? undefined : positionPoolIds.get(tokenId)
  return resolved !== undefined && sameHex(resolved, poolId)
}

function hookDataValues(current: Hex) {
  return [EMPTY_HOOK_DATA, MARKER_HOOK_DATA].filter((value) => !sameHex(value, current))
}

function smaller(value: bigint) {
  if (value <= 1n) return undefined
  return value / 2n || 1n
}

function operationHookData(operation: V4ControlledOperation): Hex | undefined {
  if ('hookData' in operation) return operation.hookData
}

function mutateHookData(operation: V4ControlledOperation, poolId: Hex, value: Hex) {
  if ('hookData' in operation) {
    operation.hookData = value
    return
  }
  if (operation.kind === 'swap-exact-in' || operation.kind === 'swap-exact-out') {
    for (const index of matchingPathIndices(operation, poolId)) operation.path[index]!.hookData = value
  }
}

/** Uniswap v4 tick bounds; a widened range must stay inside them to remain a valid position. */
const MIN_TICK = -887_272
const MAX_TICK = 887_272

function flipOperationDirection(operation: V4ControlledOperation) {
  if (operation.kind !== 'swap-exact-in-single' && operation.kind !== 'swap-exact-out-single') return false
  operation.zeroForOne = !operation.zeroForOne
  return true
}

/**
 * Widens a minted range by one tick spacing on each side.
 *
 * Both bounds stay spacing-aligned and inside the protocol tick range, so the
 * variant remains a position the PoolManager would accept.
 */
function widenOperationTickRange(operation: V4ControlledOperation, tickSpacing: number) {
  if (operation.kind !== 'mint-position' && operation.kind !== 'mint-position-from-deltas') return false
  if (!Number.isSafeInteger(tickSpacing) || tickSpacing <= 0) return false
  const lower = operation.tickLower - tickSpacing
  const upper = operation.tickUpper + tickSpacing
  if (lower < MIN_TICK || upper > MAX_TICK || lower >= upper) return false
  if (lower % tickSpacing !== 0 || upper % tickSpacing !== 0) return false
  operation.tickLower = lower
  operation.tickUpper = upper
  return true
}

function reduceOperationAmount(operation: V4ControlledOperation) {
  if (operation.kind === 'swap-exact-in-single' || operation.kind === 'swap-exact-in') {
    const value = smaller(operation.amountIn)
    if (value === undefined) return false
    operation.amountIn = value
    return true
  }
  if (operation.kind === 'swap-exact-out-single' || operation.kind === 'swap-exact-out') {
    const value = smaller(operation.amountOut)
    if (value === undefined) return false
    operation.amountOut = value
    return true
  }
  if (operation.kind === 'mint-position' || operation.kind === 'increase-liquidity' || operation.kind === 'decrease-liquidity') {
    const value = smaller(operation.liquidity)
    if (value === undefined) return false
    operation.liquidity = value
    return true
  }
  return false
}

function variantFrom(input: {
  decoded: DecodedUniswapV4Calldata
  located: LocatedV4Operation
  suffix: string
  description: string
  mutation: LiveRouterScenario['mutation']
  mutate: (operation: V4ControlledOperation) => void
}): LiveRouterScenario {
  const variant = cloneAndMutateUniswapV4Operation(input.decoded, input.located.location, input.mutate)
  return {
    id: `${input.located.operation.kind}:${input.suffix}`,
    description: input.description,
    operationKind: input.located.operation.kind,
    mutation: input.mutation,
    calldata: encodeUniswapV4Calldata(variant),
  }
}

export function buildLiveRouterScenarios(
  pool: PoolDescriptor,
  calldata: Hex,
  positionPoolIds: ReadonlyMap<bigint, Hex> = new Map(),
): LiveRouterScenario[] {
  const decoded = decodeUniswapV4Calldata(calldata)
  if (!decoded) return []
  const scenarios: LiveRouterScenario[] = []
  for (const located of locateUniswapV4Operations(decoded)) {
    if (!operationMatchesResolvedPool(located.operation, pool.poolId, positionPoolIds)) continue
    const directHookData = operationHookData(located.operation)
    const pathHookData = located.operation.kind === 'swap-exact-in' || located.operation.kind === 'swap-exact-out'
      ? located.operation.path[matchingPathIndices(located.operation, pool.poolId)[0]!]?.hookData
      : undefined
    const currentHookData = directHookData ?? pathHookData
    if (currentHookData !== undefined) {
      for (const value of hookDataValues(currentHookData)) {
        const marker = value === EMPTY_HOOK_DATA ? 'empty' : 'marker'
        scenarios.push(variantFrom({
          decoded,
          located,
          suffix: `hook-data-${marker}`,
          description: `${located.operation.kind} with ${marker === 'empty' ? 'empty' : 'alternate'} hookData`,
          mutation: marker === 'empty' ? 'hook-data-empty' : 'hook-data-marker',
          mutate: (operation) => mutateHookData(operation, pool.poolId, value),
        }))
      }
    }
    try {
      const reduced = cloneAndMutateUniswapV4Operation(decoded, located.location, (operation) => {
        if (!reduceOperationAmount(operation)) throw new Error('This operation has no safely reducible amount.')
      })
      const reducedCalldata = encodeUniswapV4Calldata(reduced)
      if (!sameHex(reducedCalldata, calldata)) {
        scenarios.push({
          id: `${located.operation.kind}:smaller-amount`,
          description: `${located.operation.kind} with a smaller amount and unchanged settlement commands`,
          operationKind: located.operation.kind,
          mutation: 'smaller-amount',
          calldata: reducedCalldata,
        })
      }
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('no safely reducible amount'))) throw error
    }

    for (const shape of [
      {
        suffix: 'flipped-direction',
        description: `${located.operation.kind} in the opposite direction with unchanged settlement commands`,
        mutation: 'flipped-direction' as const,
        apply: flipOperationDirection,
      },
      {
        suffix: 'widened-tick-range',
        description: `${located.operation.kind} across a range widened by one tick spacing`,
        mutation: 'widened-tick-range' as const,
        apply: (operation: V4ControlledOperation) => widenOperationTickRange(operation, pool.tickSpacing),
      },
    ]) {
      try {
        const variant = cloneAndMutateUniswapV4Operation(decoded, located.location, (operation) => {
          if (!shape.apply(operation)) throw new Error('This operation does not support the variant.')
        })
        const variantCalldata = encodeUniswapV4Calldata(variant)
        if (!sameHex(variantCalldata, calldata)) {
          scenarios.push({
            id: `${located.operation.kind}:${shape.suffix}`,
            description: shape.description,
            operationKind: located.operation.kind,
            mutation: shape.mutation,
            calldata: variantCalldata,
          })
        }
      } catch (error) {
        if (!(error instanceof Error && error.message.includes('does not support the variant'))) throw error
      }
    }
  }
  const unique = new Map(scenarios.map((scenario) => [scenario.calldata.toLowerCase(), scenario]))
  return [...unique.values()].slice(0, 8)
}

function evidence(
  outcome: LiveRouterScenarioOutcome,
  result: LiveRouterScenarioResult,
  poolManager: Address,
): Evidence {
  const proof = result.replay.proof
  const firstStorage = proof.storageDiffs[0]
  const observations = summarizeExecutionObservations(proof)
  const fees = summarizeDynamicFees({
    proof,
    poolManager,
    poolId: outcome.poolId,
    poolFee: outcome.poolFee ?? 0,
  })
  const deltas = decodeCurrencyDeltas({
    proof,
    poolManager,
    accounts: [outcome.actor, outcome.router, poolManager, outcome.hook].filter((value): value is Address => Boolean(value)),
    currencies: outcome.currencies ?? [],
  })
  const repeatedEnvelope = result.scenario.mutation === 'repeated-sequence'
  const historicalReplay = result.scenario.mutation === 'historical-replay'
  return {
    id: `live-router:${outcome.poolId.slice(2, 14)}:${result.scenario.id}:${result.scenario.calldata.slice(-8)}`,
    detectorId: 'live-v4-router-variant',
    detectorVersion: '0.2.0',
    severity: 'info',
    evidenceClass: 'concrete-observation',
    subject: outcome.hook,
    title: `${result.scenario.description}: ${proof.success ? 'completed' : 'reverted'}`,
    claim: historicalReplay
      ? `The exact historical custom-router payload from transaction ${outcome.transactionHash} reproduced its receipt and the execution trace reached both PoolManager and the selected hook; no calldata field was changed.`
      : repeatedEnvelope
      ? `The exact historical router payload from transaction ${outcome.transactionHash} was executed twice in one pinned session without changing its calldata; the second execution ${proof.success ? 'completed' : 'reverted'}.`
      : outcome.recognizedTemplate && outcome.recognizedTemplate.family !== 'official'
      ? `An attested custom router template was replayed at the parent state of transaction ${outcome.transactionHash} with only the input amount changed; it ${proof.success ? 'completed' : 'reverted'}. The template was derived from pinned runtime bytecode and reproduced execution, not from verified source or a published ABI.`
      : `The recognized historical v4 router payload was replayed at the parent state of transaction ${outcome.transactionHash} with only the ${result.scenario.mutation.replaceAll('-', ' ')} field changed; it ${proof.success ? 'completed' : 'reverted'}.`,
    confidence: 'confirmed',
    callPath: proof.calls.map((call) => getAddress(call.target)).slice(0, 64),
    storage: firstStorage ? [{ slot: firstStorage.slot, before: firstStorage.before, after: firstStorage.after }] : undefined,
    affectedPools: [outcome.poolId],
    witness: outcome.actor && outcome.router ? {
      from: outcome.actor,
      to: outcome.router,
      input: result.scenario.calldata,
      value: outcome.value ?? '0',
      blockNumber: outcome.blockNumber ?? 'historical-context',
      expectedOutcome: proof.success ? 'success' : 'revert',
    } : undefined,
    reproducibility: 'replayed',
    technical: {
      operationKind: result.scenario.operationKind,
      mutation: result.scenario.mutation,
      historicalTransaction: outcome.transactionHash,
      historicalRouter: outcome.router,
      engine: proof.engine,
      gasUsed: proof.gasUsed,
      calls: proof.calls,
      storageOperations: proof.storageOperations,
      observations: [observationSummary(observations), currencyDeltaSummary(deltas), dynamicFeeSummary(fees)].filter(Boolean).join(' · ') || undefined,
      dynamicFee: fees,
      currencyDeltas: deltas,
      deltasSettled: deltas.length ? deltasFullySettled(deltas) : undefined,
      logs: observations.logs.slice(0, 32),
      eventSignatures: observations.eventSignatures,
      netValueMovement: observations.netValueMovement,
      transientWrites: observations.transientWrites.slice(0, 32),
      externalSelectors: observations.externalSelectors,
      sessionMetrics: outcome.metrics,
      ...(outcome.recognizedTemplate ? customRouterTechnical(outcome.recognizedTemplate) : undefined),
    },
  }
}

/** Shared historical-context preference: a swap explains hook behavior more directly than an initialization. */
export function candidatePriority(outcome: PoolReplayOutcome) {
  if (outcome.kind === 'swap') return 0
  if (outcome.kind === 'modify-liquidity') return 1
  if (outcome.kind === 'donate') return 2
  return 3
}

type PositionLookupStats = LiveRouterScenarioCoverage['positionLookups']

/**
 * Conservative variants for a recognized custom-router payload.
 *
 * Only the amount word moves. Everything that decides which pool is reached, who
 * pays, and in which direction stays byte-identical, and every candidate is
 * re-decoded against the same pool before it is accepted.
 *
 * Deliberately not generated: hook-data variants, because this envelope exposes
 * no hook-data field; direction flips, because funding, native value and the
 * settlement currency would all have to change together; exact-output variants,
 * because the template was observed constructing an exact-input swap; and
 * recipient changes, because no recipient field is independently identified.
 */
export function customRouterScenarios(context: HistoricalRouterContext): LiveRouterScenario[] {
  if (context.family === 'official') return []
  const seed = context.decoded
  const variants: { id: string; label: string; amountIn: bigint }[] = [
    { id: 'half-amount', label: 'half the historical input amount', amountIn: seed.amountIn / 2n },
    { id: 'quarter-amount', label: 'one quarter of the historical input amount', amountIn: seed.amountIn / 4n },
    { id: 'amount-minus-one', label: 'one unit below the historical input amount', amountIn: seed.amountIn - 1n },
  ]

  const scenarios: LiveRouterScenario[] = []
  for (const variant of variants) {
    if (variant.amountIn <= 0n || variant.amountIn >= seed.amountIn) continue
    let calldata: Hex
    try {
      calldata = encodeCustomV4UnlockCalldata(seed, { amountIn: variant.amountIn })
    } catch {
      continue
    }
    // A generated payload only ships if it still decodes to the same pool.
    const check = decodeCustomV4UnlockCalldata(calldata, {
      poolKey: seed.poolKey,
      poolId: seed.poolId,
      transactionValue: 0n,
    })
    if (!check.ok || check.decoded.poolId.toLowerCase() !== seed.poolId.toLowerCase()) continue
    if (check.decoded.zeroForOne !== seed.zeroForOne) continue
    if (check.decoded.settlementCurrency.toLowerCase() !== seed.settlementCurrency.toLowerCase()) continue
    scenarios.push({
      id: `custom-router:${variant.id}`,
      description: `the recognized custom-router payload with ${variant.label}`,
      operationKind: 'historical-envelope',
      mutation: 'reduced-amount',
      calldata,
    })
  }
  return scenarios
}

async function selectContexts(input: {
  pools: PoolDescriptor[]
  replay: LivePoolReplayCoverage
  client: PublicClient
  poolManager: Address
  signal: AbortSignal
  routerContexts?: HistoricalRouterContexts
}) {
  const { pools, replay, client, poolManager, signal } = input
  const poolsById = new Map(pools.map((pool) => [pool.poolId.toLowerCase(), pool]))
  const selected = new Map<string, {
    pool: PoolDescriptor
    outcome: PoolReplayOutcome
    scenarios: LiveRouterScenario[]
    canonicalEnvelope: boolean
    recognizedTemplate?: HistoricalRouterContext
  }>()
  const positionCache = new Map<string, Promise<PositionManagerPosition | undefined>>()
  const positionLookups: PositionLookupStats = { reads: 0, resolved: 0, unavailable: 0, nestedSkipped: 0, capped: 0, observedTargets: 0, ambiguous: 0 }
  const signedPayloads: SignedPayload[] = []
  const candidates = replay.outcomes
    .filter((outcome) => outcome.status === 'passed' && outcome.candidate)
    .sort((left, right) => candidatePriority(left) - candidatePriority(right))
  for (const outcome of candidates) {
    const pool = poolsById.get(outcome.poolId.toLowerCase())
    if (!pool || selected.has(pool.poolId.toLowerCase())) continue
    if (signal.aborted) throw new DOMException('Live router scenarios cancelled', 'AbortError')
    const candidate = outcome.candidate!
    const decoded = decodeUniswapV4Calldata(candidate.transaction.calldata)
    const positionPoolIds = new Map<bigint, Hex>()
    if (decoded) {
      const located = locateUniswapV4Operations(decoded)
      const tokenOperations = located.filter((item) => operationTokenId(item.operation) !== undefined)
      const resolve = async (positionManager: Address, tokenIds: bigint[]) => {
        const bounded = tokenIds.slice(0, 16)
        positionLookups.capped += Math.max(0, tokenIds.length - bounded.length)
        await Promise.all(bounded.map(async (tokenId) => {
          const cacheKey = `${positionManager.toLowerCase()}:${candidate.stateBlockNumber}:${tokenId}`
          let lookup = positionCache.get(cacheKey)
          if (!lookup) {
            positionLookups.reads++
            lookup = fetchPositionManagerPosition({
              client,
              positionManager,
              tokenId,
              blockNumber: candidate.stateBlockNumber,
              signal,
            }).then((position) => {
              positionLookups.resolved++
              return position
            }).catch((error: unknown) => {
              if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
              positionLookups.unavailable++
              return undefined
            })
            positionCache.set(cacheKey, lookup)
          }
          const position = await lookup
          if (position) positionPoolIds.set(tokenId, position.poolId)
        }))
      }

      if (decoded.kind === 'universal-router') {
        // The outer envelope never names the PositionManager, so recover it from
        // the call the router actually made during its receipt-matched replay.
        for (const forwarded of forwardedPositionManagerCalls(decoded)) {
          if (!forwarded.attributable) {
            positionLookups.nestedSkipped += forwarded.tokenIds.length
            continue
          }
          const targets = observedPositionManagerTargets({
            router: candidate.transaction.to,
            calls: outcome.replay?.proof.calls ?? [],
            forwardedBytes: forwarded.calldataBytes,
          })
          if (targets.length !== 1) {
            positionLookups.nestedSkipped += forwarded.tokenIds.length
            if (targets.length > 1) positionLookups.ambiguous += forwarded.tokenIds.length
            continue
          }
          positionLookups.observedTargets++
          await resolve(targets[0]!, forwarded.tokenIds)
        }
      } else {
        await resolve(candidate.transaction.to, [...new Set(tokenOperations.map((item) => operationTokenId(item.operation)!))])
      }
    }
    const scenarios = buildLiveRouterScenarios(pool, candidate.transaction.calldata, positionPoolIds)
    const calls = outcome.replay?.proof.calls ?? []
    const reachedPoolManager = calls.some((call) => sameHex(call.target, poolManager))
      && calls.some((call) => sameHex(call.target, pool.hook))
    if (scenarios.length || reachedPoolManager) {
    // A recognized custom router earns conservative amount variants. It is not
    // an official envelope, so it keeps its own flag and its own report wording.
    const recognized = input.routerContexts?.byTransaction.get(contextKey(pool.poolId, candidate.transactionHash))
    const custom = recognized ? customRouterScenarios(recognized) : []
    if (custom.length) {
      selected.set(pool.poolId.toLowerCase(), {
        pool, outcome, scenarios: custom, canonicalEnvelope: false, recognizedTemplate: recognized,
      })
      continue
    }
    selected.set(pool.poolId.toLowerCase(), { pool, outcome, scenarios, canonicalEnvelope: scenarios.length > 0 })
      if (decoded) for (const signed of collectSignedPayloads(decoded)) signedPayloads.push(signed)
    }
  }
  return { contexts: [...selected.values()], positionLookups, signedPayloads }
}

export async function runLiveRouterScenarios(input: {
  scanId: string
  client: PublicClient
  poolManager: Address
  pools: PoolDescriptor[]
  replay: LivePoolReplayCoverage
  signal: AbortSignal
  maxWorkers?: number
  timeoutMs?: number
  maxHydrationRequests?: number
  /** Recognized router families, prepared once after replay and shared with exploration. */
  routerContexts?: HistoricalRouterContexts
  createSession?: SessionFactory
  onProgress?: (completed: number, total: number, detail: string) => void
}): Promise<LiveRouterScenarioCoverage> {
  const eligiblePools = input.pools.filter((pool) => pool.hook !== '0x0000000000000000000000000000000000000000').length
  const selection = await selectContexts({
    pools: input.pools,
    replay: input.replay,
    client: input.client,
    poolManager: input.poolManager,
    signal: input.signal,
    routerContexts: input.routerContexts,
  })
  const { contexts, positionLookups, signedPayloads } = selection
  const createSession = input.createSession ?? ((options) => new ForkExecutionSession(options))
  const outcomes: LiveRouterScenarioOutcome[] = []
  let cursor = 0
  let completed = 0
  const worker = async () => {
    while (true) {
      const context = contexts[cursor++]
      if (!context) return
      const candidate = context.outcome.candidate!
      if (!context.canonicalEnvelope && !context.scenarios.length && context.outcome.replay) {
        outcomes.push({
          poolId: context.pool.poolId,
          hook: context.pool.hook,
          actor: candidate.transaction.caller,
          router: candidate.transaction.to,
          transactionHash: candidate.transactionHash,
          blockNumber: candidate.block.number.toString(),
          value: candidate.transaction.value.toString(),
          status: 'completed',
          currencies: [context.pool.currency0, context.pool.currency1],
          poolFee: context.pool.fee,
          results: [{
            scenario: {
              id: 'historical-custom-router-replay',
              description: 'the exact historical custom-router payload reaching PoolManager and the selected hook',
              operationKind: 'historical-envelope',
              mutation: 'historical-replay',
              calldata: candidate.transaction.calldata,
            },
            replay: context.outcome.replay,
          }],
        })
        completed++
        input.onProgress?.(completed, contexts.length, `${completed}/${contexts.length} traced router contexts checked`)
        continue
      }
      const session = createSession({ scanId: `${input.scanId}-live-router-${completed}`, client: input.client, stateBlockNumber: candidate.stateBlockNumber })
      const results: LiveRouterScenarioResult[] = []
      try {
        const prefetch: ForkStatePrefetch = {
          accounts: [candidate.transaction.caller, candidate.transaction.to, input.poolManager, context.pool.hook, context.pool.currency0, context.pool.currency1],
        }
        await session.prefetch(prefetch)
        for (const scenario of context.scenarios) {
          if (input.signal.aborted) throw new DOMException('Live router scenarios cancelled', 'AbortError')
          input.onProgress?.(completed, contexts.length, `${scenario.operationKind} · ${scenario.mutation}`)
          const replay = await session.execute({
            transaction: { ...candidate.transaction, calldata: scenario.calldata, traceLimit: 2_048 },
            block: candidate.block,
            signal: input.signal,
            timeoutMs: input.timeoutMs ?? 15_000,
            maxHydrationRequests: input.maxHydrationRequests ?? 1_024,
          })
          results.push({ scenario, replay })
        }

        // Sequence probe, run last because it commits: the same canonical payload
        // twice in one session. A hook gated on transient state or a one-shot
        // permission behaves differently on the second execution, and nothing
        // that only ever runs a single transaction can observe that.
        if (!input.signal.aborted) {
          const sequenced = { ...candidate.transaction, traceLimit: 2_048 }
          const execute = (commit: boolean) => session.execute({
            transaction: sequenced,
            block: candidate.block,
            signal: input.signal,
            timeoutMs: input.timeoutMs ?? 15_000,
            maxHydrationRequests: input.maxHydrationRequests ?? 1_024,
            commit,
          })
          const first = await execute(true)
          const second = await execute(false)
          results.push({
            scenario: {
              id: 'repeated-sequence',
              description: 'the historical payload executed twice in one committed session; the second execution is observed',
              operationKind: context.scenarios[0]?.operationKind ?? 'historical-envelope',
              mutation: 'repeated-sequence',
              calldata: candidate.transaction.calldata,
            },
            replay: second,
            // The first execution is context for the second, not a separate claim.
            sequenceFirstSucceeded: first.proof.success,
          })
        }
        outcomes.push({
          poolId: context.pool.poolId,
          hook: context.pool.hook,
          actor: candidate.transaction.caller,
          router: candidate.transaction.to,
          transactionHash: candidate.transactionHash,
          blockNumber: candidate.block.number.toString(),
          value: candidate.transaction.value.toString(),
          status: 'completed',
          currencies: [context.pool.currency0, context.pool.currency1],
          poolFee: context.pool.fee,
          recognizedTemplate: context.recognizedTemplate,
          results,
          metrics: session.metrics(),
        })
      } catch (error) {
        if (input.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
        outcomes.push({
          poolId: context.pool.poolId,
          hook: context.pool.hook,
          actor: candidate.transaction.caller,
          router: candidate.transaction.to,
          transactionHash: candidate.transactionHash,
          blockNumber: candidate.block.number.toString(),
          value: candidate.transaction.value.toString(),
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error),
          results,
          metrics: session.metrics(),
        })
      } finally {
        session.close()
        completed++
        input.onProgress?.(completed, contexts.length, `${completed}/${contexts.length} recognized router contexts checked`)
      }
    }
  }
  const concurrency = Math.max(1, Math.min(input.maxWorkers ?? 2, contexts.length || 1))
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  const completedOutcomes = outcomes.filter((outcome) => outcome.status === 'completed')
  const canonicalContexts = contexts.filter((context) => context.canonicalEnvelope).length
  const unrecognized = Math.max(0, eligiblePools - canonicalContexts)
  const failed = outcomes.filter((outcome) => outcome.status === 'failed')
  const limitations = [
    unrecognized ? `${unrecognized} hooked pool${unrecognized === 1 ? ' has' : 's have'} no receipt-matched supported Universal Router or PositionManager envelope for controlled mutation. Its exact historical custom-router execution is still reported when the receipt-matched trace reaches both PoolManager and the selected hook.` : undefined,
    failed.length ? `${failed.length} recognized router context${failed.length === 1 ? ' did' : 's did'} not complete its bounded variants.` : undefined,
    positionLookups.unavailable ? `${positionLookups.unavailable} pinned PositionManager token lookup${positionLookups.unavailable === 1 ? ' was' : 's were'} unavailable, so those liquidity actions were not attributed to a pool.` : undefined,
    positionLookups.nestedSkipped ? `${positionLookups.nestedSkipped} token-ID-only action${positionLookups.nestedSkipped === 1 ? ' was' : 's were'} nested under Universal Router and stayed unattributed because the replay trace did not identify exactly one forwarded PositionManager call.` : undefined,
    positionLookups.ambiguous ? `${positionLookups.ambiguous} nested token-ID action${positionLookups.ambiguous === 1 ? '' : 's'} matched more than one observed call target, so no PositionManager was attributed.` : undefined,
    positionLookups.observedTargets ? `${positionLookups.observedTargets} nested PositionManager call${positionLookups.observedTargets === 1 ? ' was' : 's were'} attributed from the address the router actually called during receipt-matched replay, then confirmed by a pinned \`getPoolAndPositionInfo\` read.` : undefined,
    positionLookups.capped ? `${positionLookups.capped} token-ID-only action${positionLookups.capped === 1 ? ' exceeded' : 's exceeded'} the 16-position lookup budget for one transaction.` : undefined,
    signedPayloadLimitation(signedPayloads),
  ].filter((value): value is string => Boolean(value))
  return {
    status: eligiblePools > 0 && canonicalContexts === eligiblePools && completedOutcomes.length === eligiblePools && failed.length === 0 ? 'passed' : 'degraded',
    eligiblePools,
    recognizedPools: canonicalContexts,
    scenarios: completedOutcomes.reduce((sum, outcome) => sum + outcome.results.length, 0),
    executions: outcomes.reduce((sum, outcome) => sum + outcome.results.length, 0),
    hydrationReads: outcomes.reduce((sum, outcome) => sum + (outcome.metrics?.rpcReads ?? 0), 0),
    positionLookups,
    outcomes,
    findings: completedOutcomes.flatMap((outcome) => outcome.results.map((result) => evidence(outcome, result, input.poolManager))),
    limitations,
  }
}
