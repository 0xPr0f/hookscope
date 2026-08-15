import type { Address, Hex, PublicClient } from 'viem'
import {
  decodeUniswapV4Calldata,
  locateUniswapV4Operations,
} from '../adapters/uniswapV4RouterCodec'
import { collectSignedPayloads, signedPayloadLimitation } from '../adapters/uniswapV4SignedPayloads'
import type { Evidence, PoolDescriptor } from '../domain/report'
import type { PoolReplayCandidate } from '../data/replay'
import { assertReplayMatchesReceipt, type LivePoolReplayCoverage, type PoolReplayOutcome } from './livePoolReplay'
import { candidatePriority, operationMatchesPool } from './liveRouterScenarios'
import {
  ForkExplorationSession,
  minimizeExplorationWitnesses,
  witnessOutcomeIdentity,
  type ForkExplorationEpoch,
  type ForkExplorationMetrics,
  type ForkHydrationRequest,
  type RevmExplorationWitness,
} from './revmProof'
import { deriveUniswapV4MutationMask } from './uniswapV4MutationMask'
import {
  deriveCustomRouterMutationMask,
  mutationDistance,
  type HistoricalRouterMutationMask,
  type OfficialRouterMutationMask,
} from './historicalRouterMutationMask'
import {
  contextKey,
  customRouterTechnical,
  type HistoricalRouterContext,
  type HistoricalRouterContexts,
} from '../data/historicalRouterContext'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address

/** The revm Wasm bridge rejects a wider mask than its own 512-byte input ceiling. */
const MAX_MUTABLE_BYTES = 512
/** One shared coverage-guided budget per pool, matching the runtime-bytecode explorer. */
const EXECUTION_BUDGET = 30_000
const TIME_BUDGET_MS = 30_000
const FIRST_ROUND_SHARE = 0.6
const MAX_EXCHANGED_SEEDS = 64
/** Below this remaining time a further round cannot produce a reportable epoch. */
const MIN_ROUND_MS = 1_000
const DEFAULT_POOL_CEILING = 3

// 0.2.0: targets may now come from a recognized custom router template, and the
// corpus validator and distance function are dispatched by the mask's codec.
export const LIVE_FORK_EXPLORATION_STRATEGY = 'libafl-masked-router-fork-rounds/0.2.0'

export type LiveForkExplorationRound = {
  round: number
  executions: number
  skippedExecutions: number
  coverageEdges: number
  uniqueOutcomes: number
  elapsedMs: number
  /** Compact masked candidates handed to this round by the previous one. */
  seedCorpus: number
  /** Pinned reads applied before this round started. */
  hydratedBefore: number
}

export type LiveForkExplorationMaskSummary = {
  calldataBytes: number
  mutableBytes: number
  operationsSeen: number
  operationsSelected: number
  fields: { field: string; operationKind: string; bytes: number }[]
  truncated: boolean
}

export type LiveForkExplorationOutcome = {
  poolId: Hex
  hook: Address
  /** Present when this target came from a recognized custom router template. */
  recognizedTemplate?: HistoricalRouterContext
  actor?: Address
  router?: Address
  transactionHash?: Hex
  blockNumber?: string
  value?: string
  status: 'completed' | 'unsupported' | 'failed'
  reason?: string
  mask?: LiveForkExplorationMaskSummary
  rounds: LiveForkExplorationRound[]
  executions: number
  skippedExecutions: number
  coverageEdges: number
  uniqueOutcomes: number
  exchangedSeeds: number
  hydratedBetweenRounds: number
  witnesses: RevmExplorationWitness[]
  elapsedMs: number
  metrics?: ForkExplorationMetrics
}

export type LiveForkExplorationCoverage = {
  status: 'passed' | 'degraded'
  strategy: string
  eligiblePools: number
  recognizedPools: number
  exploredPools: number
  executions: number
  skippedExecutions: number
  coverageEdges: number
  uniqueOutcomes: number
  exchangedSeeds: number
  hydrationReads: number
  elapsedMs: number
  outcomes: LiveForkExplorationOutcome[]
  findings: Evidence[]
  limitations: string[]
}

