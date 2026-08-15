import { getAddress, type Address, type Hex } from 'viem'
import type { Evidence } from '../domain/report'
import type { ForkReplayBlock } from './revmProof'
import { erc20HarnessIdentity } from './protocolScenarioArtifact'
import { buildSwapScenario, encodeErc20Scenario, type ScenarioPoolKey } from './protocolNativeScenarios'
import { maxSafeAmount, type ProvisioningSource } from './erc20Provisioning'
import type { PreparationSession } from './erc20ActorPreparation'
import { runErc20Lane, type Erc20LaneOutcome } from './erc20ScenarioLane'

/**
 * A committed buy → approve → sell round trip through the real token path.
 *
 * Running two independent swaps in opposite directions is not a round trip, and
 * calling it one would overstate what ran. A real round trip has to carry state
 * forward: the forward leg is committed, the amount it actually delivered is
 * measured, that exact amount is approved, and the reverse leg spends precisely
 * it. Only then does a token that accepts being bought and refuses being sold
 * show up as the asymmetry it is.
 *
 * The forward direction is taken from the replayed transaction's own input leg
 * rather than assumed, so the trip starts the way the pool was really used.
 *
 * A token that skims a fee makes the delivered amount smaller than the quoted
 * one. Spending the measured amount rather than the quoted amount is what keeps
 * the reverse leg fundable, and the difference between them is itself recorded.
 */

export const ROUND_TRIP_VERSION = 'protocol-native-erc20-round-trip/0.7.0'

const NATIVE_CURRENCY = '0x0000000000000000000000000000000000000000' as Address

export type Erc20RoundTripStatus =
  | 'completed'
  | 'reverse-leg-failed'
  | 'forward-leg-failed'
  | 'preparation-unavailable'

export type Erc20RoundTripResult = {
  status: Erc20RoundTripStatus
  reason?: string
  /** Direction of the forward leg, taken from the replayed input leg. */
  forwardZeroForOne: boolean
  inputToken: Address
  outputToken: Address
  /** What the forward leg was asked to spend. */
  forwardRequested: bigint
  /** What the actor actually received, measured from its own balance. */
  forwardReceived: bigint
  /** Allowance granted for the output token before the reverse leg. */
  reverseApproved: bigint
  /** How the reverse leg was funded. */
  reverseFunding: 'erc20-approval' | 'native-value'
  /** What the actor got back on the reverse leg. */
  reverseReceived: bigint
  forward?: Erc20LaneOutcome
  reverse?: Erc20LaneOutcome
}

export type RoundTripSession = PreparationSession

/** Reads one account's balance of one token, uncommitted. */
type BalanceReader = (token: Address, owner: Address) => Promise<bigint>

