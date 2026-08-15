import { decodeErrorResult, parseAbi, toFunctionSelector, type Address, type Hex } from 'viem'
import type { RevmExecutionProof } from './revmProof'
import { ERC20_SELECTORS, decodeTokenTransfers, type TokenTransfer } from './erc20Provisioning'

/**
 * The harness's own settlement failure, which is where a transfer fee surfaces.
 *
 * A token that skims a fee delivers less than the debt, so the currency's delta
 * never reaches zero and the harness reverts naming the currency and the exact
 * amount still owed. That revert rolls the whole call back, which means the
 * shortfall cannot be recovered from balances read afterwards — they show no
 * movement at all. The revert payload is the only place the number survives.
 */
const UNSETTLED_DELTA_ABI = parseAbi(['error UnsettledDelta(address currency, int256 delta)'])
export const UNSETTLED_DELTA_SELECTOR = toFunctionSelector('function UnsettledDelta(address,int256)')

export type UnsettledDelta = { currency: Address; delta: bigint }

/** Decodes an `UnsettledDelta` revert, or returns undefined for any other output. */
export function decodeUnsettledDelta(output: Hex | undefined): UnsettledDelta | undefined {
  if (!output || !output.toLowerCase().startsWith(UNSETTLED_DELTA_SELECTOR)) return undefined
  try {
    const decoded = decodeErrorResult({ abi: UNSETTLED_DELTA_ABI, data: output })
    const [currency, delta] = decoded.args as readonly [Address, bigint]
    return { currency, delta }
  } catch {
    return undefined
  }
}

/**
 * What an ERC-20-settled scenario observed, and what that means next to the
 * claims baseline.
 *
 * The four statuses are kept apart on purpose. A token that reverts inside its
 * own transfer is a fact about the token; an actor that could not be funded is a
 * limit of the analyzer. Collapsing those would let an infrastructure gap read
 * as an accusation, which is the failure mode this whole lane has to avoid.
 */

export type Erc20ScenarioStatus =
  | 'completed'
  | 'behavior-reverted'
  | 'preparation-unavailable'
  | 'execution-failed'

export type TokenBalanceMovement = {
  address: Address
  before: bigint
  after: bigint
  moved: bigint
}

export type TokenObservations = {
  token: Address
  /** Whether this token paid the pool or was delivered by the pool. */
  tokenRole: 'input' | 'output'
  transfers: TokenTransfer[]
  /** Distinct ERC-20 selectors the trace actually invoked on this token. */
  tokenCalls: Hex[]
  balances: TokenBalanceMovement[]
  allowanceBefore: bigint
  allowanceAfter: bigint
  /** What the scenario asked to move, from the returned pool delta. */
  requestedAmount: bigint
  /** What the PoolManager's balance actually moved by. */
  poolManagerMoved: bigint
  /** What the recipient actually received. */
  recipientReceived: bigint
  /**
   * Non-zero when less was delivered than requested.
   *
   * Recovered from the `UnsettledDelta` revert when settlement failed, since a
   * revert rolls back the balances that would otherwise show it, and from
   * balance movement when settlement succeeded.
   */
  shortfall: bigint
  /** How the shortfall was measured, so a report never implies the wrong one. */
  shortfallSource?: 'unsettled-delta-revert' | 'balance-movement'
  /** The harness's settlement failure, when it reverted with one. */
  unsettledDelta?: UnsettledDelta
  reverted: boolean
  revertData?: Hex
}

function movement(address: Address, before: bigint, after: bigint): TokenBalanceMovement {
  return { address, before, after, moved: after - before }
}

function absolute(value: bigint) {
  return value < 0n ? -value : value
}

/**
 * Collects the token-side facts from one executed scenario.
 *
 * Balances are supplied by the caller from real `balanceOf` reads taken either
 * side of the run rather than derived from `Transfer` logs. A token that skims a
 * fee can emit a log for one amount and move another, so logs are recorded as
 * evidence but never trusted as the balance source.
 */
export function summarizeTokenObservations(input: {
  proof: RevmExecutionProof
  token: Address
  actor: Address
  recipient: Address
  harness: Address
  poolManager: Address
  balancesBefore: Record<string, bigint>
  balancesAfter: Record<string, bigint>
  allowanceBefore: bigint
  allowanceAfter: bigint
  requestedAmount: bigint
  tokenRole?: 'input' | 'output'
}): TokenObservations {
  const at = (source: Record<string, bigint>, address: Address) => source[address.toLowerCase()] ?? 0n

  const balances = [input.actor, input.recipient, input.harness, input.poolManager]
    .filter((address, index, all) => all.findIndex((item) => item.toLowerCase() === address.toLowerCase()) === index)
    .map((address) => movement(address, at(input.balancesBefore, address), at(input.balancesAfter, address)))

  const tokenCalls = [...new Set(
    input.proof.calls
      .filter((call) => call.target.toLowerCase() === input.token.toLowerCase() && call.selector)
      .map((call) => call.selector!.toLowerCase() as Hex),
  )]

  const poolManagerMoved = at(input.balancesAfter, input.poolManager) - at(input.balancesBefore, input.poolManager)
  const recipientReceived = at(input.balancesAfter, input.recipient) - at(input.balancesBefore, input.recipient)

  // A settlement that reverted moved nothing, so balances cannot show a
  // shortfall. The harness names the exact amount still owed in its revert.
  const decodedDelta = input.proof.success ? undefined : decodeUnsettledDelta(input.proof.output)
  // A native-input failure can name address(0) while this lane is observing the
  // ERC-20 output. Never attribute that unrelated settlement delta to the token.
  const unsettledDelta = decodedDelta?.currency.toLowerCase() === input.token.toLowerCase()
    ? decodedDelta
    : undefined
  const requested = absolute(input.requestedAmount)
  const tokenRole = input.tokenRole ?? 'input'

  let shortfall = 0n
  let shortfallSource: TokenObservations['shortfallSource']
  if (unsettledDelta) {
    // A negative remaining delta is a debt the token failed to deliver.
    shortfall = absolute(unsettledDelta.delta)
    shortfallSource = 'unsettled-delta-revert'
  } else {
    const delivered = tokenRole === 'input' ? poolManagerMoved : recipientReceived
    // Zero is a measurable delivery too. A completed exact-output call that
    // delivers none of the requested token is the full shortfall, not an exact
    // settlement.
    if (requested > 0n && delivered >= 0n && delivered < requested) {
      shortfall = requested - delivered
      shortfallSource = 'balance-movement'
    }
  }

  return {
    token: input.token,
    tokenRole,
    transfers: decodeTokenTransfers(input.proof, input.token),
    tokenCalls,
    balances,
    allowanceBefore: input.allowanceBefore,
    allowanceAfter: input.allowanceAfter,
    requestedAmount: requested,
    poolManagerMoved,
    recipientReceived,
    shortfall,
    shortfallSource,
    unsettledDelta,
    reverted: !input.proof.success,
    revertData: input.proof.success ? undefined : input.proof.output,
  }
}

