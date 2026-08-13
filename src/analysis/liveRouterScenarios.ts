import { getAddress, type Address, type Hex, type PublicClient } from 'viem'
import {
  cloneAndMutateUniswapV4Operation,
  decodeUniswapV4Calldata,
  encodeUniswapV4Calldata,
  locateUniswapV4Operations,
  UNIVERSAL_ROUTER_COMMANDS,
  type DecodedUniswapV4Calldata,
  type LocatedV4Operation,
  type UniversalRouterCommand,
  type V4ControlledOperation,
  type V4PathKey,
  type V4PoolKey,
} from '../adapters/uniswapV4RouterCodec'
import { computePoolId } from '../adapters/uniswapV4Pool'
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
  operationKind: V4ControlledOperation['kind']
  mutation: 'hook-data-empty' | 'hook-data-marker' | 'smaller-amount'
  calldata: Hex
}

export type LiveRouterScenarioResult = {
  scenario: LiveRouterScenario
  replay: ForkReplayResult
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

function matchingPathIndices(operation: V4ControlledOperation, poolId: Hex): number[] {
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

function operationMatchesPool(operation: V4ControlledOperation, poolId: Hex) {
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

function countOpaqueUniversalPositionTokenOperations(inputs: UniversalRouterCommand[]): number {
  let count = 0
  for (const command of inputs) {
    if (command.decoded?.kind === 'execute-sub-plan') {
      count += countOpaqueUniversalPositionTokenOperations(command.decoded.inputs)
      continue
    }
    if (command.commandType !== UNIVERSAL_ROUTER_COMMANDS.V4_POSITION_MANAGER_CALL || command.decoded) continue
    const nested = decodeUniswapV4Calldata(command.rawInput)
    if (nested?.kind !== 'position-manager') continue
    count += locateUniswapV4Operations(nested)
      .filter((item) => operationTokenId(item.operation) !== undefined).length
  }
  return count
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
  }
  const unique = new Map(scenarios.map((scenario) => [scenario.calldata.toLowerCase(), scenario]))
  return [...unique.values()].slice(0, 8)
}

function evidence(outcome: LiveRouterScenarioOutcome, result: LiveRouterScenarioResult): Evidence {
  const proof = result.replay.proof
  const firstStorage = proof.storageDiffs[0]
  return {
    id: `live-router:${outcome.poolId.slice(2, 14)}:${result.scenario.id}:${result.scenario.calldata.slice(-8)}`,
    detectorId: 'live-v4-router-variant',
    detectorVersion: '0.2.0',
    severity: 'info',
    evidenceClass: 'concrete-observation',
    subject: outcome.hook,
    title: `${result.scenario.description}: ${proof.success ? 'completed' : 'reverted'}`,
    claim: `The recognized official v4 router payload was replayed at the parent state of transaction ${outcome.transactionHash} with only the ${result.scenario.mutation.replaceAll('-', ' ')} field changed; it ${proof.success ? 'completed' : 'reverted'}.`,
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
      sessionMetrics: outcome.metrics,
    },
  }
}

function candidatePriority(outcome: PoolReplayOutcome) {
  if (outcome.kind === 'swap') return 0
  if (outcome.kind === 'modify-liquidity') return 1
  if (outcome.kind === 'donate') return 2
  return 3
}

type PositionLookupStats = LiveRouterScenarioCoverage['positionLookups']

async function selectContexts(input: {
  pools: PoolDescriptor[]
  replay: LivePoolReplayCoverage
  client: PublicClient
  signal: AbortSignal
}) {
  const { pools, replay, client, signal } = input
  const poolsById = new Map(pools.map((pool) => [pool.poolId.toLowerCase(), pool]))
  const selected = new Map<string, { pool: PoolDescriptor; outcome: PoolReplayOutcome; scenarios: LiveRouterScenario[] }>()
  const positionCache = new Map<string, Promise<PositionManagerPosition | undefined>>()
  const positionLookups: PositionLookupStats = { reads: 0, resolved: 0, unavailable: 0, nestedSkipped: 0, capped: 0 }
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
      if (decoded.kind === 'universal-router') {
        const nestedTokenOperations = tokenOperations.length + countOpaqueUniversalPositionTokenOperations(decoded.inputs)
        positionLookups.nestedSkipped += nestedTokenOperations
      } else {
        const tokenIds = [...new Set(tokenOperations.map((item) => operationTokenId(item.operation)!))]
        const boundedTokenIds = tokenIds.slice(0, 16)
        positionLookups.capped += Math.max(0, tokenIds.length - boundedTokenIds.length)
        await Promise.all(boundedTokenIds.map(async (tokenId) => {
          const cacheKey = `${candidate.transaction.to.toLowerCase()}:${candidate.stateBlockNumber}:${tokenId}`
          let lookup = positionCache.get(cacheKey)
          if (!lookup) {
            positionLookups.reads++
            lookup = fetchPositionManagerPosition({
              client,
              positionManager: candidate.transaction.to,
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
    }
    const scenarios = buildLiveRouterScenarios(pool, candidate.transaction.calldata, positionPoolIds)
    if (scenarios.length) selected.set(pool.poolId.toLowerCase(), { pool, outcome, scenarios })
  }
  return { contexts: [...selected.values()], positionLookups }
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
  createSession?: SessionFactory
  onProgress?: (completed: number, total: number, detail: string) => void
}): Promise<LiveRouterScenarioCoverage> {
  const eligiblePools = input.pools.filter((pool) => pool.hook !== '0x0000000000000000000000000000000000000000').length
  const selection = await selectContexts({ pools: input.pools, replay: input.replay, client: input.client, signal: input.signal })
  const { contexts, positionLookups } = selection
  const createSession = input.createSession ?? ((options) => new ForkExecutionSession(options))
  const outcomes: LiveRouterScenarioOutcome[] = []
  let cursor = 0
  let completed = 0
  const worker = async () => {
    while (true) {
      const context = contexts[cursor++]
      if (!context) return
      const candidate = context.outcome.candidate!
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
        outcomes.push({
          poolId: context.pool.poolId,
          hook: context.pool.hook,
          actor: candidate.transaction.caller,
          router: candidate.transaction.to,
          transactionHash: candidate.transactionHash,
          blockNumber: candidate.block.number.toString(),
          value: candidate.transaction.value.toString(),
          status: 'completed',
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
  const unrecognized = Math.max(0, eligiblePools - contexts.length)
  const failed = outcomes.filter((outcome) => outcome.status === 'failed')
  const limitations = [
    unrecognized ? `${unrecognized} hooked pool${unrecognized === 1 ? ' has' : 's have'} no receipt-matched canonical Universal Router or PositionManager payload for controlled mutation.` : undefined,
    failed.length ? `${failed.length} recognized router context${failed.length === 1 ? ' did' : 's did'} not complete its bounded variants.` : undefined,
    positionLookups.unavailable ? `${positionLookups.unavailable} pinned PositionManager token lookup${positionLookups.unavailable === 1 ? ' was' : 's were'} unavailable, so those liquidity actions were not attributed to a pool.` : undefined,
    positionLookups.nestedSkipped ? `${positionLookups.nestedSkipped} token-ID-only action${positionLookups.nestedSkipped === 1 ? ' was' : 's were'} nested under Universal Router; attribution was skipped because that envelope does not encode the PositionManager address.` : undefined,
    positionLookups.capped ? `${positionLookups.capped} token-ID-only action${positionLookups.capped === 1 ? ' exceeded' : 's exceeded'} the 16-position lookup budget for one transaction.` : undefined,
  ].filter((value): value is string => Boolean(value))
  return {
    status: eligiblePools > 0 && completedOutcomes.length === eligiblePools && failed.length === 0 ? 'passed' : 'degraded',
    eligiblePools,
    recognizedPools: completedOutcomes.length,
    scenarios: completedOutcomes.reduce((sum, outcome) => sum + outcome.results.length, 0),
    executions: outcomes.reduce((sum, outcome) => sum + outcome.results.length, 0),
    hydrationReads: outcomes.reduce((sum, outcome) => sum + (outcome.metrics?.rpcReads ?? 0), 0),
    positionLookups,
    outcomes,
    findings: completedOutcomes.flatMap((outcome) => outcome.results.map((result) => evidence(outcome, result))),
    limitations,
  }
}