type ExplorationSession = Pick<ForkExplorationSession, 'warm' | 'hydrate' | 'explore' | 'metrics' | 'close'>
type SessionFactory = (input: { scanId: string; client: PublicClient; stateBlockNumber: bigint }) => ExplorationSession

export type LiveForkExplorationTarget = {
  pool: PoolDescriptor
  candidate: PoolReplayCandidate
  mask: HistoricalRouterMutationMask
  /** Present when this target came from a recognized custom router template. */
  recognizedTemplate?: HistoricalRouterContext
}

function maskSummary(mask: HistoricalRouterMutationMask): LiveForkExplorationMaskSummary {
  if (mask.codec !== 'official') {
    return {
      calldataBytes: mask.calldataBytes,
      mutableBytes: mask.byteIndices.length,
      operationsSeen: 1,
      operationsSelected: 1,
      // Named exactly, so evidence never says "amount and hookData" for an
      // envelope that carries no hook data at all.
      fields: mask.fields.map((field) => ({ field, operationKind: 'custom-v4-unlock-swap', bytes: mask.byteIndices.length })),
      truncated: false,
    }
  }
  return {
    calldataBytes: mask.calldataBytes,
    mutableBytes: mask.byteIndices.length,
    operationsSeen: mask.operationsSeen,
    operationsSelected: mask.operationsSelected,
    fields: mask.regions.map((region) => ({
      field: region.field,
      operationKind: region.operationKind,
      bytes: region.byteIndices.length,
    })),
    truncated: mask.truncated,
  }
}

/**
 * Derives a mutation mask restricted to the operations that provably act on
 * this pool.
 *
 * Token-ID-only PositionManager actions are excluded: their pool attribution is
 * resolved from pinned chain state rather than from calldata, so calldata alone
 * cannot establish that mutating them exercises the selected pool.
 */
export function poolScopedMutationMask(poolId: Hex, calldata: Hex): OfficialRouterMutationMask | null {
  const decoded = decodeUniswapV4Calldata(calldata)
  if (!decoded) return null
  const matching = new Set(
    locateUniswapV4Operations(decoded)
      .map((located, index) => (operationMatchesPool(located.operation, poolId) ? index : -1))
      .filter((index) => index >= 0),
  )
  if (matching.size === 0) return null
  const mask = deriveUniswapV4MutationMask(calldata, {
    maxMutableBytes: MAX_MUTABLE_BYTES,
    keepOperation: (_located, operationIndex) => matching.has(operationIndex),
  })
  return mask && mask.byteIndices.length > 0 ? { ...mask, codec: 'official' } : null
}

/**
 * Picks one canonical, receipt-matched, pool-attributed router transaction per
 * pool, preferring the historical context that explains hook behavior most
 * directly.
 */
