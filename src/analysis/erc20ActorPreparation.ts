import { encodeFunctionData, decodeFunctionResult, parseAbi, type Address, type Hex } from 'viem'
import type { ForkReplayBlock, ForkReplayResult } from './revmProof'
import { ERC20_SELECTORS, maxSafeAmount, type ProvisioningSource } from './erc20Provisioning'

/**
 * Preparing a real account to pay for a generated ERC-20 scenario.
 *
 * The approval is granted by calling the token's own `approve` from the actor
 * inside the fork, then reading `allowance` back to confirm it took. Writing an
 * allowance slot directly would be faster and wrong twice over: it guesses a
 * storage layout the analyzer has not verified, and it skips the token's own
 * approval logic — which is exactly the behavior worth observing, since a token
 * may refuse an approval by returning `false` without reverting.
 *
 * Impersonating the actor is safe here for a reason that does not generalize:
 * nothing is signed and nothing is broadcast. The transaction exists only inside
 * a browser-local fork of pinned state.
 *
 * Failure to prepare is never a finding about the token's swap behavior. It is
 * reported as preparation-unavailable so an infrastructure limit can never be
 * mistaken for a hook or pool verdict.
 */

const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
])

export type Erc20PreparationStatus =
  | 'prepared'
  | 'preparation-unavailable'
  | 'approval-refused'

export type Erc20ActorPreparation = {
  status: Erc20PreparationStatus
  source: ProvisioningSource
  actor: Address
  token: Address
  spender: Address
  /** Actor balance read at the pinned block, before anything ran. */
  balance: bigint
  /** Allowance before and after the approval attempt. */
  allowanceBefore: bigint
  allowanceAfter: bigint
  /** The bound a scenario may spend, derived from the observed balance. */
  spendCeiling: bigint
  /** Whether the token's `approve` returned true. */
  approveReturnedTrue?: boolean
  reason?: string
}

/** The subset of a fork session this preparation needs. */
export type PreparationSession = {
  execute(input: {
    transaction: {
      caller: Address
      to: Address
      calldata: Hex
      value: bigint
      /** eth_call semantics: skip the nonce and base-fee checks. */
      executionMode?: 'transaction' | 'simulation'
      gasLimit: bigint
      gasPrice: bigint
      nonce: number
      chainId: number
      traceLimit?: number
    }
    block: ForkReplayBlock
    signal: AbortSignal
    timeoutMs?: number
    maxHydrationRequests?: number
    commit?: boolean
  }): Promise<ForkReplayResult>
}

const READ_GAS = 200_000n
const APPROVE_GAS = 300_000n

function decodeUint(output: Hex): bigint | undefined {
  try {
    return BigInt(output.slice(0, 66))
  } catch {
    return undefined
  }
}

async function readUint(input: {
  session: PreparationSession
  caller: Address
  token: Address
  calldata: Hex
  block: ForkReplayBlock
  chainId: number
  signal: AbortSignal
}): Promise<bigint | undefined> {
  const result = await input.session.execute({
    transaction: {
      caller: input.caller,
      to: input.token,
      calldata: input.calldata,
      value: 0n,
      executionMode: 'simulation',
      gasLimit: READ_GAS,
      gasPrice: 0n,
      nonce: 0,
      chainId: input.chainId,
      traceLimit: 16,
    },
    block: input.block,
    signal: input.signal,
    // A read must never persist, or a later scenario would observe it.
    commit: false,
  })
  if (!result.proof.success) return undefined
  return decodeUint(result.proof.output)
}

/**
 * Verifies a real balance, grants an approval through the token, and confirms it.
 *
 * Every step is a real call into the deployed token. The confirmation read is
 * what makes the result trustworthy: a token that accepts `approve` and records
 * nothing is caught here rather than misreported later as a swap failure.
 */
