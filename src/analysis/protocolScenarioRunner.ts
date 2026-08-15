import { encodeFunctionData, getAddress, parseAbi, toEventSelector, type Address, type Hex, type PublicClient } from 'viem'
import type { SelectorSignatureLookup } from '../data/signatureDatabase'
import type { Evidence, PoolDescriptor } from '../domain/report'
import { ForkExecutionSession, type ForkReplayResult } from './revmProof'
import { summarizeExecutionObservations } from './executionObservations'
import { currencyDeltaSlot, decodeCurrencyDeltas, deltasFullySettled } from './currencyDeltas'
import { summarizeDynamicFees } from './poolEvents'
import { scenarioRouterIdentity } from './protocolScenarioArtifact'
import { buildProtocolScenarioContext, type ProtocolScenarioContext } from './protocolScenarioContext'
import { buildProtocolScenarioMatrix, type ProtocolScenario } from './protocolNativeScenarios'
import { reachedHook, validateScenarioExecution } from './protocolScenarioValidation'
import {
  compareExecutions,
  describeControlledComparison,
  type ComparisonNormalization,
  type ControlledDifference,
} from './behaviorComparators'
import { claimBalanceSlot } from './protocolScenarioState'
import { publicHackenSuiteEvidence, PUBLIC_HACKEN_VERSION } from './publicHackenScenarios'
import { runPublicHackenRuntimeProbes, type PublicHackenRuntimeProbe } from './publicHackenRuntime'
import { decodeProtocolRevert, summarizeProtocolSwapMovement, unresolvedProtocolRevertSelectors } from './protocolScenarioDiagnostics'

/**
 * Runs generated PoolManager scenarios for the discovered pools.
 *
 * This path requires only a pool and read access. It never consults historical
 * replay status, router recognition, historical calldata, or PositionManager
 * attribution, so a pool whose historical router is unrecognized still receives
 * protocol-level observations.
 */

// 0.10.0: unresolved revert selectors are batch-resolved through Sourcify's
// filtered 4byte database and remain explicitly labelled as collision-prone
// candidates rather than target-ABI facts.
// 0.11.0: the same hydrated fork session now runs canonical hook getter,
// direct-callback authorization, ERC-165, and compatible secondary-PoolId
// adaptations for the public Hacken catalogue.
export const PROTOCOL_SCENARIO_VERSION = 'protocol-native-generated/0.11.0'

/** EIP-7825 caps a transaction at 2**24 gas; revm enforces it on recent forks. */
const SCENARIO_GAS_LIMIT = 16_000_000n
/** `poolManager()` on the harness; used to prove the injected patch took effect. */
const POOL_MANAGER_GETTER = '0xdc4c90d3' as Hex
const DEFAULT_POOL_CEILING = 3
/** Allows the first scenario to hydrate a public-RPC fork without poisoning the reusable session. */
const DEFAULT_SCENARIO_TIMEOUT_MS = 45_000

export type ProtocolScenarioOutcome = {
  poolId: Hex
  scenarioId: string
  operation: ProtocolScenario['operation'] | 'initialize'
  description?: string
  status: 'completed' | 'reverted' | 'unavailable' | 'failed'
  proof?: ForkReplayResult
  reason?: string
}

export type ProtocolScenarioCoverage = {
  status: 'passed' | 'degraded'
  version: string
  publicHackenVersion: string
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
const INITIALIZE_ABI = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'function initialize(PoolKey key, uint160 sqrtPriceX96) returns (int24 tick)',
])
const INITIALIZE_SELECTOR = '0x6276cbbe' as Hex
const INITIALIZE_TOPIC = toEventSelector('event Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)')



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
    detectorVersion: '0.4.0',
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
      // eth_call semantics: no signed transaction, no gas charged, real base fee.
      executionMode: 'simulation',
      scenarioVersion: PROTOCOL_SCENARIO_VERSION,
      scenarioId: scenario.id,
      harness: scenarioRouterIdentity(context.overlay.patched),
      declaredOverrides: context.overlay.declaredOverrides,
      caller: scenario.caller === 'actor' ? context.actor : context.alternateActor,
      sender: scenario.via === 'router' ? context.router : context.alternateRouter,
      reachedHook: reachedHook(proof, context.pool.hook),
      relocatedAddresses: context.relocatedAddresses.length ? context.relocatedAddresses : undefined,
      calldata: scenario.calldata,
      gasUsed: proof.gasUsed,
      calls: proof.calls,
      observations,
      currencyDeltas: deltas,
      deltasSettled: deltas.length ? deltasFullySettled(deltas) : undefined,
      // Deliberately absent: no historical transaction hash. A generated
      // observation must never be mistaken for a reproduced onchain event.
    },
  }
}

