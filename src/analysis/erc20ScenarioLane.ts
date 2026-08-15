import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'
import type { Evidence } from '../domain/report'
import type { ForkReplayBlock, ForkReplayResult } from './revmProof'
import { erc20HarnessIdentity } from './protocolScenarioArtifact'
import { validateScenarioExecution } from './protocolScenarioValidation'
import type { ProtocolScenario } from './protocolNativeScenarios'
import { ERC20_SELECTORS, type ProvisioningSource } from './erc20Provisioning'
import {
  prepareErc20Actor,
  preparationSummary,
  type Erc20ActorPreparation,
  type PreparationSession,
} from './erc20ActorPreparation'
import {
  classifyTokenObservations,
  compareLanes,
  summarizeTokenObservations,
  type Erc20ScenarioStatus,
  type LaneComparison,
  type TokenObservations,
} from './erc20Observations'
import { decodePoolManagerSwaps } from './poolEvents'

/**
 * Runs one generated scenario down both settlement lanes and reports the pair.
 *
 * The claims lane is assumed to have run already — it is the baseline and needs
 * no funded account. This adds the ERC-20 lane beside it: prepare a real payer,
 * read balances, execute the same operation through the ERC-20 harness, read
 * balances again, and hand both outcomes to the comparison.
 *
 * The ordering matters. Preparation happens first and its failure short-circuits
 * everything, because a scenario that never had a funded payer cannot say
 * anything about the token — and saying nothing is the correct output there.
 */

const ERC20_ABI = parseAbi(['function balanceOf(address owner) view returns (uint256)'])
const READ_GAS = 200_000n
const SCENARIO_GAS_LIMIT = 16_000_000n

export type Erc20LaneSession = PreparationSession

export type Erc20RoundTripCoverage = {
  method: 'committed-native-token-native'
  roundTripVersion: string
  reason: string
}

export type Erc20LaneOutcome = {
  scenarioId: string
  /** The deployed token was either the currency paid in or the currency received. */
  tokenRole: 'input' | 'output'
  /** Value supplied by the actor when the other pool currency was native. */
  nativeValue: bigint
  status: Erc20ScenarioStatus
  reason?: string
  preparation: ReturnType<typeof preparationSummary>
  observations?: TokenObservations
  classifications?: ReturnType<typeof classifyTokenObservations>
  comparison: LaneComparison
  proof?: ForkReplayResult
  /**
   * A successful committed round trip may cover this token-input direction even
   * when this exact standalone amount could not obtain an independent holder.
   * The original status stays intact so the report never implies this separate
   * transaction executed.
   */
  coveredByRoundTrip?: Erc20RoundTripCoverage
}

async function balanceOf(input: {
  session: Erc20LaneSession
  token: Address
  /** EOA used as the eth_call sender; independent from the balance owner. */
  caller: Address
  owner: Address
  block: ForkReplayBlock
  chainId: number
  signal: AbortSignal
}): Promise<bigint> {
  const result = await input.session.execute({
    transaction: {
      caller: input.caller,
      to: input.token,
      calldata: encodeFunctionData({ abi: ERC20_ABI, functionName: 'balanceOf', args: [input.owner] }),
      value: 0n,
      executionMode: 'simulation',
      gasLimit: READ_GAS,
      gasPrice: 0n,
      nonce: 0,
      chainId: input.chainId,
      traceLimit: 8,
    },
    block: input.block,
    signal: input.signal,
    commit: false,
  })
  if (!result.proof.success) return 0n
  try {
    return BigInt(result.proof.output.slice(0, 66))
  } catch {
    return 0n
  }
}

async function balanceSnapshot(input: {
  session: Erc20LaneSession
  token: Address
  caller: Address
  owners: Address[]
  block: ForkReplayBlock
  chainId: number
  signal: AbortSignal
}): Promise<Record<string, bigint>> {
  const snapshot: Record<string, bigint> = {}
  for (const owner of input.owners) {
    snapshot[owner.toLowerCase()] = await balanceOf({ ...input, owner })
  }
  return snapshot
}