export async function runErc20RoundTrip(input: {
  session: RoundTripSession
  readBalance: BalanceReader
  poolKey: ScenarioPoolKey
  poolId: Hex
  hook: Address
  poolManager: Address
  harness: Address
  payer: Address
  /** The leg the replayed transaction paid in; the trip starts in that direction. */
  inputToken: Address
  block: ForkReplayBlock
  chainId: number
  signal: AbortSignal
  provisioning: ProvisioningSource
  claimsOutcome: 'completed' | 'reverted' | 'unavailable'
  /** Explicit bounded call value when the forward leg pays native currency. */
  nativeInputAmount?: bigint
  /** Exact token output requested by a native-input forward leg. */
  nativeOutputAmount?: bigint
  timeoutMs?: number
}): Promise<Erc20RoundTripResult> {
  const currency0 = getAddress(input.poolKey.currency0)
  const currency1 = getAddress(input.poolKey.currency1)
  const inputToken = getAddress(input.inputToken)
  const inputIsNative = inputToken.toLowerCase() === NATIVE_CURRENCY
  const forwardZeroForOne = inputToken.toLowerCase() === currency0.toLowerCase()
  const outputToken = forwardZeroForOne ? currency1 : currency0
  const outputIsNative = outputToken.toLowerCase() === NATIVE_CURRENCY

  const base = {
    status: 'preparation-unavailable' as Erc20RoundTripStatus,
    forwardZeroForOne,
    inputToken,
    outputToken,
    forwardRequested: 0n,
    forwardReceived: 0n,
    reverseApproved: 0n,
    reverseFunding: outputIsNative ? 'native-value' as const : 'erc20-approval' as const,
    reverseReceived: 0n,
  }

  // The forward leg spends a bounded share of what the payer really holds.
  const inputBalance = inputIsNative ? input.nativeInputAmount ?? 0n : await input.readBalance(inputToken, input.payer)
  const forwardRequested = inputIsNative ? inputBalance : maxSafeAmount(inputBalance)
  const nativeOutputAmount = input.nativeOutputAmount ?? 1_000_000n
  if (forwardRequested <= 0n) {
    return {
      ...base,
      reason: inputIsNative
        ? 'No bounded native call value was supplied for the forward leg.'
        : `The payer holds ${inputBalance} of the input token, too little to fund a round trip.`,
    }
  }

  const forwardScenario = buildSwapScenario({
    id: 'round-trip:forward',
    description: inputIsNative
      ? `committed exact-output ${forwardZeroForOne ? '0-for-1' : '1-for-0'} swap funded by bounded native call value`
      : `committed ${forwardZeroForOne ? '0-for-1' : '1-for-0'} swap in the direction the replayed transaction used`,
    key: input.poolKey,
    zeroForOne: forwardZeroForOne,
    // A native-input exact-output leg either yields a measurable token amount
    // or reverts. The call-value ceiling is refunded by the harness when the
    // pool needs less, avoiding the ambiguous zero-output exact-input case.
    amountSpecified: inputIsNative ? nativeOutputAmount : -forwardRequested,
  })

  const outputBefore = outputIsNative ? 0n : await input.readBalance(outputToken, input.payer)
  const forward = await runErc20Lane({
    session: input.session,
    scenario: forwardScenario,
    calldata: encodeErc20Scenario(forwardScenario.steps, input.payer, input.payer),
    harness: input.harness,
    // A native-input forward leg observes the real ERC-20 output. Otherwise it
    // observes the ERC-20 input being pulled into the PoolManager.
    token: inputIsNative ? outputToken : inputToken,
    payer: input.payer,
    recipient: input.payer,
    poolManager: input.poolManager,
    poolId: input.poolId,
    hook: input.hook,
    block: input.block,
    chainId: input.chainId,
    signal: input.signal,
    provisioning: input.provisioning,
    claimsOutcome: input.claimsOutcome,
    requestedAmount: inputIsNative ? nativeOutputAmount : -forwardRequested,
    requestedAmountRole: inputIsNative ? 'observed-token' : 'input-currency',
    tokenRole: inputIsNative ? 'output' : 'input',
    nativeValue: inputIsNative ? forwardRequested : 0n,
    approvalAmount: inputIsNative ? undefined : forwardRequested,
    timeoutMs: input.timeoutMs,
  })

  if (forward.status !== 'completed') {
    return {
      ...base,
      status: forward.status === 'preparation-unavailable' ? 'preparation-unavailable' : 'forward-leg-failed',
      reason: forward.reason ?? 'The forward leg did not complete, so there was nothing to sell back.',
      forwardRequested,
      forward,
    }
  }

  // Measured, not quoted: a fee-taking token delivers less than the pool says,
  // and selling back a quoted amount the actor never received would revert for a
  // reason that has nothing to do with the token's sell path.
  const outputAfter = outputIsNative ? 0n : await input.readBalance(outputToken, input.payer)
  const nativeChange = forward.proof?.proof.balanceChanges.find(
    (change) => change.address.toLowerCase() === input.payer.toLowerCase(),
  )
  const nativeReceived = nativeChange
    ? BigInt(nativeChange.after) - BigInt(nativeChange.before)
    : 0n
  const forwardReceived = outputIsNative
    ? nativeReceived > 0n ? nativeReceived : 0n
    : outputAfter > outputBefore ? outputAfter - outputBefore : 0n
  if (forwardReceived <= 0n) {
    return {
      ...base,
      status: 'forward-leg-failed',
      reason: 'The forward leg completed but delivered no measurable output, so the reverse leg has nothing to spend.',
      forwardRequested,
      forward,
    }
  }

  // Approval happens inside the reverse leg, for exactly the measured amount:
  // preparing separately would be overwritten by the lane's own default ceiling.
  const reverseScenario = buildSwapScenario({
    id: 'round-trip:reverse',
    description: 'committed reverse swap spending exactly the amount the forward leg delivered',
    key: input.poolKey,
    zeroForOne: !forwardZeroForOne,
    amountSpecified: -forwardReceived,
  })

  const inputBefore = inputIsNative ? 0n : await input.readBalance(inputToken, input.payer)
  const reverse = await runErc20Lane({
    session: input.session,
    scenario: reverseScenario,
    calldata: encodeErc20Scenario(reverseScenario.steps, input.payer, input.payer),
    harness: input.harness,
    // When the reverse leg pays native, observe the deployed ERC-20 output.
    // Otherwise observe the ERC-20 input as before.
    token: outputIsNative ? inputToken : outputToken,
    payer: input.payer,
    recipient: input.payer,
    poolManager: input.poolManager,
    poolId: input.poolId,
    hook: input.hook,
    block: input.block,
    chainId: input.chainId,
    signal: input.signal,
    provisioning: input.provisioning,
    claimsOutcome: input.claimsOutcome,
    requestedAmount: -forwardReceived,
    tokenRole: outputIsNative ? 'output' : 'input',
    nativeValue: outputIsNative ? forwardReceived : 0n,
    approvalAmount: outputIsNative ? undefined : forwardReceived,
    timeoutMs: input.timeoutMs,
  })
  const inputAfter = inputIsNative ? 0n : await input.readBalance(inputToken, input.payer)
  const reverseNativeChange = inputIsNative
    ? reverse.proof?.proof.balanceChanges.find(
        (change) => change.address.toLowerCase() === input.payer.toLowerCase(),
      )
    : undefined
  const reverseNativeReceived = reverseNativeChange
    ? BigInt(reverseNativeChange.after) - BigInt(reverseNativeChange.before)
    : 0n

  return {
    status: reverse.status === 'completed' ? 'completed' : 'reverse-leg-failed',
    reason: reverse.status === 'completed' ? undefined : reverse.reason,
    forwardZeroForOne,
    inputToken,
    outputToken,
    forwardRequested,
    forwardReceived,
    reverseApproved: outputIsNative ? 0n : BigInt(reverse.preparation.allowanceAfter),
    reverseFunding: outputIsNative ? 'native-value' : 'erc20-approval',
    reverseReceived: inputIsNative
      ? reverseNativeReceived > 0n ? reverseNativeReceived : 0n
      : inputAfter > inputBefore ? inputAfter - inputBefore : 0n,
    forward,
    reverse,
  }
}