export function selectForkExplorationTargets(input: {
  pools: PoolDescriptor[]
  replay: LivePoolReplayCoverage
  routerContexts?: HistoricalRouterContexts
}): LiveForkExplorationTarget[] {
  const poolsById = new Map(input.pools.map((pool) => [pool.poolId.toLowerCase(), pool]))
  const byPool = new Map<string, LiveForkExplorationTarget>()
  const candidates = input.replay.outcomes
    .filter((outcome): outcome is PoolReplayOutcome & { candidate: PoolReplayCandidate } =>
      outcome.status === 'passed' && Boolean(outcome.candidate))
    .sort((left, right) => candidatePriority(left) - candidatePriority(right))
  for (const outcome of candidates) {
    const pool = poolsById.get(outcome.poolId.toLowerCase())
    if (!pool || byPool.has(pool.poolId.toLowerCase())) continue

    // The official codec first: it decodes from a published ABI and needs no
    // runtime evidence to be trusted.
    const official = poolScopedMutationMask(pool.poolId, outcome.candidate.transaction.calldata)
    if (official) {
      byPool.set(pool.poolId.toLowerCase(), { pool, candidate: outcome.candidate, mask: official })
      continue
    }

    // Otherwise a recognized custom template, which must have passed runtime
    // recognition and trace attestation before it can be mutated at all.
    const recognized = input.routerContexts?.byTransaction.get(
      contextKey(pool.poolId, outcome.candidate.transactionHash),
    )
    if (!recognized || recognized.family === 'official') continue
    const mask = deriveCustomRouterMutationMask({
      calldata: outcome.candidate.transaction.calldata,
      expectation: {
        poolKey: recognized.decoded.poolKey,
        poolId: recognized.decoded.poolId,
        transactionValue: outcome.candidate.transaction.value,
      },
    })
    if (!mask) continue
    byPool.set(pool.poolId.toLowerCase(), {
      pool, candidate: outcome.candidate, mask, recognizedTemplate: recognized,
    })
  }
  return [...byPool.values()]
}

/**
 * Builds the compact corpus handed to the next round.
 *
 * Inputs that were skipped for missing state are included because the
 * coordinator hydrates that state before the next round starts. Every entry is
 * re-checked against the mask, so an exchanged seed can never carry a changed
 * router envelope into the next epoch.
 */
export function exchangeCorpus(mask: HistoricalRouterMutationMask, epoch: ForkExplorationEpoch): Hex[] {
  const ordered = [
    ...minimizeExplorationWitnesses(epoch.witnesses, MAX_EXCHANGED_SEEDS).map((witness) => witness.calldata),
    ...epoch.missingCandidates.map((candidate) => candidate.calldata),
  ]
  // Distance is measured once per candidate: it re-decodes the calldata, so
  // calling it from inside a sort comparator would repeat that work O(n log n) times.
  const unique = new Map<string, { calldata: Hex; distance: number }>()
  for (const calldata of ordered) {
    const identity = calldata.toLowerCase()
    if (unique.has(identity)) continue
    // Dispatched by the mask's own codec: an official distance function applied
    // to a custom payload would rank noise.
    const distance = mutationDistance(mask, calldata)
    if (!Number.isFinite(distance)) continue
    unique.set(identity, { calldata, distance })
  }
  return [...unique.values()]
    .sort((left, right) => left.distance - right.distance)
    .slice(0, MAX_EXCHANGED_SEEDS)
    .map((entry) => entry.calldata)
}

function splitRoundBudget(total: number) {
  const first = Math.min(total, Math.max(1, Math.ceil(total * FIRST_ROUND_SHARE)))
  return [first, Math.max(0, total - first)]
}

function distinctOutcomes(witnesses: RevmExplorationWitness[]) {
  return new Set(witnesses.map(witnessOutcomeIdentity)).size
}

function accountRequests(addresses: (Address | undefined)[]): ForkHydrationRequest[] {
  const unique = new Map<string, Address>()
  for (const address of addresses) {
    if (!address || address === ZERO_ADDRESS) continue
    unique.set(address.toLowerCase(), address)
  }
  return [...unique.values()].map((address) => ({ kind: 'account', address }))
}