/**
 * Executes one scenario on the ERC-20 lane, beside an already-known claims result.
 *
 * Balances are read either side of the run from the token itself, so a fee that
 * is skimmed without being logged still shows up as a difference between what
 * was requested and what moved.
 */
export async function runErc20Lane(input: {
  session: Erc20LaneSession
  scenario: ProtocolScenario
  /** Calldata for the ERC-20 harness, which takes payer and recipient. */
  calldata: Hex
  harness: Address
  token: Address
  payer: Address
  recipient: Address
  poolManager: Address
  poolId: Hex
  hook: Address
  block: ForkReplayBlock
  chainId: number
  signal: AbortSignal
  provisioning: ProvisioningSource
  claimsOutcome: 'completed' | 'reverted' | 'unavailable'
  requestedAmount: bigint
  /** Whether requestedAmount is already denominated in the observed token. */
  requestedAmountRole?: 'input-currency' | 'observed-token'
  /** Defaults to input for ERC-20/ERC-20 compatibility. */
  tokenRole?: 'input' | 'output'
  /** Native value supplied by the actor for a native-input scenario. */
  nativeValue?: bigint
  /**
   * Exact allowance to grant, when the caller knows it.
   *
   * A round trip must approve precisely what the previous leg delivered.
   * Without this the default bounded ceiling would be granted instead and would
   * silently overwrite that approval, leaving the reverse leg underfunded.
   */
  approvalAmount?: bigint
  timeoutMs?: number
}): Promise<Erc20LaneOutcome> {
  const tokenRole = input.tokenRole ?? 'input'
  const preparation: Erc20ActorPreparation = tokenRole === 'input'
    ? await prepareErc20Actor({
        session: input.session,
        actor: input.payer,
        token: input.token,
        spender: input.harness,
        block: input.block,
        chainId: input.chainId,
        signal: input.signal,
        source: input.provisioning,
        amount: input.approvalAmount,
      })
    : {
        status: 'prepared',
        source: input.provisioning,
        actor: input.payer,
        token: input.token,
        spender: input.harness,
        balance: 0n,
        allowanceBefore: 0n,
        allowanceAfter: 0n,
        spendCeiling: 0n,
        reason: 'The scenario pays with native currency, so no ERC-20 approval is required for the observed output token.',
      }

  if (preparation.status !== 'prepared') {
    // An unfundable actor is an analyzer limit; a refused approval is a token
    // fact. Both stop the scenario, but only one is an observation.
    const status: Erc20ScenarioStatus =
      preparation.status === 'approval-refused' ? 'behavior-reverted' : 'preparation-unavailable'
    return {
      scenarioId: input.scenario.id,
      tokenRole,
      nativeValue: input.nativeValue ?? 0n,
      status,
      reason: preparation.reason,
      preparation: preparationSummary(preparation),
      classifications: preparation.status === 'approval-refused' ? ['approval-insufficient'] : undefined,
      comparison: compareLanes({
        claims: input.claimsOutcome,
        token: status,
        classifications: preparation.status === 'approval-refused' ? ['approval-insufficient'] : undefined,
      }),
    }
  }

  const owners = [input.payer, input.recipient, input.harness, input.poolManager]
  const before = await balanceSnapshot({
    session: input.session,
    token: input.token,
    caller: input.payer,
    owners,
    block: input.block,
    chainId: input.chainId,
    signal: input.signal,
  })
  if (tokenRole === 'output') preparation.balance = before[input.payer.toLowerCase()] ?? 0n

  let proof: ForkReplayResult
  try {
    proof = await input.session.execute({
      transaction: {
        caller: input.payer,
        to: input.harness,
        calldata: input.calldata,
        value: input.nativeValue ?? 0n,
        executionMode: 'simulation',
        gasLimit: SCENARIO_GAS_LIMIT,
        gasPrice: 0n,
        nonce: 0,
        chainId: input.chainId,
        traceLimit: 2_048,
      },
      block: input.block,
      signal: input.signal,
      timeoutMs: input.timeoutMs ?? 20_000,
      // Committed so the after-balances observe what the scenario actually did.
      commit: true,
    })
  } catch (error) {
    if (input.signal.aborted) throw error
    return {
      scenarioId: input.scenario.id,
      tokenRole,
      nativeValue: input.nativeValue ?? 0n,
      status: 'execution-failed',
      reason: error instanceof Error ? error.message : String(error),
      preparation: preparationSummary(preparation),
      comparison: compareLanes({ claims: input.claimsOutcome, token: 'execution-failed' }),
    }
  }

  // A run that never reached the PoolManager says nothing about the token path
  // either, so it is a failure rather than a token observation.
  const validation = validateScenarioExecution({
    proof: proof.proof,
    scenario: input.scenario,
    poolManager: input.poolManager,
    hook: input.hook,
    poolId: input.poolId,
    router: input.harness,
  })
  if (validation.status === 'failed') {
    // Applies to reverts too, and that is the whole point: a harness that
    // reverted before reaching `unlock` — a bad payer, a refused approval, an
    // ABI decode failure — never touched the pool or the token's transfer path.
    // Reporting it as a token observation would blame the token for an analyzer
    // or setup fault. Restricting this to successful runs, as it previously did,
    // let exactly that class of revert through.
    return {
      scenarioId: input.scenario.id,
      tokenRole,
      nativeValue: input.nativeValue ?? 0n,
      status: 'execution-failed',
      reason: validation.reason,
      preparation: preparationSummary(preparation),
      proof,
      comparison: compareLanes({ claims: input.claimsOutcome, token: 'execution-failed' }),
    }
  }

  const after = await balanceSnapshot({
    session: input.session,
    token: input.token,
    caller: input.payer,
    owners,
    block: input.block,
    chainId: input.chainId,
    signal: input.signal,
  })

  const swapStep = input.scenario.steps.find((step) => step.operation === 0)
  const swap = decodePoolManagerSwaps(proof.proof, input.poolManager)
    .find((item) => item.poolId.toLowerCase() === input.poolId.toLowerCase())
  let expectedTokenAmount = input.requestedAmount
  if (input.requestedAmountRole === 'observed-token') {
    // Exact-output native-first scenarios already name the requested amount in
    // the deployed token's units. Preserve that explicit denomination even if
    // the pool event reports a zero or adjusted delta.
    expectedTokenAmount = input.requestedAmount
  } else if (swapStep && swap) {
    const tokenIsCurrency0 = swapStep.key.currency0.toLowerCase() === input.token.toLowerCase()
    expectedTokenAmount = tokenIsCurrency0 ? swap.amount0 : swap.amount1
  } else if (tokenRole === 'output') {
    // Input and output are different units. Without a decoded PoolManager Swap
    // event there is no honest amount against which to compare the output.
    expectedTokenAmount = 0n
  }

  const observations = summarizeTokenObservations({
    proof: proof.proof,
    token: input.token,
    actor: input.payer,
    recipient: input.recipient,
    harness: input.harness,
    poolManager: input.poolManager,
    balancesBefore: before,
    balancesAfter: after,
    allowanceBefore: preparation.allowanceBefore,
    allowanceAfter: preparation.allowanceAfter,
    requestedAmount: expectedTokenAmount,
    tokenRole,
  })
  const classifications = classifyTokenObservations(observations)
  const status: Erc20ScenarioStatus = proof.proof.success ? 'completed' : 'behavior-reverted'

  return {
    scenarioId: input.scenario.id,
    tokenRole,
    nativeValue: input.nativeValue ?? 0n,
    status,
    preparation: preparationSummary(preparation),
    observations,
    classifications,
    proof,
    comparison: compareLanes({ claims: input.claimsOutcome, token: status, classifications }),
  }
}

