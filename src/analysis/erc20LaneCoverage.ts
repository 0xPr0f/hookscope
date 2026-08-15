import { getAddress, type Address, type Hex } from 'viem'
import type { Evidence } from '../domain/report'
import type { LivePoolReplayCoverage, PoolReplayOutcome } from './livePoolReplay'
import type { PoolReplayCandidate } from '../data/replay'
import type { ProtocolScenarioContext } from './protocolScenarioContext'
import type { ProtocolScenarioOutcome } from './protocolScenarioRunner'
import { encodeErc20Scenario, buildProtocolScenarioMatrix, type ProtocolScenario } from './protocolNativeScenarios'
import { identifyTokenPayer, type ProvisioningSource } from './erc20Provisioning'
import { erc20LaneEvidence, runErc20Lane, type Erc20LaneOutcome, type Erc20LaneSession } from './erc20ScenarioLane'
import { ROUND_TRIP_VERSION, roundTripEvidence, runErc20RoundTrip, type Erc20RoundTripResult } from './erc20RoundTrip'
import { decodePoolManagerSwaps } from './poolEvents'
import { compareLanes } from './erc20Observations'
import { encodeFunctionData, parseAbi } from 'viem'

/**
 * Pairs the ERC-20 settlement lane with the claims baseline, pool by pool.
 *
 * Token-funded cases need one thing the claims baseline does not: a real account
 * that already holds the input token. Native-funded cases do not. They use the
 * bounded synthetic actor declared in the fork overlay, acquire the deployed
 * token through the pool, and carry that exact output into the reverse leg.
 * Neither path depends on a token symbol, address, or project-specific mapping.
 */

export const ERC20_LANE_VERSION = 'protocol-native-erc20-lane/1.1.0'

const NATIVE_CURRENCY = '0x0000000000000000000000000000000000000000' as Address

/** Minimal ABI for the balance reads the round trip measures its legs with. */
const BALANCE_ABI = parseAbi(['function balanceOf(address owner) view returns (uint256)'])

/** How many scenarios per pool run on the token rail. Bounded: each costs real reads. */
const DEFAULT_SCENARIOS_PER_POOL = 4
/** 0.001 native units from the declared 1-native-unit actor overlay. */
const NATIVE_ROUND_TRIP_INPUT = 1_000_000_000_000_000n

/**
 * Scenarios worth running on the token rail, in priority order.
 *
 * Both directions matter most: a token can accept being bought and refuse being
 * sold, and only running one direction would miss exactly that. Amount variation
 * comes next, since thresholds and fees are amount-dependent.
 */
const LANE_SCENARIO_IDS = [
  'swap:exact-input:0-for-1:medium',
  'swap:exact-input:1-for-0:medium',
  'swap:exact-input:0-for-1:small',
  'swap:exact-input:1-for-0:small',
  'swap:exact-output:0-for-1:medium',
  'swap:exact-output:1-for-0:medium',
] as const

export type Erc20LaneCoverage = {
  status: 'passed' | 'degraded' | 'unavailable'
  version: string
  eligiblePools: number
  coveredPools: number
  completed: number
  reverted: number
  unavailable: number
  /** Standalone token-input cases whose direction was exercised by a committed round trip. */
  coveredByRoundTrip: number
  failed: number
  outcomes: (Erc20LaneOutcome & { poolId: Hex })[]
  /** One committed buy → approve → sell trip per covered pool. */
  roundTrips: (Erc20RoundTripResult & { poolId: Hex })[]
  findings: Evidence[]
  limitations: string[]
}

export type PayerResolution =
  | { ok: true; payer: Address; token: Address; source: ProvisioningSource }
  | { ok: false; reason: string }

