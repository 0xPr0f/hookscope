import type { Address, Hex, PublicClient } from 'viem'
import type { Evidence, PoolDescriptor } from '../domain/report'
import {
  ForkExplorationSession,
  minimizeExplorationWitnesses,
  witnessOutcomeIdentity,
  type ForkExplorationMetrics,
  type ForkHydrationRequest,
  type RevmExplorationWitness,
} from './revmProof'
import { scenarioRouterIdentity } from './protocolScenarioArtifact'
import {
  buildProtocolScenarioContext,
  type ProtocolScenarioContext,
} from './protocolScenarioContext'
import { buildProtocolScenarioMatrix, type ProtocolScenario } from './protocolNativeScenarios'
import {
  deriveScenarioMutationMask,
  isScenarioDerivative,
  splitExplorationBudget,
  type ScenarioMutationMask,
} from './protocolScenarioMask'

/**
 * Coverage-guided exploration of generated PoolManager calldata.
 *
 * Seeds come from the generated scenario matrix rather than from a historical
 * transaction, so this phase runs for a pool whose historical router is
 * unrecognized, whose replay was degraded, or that has no attributable
 * historical calldata at all. Mutation stays inside the mask, which keeps the
 * PoolKey, the operation, and every tick bound exactly as generated.
 */

export const PROTOCOL_EXPLORATION_STRATEGY = 'libafl-masked-generated-scenario-rounds/0.1.0'

/** The revm Wasm bridge rejects a mask wider than its own input ceiling. */
const MAX_MUTABLE_BYTES = 512
const EXECUTION_BUDGET = 12_000
const TIME_BUDGET_MS = 24_000
const MIN_SHAPE_MS = 1_000
const SCENARIO_GAS_LIMIT = 16_000_000n
const DEFAULT_POOL_CEILING = 3
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address

/**
 * One representative seed per operation shape.
 *
 * Exploring every scenario would spend the budget re-deriving the same masked
 * regions; one seed per shape covers each distinct calldata layout the mask can
 * mutate, and the scenario suite already executes the full matrix once.
 */
const SEED_IDS = [
  'swap:exact-input:0-for-1:medium',
  'swap:exact-output:1-for-0:medium',
  'swap:hook-data:marker',
  'liquidity:add:narrow',
  'donate:both',
] as const

export type ProtocolExplorationShape = {
  scenarioId: string
  operation: ProtocolScenario['operation']
  mutableBytes: number
  executions: number
  skippedExecutions: number
  coverageEdges: number
  uniqueOutcomes: number
  elapsedMs: number
}

export type ProtocolExplorationOutcome = {
  poolId: Hex
  hook: Address
  status: 'completed' | 'unavailable' | 'failed'
  reason?: string
  shapes: ProtocolExplorationShape[]
  executions: number
  skippedExecutions: number
  coverageEdges: number
  uniqueOutcomes: number
  witnesses: RevmExplorationWitness[]
  elapsedMs: number
  metrics?: ForkExplorationMetrics
}

export type ProtocolExplorationCoverage = {
  status: 'passed' | 'degraded'
  strategy: string
  eligiblePools: number
  exploredPools: number
  executions: number
  skippedExecutions: number
  coverageEdges: number
  uniqueOutcomes: number
  hydrationReads: number
  elapsedMs: number
  outcomes: ProtocolExplorationOutcome[]
  findings: Evidence[]
  limitations: string[]
}

type ExplorationSession = Pick<ForkExplorationSession, 'warm' | 'hydrate' | 'explore' | 'metrics' | 'close'>
type SessionFactory = (input: {
  scanId: string
  client: PublicClient
  stateBlockNumber: bigint
  snapshot: ProtocolScenarioContext['overlay']['snapshot']
}) => ExplorationSession

type SeedTarget = { scenario: ProtocolScenario; mask: ScenarioMutationMask }

/**
 * Selects the seeds this pool can actually offer.
 *
 * A shape the matrix could not generate — liquidity when the tick was
 * unreadable, for instance — is simply absent rather than substituted, so the
 * report never implies an operation was explored when it was not.
 */
export function selectExplorationSeeds(scenarios: ProtocolScenario[]): SeedTarget[] {
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]))
  const targets: SeedTarget[] = []
  for (const id of SEED_IDS) {
    const scenario = byId.get(id)
    if (!scenario) continue
    const mask = deriveScenarioMutationMask(scenario)
    if (!mask.byteIndices.length || mask.byteIndices.length > MAX_MUTABLE_BYTES) continue
    targets.push({ scenario, mask })
  }
  return targets
}

function accountRequests(addresses: (Address | undefined)[]): ForkHydrationRequest[] {
  const unique = new Map<string, Address>()
  for (const address of addresses) {
    if (!address || address === ZERO_ADDRESS) continue
    unique.set(address.toLowerCase(), address)
  }
  return [...unique.values()].map((address) => ({ kind: 'account', address }))
}

