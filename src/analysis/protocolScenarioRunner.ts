import { getAddress, type Address, type Hex, type PublicClient } from 'viem'
import type { Evidence, PoolDescriptor } from '../domain/report'
import { ForkExecutionSession, type ForkReplayResult } from './revmProof'
import { summarizeExecutionObservations } from './executionObservations'
import { decodeCurrencyDeltas, deltasFullySettled } from './currencyDeltas'
import { scenarioRouterIdentity } from './protocolScenarioArtifact'
import { buildProtocolScenarioContext, type ProtocolScenarioContext } from './protocolScenarioContext'
import { buildProtocolScenarioMatrix, type ProtocolScenario } from './protocolNativeScenarios'

/**
 * Runs generated PoolManager scenarios for the discovered pools.
 *
 * This path requires only a pool and read access. It never consults historical
 * replay status, router recognition, historical calldata, or PositionManager
 * attribution, so a pool whose historical router is unrecognized still receives
 * protocol-level observations.
 */

export const PROTOCOL_SCENARIO_VERSION = 'protocol-native-generated/0.1.0'

/** EIP-7825 caps a transaction at 2**24 gas; revm enforces it on recent forks. */
const SCENARIO_GAS_LIMIT = 16_000_000n
const DEFAULT_POOL_CEILING = 3

export type ProtocolScenarioOutcome = {
  poolId: Hex
  scenarioId: string
  operation: ProtocolScenario['operation']
  status: 'completed' | 'reverted' | 'unavailable' | 'failed'
  proof?: ForkReplayResult
  reason?: string
}

export type ProtocolScenarioCoverage = {
  status: 'passed' | 'degraded'
  version: string
  eligiblePools: number
  executedPools: number
  scenarios: number
  completed: number
  reverted: number
  failed: number
  hydrationReads: number
  findings: Evidence[]
  outcomes: ProtocolScenarioOutcome[]
  limitations: string[]
  /** Pinned contexts, so a later generated phase reuses these reads instead of repeating them. */
  contexts: ProtocolScenarioContext[]
}

type ScenarioSession = Pick<ForkExecutionSession, 'execute' | 'metrics' | 'close'>
type SessionFactory = (input: {
  scanId: string
  client: PublicClient
  stateBlockNumber: bigint
  snapshot: ProtocolScenarioContext['overlay']['snapshot']
}) => ScenarioSession

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address

/**
 * Distinguishes a finding from a malfunction.
 *
 * A revert reached the PoolManager and is a fact about the pool; a missing state
 * read or worker fault is an analyzer problem and must never be reported as hook
 * behavior.
 */
function classify(replay: ForkReplayResult): 'completed' | 'reverted' {
  return replay.proof.success ? 'completed' : 'reverted'
}

function evidenceFor(input: {
  context: ProtocolScenarioContext
  scenario: ProtocolScenario
  replay: ForkReplayResult
  reverted: boolean
}): Evidence {
  const { context, scenario, replay } = input
  const proof = replay.proof
  const observations = summarizeExecutionObservations(proof)
  const deltas = decodeCurrencyDeltas({
    proof,
    poolManager: context.poolManager,
    accounts: [context.router, context.actor, context.poolManager, context.pool.hook],
    currencies: [context.pool.currency0, context.pool.currency1],
  })

  return {
    id: `protocol-scenario:${context.pool.poolId.slice(2, 14)}:${scenario.id}`,
    detectorId: 'protocol-native-scenario',
    detectorVersion: '0.1.0',
    severity: 'info',
    evidenceClass: 'concrete-observation',
    subject: context.pool.hook,
    title: input.reverted
      ? `Generated ${scenario.operation} reverted at pinned state`
      : `Generated ${scenario.operation} executed at pinned state`,
    claim: `${scenario.description}, executed through a pinned Uniswap-derived scenario harness against the deployed PoolManager and hook at block ${context.stateBlockNumber}. This is a generated transaction against pinned state, not an onchain transaction.`,
    confidence: 'confirmed',
    callPath: proof.calls.map((call) => getAddress(call.target)).slice(0, 64),
    affectedPools: [context.pool.poolId],
    reproducibility: 'replayed',
    technical: {
      executionSource: 'protocol-native-generated',
      stateMode: 'pinned-block-with-declared-overrides',
      scenarioVersion: PROTOCOL_SCENARIO_VERSION,
      scenarioId: scenario.id,
      harness: scenarioRouterIdentity(context.overlay.patched),
      declaredOverrides: context.overlay.declaredOverrides,
      caller: scenario.caller === 'actor' ? context.actor : context.alternateActor,
      calldata: scenario.calldata,
      gasUsed: proof.gasUsed,
      observations,
      currencyDeltas: deltas,
      deltasSettled: deltas.length ? deltasFullySettled(deltas) : undefined,
      // Deliberately absent: no historical transaction hash. A generated
      // observation must never be mistaken for a reproduced onchain event.
    },
  }
}