/**
 * Finds the input leg and a real holder of it from the replayed history.
 *
 * Which currency to exercise cannot be assumed. On an ERC-20/ERC-20 pool both
 * legs are tokens, and picking `currency0` would analyze whichever asset the
 * PoolKey happened to sort first rather than the transaction's actual input.
 * That could approve and measure a currency the replayed swap never spent.
 *
 * The direction is therefore taken from the selected pool's decoded Swap
 * event. Its negative delta is the currency the caller owed the PoolManager.
 * The transfer chain for that exact currency must then terminate at the
 * PoolManager; otherwise the payer is not considered identified.
 */
export function resolvePayerFromReplay(input: {
  replay: LivePoolReplayCoverage
  poolId: Hex
  currency0: Address
  currency1: Address
  poolManager: Address
}): PayerResolution {
  const zero = '0x0000000000000000000000000000000000000000'

  const outcome = input.replay.outcomes.find(
    (item): item is PoolReplayOutcome & { candidate: PoolReplayCandidate } =>
      item.status === 'passed'
      && item.kind === 'swap'
      && item.poolId.toLowerCase() === input.poolId.toLowerCase()
      && Boolean(item.candidate)
      && Boolean(item.replay),
  )
  if (!outcome?.replay) {
    return { ok: false, reason: 'No receipt-matched swap replay for this pool could supply a funded token holder.' }
  }

  const swaps = decodePoolManagerSwaps(outcome.replay.proof, input.poolManager)
    .filter((swap) => swap.poolId.toLowerCase() === input.poolId.toLowerCase())
  const inputLegs = new Set(swaps.flatMap((swap) => {
    if (swap.amount0 < 0n && swap.amount1 >= 0n) return [0]
    if (swap.amount1 < 0n && swap.amount0 >= 0n) return [1]
    return []
  }))
  if (inputLegs.size !== 1) {
    return {
      ok: false,
      reason: swaps.length
        ? 'The replayed transaction did not expose one unambiguous swap input currency for the selected pool.'
        : 'The replayed transaction emitted no decodable Swap event for the selected pool.',
    }
  }

  const inputToken = getAddress([...inputLegs][0] === 0 ? input.currency0 : input.currency1)
  if (inputToken.toLowerCase() === zero) {
    return { ok: false, reason: 'The replayed swap paid with the native currency, so it cannot supply an ERC-20 approval actor.' }
  }
  const identified = identifyTokenPayer({
    proof: outcome.replay.proof,
    token: inputToken,
    poolManager: input.poolManager,
  })
  if (!identified.ok) return identified

  return {
    ok: true,
    payer: identified.payer,
    token: inputToken,
    source: 'receipt-derived',
  }
}

function laneScenarios(context: ProtocolScenarioContext, limit: number): ProtocolScenario[] {
  const { scenarios } = buildProtocolScenarioMatrix({
    key: {
      currency0: context.pool.currency0,
      currency1: context.pool.currency1,
      fee: context.pool.fee,
      tickSpacing: context.pool.tickSpacing,
      hooks: context.pool.hook,
    },
    currentTick: context.slot0?.tick,
    actor: context.actor,
  })
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]))
  return LANE_SCENARIO_IDS.map((id) => byId.get(id)).filter((scenario): scenario is ProtocolScenario => Boolean(scenario)).slice(0, limit)
}

/** How the claims lane finished for one scenario, for the comparison. */
function claimsOutcomeFor(
  outcomes: ProtocolScenarioOutcome[],
  poolId: Hex,
  scenarioId: string,
): 'completed' | 'reverted' | 'unavailable' {
  const match = outcomes.find(
    (outcome) => outcome.poolId.toLowerCase() === poolId.toLowerCase() && outcome.scenarioId === scenarioId,
  )
  if (match?.status === 'completed') return 'completed'
  if (match?.status === 'reverted') return 'reverted'
  return 'unavailable'
}

/**
 * Reconciles redundant standalone funding failures with a successful native
 * round trip without pretending the standalone amount itself executed.
 */