/**
 * Evidence for one round trip.
 *
 * An asymmetric result is the interesting one and is stated as such: buying
 * succeeded and selling did not, at this pinned state, for this pool.
 */
export function roundTripEvidence(input: {
  result: Erc20RoundTripResult
  poolId: Hex
  hook: Address
  stateBlockNumber: bigint
}): Evidence {
  const { result } = input
  const asymmetric = result.status === 'reverse-leg-failed' && Boolean(result.forward)
  const forwardDeliveryFailure = result.status === 'forward-leg-failed'
    && Boolean(result.forward?.classifications?.includes('recipient-received-less-than-sent'))
  const nativeReverse = result.reverseFunding === 'native-value'
  const reverseFundingText = nativeReverse
    ? 'supplied that exact native amount as call value'
    : 'approved that exact ERC-20 amount'

  return {
    id: `erc20-round-trip:${input.poolId.slice(2, 14)}`,
    detectorId: 'protocol-native-erc20-round-trip',
    detectorVersion: '0.7.0',
    severity: asymmetric || forwardDeliveryFailure ? 'medium' : 'info',
    evidenceClass: 'concrete-observation',
    subject: input.hook,
    title: forwardDeliveryFailure
      ? 'Forward swap completed but the requested token output was not delivered'
      : asymmetric
      ? 'Round trip bought successfully but could not sell back'
      : result.status === 'completed'
        ? 'Round trip completed in both directions through the real token path'
        : 'Round trip could not be run',
    claim: forwardDeliveryFailure
      ? `The generated exact-output swap completed against the deployed pool, but the recipient received ${result.forward?.observations?.recipientReceived ?? 0n} of ${result.outputToken} while ${result.forward?.observations?.requestedAmount ?? 0n} was requested at block ${input.stateBlockNumber}. No reverse leg was attempted because no measurable token output was available. This describes this pool and recipient at this pinned state, not the token in general.`
      : asymmetric
      ? `A committed swap in the direction the replayed transaction used delivered ${result.forwardReceived} of ${result.outputToken}, ${reverseFundingText}, and the reverse swap then failed: ${result.reason}. Both legs ran against the deployed pool and token at block ${input.stateBlockNumber}. This describes this pool at this state, not the token in general.`
      : result.status === 'completed'
        ? `A committed round trip ${result.inputToken.toLowerCase() === NATIVE_CURRENCY
            ? `supplied at most ${result.forwardRequested} native units as refundable call value`
            : `spent ${result.forwardRequested} of ${result.inputToken}`}, received ${result.forwardReceived} of ${result.outputToken}, ${reverseFundingText}, and returned for ${result.reverseReceived}. Both legs exercised the deployed token's real transferFrom and transfer paths at block ${input.stateBlockNumber}.`
        : `No round trip was run: ${result.reason}`,
    confidence: 'confirmed',
    affectedPools: [input.poolId],
    reproducibility: result.forward ? 'replayed' : 'not-applicable',
    technical: {
      executionSource: 'protocol-native-generated',
      executionMode: 'simulation',
      settlement: nativeReverse ? 'erc20-transfers-with-native-value' : 'erc20-transfers',
      roundTripVersion: ROUND_TRIP_VERSION,
      harness: erc20HarnessIdentity(),
      status: result.status,
      forwardZeroForOne: result.forwardZeroForOne,
      inputToken: result.inputToken,
      outputToken: result.outputToken,
      forwardRequested: result.forwardRequested.toString(),
      // Measured from the actor's own balance, so a transfer fee is visible as
      // the gap between what the pool quoted and what actually arrived.
      forwardReceived: result.forwardReceived.toString(),
      reverseApproved: result.reverseApproved.toString(),
      reverseFunding: result.reverseFunding,
      reverseReceived: result.reverseReceived.toString(),
      forwardClassifications: result.forward?.classifications,
      reverseClassifications: result.reverse?.classifications,
    },
  }
}