export async function prepareErc20Actor(input: {
  session: PreparationSession
  actor: Address
  token: Address
  spender: Address
  block: ForkReplayBlock
  chainId: number
  signal: AbortSignal
  source: ProvisioningSource
  /** Requested allowance; defaults to the whole observed spend ceiling. */
  amount?: bigint
}): Promise<Erc20ActorPreparation> {
  const base = {
    source: input.source,
    actor: input.actor,
    token: input.token,
    spender: input.spender,
    balance: 0n,
    allowanceBefore: 0n,
    allowanceAfter: 0n,
    spendCeiling: 0n,
  }

  const balance = await readUint({
    session: input.session,
    caller: input.actor,
    token: input.token,
    calldata: encodeFunctionData({ abi: ERC20_ABI, functionName: 'balanceOf', args: [input.actor] }),
    block: input.block,
    chainId: input.chainId,
    signal: input.signal,
  })
  if (balance === undefined) {
    return { ...base, status: 'preparation-unavailable', reason: 'The token did not answer balanceOf at the pinned block.' }
  }
  const spendCeiling = maxSafeAmount(balance)
  if (spendCeiling <= 0n) {
    return {
      ...base,
      status: 'preparation-unavailable',
      balance,
      reason: `The actor holds ${balance} of this token at the pinned block, which is too little to fund a bounded scenario.`,
    }
  }

  const allowanceCalldata = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [input.actor, input.spender],
  })
  const allowanceBefore = await readUint({
    session: input.session,
    caller: input.actor,
    token: input.token,
    calldata: allowanceCalldata,
    block: input.block,
    chainId: input.chainId,
    signal: input.signal,
  })
  if (allowanceBefore === undefined) {
    return { ...base, status: 'preparation-unavailable', balance, spendCeiling, reason: 'The token did not answer allowance at the pinned block.' }
  }

  const requested = input.amount ?? spendCeiling
  const approval = await input.session.execute({
    transaction: {
      caller: input.actor,
      to: input.token,
      calldata: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [input.spender, requested] }),
      value: 0n,
      executionMode: 'simulation',
      gasLimit: APPROVE_GAS,
      gasPrice: 0n,
      nonce: 0,
      chainId: input.chainId,
      traceLimit: 64,
    },
    block: input.block,
    signal: input.signal,
    // Committed, so the scenario that follows sees the allowance.
    commit: true,
  })

  const shared = { ...base, balance, allowanceBefore, spendCeiling }
  if (!approval.proof.success) {
    // A reverting approve is a concrete fact about the token, not a missing
    // capability, so it is reported as an observation rather than unavailable.
    return { ...shared, status: 'approval-refused', reason: 'The token reverted while approving the scenario harness.' }
  }

  let approveReturnedTrue: boolean | undefined
  try {
    approveReturnedTrue = decodeFunctionResult({
      abi: ERC20_ABI,
      functionName: 'approve',
      data: approval.proof.output,
    }) as boolean
  } catch {
    // A token that returns nothing is still usable; the allowance read decides.
    approveReturnedTrue = undefined
  }

  const allowanceAfter = await readUint({
    session: input.session,
    caller: input.actor,
    token: input.token,
    calldata: allowanceCalldata,
    block: input.block,
    chainId: input.chainId,
    signal: input.signal,
  })
  if (allowanceAfter === undefined) {
    return { ...shared, status: 'preparation-unavailable', approveReturnedTrue, reason: 'The token stopped answering allowance after the approval.' }
  }

  // The confirmation read, not the return value, is the authority: a token can
  // report success and record nothing.
  if (allowanceAfter < requested) {
    return {
      ...shared,
      status: 'approval-refused',
      allowanceAfter,
      approveReturnedTrue,
      reason: `The token accepted approve${approveReturnedTrue === false ? ' returning false' : ''} but the allowance is ${allowanceAfter}, below the requested ${requested}.`,
    }
  }

  return { ...shared, status: 'prepared', allowanceAfter, approveReturnedTrue }
}

/** Report-ready summary of how an ERC-20 actor was funded and approved. */
export function preparationSummary(preparation: Erc20ActorPreparation) {
  return {
    provisioning: preparation.source,
    status: preparation.status,
    actor: preparation.actor,
    token: preparation.token,
    spender: preparation.spender,
    balanceAtPinnedBlock: preparation.balance.toString(),
    allowanceBefore: preparation.allowanceBefore.toString(),
    allowanceAfter: preparation.allowanceAfter.toString(),
    spendCeiling: preparation.spendCeiling.toString(),
    approveReturnedTrue: preparation.approveReturnedTrue,
    approvalSelector: ERC20_SELECTORS.approve,
    reason: preparation.reason,
  }
}