/**
 * Evidence for one paired scenario.
 *
 * The claim names both lanes and what separated them, because a token-path
 * observation is only interpretable next to the baseline that did not touch the
 * token. Reporting the ERC-20 result alone would invite reading a fee or a
 * blocklist as pool behavior.
 */
export function erc20LaneEvidence(input: {
  outcome: Erc20LaneOutcome
  poolId: Hex
  hook: Address
  token: Address
  stateBlockNumber: bigint
}): Evidence {
  const { outcome } = input
  const observations = outcome.observations
  const shortfall = observations?.shortfall ?? 0n
  const approvalOnly = !outcome.proof && outcome.classifications?.includes('approval-insufficient')

  const title = outcome.status === 'preparation-unavailable'
    ? 'ERC-20 settlement lane unavailable for this pool'
    : outcome.status === 'execution-failed'
      ? 'Generated ERC-20 scenario did not execute'
      : approvalOnly
        ? 'Token approval did not prepare the generated scenario'
        : outcome.status === 'behavior-reverted'
          ? 'Generated scenario reverted settling in real ERC-20'
          : shortfall > 0n
            ? 'Generated scenario settled in real ERC-20 with a shortfall'
            : 'Generated scenario settled in real ERC-20'

  const claim = outcome.status === 'preparation-unavailable'
    ? `${outcome.comparison.detail} No settlement transaction was executed for ${input.token} at block ${input.stateBlockNumber}.`
    : outcome.status === 'execution-failed'
      ? `${outcome.comparison.detail} The generated call did not produce a validated PoolManager execution for ${input.token} at block ${input.stateBlockNumber}: ${outcome.reason ?? 'execution could not be validated'}.`
      : approvalOnly
        ? `${outcome.comparison.detail} Approval was attempted against ${input.token} at block ${input.stateBlockNumber}, but settlement was not executed: ${outcome.reason ?? 'the required allowance was not established'}.`
        : `${outcome.comparison.detail} Settlement ran against the deployed token ${input.token} at block ${input.stateBlockNumber}${
            shortfall > 0n
              ? `, and ${shortfall} less was delivered than the ${observations!.requestedAmount} requested${
                  observations!.shortfallSource === 'unsettled-delta-revert'
                    ? ', measured from the settlement failure the harness reverted with rather than from balances, which the revert rolled back'
                    : ''
                }`
              : ''
          }.`

  return {
    id: `erc20-lane:${input.poolId.slice(2, 14)}:${outcome.scenarioId}`,
    detectorId: 'protocol-native-erc20-lane',
    detectorVersion: '0.6.0',
    severity: shortfall > 0n || outcome.status === 'behavior-reverted' ? 'medium' : 'info',
    evidenceClass: 'concrete-observation',
    subject: input.hook,
    title,
    claim: `${claim} This is a generated transaction against pinned state, not an onchain transaction.`,
    confidence: 'confirmed',
    affectedPools: [input.poolId],
    reproducibility: outcome.proof ? 'replayed' : 'not-applicable',
    technical: {
      executionSource: 'protocol-native-generated',
      settlement: 'erc20-transfers',
      executionMode: 'simulation',
      tokenRole: outcome.tokenRole,
      nativeValue: outcome.nativeValue.toString(),
      harness: erc20HarnessIdentity(),
      scenarioId: outcome.scenarioId,
      status: outcome.status,
      reason: outcome.reason,
      coveredByRoundTrip: outcome.coveredByRoundTrip,
      laneComparison: outcome.comparison,
      classifications: outcome.classifications,
      preparation: outcome.preparation,
      tokenCalls: observations?.tokenCalls,
      knownSelectors: ERC20_SELECTORS,
      transfers: observations?.transfers.map((transfer) => ({
        from: transfer.from,
        to: transfer.to,
        value: transfer.value.toString(),
      })),
      balances: observations?.balances.map((balance) => ({
        address: balance.address,
        before: balance.before.toString(),
        after: balance.after.toString(),
        moved: balance.moved.toString(),
      })),
      requestedAmount: observations?.requestedAmount.toString(),
      poolManagerMoved: observations?.poolManagerMoved.toString(),
      recipientReceived: observations?.recipientReceived.toString(),
      shortfall: shortfall.toString(),
      shortfallSource: observations?.shortfallSource,
      unsettledDelta: observations?.unsettledDelta
        ? { currency: observations.unsettledDelta.currency, delta: observations.unsettledDelta.delta.toString() }
        : undefined,
      gasUsed: outcome.proof?.proof.gasUsed,
      // Deliberately absent: no historical transaction hash.
    },
  }
}