function evidenceFor(input: {
  context: ProtocolScenarioContext
  outcome: ProtocolExplorationOutcome
}): Evidence {
  const { context, outcome } = input
  const witness = outcome.witnesses.find((item) => item.storageDiffs.length > 0) ?? outcome.witnesses[0]
  const reached = outcome.uniqueOutcomes >= 2
  const preserved = 'Every executed input kept the generated PoolKey, operation, tick bounds, and salt; only amount, liquidity, donation, hookData, and direction bytes were mutated.'

  return {
    id: `protocol-scenario-exploration:${outcome.poolId.slice(2, 14)}`,
    detectorId: 'protocol-native-scenario-exploration',
    detectorVersion: '0.1.0',
    severity: reached ? 'medium' : 'info',
    evidenceClass: 'fuzz-discovery',
    subject: outcome.hook,
    title: reached
      ? 'Generated scenario inputs reach different outcomes at pinned state'
      : 'Bounded generated-scenario exploration produced no additional outcome',
    claim: reached
      ? `Coverage-guided mutation of generated PoolManager calldata reached ${outcome.uniqueOutcomes} distinct outcomes across ${outcome.executions.toLocaleString()} executions and ${outcome.coverageEdges} execution edges against the deployed PoolManager and hook at block ${context.stateBlockNumber}. ${preserved} These are generated transactions against pinned state, not onchain transactions.`
      : `Coverage-guided mutation of generated PoolManager calldata ran ${outcome.executions.toLocaleString()} executions and ${outcome.coverageEdges} execution edges against the deployed PoolManager and hook at block ${context.stateBlockNumber} without reaching a second distinct outcome. ${preserved} This is bounded exploration against pinned state, not an absence proof and not an onchain transaction.`,
    confidence: 'confirmed',
    storage: witness?.storageDiffs[0]
      ? [{ slot: witness.storageDiffs[0].slot, before: witness.storageDiffs[0].before, after: witness.storageDiffs[0].after }]
      : undefined,
    affectedPools: [outcome.poolId],
    witness: witness ? {
      from: context.actor,
      to: context.router,
      input: witness.calldata,
      value: '0',
      blockNumber: context.executionBlock.number.toString(),
      expectedOutcome: witness.success ? 'success' : 'revert',
      // The scenario harness and its funding exist only under these overrides;
      // naming them keeps the witness honest about what it needs to reproduce.
      stateOverrides: { declared: context.overlay.declaredOverrides },
    } : undefined,
    reproducibility: witness ? 'replayed' : 'not-applicable',
    technical: {
      executionSource: 'protocol-native-generated',
      stateMode: 'pinned-block-with-declared-overrides',
      strategy: PROTOCOL_EXPLORATION_STRATEGY,
      harness: scenarioRouterIdentity(context.overlay.patched),
      shapes: outcome.shapes,
      skippedExecutions: outcome.skippedExecutions,
      elapsedMs: outcome.elapsedMs,
      witnesses: outcome.witnesses.slice(0, 16),
      sessionMetrics: outcome.metrics,
      // Deliberately absent: no historical transaction hash or router.
    },
  }
}