export function applyNativeRoundTripCoverage(input: {
  poolId: Hex
  trip: Erc20RoundTripResult
  outcomes: (Erc20LaneOutcome & { poolId: Hex })[]
  findings: Evidence[]
}): number {
  if (
    input.trip.status !== 'completed'
    || input.trip.inputToken.toLowerCase() !== NATIVE_CURRENCY
    || input.trip.outputToken.toLowerCase() === NATIVE_CURRENCY
  ) return 0

  let covered = 0
  for (const outcome of input.outcomes) {
    if (
      outcome.poolId.toLowerCase() !== input.poolId.toLowerCase()
      || outcome.status !== 'preparation-unavailable'
      || outcome.tokenRole !== 'input'
      || !outcome.scenarioId.startsWith('swap:exact-input:')
      || outcome.preparation.token.toLowerCase() !== input.trip.outputToken.toLowerCase()
    ) continue

    const reason = `A committed native → token → native round trip bought ${input.trip.forwardReceived} of ${input.trip.outputToken} through this pool and sold that exact received amount back. This covers the token-input direction at the pinned state; the standalone ${outcome.scenarioId} amount was not independently executed.`
    outcome.coveredByRoundTrip = {
      method: 'committed-native-token-native',
      roundTripVersion: ROUND_TRIP_VERSION,
      reason,
    }
    covered++

    const findingIndex = input.findings.findIndex((finding) =>
      finding.detectorId === 'protocol-native-erc20-lane'
      && finding.affectedPools.some((poolId) => poolId.toLowerCase() === input.poolId.toLowerCase())
      && finding.technical?.scenarioId === outcome.scenarioId,
    )
    const finding = input.findings[findingIndex]
    if (finding) {
      input.findings[findingIndex] = {
        ...finding,
        title: 'Token-input direction covered by committed round trip',
        claim: `The standalone generated case was not executed because it lacked an independent pre-funded token holder. ${reason} This is generated execution against pinned state, not an onchain transaction.`,
        technical: {
          ...finding.technical,
          coveredByRoundTrip: outcome.coveredByRoundTrip,
        },
      }
    }
  }
  return covered
}