function reinitializeEvidence(input: {
  context: ProtocolScenarioContext
  replay: ForkReplayResult
  status: 'completed' | 'reverted'
  calldata: Hex
}): Evidence {
  const { context, replay } = input
  return {
    id: `protocol-scenario:${context.pool.poolId.slice(2, 14)}:initialize:reinitialize`,
    detectorId: 'protocol-native-scenario',
    detectorVersion: '0.5.0',
    severity: input.status === 'completed' ? 'high' : 'info',
    evidenceClass: 'concrete-observation',
    subject: context.pool.hook,
    title: input.status === 'completed'
      ? 'Existing PoolId initialization unexpectedly completed'
      : 'Existing PoolId initialization reverted',
    claim: `The analyzer called initialize directly on the deployed PoolManager with the selected existing PoolKey at block ${context.stateBlockNumber}; the call ${input.status}. This is a generated pinned-state simulation, not an onchain transaction.`,
    confidence: 'confirmed',
    callPath: replay.proof.calls.map((call) => getAddress(call.target)).slice(0, 64),
    affectedPools: [context.pool.poolId],
    reproducibility: 'replayed',
    technical: {
      executionSource: 'protocol-native-generated',
      stateMode: 'pinned-block-with-declared-overrides',
      executionMode: 'simulation',
      scenarioVersion: PROTOCOL_SCENARIO_VERSION,
      scenarioId: 'initialize:reinitialize',
      calldata: input.calldata,
      gasUsed: replay.proof.gasUsed,
      calls: replay.proof.calls,
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
  selectorSignatures?: SelectorSignatureLookup
}): Evidence {
  const tally = (status: ProtocolScenarioOutcome['status']) =>
    input.outcomes.filter((outcome) => outcome.status === status).length
  return {
    id: 'protocol-scenario-suite',
    detectorId: 'protocol-native-scenario-suite',
    detectorVersion: '0.5.0',
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
        description: outcome.description,
        status: outcome.status,
        reason: outcome.reason,
        gasUsed: outcome.proof?.proof.gasUsed,
        revert: outcome.status === 'reverted'
          ? decodeProtocolRevert(outcome.proof?.proof.output, input.selectorSignatures)
          : undefined,
        swapMovement: outcome.proof
          ? summarizeProtocolSwapMovement({
              proof: outcome.proof.proof,
              poolManager: input.poolManager,
              poolId: outcome.poolId,
            })
          : undefined,
      })),
    },
  }
}

/**
 * Turns the caller-probe corners into attributable dependency findings.
 *
 * Two comparisons are drawn from the four runs: baseline against tx-caller, and
 * baseline against hook-sender. Each varies one input. The combined corner is
 * executed and reported as an outcome but is deliberately not compared here —
 * it differs in two variables at once, so any difference it shows would be
 * unattributable, which is the flaw this family exists to fix.
 */