async function explorePool(input: {
  context: ProtocolScenarioContext
  seeds: SeedTarget[]
  scanId: string
  client: PublicClient
  createSession: SessionFactory
  signal: AbortSignal
  maxExecutions: number
  timeoutMs: number
  seed: bigint
  maxHydrationRequests?: number
  onShape?: (detail: string) => void
}): Promise<ProtocolExplorationOutcome> {
  const { context, seeds, signal } = input
  const startedAt = performance.now()
  const deadline = startedAt + input.timeoutMs
  const session = input.createSession({
    scanId: input.scanId,
    client: input.client,
    stateBlockNumber: context.stateBlockNumber,
    snapshot: context.overlay.snapshot,
  })
  const shapes: ProtocolExplorationShape[] = []
  const witnesses: RevmExplorationWitness[] = []

  const transactionFor = (scenario: ProtocolScenario) => ({
    caller: scenario.caller === 'actor' ? context.actor : context.alternateActor,
    to: context.router,
    calldata: scenario.calldata,
    value: 0n,
    gasLimit: SCENARIO_GAS_LIMIT,
    gasPrice: 0n,
    nonce: 0,
    chainId: context.chainId,
    traceLimit: 2_048,
  })

  const summarize = (status: 'completed' | 'failed', reason?: string): ProtocolExplorationOutcome => {
    const minimized = minimizeExplorationWitnesses(witnesses)
    return {
      poolId: context.pool.poolId,
      hook: context.pool.hook,
      status,
      reason,
      shapes,
      executions: shapes.reduce((sum, shape) => sum + shape.executions, 0),
      skippedExecutions: shapes.reduce((sum, shape) => sum + shape.skippedExecutions, 0),
      // Edge maps are per shape and cannot be unioned from counts, so the
      // largest observed cardinality is reported instead of a false sum.
      coverageEdges: Math.max(0, ...shapes.map((shape) => shape.coverageEdges)),
      uniqueOutcomes: new Set(minimized.map(witnessOutcomeIdentity)).size,
      witnesses: minimized,
      elapsedMs: Math.round(performance.now() - startedAt),
      metrics: session.metrics(),
    }
  }

  try {
    await session.hydrate(accountRequests([
      context.poolManager,
      context.pool.hook,
      context.pool.currency0,
      context.pool.currency1,
    ]))
    input.onShape?.('hydrating the pinned pool context')
    // Warming on the first seed pulls in the state every shape shares, so each
    // shape spends its budget on execution rather than on repeated hydration.
    await session.warm({
      transaction: transactionFor(seeds[0]!.scenario),
      block: context.executionBlock,
      signal,
      timeoutMs: Math.max(MIN_SHAPE_MS, Math.floor(deadline - performance.now())),
      maxHydrationRequests: input.maxHydrationRequests ?? 2_048,
    })

    const budgets = splitExplorationBudget(seeds.map((target) => target.scenario.id), input.maxExecutions)
    for (const [index, target] of seeds.entries()) {
      const budget = budgets[index]?.executions ?? 0
      const remainingMs = Math.floor(deadline - performance.now())
      if (budget <= 0 || remainingMs < MIN_SHAPE_MS) break
      if (signal.aborted) throw new DOMException('Generated exploration cancelled', 'AbortError')
      input.onShape?.(`${target.scenario.id} · ${budget.toLocaleString()} executions`)
      const epoch = await session.explore({
        transaction: transactionFor(target.scenario),
        block: context.executionBlock,
        mutableIndices: target.mask.byteIndices,
        maxExecutions: budget,
        seed: input.seed + BigInt(index + 1),
        signal,
        timeoutMs: remainingMs,
      })
      // The mask is the contract with the mutator; a witness outside it would
      // mean the executed calldata was not the generated scenario any more.
      const kept = epoch.witnesses.filter((item) => isScenarioDerivative(target.mask, item.calldata))
      witnesses.push(...kept)
      shapes.push({
        scenarioId: target.scenario.id,
        operation: target.scenario.operation,
        mutableBytes: target.mask.byteIndices.length,
        executions: epoch.executions,
        skippedExecutions: epoch.skippedExecutions + (epoch.witnesses.length - kept.length),
        coverageEdges: epoch.coverageEdges,
        uniqueOutcomes: epoch.uniqueOutcomes,
        elapsedMs: epoch.elapsedMs,
      })
    }
    if (!shapes.length) {
      throw new Error('Generated-scenario exploration exhausted its budget during pinned-state hydration.')
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
 * Runs bounded generated-scenario exploration for the discovered pools.
 *
 * Contexts may be handed in by the generated scenario phase to reuse its pinned
 * reads; when they are not, they are built here, so this phase never becomes
 * conditional on another one having succeeded.
 */
export async function runProtocolScenarioExploration(input: {
  scanId: string
  client: PublicClient
  chainId: number
  poolManager: Address
  pools: PoolDescriptor[]
  stateBlockNumber: bigint
  pinnedBlock: { timestamp: bigint; baseFeePerGas: bigint | null; gasLimit: bigint; miner: Address }
  signal: AbortSignal
  contexts?: ProtocolScenarioContext[]
  maxPools?: number
  maxExecutionsPerPool?: number
  timeoutMsPerPool?: number
  maxHydrationRequests?: number
  seed?: bigint
  createSession?: SessionFactory
  onProgress?: (completed: number, total: number, detail: string) => void
}): Promise<ProtocolExplorationCoverage> {
  const startedAt = performance.now()
  const hookedPools = input.pools.filter((pool) => pool.hook !== ZERO_ADDRESS)
  const maxPools = Math.max(0, input.maxPools ?? DEFAULT_POOL_CEILING)
  const selected = hookedPools.slice(0, maxPools)
  const createSession = input.createSession ?? ((options) => new ForkExplorationSession(options))
  const maxExecutions = Math.min(EXECUTION_BUDGET, Math.max(1, input.maxExecutionsPerPool ?? EXECUTION_BUDGET))
  const timeoutMs = Math.max(MIN_SHAPE_MS, input.timeoutMsPerPool ?? TIME_BUDGET_MS)
  const byPool = new Map((input.contexts ?? []).map((context) => [context.pool.poolId.toLowerCase(), context]))
  const outcomes: ProtocolExplorationOutcome[] = []
  const findings: Evidence[] = []
  let completed = 0

  for (const [index, pool] of selected.entries()) {
    if (input.signal.aborted) throw new DOMException('Generated exploration cancelled', 'AbortError')

    let context = byPool.get(pool.poolId.toLowerCase())
    if (!context) {
      try {
        context = await buildProtocolScenarioContext({
          client: input.client,
          chainId: input.chainId,
          poolManager: input.poolManager,
          pool,
          stateBlockNumber: input.stateBlockNumber,
          pinnedBlock: input.pinnedBlock,
          signal: input.signal,
        })
      } catch (error) {
        if (input.signal.aborted) throw error
        outcomes.push({
          poolId: pool.poolId,
          hook: pool.hook,
          status: 'unavailable',
          reason: error instanceof Error ? error.message : String(error),
          shapes: [],
          executions: 0,
          skippedExecutions: 0,
          coverageEdges: 0,
          uniqueOutcomes: 0,
          witnesses: [],
          elapsedMs: 0,
        })
        continue
      }
    }

    const { scenarios } = buildProtocolScenarioMatrix({
      key: {
        currency0: pool.currency0,
        currency1: pool.currency1,
        fee: pool.fee,
        tickSpacing: pool.tickSpacing,
        hooks: pool.hook,
      },
      currentTick: context.slot0?.tick,
      actor: context.actor,
    })
    const seeds = selectExplorationSeeds(scenarios)
    if (!seeds.length) {
      outcomes.push({
        poolId: pool.poolId,
        hook: pool.hook,
        status: 'unavailable',
        reason: 'No generated scenario for this pool exposed a mutable region within the input ceiling.',
        shapes: [],
        executions: 0,
        skippedExecutions: 0,
        coverageEdges: 0,
        uniqueOutcomes: 0,
        witnesses: [],
        elapsedMs: 0,
      })
      continue
    }

    const outcome = await explorePool({
      context,
      seeds,
      scanId: `${input.scanId}-protocol-explore-${index}`,
      client: input.client,
      createSession,
      signal: input.signal,
      maxExecutions,
      timeoutMs,
      maxHydrationRequests: input.maxHydrationRequests,
      seed: (input.seed ?? 0x484f_4f4b_5343_4f50n) + BigInt(index * 0x100),
      onShape: (detail) => input.onProgress?.(completed, selected.length, `${pool.poolId.slice(0, 10)} · ${detail}`),
    })
    outcomes.push(outcome)
    if (outcome.status === 'completed') findings.push(evidenceFor({ context, outcome }))
    completed++
    input.onProgress?.(completed, selected.length, `${completed}/${selected.length} generated exploration targets`)
  }

  const completedOutcomes = outcomes.filter((outcome) => outcome.status === 'completed')
  const failed = outcomes.filter((outcome) => outcome.status === 'failed')
  const capped = Math.max(0, hookedPools.length - selected.length)
  const skippedExecutions = outcomes.reduce((sum, outcome) => sum + outcome.skippedExecutions, 0)
  const limitations = [
    capped ? `${capped} hooked pool${capped === 1 ? ' was' : 's were'} not explored because the generated exploration phase is bounded per scan.` : undefined,
    failed.length ? `${failed.length} generated exploration target${failed.length === 1 ? ' did' : 's did'} not complete its bounded budget.` : undefined,
    outcomes.some((outcome) => outcome.status === 'unavailable')
      ? 'Some pools produced no explorable generated seed; each records its own reason.'
      : undefined,
    skippedExecutions
      ? `${skippedExecutions} generated input${skippedExecutions === 1 ? ' was' : 's were'} skipped for unavailable fork state or for falling outside its mask.`
      : undefined,
    completedOutcomes.length
      ? 'Bounded exploration cannot prove the absence of unobserved mechanics; tick bounds and PoolKey fields were never mutated.'
      : undefined,
  ].filter((value): value is string => Boolean(value))

  return {
    status: hookedPools.length > 0 && completedOutcomes.length === hookedPools.length && failed.length === 0
      ? 'passed'
      : 'degraded',
    strategy: PROTOCOL_EXPLORATION_STRATEGY,
    eligiblePools: hookedPools.length,
    exploredPools: completedOutcomes.length,
    executions: outcomes.reduce((sum, outcome) => sum + outcome.executions, 0),
    skippedExecutions,
    coverageEdges: Math.max(0, ...outcomes.map((outcome) => outcome.coverageEdges)),
    uniqueOutcomes: completedOutcomes.reduce((sum, outcome) => sum + outcome.uniqueOutcomes, 0),
    hydrationReads: outcomes.reduce((sum, outcome) => sum + (outcome.metrics?.rpcReads ?? 0), 0),
    elapsedMs: Math.round(performance.now() - startedAt),
    outcomes,
    findings,
    limitations,
  }
}