/**
 * One deterministic record of what the generated suite actually ran.
 *
 * Scenarios that were unavailable or that failed for infrastructure reasons
 * produce no observation about the hook, so they are deliberately not findings.
 * They still belong in the report: a transcript that silently omits them would
 * read as though the suite covered more than it did.
 */
function suiteManifest(input: {
  poolManager: Address
  outcomes: ProtocolScenarioOutcome[]
  harness?: ReturnType<typeof scenarioRouterIdentity>
}): Evidence {
  const tally = (status: ProtocolScenarioOutcome['status']) =>
    input.outcomes.filter((outcome) => outcome.status === status).length
  return {
    id: 'protocol-scenario-suite',
    detectorId: 'protocol-native-scenario-suite',
    detectorVersion: '0.1.0',
    severity: 'info',
    evidenceClass: 'deterministic-fact',
    subject: input.poolManager,
    title: 'Generated PoolManager scenario suite',
    claim: `A pinned Uniswap-derived scenario harness ran ${input.outcomes.length} generated scenarios against the deployed PoolManager: ${tally('completed')} completed, ${tally('reverted')} reverted, ${tally('unavailable')} unavailable at the pinned block, ${tally('failed')} did not execute. Generated scenarios do not depend on any historical transaction, router, or calldata.`,
    confidence: 'confirmed',
    affectedPools: [...new Set(input.outcomes.map((outcome) => outcome.poolId))].slice(0, 20),
    reproducibility: 'not-applicable',
    technical: {
      executionSource: 'protocol-native-generated',
      scenarioVersion: PROTOCOL_SCENARIO_VERSION,
      harness: input.harness,
      outcomes: input.outcomes.map((outcome) => ({
        poolId: outcome.poolId,
        scenarioId: outcome.scenarioId,
        operation: outcome.operation,
        status: outcome.status,
        reason: outcome.reason,
        gasUsed: outcome.proof?.proof.gasUsed,
      })),
    },
  }
}