function callerDependenceFindings(input: {
  context: ProtocolScenarioContext
  probeProofs: Map<string, ForkReplayResult>
}): Evidence[] {
  const { context, probeProofs } = input
  const baseline = probeProofs.get('baseline')
  if (!baseline) return []

  const decodedObservations = (proof: ForkReplayResult['proof']) => ({
    currencyDeltas: decodeCurrencyDeltas({
      proof,
      poolManager: context.poolManager,
      accounts: [
        context.router,
        context.alternateRouter,
        context.actor,
        context.alternateActor,
        context.poolManager,
        context.pool.hook,
      ],
      currencies: [context.pool.currency0, context.pool.currency1],
    }),
    fees: summarizeDynamicFees({
      proof,
      poolManager: context.poolManager,
      poolId: context.pool.poolId,
      poolFee: context.pool.fee,
    })?.observedFees ?? [],
  })

  // Each pair declares what differs by construction, so the comparison reports
  // only what the hook did rather than the substitution being visible.
  const callerNormalization: ComparisonNormalization = {
    substituted: [{ before: context.actor, after: context.alternateActor }],
  }
  const senderNormalization: ComparisonNormalization = {
    substituted: [{ before: context.router, after: context.alternateRouter }],
    // Each harness instance owns its own ERC-6909 claim balances inside the
    // PoolManager, so those slots always differ when the instance does.
    ignoredSlots: [context.router, context.alternateRouter].flatMap((router) =>
      [context.pool.currency0, context.pool.currency1].flatMap((currency) => [
        claimBalanceSlot(router, currency),
        currencyDeltaSlot(router, currency),
      ]),
    ),
  }

  const pairs: {
    id: string
    difference: ControlledDifference
    proof?: ForkReplayResult
    normalization: ComparisonNormalization
  }[] = [
    {
      id: 'transaction-caller',
      difference: { kind: 'transaction-caller', before: context.actor, after: context.alternateActor },
      proof: probeProofs.get('tx-caller'),
      normalization: callerNormalization,
    },
    {
      id: 'hook-sender',
      difference: { kind: 'hook-sender', before: context.router, after: context.alternateRouter },
      proof: probeProofs.get('hook-sender'),
      normalization: senderNormalization,
    },
  ]

  const findings: Evidence[] = []
  for (const pair of pairs) {
    if (!pair.proof) continue
    const behavior = compareExecutions({
      before: baseline.proof,
      after: pair.proof.proof,
      normalization: pair.normalization,
      beforeObservations: decodedObservations(baseline.proof),
      afterObservations: decodedObservations(pair.proof.proof),
    })
    const comparison = describeControlledComparison({ difference: pair.difference, behavior })
    findings.push({
      id: `caller-dependence:${context.pool.poolId.slice(2, 14)}:${pair.id}`,
      detectorId: `concrete-${pair.id}-dependence`,
      detectorVersion: '0.2.0',
      // A demonstrated dependence is worth more than a co-presence hint and
      // less than a demonstrated exploit; no difference at all is information.
      severity: behavior.identical ? 'info' : 'medium',
      evidenceClass: 'concrete-observation',
      subject: context.pool.hook,
      title: behavior.identical
        ? `Changing only the ${pair.id === 'hook-sender' ? 'hook-visible sender' : 'transaction caller'} changed nothing observable`
        : `Behavior depends on the ${pair.id === 'hook-sender' ? 'hook-visible sender' : 'transaction caller'}`,
      claim: `${comparison.summary} Both executions ran the identical generated calldata against the deployed PoolManager and hook at block ${context.stateBlockNumber}, differing in one input only. This is a fact about these two executions at this pinned state, not a universal property of the hook.`,
      confidence: 'confirmed',
      affectedPools: [context.pool.poolId],
      storage: behavior.changedStorage.slice(0, 8).map((diff) => ({
        slot: diff.slot,
        before: diff.before,
        after: diff.after,
      })),
      reproducibility: 'replayed',
      technical: {
        executionSource: 'protocol-native-generated',
        stateMode: 'pinned-block-with-declared-overrides',
        controlledDifference: pair.difference,
        // Declared so a reader can see what was discounted, not just what remained.
        normalization: {
          substituted: pair.normalization.substituted,
          ignoredSlotCount: pair.normalization.ignoredSlots?.length ?? 0,
        },
        behavior,
        // Deliberately absent: no historical transaction hash.
      },
    })
  }
  return findings
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
  resolveSelectorSignatures?: (selectors: Hex[], signal: AbortSignal) => Promise<SelectorSignatureLookup>
  onProgress?: (completed: number, total: number, detail: string) => void
}): Promise<ProtocolScenarioCoverage> {
  const hookedPools = input.pools.filter((pool) => pool.hook !== ZERO_ADDRESS)
  const selected = hookedPools.slice(0, Math.max(0, input.maxPools ?? DEFAULT_POOL_CEILING))
  const createSession = input.createSession
    ?? ((options) => new ForkExecutionSession(options))
  const outcomes: ProtocolScenarioOutcome[] = []
  const findings: Evidence[] = []
  const deferredFindings: Evidence[] = []
  const contexts: ProtocolScenarioContext[] = []
  const publicHackenRuntimeProbes: PublicHackenRuntimeProbe[] = []
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
        description: 'Prepare a pinned PoolManager execution context for the selected pool.',
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
      outcomes.push({
        poolId: pool.poolId,
        scenarioId: item.id,
        operation: item.operation,
        description: `Generate the ${item.operation} scenario family from the selected PoolKey and pinned pool state.`,
        status: 'unavailable',
        reason: item.reason,
      })
    }

    const session = createSession({
      scanId: `${input.scanId}-protocol-${pool.poolId.slice(2, 10)}`,
      client: input.client,
      stateBlockNumber: input.stateBlockNumber,
      snapshot: context.overlay.snapshot,
    })

    try {
      // Preflight: ask the injected harness which PoolManager it is bound to.
      // Patching only compiler-declared immutable positions is a static
      // guarantee; this is the runtime one, and it costs a single call.
      const bound = await session.execute({
        transaction: {
          caller: context.actor,
          to: context.router,
          calldata: POOL_MANAGER_GETTER,
          value: 0n,
          executionMode: 'simulation',
          gasLimit: 100_000n,
          gasPrice: 0n,
          nonce: 0,
          chainId: input.chainId,
          traceLimit: 8,
        },
        block: context.executionBlock,
        signal: input.signal,
        timeoutMs: input.timeoutMs ?? 20_000,
        maxHydrationRequests: 64,
        commit: false,
      })
      const reported = bound.proof.success && bound.proof.output.length === 66
        ? getAddress(`0x${bound.proof.output.slice(26)}`)
        : undefined
      if (reported !== context.poolManager) {
        outcomes.push({
          poolId: pool.poolId,
          scenarioId: 'harness-binding',
          operation: 'swap',
          description: 'Verify that the injected scenario harness is bound to the deployed PoolManager.',
          status: 'failed',
          reason: `The injected harness reported PoolManager ${reported ?? 'nothing'}, expected ${context.poolManager}.`,
        })
        continue
      }

      // The upstream reinitialization case does not belong inside unlock: it is
      // a direct PoolManager invariant. Run it independently so the public
      // adaptation covers the real deployed manager without teaching the
      // injected router a fixture-only operation.
      const initializeCalldata = encodeFunctionData({
        abi: INITIALIZE_ABI,
        functionName: 'initialize',
        args: [{
          currency0: pool.currency0,
          currency1: pool.currency1,
          fee: pool.fee,
          tickSpacing: pool.tickSpacing,
          hooks: pool.hook,
        }, context.slot0?.sqrtPriceX96 ?? (1n << 96n)],
      })
      try {
        const replay = await session.execute({
          transaction: {
            caller: context.actor,
            to: context.poolManager,
            calldata: initializeCalldata,
            value: 0n,
            executionMode: 'simulation',
            gasLimit: 1_000_000n,
            gasPrice: 0n,
            nonce: 0,
            chainId: input.chainId,
            traceLimit: 512,
          },
          block: context.executionBlock,
          signal: input.signal,
          timeoutMs: input.timeoutMs ?? 20_000,
          maxHydrationRequests: input.maxHydrationRequests ?? 512,
          commit: false,
        })
        const entered = replay.proof.calls.some((call) =>
          call.target.toLowerCase() === context.poolManager.toLowerCase()
          && call.selector?.toLowerCase() === INITIALIZE_SELECTOR)
        if (!entered) {
          outcomes.push({
            poolId: pool.poolId,
            scenarioId: 'initialize:reinitialize',
            operation: 'initialize',
            description: 'Call initialize again with the selected existing PoolKey; the PoolManager should reject the already initialized PoolId.',
            status: 'failed',
            proof: replay,
            reason: 'The generated initialize call did not enter the deployed PoolManager, so it produced no pool observation.',
          })
        } else if (!replay.proof.success) {
          outcomes.push({
            poolId: pool.poolId,
            scenarioId: 'initialize:reinitialize',
            operation: 'initialize',
            description: 'Call initialize again with the selected existing PoolKey; the PoolManager should reject the already initialized PoolId.',
            status: 'reverted',
            proof: replay,
          })
          deferredFindings.push(reinitializeEvidence({ context, replay, status: 'reverted', calldata: initializeCalldata }))
        } else {
          const initializedSelectedPool = replay.proof.logs.some((log) =>
            log.address.toLowerCase() === context.poolManager.toLowerCase()
            && log.topics[0]?.toLowerCase() === INITIALIZE_TOPIC.toLowerCase()
            && log.topics[1]?.toLowerCase() === pool.poolId.toLowerCase())
          if (!initializedSelectedPool) {
            outcomes.push({
              poolId: pool.poolId,
              scenarioId: 'initialize:reinitialize',
              operation: 'initialize',
              description: 'Call initialize again with the selected existing PoolKey; the PoolManager should reject the already initialized PoolId.',
              status: 'failed',
              proof: replay,
              reason: 'The initialize call completed without an Initialize event naming the selected PoolId.',
            })
          } else {
            completedScenarios++
            outcomes.push({
              poolId: pool.poolId,
              scenarioId: 'initialize:reinitialize',
              operation: 'initialize',
              description: 'Call initialize again with the selected existing PoolKey; the PoolManager should reject the already initialized PoolId.',
              status: 'completed',
              proof: replay,
            })
            deferredFindings.push(reinitializeEvidence({ context, replay, status: 'completed', calldata: initializeCalldata }))
          }
        }
      } catch (error) {
        if (input.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
        outcomes.push({
          poolId: pool.poolId,
          scenarioId: 'initialize:reinitialize',
          operation: 'initialize',
          description: 'Call initialize again with the selected existing PoolKey; the PoolManager should reject the already initialized PoolId.',
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        })
      }

      // Proofs from the caller-dependence probe, kept so the four corners can be
      // paired afterwards. Attribution needs both members of a pair, so it
      // cannot be done as each scenario finishes.
      const probeProofs = new Map<string, ForkReplayResult>()

      let index = 0
      for (const scenario of scenarios) {
        if (input.signal.aborted) throw new DOMException('Generated scenarios cancelled', 'AbortError')
        input.onProgress?.(index++, scenarios.length, `${pool.poolId.slice(0, 10)} · ${scenario.id}`)
        try {
          const replay = await session.execute({
            transaction: {
              caller: scenario.caller === 'actor' ? context.actor : context.alternateActor,
              to: scenario.via === 'router' ? context.router : context.alternateRouter,
              calldata: scenario.calldata,
              value: 0n,
              executionMode: 'simulation',
              gasLimit: SCENARIO_GAS_LIMIT,
              gasPrice: 0n,
              nonce: 0,
              chainId: input.chainId,
              traceLimit: 2_048,
            },
            block: context.executionBlock,
            signal: input.signal,
            timeoutMs: input.timeoutMs ?? DEFAULT_SCENARIO_TIMEOUT_MS,
            maxHydrationRequests: input.maxHydrationRequests ?? 2_048,
            // Sequences observe their own prior steps inside one call, so no
            // scenario needs to commit across executions.
            commit: false,
          })
          // Success alone is not evidence: the trace has to have entered the
          // deployed PoolManager and named the selected pool.
          const validation = validateScenarioExecution({
            proof: replay.proof,
            scenario,
            poolManager: context.poolManager,
            hook: context.pool.hook,
            poolId: context.pool.poolId,
            router: scenario.via === 'router' ? context.router : context.alternateRouter,
          })
          if (validation.status === 'failed') {
            outcomes.push({
              poolId: pool.poolId,
              scenarioId: scenario.id,
              operation: scenario.operation,
              description: scenario.description,
              status: 'failed',
              proof: replay,
              reason: validation.reason,
            })
            continue
          }
          if (validation.status === 'completed') completedScenarios++
          if (scenario.id.startsWith('caller-probe:')) {
            probeProofs.set(scenario.id.slice('caller-probe:'.length), replay)
          }
          outcomes.push({
            poolId: pool.poolId,
            scenarioId: scenario.id,
            operation: scenario.operation,
            description: scenario.description,
            status: validation.status,
            proof: replay,
          })
          findings.push(evidenceFor({ context, scenario, replay, reverted: validation.status === 'reverted' }))
        } catch (error) {
          if (input.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
          outcomes.push({
            poolId: pool.poolId,
            scenarioId: scenario.id,
            operation: scenario.operation,
            description: scenario.description,
            status: 'failed',
            reason: error instanceof Error ? error.message : String(error),
          })
        }
      }
      // Pair the probe corners: each comparison changes exactly one variable, so
      // a difference is attributable to that variable rather than to context in
      // general.
      findings.push(...callerDependenceFindings({ context, probeProofs }))

      // Reuse this pool's hydrated session for public-hook introspection and
      // authorization probes. This keeps these adaptations pinned to the exact
      // same block and avoids a second burst of account/code/storage RPC reads.
      publicHackenRuntimeProbes.push(...await runPublicHackenRuntimeProbes({
        session,
        context,
        pools: input.pools,
        signal: input.signal,
        maxHydrationRequests: input.maxHydrationRequests,
      }))
      executedPools++
    } finally {
      hydrationReads += session.metrics().rpcReads
      session.close()
    }
  }

  const reverted = outcomes.filter((outcome) => outcome.status === 'reverted').length
  const behaviorReverts = outcomes.filter((outcome) =>
    outcome.status === 'reverted' && outcome.scenarioId !== 'initialize:reinitialize').length
  const failed = outcomes.filter((outcome) => outcome.status === 'failed').length
  const runtimeProbeErrors = publicHackenRuntimeProbes.filter((probe) => probe.status === 'error').length
  const runtimeProbeUnavailable = publicHackenRuntimeProbes.filter((probe) => probe.status === 'unavailable').length
  const capped = Math.max(0, hookedPools.length - selected.length)

  if (capped) limitations.push(`${capped} hooked pool${capped === 1 ? ' was' : 's were'} not covered by generated scenarios because the phase is bounded per scan.`)
  if (failed) limitations.push(`${failed} generated scenario${failed === 1 ? '' : 's'} did not produce an observation: each either could not execute, or executed without reaching the deployed PoolManager for the selected pool.`)
  if (behaviorReverts) limitations.push(`${behaviorReverts} generated scenario${behaviorReverts === 1 ? '' : 's'} reverted; a revert reached by the PoolManager is an observation about the pool, not an analyzer failure.`)
  if (outcomes.some((outcome) => outcome.status === 'unavailable')) {
    limitations.push('Some generated scenarios were unavailable at the pinned block; each records its own reason.')
  }
  if (runtimeProbeErrors) {
    limitations.push(`${runtimeProbeErrors} public-hook runtime adaptation${runtimeProbeErrors === 1 ? '' : 's'} encountered an analyzer or execution error; each case records its own reason.`)
  }
  if (runtimeProbeUnavailable) {
    limitations.push(`${runtimeProbeUnavailable} conditional public-hook adaptation${runtimeProbeUnavailable === 1 ? ' was' : 's were'} unavailable because the deployed hook or discovered pool batch did not prove the required interface or prerequisite.`)
  }
  if (completedScenarios) {
    limitations.push('Generated scenarios settle exclusively in ERC-6909 claims, so they exercise pool, hook, callback, and settlement behavior rather than the token\'s ordinary ERC-20 transfer path.')
  }

  const unresolvedSelectors = [...new Set(
    outcomes.flatMap((outcome) => outcome.status === 'reverted'
      ? unresolvedProtocolRevertSelectors(outcome.proof?.proof.output)
      : []),
  )]
  let selectorSignatures: SelectorSignatureLookup | undefined
  if (unresolvedSelectors.length && input.resolveSelectorSignatures) {
    try {
      selectorSignatures = await input.resolveSelectorSignatures(unresolvedSelectors, input.signal)
    } catch (error) {
      if (input.signal.aborted) throw error
      limitations.push(`Sourcify 4byte could not label ${unresolvedSelectors.length} unresolved revert selector${unresolvedSelectors.length === 1 ? '' : 's'}; raw selectors remain in the report.`)
    }
  }

  return {
    status: executedPools === hookedPools.length && failed === 0 && runtimeProbeErrors === 0 && executedPools > 0 ? 'passed' : 'degraded',
    version: PROTOCOL_SCENARIO_VERSION,
    publicHackenVersion: PUBLIC_HACKEN_VERSION,
    eligiblePools: hookedPools.length,
    executedPools,
    scenarios: outcomes.length,
    completed: completedScenarios,
    reverted,
    failed,
    hydrationReads,
    findings: [
      ...findings,
      ...deferredFindings,
      suiteManifest({
        poolManager: getAddress(input.poolManager),
        outcomes,
        harness: contexts[0] ? scenarioRouterIdentity(contexts[0].overlay.patched) : undefined,
        selectorSignatures,
      }),
      publicHackenSuiteEvidence({
        poolManager: getAddress(input.poolManager),
        pools: selected,
        outcomes,
        runtimeProbes: publicHackenRuntimeProbes,
        selectorSignatures,
      }),
    ],
    outcomes,
    limitations,
    contexts,
  }
}

export { PUBLIC_HACKEN_VERSION }