function evidence(outcome: LiveForkExplorationOutcome): Evidence {
  const witness = outcome.witnesses.find((item) => item.storageDiffs.length > 0) ?? outcome.witnesses[0]
  const firstStorage = witness?.storageDiffs[0]
  const reached = outcome.uniqueOutcomes >= 2
  const custom = outcome.recognizedTemplate && outcome.recognizedTemplate.family !== 'official'
  // Named from the mask itself: this envelope exposes no hook-data field, and
  // claiming otherwise would describe mutation that never happened.
  const mutatedFields = outcome.mask?.fields.map((field) => field.field).join(' and ') || 'masked'
  const preserved = custom
    ? `Every executed input kept the recognized template's selector, direction, pool key, hook and settlement currency; only the ${mutatedFields} bytes were mutated.`
    : 'Every executed input kept the canonical router envelope, caller, value, and settlement commands of the historical transaction.'
  return {
    id: `live-fork-exploration:${outcome.poolId.slice(2, 14)}:${outcome.transactionHash?.slice(2, 10) ?? 'context'}`,
    detectorId: 'live-v4-masked-router-exploration',
    detectorVersion: '0.1.0',
    severity: reached ? 'medium' : 'info',
    evidenceClass: 'fuzz-discovery',
    subject: outcome.hook,
    title: reached
      ? 'Masked router inputs reach different outcomes at pinned state'
      : 'Bounded masked router exploration produced no additional outcome',
    claim: reached
      ? `Coverage-guided mutation of only the masked ${mutatedFields} bytes of a receipt-matched router payload reached ${outcome.uniqueOutcomes} distinct outcomes across ${outcome.executions.toLocaleString()} executions and ${outcome.coverageEdges} execution edges at the parent state of transaction ${outcome.transactionHash}. ${preserved}`
      : `Coverage-guided mutation of only the masked ${mutatedFields} bytes of a receipt-matched router payload ran ${outcome.executions.toLocaleString()} executions and ${outcome.coverageEdges} execution edges at the parent state of transaction ${outcome.transactionHash} without reaching a second distinct outcome. ${preserved} This is bounded exploration, not an absence proof.`,
    confidence: 'confirmed',
    storage: firstStorage ? [{ slot: firstStorage.slot, before: firstStorage.before, after: firstStorage.after }] : undefined,
    affectedPools: [outcome.poolId],
    witness: witness && outcome.actor && outcome.router ? {
      from: outcome.actor,
      to: outcome.router,
      input: witness.calldata,
      value: outcome.value ?? '0',
      blockNumber: outcome.blockNumber ?? 'historical-context',
      expectedOutcome: witness.success ? 'success' : 'revert',
    } : undefined,
    reproducibility: witness ? 'replayed' : 'not-applicable',
    technical: {
      strategy: LIVE_FORK_EXPLORATION_STRATEGY,
      historicalTransaction: outcome.transactionHash,
      historicalRouter: outcome.router,
      mask: outcome.mask,
      rounds: outcome.rounds,
      exchangedSeeds: outcome.exchangedSeeds,
      hydratedBetweenRounds: outcome.hydratedBetweenRounds,
      skippedExecutions: outcome.skippedExecutions,
      elapsedMs: outcome.elapsedMs,
      witnesses: outcome.witnesses.slice(0, 16),
      sessionMetrics: outcome.metrics,
      ...(outcome.recognizedTemplate ? customRouterTechnical(outcome.recognizedTemplate) : undefined),
    },
  }
}

function unexploredOutcome(pool: PoolDescriptor, reason: string): LiveForkExplorationOutcome {
  return {
    poolId: pool.poolId,
    hook: pool.hook,
    status: 'unsupported',
    reason,
    rounds: [],
    executions: 0,
    skippedExecutions: 0,
    coverageEdges: 0,
    uniqueOutcomes: 0,
    exchangedSeeds: 0,
    hydratedBetweenRounds: 0,
    witnesses: [],
    elapsedMs: 0,
  }
}