/** A named, concrete thing the token rail did. Never a universal verdict. */
export type TokenClassification =
  | 'input-transfer-reverted'
  | 'output-transfer-reverted'
  | 'pool-received-less-than-requested'
  | 'recipient-received-less-than-sent'
  | 'approval-insufficient'
  | 'settlement-short-by-fee'
  | 'settled-exactly'

/**
 * Names what happened on the token rail.
 *
 * Every label describes this one execution at this one pinned block. None of
 * them generalizes to "this token is malicious" — a threshold, a fee or a
 * blocklist is a property the report states, and the reader draws conclusions.
 */
export function classifyTokenObservations(observations: TokenObservations): TokenClassification[] {
  const labels: TokenClassification[] = []

  if (observations.reverted) {
    if (observations.unsettledDelta) {
      // The token accepted the transfer and delivered less than it was told to,
      // so settlement could not balance. That is a fee, not a rejection.
      labels.push('settlement-short-by-fee')
      return labels
    }
    const calledTransferFrom = observations.tokenCalls.includes(ERC20_SELECTORS.transferFrom.toLowerCase() as Hex)
    const calledTransfer = observations.tokenCalls.includes(ERC20_SELECTORS.transfer.toLowerCase() as Hex)
    if (calledTransferFrom) labels.push('input-transfer-reverted')
    else if (calledTransfer) labels.push('output-transfer-reverted')
    if (observations.allowanceAfter < observations.requestedAmount) labels.push('approval-insufficient')
    return labels
  }

  if (observations.shortfall > 0n) {
    if (observations.tokenRole === 'input') labels.push('pool-received-less-than-requested')
    else labels.push('recipient-received-less-than-sent')
  }
  if (!labels.length) labels.push('settled-exactly')
  return labels
}

export type LaneComparison = {
  claims: 'completed' | 'reverted' | 'unavailable'
  token: Erc20ScenarioStatus
  /** Which layer the evidence points at, stated as a reading rather than a verdict. */
  reading:
    | 'token-settlement-specific'
    | 'pool-or-hook-behavior'
    | 'both-lanes-agree'
    | 'token-lane-not-comparable'
  detail: string
}

/**
 * Reads the two lanes against each other.
 *
 * This is the comparison the whole design exists for. The claims lane cannot
 * touch a token, so when it succeeds and the token lane does not, the difference
 * is localized to token settlement. When both refuse, the pool or the hook is
 * the better explanation. When the token lane could not be prepared, no
 * comparison is available at all and saying so is the honest output.
 */
export function compareLanes(input: {
  claims: 'completed' | 'reverted' | 'unavailable'
  token: Erc20ScenarioStatus
  classifications?: TokenClassification[]
}): LaneComparison {
  const { claims, token } = input
  const labels = input.classifications?.length ? ` (${input.classifications.join(', ')})` : ''

  if (token === 'preparation-unavailable' || token === 'execution-failed' || claims === 'unavailable') {
    return {
      claims,
      token,
      reading: 'token-lane-not-comparable',
      detail: token === 'preparation-unavailable'
        ? 'No comparison is available: a real funded actor could not be prepared for the token settlement lane, so only the claims baseline ran.'
        : claims === 'unavailable'
          ? 'No comparison is available: the claims baseline did not run for this scenario.'
          : 'No comparison is available: the token settlement lane did not execute.',
    }
  }

  if (claims === 'completed' && token === 'behavior-reverted') {
    return {
      claims,
      token,
      reading: 'token-settlement-specific',
      detail: `The same scenario completed settling in ERC-6909 claims but reverted settling in real ERC-20${labels}. The pool and hook accepted the operation, so the difference is specific to the token's own transfer path.`,
    }
  }

  if (claims === 'reverted' && token === 'behavior-reverted') {
    return {
      claims,
      token,
      reading: 'pool-or-hook-behavior',
      detail: `The scenario reverted on both settlement rails${labels}. Pool or hook behavior explains this better than the token's transfer path, since the claims lane never calls the token.`,
    }
  }

  if (claims === 'reverted' && token === 'completed') {
    return {
      claims,
      token,
      reading: 'pool-or-hook-behavior',
      detail: 'The scenario reverted settling in claims but completed settling in real ERC-20, so the difference lies in how settlement was funded rather than in the token transfer itself.',
    }
  }

  return {
    claims,
    token,
    reading: 'both-lanes-agree',
    detail: `Both settlement rails completed${labels}.`,
  }
}