export async function runProtocolScenarios(input: {
  scanId: string
  client: PublicClient
  chainId: number
  poolManager: Address
  pools: PoolDescriptor[]
  stateBlockNumber: bigint
  pinnedBlock: { timestamp: bigint; baseFeePerGas: bigint | null; gasLimit: bigint; miner: Address }
  signal: AbortSignal
  maxPools?: number
  timeoutMs?: number
  maxHydrationRequests?: number
  createSession?: SessionFactory
  onProgress?: (completed: number, total: number, detail: string) => void
}): Promise<ProtocolScenarioCoverage> {
  const hookedPools = input.pools.filter((pool) => pool.hook !== ZERO_ADDRESS)
  const selected = hookedPools.slice(0, Math.max(0, input.maxPools ?? DEFAULT_POOL_CEILING))
  const createSession = input.createSession
    ?? ((options) => new ForkExecutionSession(options))
  const outcomes: ProtocolScenarioOutcome[] = []
  const findings: Evidence[] = []
  const contexts: ProtocolScenarioContext[] = []
  const limitations: string[] = []
  let hydrationReads = 0
  let executedPools = 0
  let completedScenarios = 0

  for (const pool of selected) {
    if (input.signal.aborted) throw new DOMException('Generated scenarios cancelled', 'AbortError')

    let context: ProtocolScenarioContext
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
        scenarioId: 'context',
        operation: 'swap',
        status: 'unavailable',
        reason: error instanceof Error ? error.message : String(error),
      })
      continue
    }
    contexts.push(context)

    const { scenarios, unavailable } = buildProtocolScenarioMatrix({
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
    for (const item of unavailable) {
      outcomes.push({ poolId: pool.poolId, scenarioId: item.id, operation: item.operation, status: 'unavailable', reason: item.reason })
    }

    const session = createSession({
      scanId: `${input.scanId}-protocol-${pool.poolId.slice(2, 10)}`,
      client: input.client,
      stateBlockNumber: input.stateBlockNumber,
      snapshot: context.overlay.snapshot,
    })

    try {
      let index = 0
      for (const scenario of scenarios) {
        if (input.signal.aborted) throw new DOMException('Generated scenarios cancelled', 'AbortError')
        input.onProgress?.(index++, scenarios.length, `${pool.poolId.slice(0, 10)} · ${scenario.id}`)
        try {
          const replay = await session.execute({
            transaction: {
              caller: scenario.caller === 'actor' ? context.actor : context.alternateActor,
              to: context.router,
              calldata: scenario.calldata,
              value: 0n,
              gasLimit: SCENARIO_GAS_LIMIT,
              gasPrice: 0n,
              nonce: 0,
              chainId: input.chainId,
              traceLimit: 2_048,
            },
            block: context.executionBlock,
            signal: input.signal,
            timeoutMs: input.timeoutMs ?? 20_000,
            maxHydrationRequests: input.maxHydrationRequests ?? 2_048,
            // Sequences observe their own prior steps inside one call, so no
            // scenario needs to commit across executions.
            commit: false,
          })
          const status = classify(replay)
          if (status === 'completed') completedScenarios++
          outcomes.push({ poolId: pool.poolId, scenarioId: scenario.id, operation: scenario.operation, status, proof: replay })
          findings.push(evidenceFor({ context, scenario, replay, reverted: status === 'reverted' }))
        } catch (error) {
          if (input.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
          outcomes.push({
            poolId: pool.poolId,
            scenarioId: scenario.id,
            operation: scenario.operation,
            status: 'failed',
            reason: error instanceof Error ? error.message : String(error),
          })
        }
      }
      executedPools++
    } finally {
      hydrationReads += session.metrics().rpcReads
      session.close()
    }
  }

  const reverted = outcomes.filter((outcome) => outcome.status === 'reverted').length
  const failed = outcomes.filter((outcome) => outcome.status === 'failed').length
  const capped = Math.max(0, hookedPools.length - selected.length)

  if (capped) limitations.push(`${capped} hooked pool${capped === 1 ? ' was' : 's were'} not covered by generated scenarios because the phase is bounded per scan.`)
  if (failed) limitations.push(`${failed} generated scenario${failed === 1 ? '' : 's'} could not execute for infrastructure reasons and produced no observation.`)
  if (reverted) limitations.push(`${reverted} generated scenario${reverted === 1 ? '' : 's'} reverted; a revert reached by the PoolManager is an observation about the pool, not an analyzer failure.`)
  if (outcomes.some((outcome) => outcome.status === 'unavailable')) {
    limitations.push('Some generated scenarios were unavailable at the pinned block; each records its own reason.')
  }
  if (completedScenarios) {
    limitations.push('Generated scenarios settle exclusively in ERC-6909 claims, so they exercise pool, hook, callback, and settlement behavior rather than the token\'s ordinary ERC-20 transfer path.')
  }

  return {
    status: executedPools === hookedPools.length && failed === 0 && executedPools > 0 ? 'passed' : 'degraded',
    version: PROTOCOL_SCENARIO_VERSION,
    eligiblePools: hookedPools.length,
    executedPools,
    scenarios: outcomes.length,
    completed: completedScenarios,
    reverted,
    failed,
    hydrationReads,
    findings: [
      ...findings,
      suiteManifest({
        poolManager: getAddress(input.poolManager),
        outcomes,
        harness: contexts[0] ? scenarioRouterIdentity(contexts[0].overlay.patched) : undefined,
      }),
    ],
    outcomes,
    limitations,
    contexts,
  }
}