async function exploreTarget(input: {
  target: LiveForkExplorationTarget
  scanId: string
  client: PublicClient
  poolManager: Address
  createSession: SessionFactory
  signal: AbortSignal
  maxExecutions: number
  timeoutMs: number
  seed: bigint
  maxHydrationRequests?: number
  onRound?: (detail: string) => void
}): Promise<LiveForkExplorationOutcome> {
  const { target, signal } = input
  const { pool, candidate, mask } = target
  const startedAt = performance.now()
  const deadline = startedAt + input.timeoutMs
  const session = input.createSession({
    scanId: input.scanId,
    client: input.client,
    stateBlockNumber: candidate.stateBlockNumber,
  })
  const rounds: LiveForkExplorationRound[] = []
  const witnesses: RevmExplorationWitness[] = []
  let hydratedBetweenRounds = 0

  const summarize = (
    status: 'completed' | 'failed',
    reason?: string,
  ): LiveForkExplorationOutcome => {
    const minimized = minimizeExplorationWitnesses(witnesses)
    return {
      poolId: pool.poolId,
      hook: pool.hook,
      recognizedTemplate: target.recognizedTemplate,
      actor: candidate.transaction.caller,
      router: candidate.transaction.to,
      transactionHash: candidate.transactionHash,
      blockNumber: candidate.block.number.toString(),
      value: candidate.transaction.value.toString(),
      status,
      reason,
      mask: maskSummary(mask),
      rounds,
      executions: rounds.reduce((sum, item) => sum + item.executions, 0),
      skippedExecutions: rounds.reduce((sum, item) => sum + item.skippedExecutions, 0),
      // Round-local edge maps cannot be unioned from summary counts, so the
      // largest observed cardinality is reported instead of a false sum.
      coverageEdges: Math.max(0, ...rounds.map((item) => item.coverageEdges)),
      uniqueOutcomes: distinctOutcomes(minimized),
      exchangedSeeds: rounds.reduce((sum, item) => sum + item.seedCorpus, 0),
      hydratedBetweenRounds,
      witnesses: minimized,
      elapsedMs: Math.round(performance.now() - startedAt),
      metrics: session.metrics(),
    }
  }

  try {
    const prefetched = await session.hydrate(accountRequests([
      candidate.transaction.caller,
      candidate.transaction.to,
      input.poolManager,
      pool.hook,
      pool.currency0,
      pool.currency1,
    ]))
    input.onRound?.('hydrating the pinned router context')
    const warmed = await session.warm({
      transaction: { ...candidate.transaction, traceLimit: 2_048 },
      block: candidate.block,
      signal,
      timeoutMs: Math.max(MIN_ROUND_MS, Math.floor(deadline - performance.now())),
      maxHydrationRequests: input.maxHydrationRequests ?? 2_048,
    })
    // The seed must still reproduce its chain receipt inside this session, or a
    // mutation result cannot be attributed to the historical pinned context.
    assertReplayMatchesReceipt(warmed, candidate)

    const budgets = splitRoundBudget(input.maxExecutions)
    let seedCorpus: Hex[] = []
    let hydratedBefore = prefetched
    for (const [index, budget] of budgets.entries()) {
      const round = index + 1
      const remainingMs = Math.floor(deadline - performance.now())
      if (budget <= 0 || remainingMs < MIN_ROUND_MS) break
      input.onRound?.(`round ${round} · ${budget.toLocaleString()} executions`)
      const epoch = await session.explore({
        transaction: { ...candidate.transaction, traceLimit: 2_048 },
        block: candidate.block,
        mutableIndices: mask.byteIndices,
        maxExecutions: budget,
        seed: input.seed + BigInt(round),
        signal,
        seedCorpus,
        timeoutMs: remainingMs,
      })
      rounds.push({
        round,
        executions: epoch.executions,
        skippedExecutions: epoch.skippedExecutions,
        coverageEdges: epoch.coverageEdges,
        uniqueOutcomes: epoch.uniqueOutcomes,
        elapsedMs: epoch.elapsedMs,
        seedCorpus: seedCorpus.length,
        hydratedBefore,
      })
      witnesses.push(...epoch.witnesses)
      if (index >= budgets.length - 1 || budgets[index + 1]! <= 0) break
      seedCorpus = exchangeCorpus(mask, epoch)
      hydratedBefore = epoch.missingRequests.length ? await session.hydrate(epoch.missingRequests) : 0
      hydratedBetweenRounds += hydratedBefore
    }
    if (!rounds.length) {
      throw new Error('Coverage-guided fork exploration exhausted its shared budget during pinned-state hydration.')
    }
    return summarize('completed')
  } catch (error) {
    if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
    return summarize('failed', error instanceof Error ? error.message : String(error))
  } finally {
    session.close()
  }
}

