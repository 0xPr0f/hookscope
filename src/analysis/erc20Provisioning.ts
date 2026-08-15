import { getAddress, toEventSelector, toFunctionSelector, type Address, type Hex } from 'viem'
import type { RevmExecutionProof } from './revmProof'

/**
 * Finding a real, already-funded account to run the ERC-20 settlement lane as.
 *
 * The lane is only worth anything if the payer is an account that genuinely
 * holds the token at the pinned block. Inventing a balance would mean the token
 * rail was exercised against a fiction, and every observation about fees,
 * blocklists or thresholds would be unfalsifiable.
 *
 * The most defensible source is the historical transaction the analyzer already
 * replayed: some address really did supply the input token there. Recovering it
 * takes care, because the address that hands tokens to the PoolManager is
 * usually the router, not the funded account. Real example from mainnet:
 *
 *     actor 0xbbd6…c728 --transferFrom--> router 0xda5c…be6f
 *     router 0xda5c…be6f --transfer------> PoolManager 0x0000…8a90
 *
 * Taking the address adjacent to the PoolManager would pick the router, which
 * holds nothing of its own. So the movement is walked back to its source.
 */

export const ERC20_SELECTORS = {
  balanceOf: toFunctionSelector('function balanceOf(address) view returns (uint256)'),
  allowance: toFunctionSelector('function allowance(address,address) view returns (uint256)'),
  approve: toFunctionSelector('function approve(address,uint256) returns (bool)'),
  transfer: toFunctionSelector('function transfer(address,uint256) returns (bool)'),
  transferFrom: toFunctionSelector('function transferFrom(address,address,uint256) returns (bool)'),
} as const

export const ERC20_TOPICS = {
  transfer: toEventSelector('event Transfer(address indexed from, address indexed to, uint256 value)'),
  approval: toEventSelector('event Approval(address indexed owner, address indexed spender, uint256 value)'),
} as const

export type TokenTransfer = { from: Address; to: Address; value: bigint }

/** Where an ERC-20 actor's funding came from, in descending order of defensibility. */
export type ProvisioningSource =
  | 'receipt-derived'
  | 'indexed-holder'
  | 'verified-storage-overlay'
  | 'deterministic-fixture'
  | 'unavailable'

function topicAddress(topic: Hex | undefined): Address | undefined {
  if (!topic || topic.length !== 66) return undefined
  return getAddress(`0x${topic.slice(26)}`)
}

/** Decodes the `Transfer` events a single token emitted during one execution. */
export function decodeTokenTransfers(proof: RevmExecutionProof, token: Address): TokenTransfer[] {
  const transfers: TokenTransfer[] = []
  for (const log of proof.logs) {
    if (log.address.toLowerCase() !== token.toLowerCase()) continue
    if (log.topics[0]?.toLowerCase() !== ERC20_TOPICS.transfer.toLowerCase()) continue
    const from = topicAddress(log.topics[1])
    const to = topicAddress(log.topics[2])
    if (!from || !to) continue
    // A non-standard token may pack the value elsewhere; an unreadable amount
    // must not discard the movement, which is what identifies the payer.
    let value = 0n
    try {
      value = log.data && log.data !== '0x' ? BigInt(log.data.slice(0, 66)) : 0n
    } catch {
      value = 0n
    }
    transfers.push({ from, to, value })
  }
  return transfers
}

export type PayerIdentification =
  | { ok: true; payer: Address; hops: number; chain: Address[] }
  | { ok: false; reason: string }

/**
 * Walks the token's movement back from the PoolManager to whoever supplied it.
 *
 * Each hop asks who paid the current holder within this same execution. The walk
 * stops at an address nobody paid, which is the account that actually spent its
 * own balance. Addresses already seen terminate the walk so a token that
 * transfers in a cycle cannot spin here.
 */
export function identifyTokenPayer(input: {
  proof: RevmExecutionProof
  token: Address
  poolManager: Address
}): PayerIdentification {
  const transfers = decodeTokenTransfers(input.proof, input.token)
  if (!transfers.length) {
    return { ok: false, reason: 'The replayed transaction emitted no Transfer event for this token.' }
  }

  const manager = input.poolManager.toLowerCase()
  const intoManager = transfers.filter((transfer) => transfer.to.toLowerCase() === manager)
  if (!intoManager.length) {
    return { ok: false, reason: 'No observed transfer of this token reached the PoolManager.' }
  }

  const chain: Address[] = [getAddress(input.poolManager)]
  const seen = new Set<string>([manager])
  let current = intoManager[0]!.from

  while (!seen.has(current.toLowerCase())) {
    chain.push(current)
    seen.add(current.toLowerCase())
    const upstream = transfers.find(
      (transfer) => transfer.to.toLowerCase() === current.toLowerCase() && !seen.has(transfer.from.toLowerCase()),
    )
    if (!upstream) {
      // Nobody paid this address inside the transaction, so it spent its own
      // balance: this is the funded account the lane needs.
      return { ok: true, payer: current, hops: chain.length - 1, chain }
    }
    current = upstream.from
  }

  return { ok: false, reason: 'Token movement formed a cycle, so no originating payer could be identified.' }
}

/**
 * Caps how much of a real account's balance a generated scenario may spend.
 *
 * Generated scenarios run against pinned state and are never broadcast, but the
 * bound still matters: a swap sized near an actor's whole balance would move the
 * pool far more than any observation needs, and the resulting price impact would
 * be reported as hook behavior. A small fraction keeps the observation about the
 * token path rather than about depleting a position.
 */
export const MAX_ACTOR_BALANCE_SHARE_BPS = 100n

export function maxSafeAmount(balance: bigint): bigint {
  if (balance <= 0n) return 0n
  return (balance * MAX_ACTOR_BALANCE_SHARE_BPS) / 10_000n
}