export async function runErc20LaneCoverage(input: {
  contexts: ProtocolScenarioContext[]
  claimsOutcomes: ProtocolScenarioOutcome[]
  replay?: LivePoolReplayCoverage
  createSession: (input: {
    scanId: string
    stateBlockNumber: bigint
    snapshot: ProtocolScenarioContext['overlay']['snapshot']
  }) => Erc20LaneSession & { close(): void }
  scanId: string
  /** Pinned code lookup used to prove that direct caller impersonation is valid. */
  readPayerCode: (address: Address, blockNumber: bigint) => Promise<Hex | undefined>
  signal: AbortSignal
  maxScenariosPerPool?: number
  timeoutMs?: number
  onProgress?: (completed: number, total: number, detail: string) => void
}): Promise<Erc20LaneCoverage> {
  const outcomes: (Erc20LaneOutcome & { poolId: Hex })[] = []
  const roundTrips: (Erc20RoundTripResult & { poolId: Hex })[] = []
  const findings: Evidence[] = []
  const limitations: string[] = []
  let coveredPools = 0
  let completed = 0

  for (const [index, context] of input.contexts.entries()) {
    if (input.signal.aborted) throw new DOMException('ERC-20 lane cancelled', 'AbortError')

    let resolution: PayerResolution = input.replay
      ? resolvePayerFromReplay({
          replay: input.replay,
          poolId: context.pool.poolId,
          currency0: context.pool.currency0,
          currency1: context.pool.currency1,
          poolManager: context.poolManager,
        })
      : { ok: false as const, reason: 'Historical replay did not run, so no funded token holder was available.' }

    if (resolution.ok) {
      try {
        const code = await input.readPayerCode(resolution.payer, context.stateBlockNumber)
        if (input.signal.aborted) throw new DOMException('ERC-20 lane cancelled', 'AbortError')
        if (code === undefined) {
          resolution = {
            ok: false,
            reason: `The replay-derived payer ${resolution.payer} could not be checked for code at the pinned block.`,
          }
        } else if (code !== '0x') {
          resolution = {
            ok: false,
            reason: `The replay-derived payer ${resolution.payer} is a contract at the pinned block; directly originating approve from it would bypass its authorization logic.`,
          }
        }
      } catch (error) {
        if (input.signal.aborted) throw error
        resolution = {
          ok: false,
          reason: `The replay-derived payer could not be validated at the pinned block: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }

    const scenarios = laneScenarios(context, input.maxScenariosPerPool ?? DEFAULT_SCENARIOS_PER_POOL)
    if (!scenarios.length) continue

    const createIsolatedSession = (suffix: string) => input.createSession({
      scanId: `${input.scanId}-erc20-${index}-${suffix}`,
      stateBlockNumber: context.stateBlockNumber,
      snapshot: context.overlay.snapshot,
    })
    let poolAttempted = false
    try {
      for (const [scenarioIndex, scenario] of scenarios.entries()) {
        if (input.signal.aborted) throw new DOMException('ERC-20 lane cancelled', 'AbortError')
        input.onProgress?.(completed, input.contexts.length, `${context.pool.poolId.slice(0, 10)} · ${scenario.id}`)

        const swapStep = scenario.steps.find((step) => step.operation === 0)
        const scenarioInputCurrency = swapStep
          ? getAddress(swapStep.zeroForOne ? swapStep.key.currency0 : swapStep.key.currency1)
          : context.pool.currency0
        const claimsOutcome = claimsOutcomeFor(input.claimsOutcomes, context.pool.poolId, scenario.id)
        const nativeInput = scenarioInputCurrency === NATIVE_CURRENCY
        const observedToken = nativeInput && swapStep
          ? getAddress(swapStep.zeroForOne ? swapStep.key.currency1 : swapStep.key.currency0)
          : scenarioInputCurrency
        const requested = scenario.steps[0]?.amountSpecified ?? 0n
        const scenarioPayer = nativeInput ? context.actor : resolution.ok ? resolution.payer : undefined
        const scenarioProvisioning: ProvisioningSource = nativeInput
          ? 'verified-storage-overlay'
          : resolution.ok
            ? resolution.source
            : 'unavailable'

        if (!scenarioPayer) {
          const reason = resolution.ok
            ? 'No verified payer was available for this token-funded scenario.'
            : resolution.reason
          const outcome: Erc20LaneOutcome = {
            scenarioId: scenario.id,
            tokenRole: 'input',
            nativeValue: 0n,
            status: 'preparation-unavailable',
            reason,
            preparation: {
              provisioning: 'unavailable',
              status: 'preparation-unavailable',
              actor: context.actor,
              token: observedToken,
              spender: context.erc20Router,
              balanceAtPinnedBlock: '0',
              allowanceBefore: '0',
              allowanceAfter: '0',
              spendCeiling: '0',
              approveReturnedTrue: undefined,
              approvalSelector: '0x095ea7b3',
              reason,
            },
            comparison: compareLanes({ claims: claimsOutcome, token: 'preparation-unavailable' }),
          }
          outcomes.push({ ...outcome, poolId: context.pool.poolId })
          findings.push(erc20LaneEvidence({
            outcome,
            poolId: context.pool.poolId,
            hook: context.pool.hook,
            token: observedToken,
            stateBlockNumber: context.stateBlockNumber,
          }))
          continue
        }

        if (nativeInput && requested >= 0n) {
          const reason = 'This exact-output native scenario has no bounded maximum input value, so it was not generated.'
          const outcome: Erc20LaneOutcome = {
            scenarioId: scenario.id,
            tokenRole: 'output',
            nativeValue: 0n,
            status: 'preparation-unavailable',
            reason,
            preparation: {
              provisioning: scenarioProvisioning,
              status: 'preparation-unavailable',
              actor: scenarioPayer,
              token: observedToken,
              spender: context.erc20Router,
              balanceAtPinnedBlock: '0',
              allowanceBefore: '0',
              allowanceAfter: '0',
              spendCeiling: '0',
              approveReturnedTrue: undefined,
              approvalSelector: '0x095ea7b3',
              reason,
            },
            comparison: compareLanes({ claims: claimsOutcome, token: 'preparation-unavailable' }),
          }
          outcomes.push({ ...outcome, poolId: context.pool.poolId })
          findings.push(erc20LaneEvidence({
            outcome,
            poolId: context.pool.poolId,
            hook: context.pool.hook,
            token: observedToken,
            stateBlockNumber: context.stateBlockNumber,
          }))
          continue
        }

        // Every standalone case starts from the same pinned snapshot. Approval
        // and settlement must commit so its own after-reads are meaningful, but
        // those writes must never leak into the next case.
        const scenarioSession = createIsolatedSession(`scenario-${scenarioIndex}`)
        try {
          poolAttempted = true
          const outcome = await runErc20Lane({
            session: scenarioSession,
            scenario,
            // The payer both pays and receives, so a round trip stays with one account.
            calldata: encodeErc20Scenario(scenario.steps, scenarioPayer, scenarioPayer),
            harness: context.erc20Router,
            // Each direction spends a different currency. The historical
            // replay identifies a real payer, but the scenario itself decides
            // which token that payer must hold and approve.
            token: observedToken,
            payer: scenarioPayer,
            recipient: scenarioPayer,
            poolManager: context.poolManager,
            poolId: context.pool.poolId,
            hook: context.pool.hook,
            block: context.executionBlock,
            chainId: context.chainId,
            signal: input.signal,
            provisioning: scenarioProvisioning,
            claimsOutcome,
            requestedAmount: requested,
            tokenRole: nativeInput ? 'output' : 'input',
            nativeValue: nativeInput ? -requested : 0n,
            timeoutMs: input.timeoutMs,
          })
          outcomes.push({ ...outcome, poolId: context.pool.poolId })
          findings.push(erc20LaneEvidence({
            outcome,
            poolId: context.pool.poolId,
            hook: context.pool.hook,
            token: observedToken,
            stateBlockNumber: context.stateBlockNumber,
          }))
        } finally {
          scenarioSession.close()
        }
      }
      // The two round-trip legs deliberately share one clean session so the
      // reverse leg can spend exactly what the forward leg delivered. No
      // standalone scenario state is present in this session.
      const poolHasNative = context.pool.currency0.toLowerCase() === NATIVE_CURRENCY
        || context.pool.currency1.toLowerCase() === NATIVE_CURRENCY
      const tokenResolution = resolution.ok ? resolution : undefined
      if (poolHasNative || tokenResolution) {
        const roundTripSession = createIsolatedSession('round-trip')
        try {
          // For a native/token pool, starting with native requires no invented
          // token balance: the declared synthetic EOA buys the deployed token,
          // approves exactly what arrived, then sells that amount back. For an
          // ERC-20/ERC-20 pool, retain the replay-derived input holder.
          const roundTripPayer = poolHasNative ? context.actor : tokenResolution!.payer
          const roundTripInput = poolHasNative ? NATIVE_CURRENCY : tokenResolution!.token
          poolAttempted = true
          const trip = await runErc20RoundTrip({
            session: roundTripSession,
            readBalance: async (token, owner) => {
              const result = await roundTripSession.execute({
                transaction: {
                  caller: owner,
                  to: token,
                  calldata: encodeFunctionData({ abi: BALANCE_ABI, functionName: 'balanceOf', args: [owner] }),
                  value: 0n,
                  executionMode: 'simulation',
                  gasLimit: 200_000n,
                  gasPrice: 0n,
                  nonce: 0,
                  chainId: context.chainId,
                  traceLimit: 8,
                },
                block: context.executionBlock,
                signal: input.signal,
                commit: false,
              })
              if (!result.proof.success) return 0n
              try {
                return BigInt(result.proof.output.slice(0, 66))
              } catch {
                return 0n
              }
            },
            poolKey: {
              currency0: context.pool.currency0,
              currency1: context.pool.currency1,
              fee: context.pool.fee,
              tickSpacing: context.pool.tickSpacing,
              hooks: context.pool.hook,
            },
            poolId: context.pool.poolId,
            hook: context.pool.hook,
            poolManager: context.poolManager,
            harness: context.erc20Router,
            payer: roundTripPayer,
            inputToken: roundTripInput,
            block: context.executionBlock,
            chainId: context.chainId,
            signal: input.signal,
            provisioning: poolHasNative ? 'verified-storage-overlay' : tokenResolution!.source,
            claimsOutcome: 'completed',
            nativeInputAmount: poolHasNative ? NATIVE_ROUND_TRIP_INPUT : undefined,
            timeoutMs: input.timeoutMs,
          })
          roundTrips.push({ ...trip, poolId: context.pool.poolId })
          findings.push(roundTripEvidence({
            result: trip,
            poolId: context.pool.poolId,
            hook: context.pool.hook,
            stateBlockNumber: context.stateBlockNumber,
          }))
          applyNativeRoundTripCoverage({
            poolId: context.pool.poolId,
            trip,
            outcomes,
            findings,
          })
        } finally {
          roundTripSession.close()
        }
      }

      if (poolAttempted) coveredPools++
    } finally {
      completed++
    }
  }

  const tally = (status: Erc20LaneOutcome['status']) => outcomes.filter((outcome) => outcome.status === status).length
  const coveredByRoundTrip = outcomes.filter((outcome) => Boolean(outcome.coveredByRoundTrip)).length
  const unavailable = outcomes.filter(
    (outcome) => outcome.status === 'preparation-unavailable' && !outcome.coveredByRoundTrip,
  ).length
  const failed = tally('execution-failed')
  const reverted = tally('behavior-reverted')
  const completedCount = tally('completed')

  if (unavailable) {
    limitations.push(`${unavailable} ERC-20 lane scenario${unavailable === 1 ? '' : 's'} could not prepare the required bounded input; the ERC-6909 claims baseline still ran for ${unavailable === 1 ? 'that case' : 'those cases'}.`)
  }
  if (coveredByRoundTrip) {
    limitations.push(`${coveredByRoundTrip} separately unfunded token-input scenario${coveredByRoundTrip === 1 ? '' : 's'} were covered directionally by a successful committed native → token → native round trip. Their exact standalone amounts were not executed.`)
  }
  if (failed) {
    limitations.push(`${failed} ERC-20 lane scenario${failed === 1 ? '' : 's'} did not execute and produced no token observation.`)
  }
  if (reverted) {
    limitations.push(`${reverted} ERC-20 lane scenario${reverted === 1 ? '' : 's'} reverted; each finding names whether the claims baseline completed, which is what separates a token settlement issue from pool or hook behavior.`)
  }
  const asymmetric = roundTrips.filter((trip) => trip.status === 'reverse-leg-failed')
  if (asymmetric.length) {
    limitations.push(`${asymmetric.length} pool${asymmetric.length === 1 ? '' : 's'} completed a committed buy through the real token path but could not sell the received amount back; each finding names the failure.`)
  }
  if (completedCount) {
    limitations.push('ERC-20 lane observations describe this token at this pinned block only. For native/token pools, native input is supplied by the scenario caller as call value and unused value is refunded; the report records the exact value used.')
  }

  return {
    status: coveredPools === 0 ? 'unavailable' : failed === 0 && unavailable === 0 ? 'passed' : 'degraded',
    version: ERC20_LANE_VERSION,
    eligiblePools: input.contexts.length,
    coveredPools,
    completed: completedCount,
    reverted,
    unavailable,
    coveredByRoundTrip,
    failed,
    outcomes,
    roundTrips,
    findings,
    limitations,
  }
}