/**
 * Runs coverage-guided mutation against hydrated live fork targets.
 *
 * Each selected pool receives one canonical receipt-matched router transaction,
 * a pool-scoped mutation mask, and one hydrated revm session under a single
 * execution and time budget split across two rounds. State that a round reports
 * as missing is hydrated before the next round starts, and interesting inputs
 * are exchanged forward as a compact masked corpus.
 *
 * Fan-out is applied across pools rather than inside one pool: a second session
 * for the same pool would repeat its pinned-state hydration instead of sharing
 * it, because hydrated fork state cannot be transferred between Wasm sessions.
 */
export async function runLiveForkExploration(input: {
  scanId: string
  client: PublicClient
  poolManager: Address
  pools: PoolDescriptor[]
  replay: LivePoolReplayCoverage
  /** Recognized router families, prepared once after replay and shared with scenarios. */
  routerContexts?: HistoricalRouterContexts
  signal: AbortSignal
  maxWorkers?: number
  maxPools?: number
  maxExecutionsPerPool?: number
  timeoutMsPerPool?: number
  maxHydrationRequests?: number
  seed?: bigint
  createSession?: SessionFactory
  onProgress?: (completed: number, total: number, detail: string) => void
}): Promise<LiveForkExplorationCoverage> {
  const startedAt = performance.now()
  const hookedPools = input.pools.filter((pool) => pool.hook !== ZERO_ADDRESS)
  const maxPools = Math.max(0, input.maxPools ?? DEFAULT_POOL_CEILING)
  const recognized = selectForkExplorationTargets({
    pools: input.pools,
    replay: input.replay,
    routerContexts: input.routerContexts,
  })
  const targets = recognized.slice(0, maxPools)
  const createSession = input.createSession ?? ((options) => new ForkExplorationSession(options))
  const maxExecutions = Math.min(EXECUTION_BUDGET, Math.max(1, input.maxExecutionsPerPool ?? EXECUTION_BUDGET))
  const timeoutMs = Math.max(MIN_ROUND_MS, input.timeoutMsPerPool ?? TIME_BUDGET_MS)
  const outcomes: LiveForkExplorationOutcome[] = []
  // Progress is reported against every hooked pool, so a bounded run stays visibly incomplete.
  const progressTotal = Math.max(hookedPools.length, targets.length)
  let cursor = 0
  let completed = 0

  const worker = async () => {
    while (true) {
      const index = cursor++
      const target = targets[index]
      if (!target) return
      if (input.signal.aborted) throw new DOMException('Live fork exploration cancelled', 'AbortError')
      outcomes.push(await exploreTarget({
        target,
        scanId: `${input.scanId}-live-fork-${index}`,
        client: input.client,
        poolManager: input.poolManager,
        createSession,
        signal: input.signal,
        maxExecutions,
        timeoutMs,
        maxHydrationRequests: input.maxHydrationRequests,
        seed: (input.seed ?? 0x484f_4f4b_5343_4f50n) + BigInt(index * 0x100),
        onRound: (detail) => input.onProgress?.(completed, progressTotal, `${target.pool.poolId.slice(0, 10)} · ${detail}`),
      }))
      completed++
      input.onProgress?.(completed, progressTotal, `${completed}/${targets.length} hydrated fork targets explored`)
    }
  }

  const concurrency = Math.max(1, Math.min(input.maxWorkers ?? 2, targets.length || 1))
  // Every worker is settled before rethrowing so a cancelled scan cannot leave a
  // second rejection unhandled or a Wasm session open.
  const settled = await Promise.allSettled(Array.from({ length: concurrency }, () => worker()))
  const rejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (rejected) throw rejected.reason

  const explored = new Set(targets.map((target) => target.pool.poolId.toLowerCase()))
  const capped = recognized.slice(maxPools)
  for (const target of capped) {
    outcomes.push(unexploredOutcome(
      target.pool,
      `The fuzz phase is bounded to ${maxPools} hydrated fork target${maxPools === 1 ? '' : 's'} per scan.`,
    ))
    explored.add(target.pool.poolId.toLowerCase())
  }
  for (const pool of hookedPools) {
    if (explored.has(pool.poolId.toLowerCase())) continue
    outcomes.push(unexploredOutcome(
      pool,
      'The receipt-matched transaction used a router envelope that is neither a canonical Uniswap envelope nor a recognized custom template, so its exact replay can be observed but bounded input mutation is not generated.',
    ))
  }

  const signedPayloads = targets.flatMap((target) => {
    const decoded = decodeUniswapV4Calldata(target.candidate.transaction.calldata)
    return decoded ? collectSignedPayloads(decoded) : []
  })
  const completedOutcomes = outcomes.filter((outcome) => outcome.status === 'completed')
  const failed = outcomes.filter((outcome) => outcome.status === 'failed')
  const unrecognized = Math.max(0, hookedPools.length - recognized.length)
  const skippedExecutions = outcomes.reduce((sum, outcome) => sum + outcome.skippedExecutions, 0)
  const limitations = [
    unrecognized ? `${unrecognized} hooked pool${unrecognized === 1 ? ' has' : 's have'} no receipt-matched recognized router envelope with independently attributable mutable fields, so bounded input exploration did not run for ${unrecognized === 1 ? 'it' : 'them'}.` : undefined,
    capped.length ? `${capped.length} recognized fork target${capped.length === 1 ? ' was' : 's were'} not explored because the fuzz phase is bounded to ${maxPools} pool${maxPools === 1 ? '' : 's'} per scan.` : undefined,
    failed.length ? `${failed.length} hydrated fork target${failed.length === 1 ? ' did' : 's did'} not complete its bounded rounds.` : undefined,
    completedOutcomes.some((outcome) => outcome.mask?.truncated)
      ? 'At least one mutation mask was truncated to its byte ceiling, so some mutable value bytes were never mutated.'
      : undefined,
    skippedExecutions
      ? `${skippedExecutions} generated input${skippedExecutions === 1 ? ' was' : 's were'} skipped for fork state that was unavailable at execution time.`
      : undefined,
    completedOutcomes.length
      ? 'Bounded exploration cannot prove the absence of unobserved mechanics; only masked amount and hookData bytes were mutated.'
      : undefined,
    signedPayloadLimitation(signedPayloads),
  ].filter((value): value is string => Boolean(value))

  return {
    status: hookedPools.length > 0 && completedOutcomes.length === hookedPools.length && failed.length === 0
      ? 'passed'
      : 'degraded',
    strategy: LIVE_FORK_EXPLORATION_STRATEGY,
    eligiblePools: hookedPools.length,
    recognizedPools: recognized.length,
    exploredPools: completedOutcomes.length,
    executions: outcomes.reduce((sum, outcome) => sum + outcome.executions, 0),
    skippedExecutions,
    coverageEdges: Math.max(0, ...outcomes.map((outcome) => outcome.coverageEdges)),
    uniqueOutcomes: completedOutcomes.reduce((sum, outcome) => sum + outcome.uniqueOutcomes, 0),
    exchangedSeeds: outcomes.reduce((sum, outcome) => sum + outcome.exchangedSeeds, 0),
    hydrationReads: outcomes.reduce((sum, outcome) => sum + (outcome.metrics?.rpcReads ?? 0), 0),
    elapsedMs: Math.round(performance.now() - startedAt),
    outcomes,
    findings: completedOutcomes.map((outcome) => evidence(outcome)),
    limitations,
  }
}
