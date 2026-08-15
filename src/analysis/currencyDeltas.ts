import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem'
import type { RevmExecutionProof } from './revmProof'

/**
 * Uniswap v4 settles every operation through per-(account, currency) deltas held
 * in PoolManager transient storage.
 *
 * Upstream `CurrencyDelta._computeSlot` stores the target address at memory 0
 * and the currency at 32, then hashes both words — the same bytes ABI encoding
 * produces for two addresses. Reading these values makes settlement a decoded
 * observation rather than something inferred from balances after the fact.
 */
export function currencyDeltaSlot(target: Address, currency: Address): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [target, currency]))
}

const TWO_POW_255 = 1n << 255n
const TWO_POW_256 = 1n << 256n

/** Transient deltas are `int256`; a raw word above 2^255 is a negative balance owed. */
export function decodeSignedDelta(word: Hex): bigint {
  const value = BigInt(word)
  return value >= TWO_POW_255 ? value - TWO_POW_256 : value
}

export type CurrencyDeltaObservation = {
  account: Address
  currency: Address
  slot: Hex
  /** Signed decimal. Negative means the account owes the PoolManager. */
  delta: string
  /** Final observed value; a delta written more than once keeps its last write. */
  writes: number
}

/**
 * Ordered values written to one known PoolManager currency-delta slot.
 *
 * A completed unlock normally finishes at zero. Keeping only that final value
 * erases the economically interesting part of the execution: a hook can first
 * be credited a fee and then settle that credit before the transaction ends.
 * The timeline retains those intermediate values without treating unrelated
 * transient storage as currency accounting.
 */
export type CurrencyDeltaTimeline = {
  account: Address
  currency: Address
  slot: Hex
  /** Signed decimal values in execution order. */
  values: string[]
  finalDelta: string
  settled: boolean
}

function matchingDeltaWrites(input: {
  proof: RevmExecutionProof
  poolManager: Address
  accounts: readonly Address[]
  currencies: readonly Address[]
  /** Optional execution-frame boundary for operation-specific accounting. */
  frameIds?: ReadonlySet<number>
}) {
  const manager = input.poolManager.toLowerCase()
  const writes = input.proof.storageOperations.filter(
    (access) =>
      access.opcode === 'TSTORE'
      && (input.frameIds === undefined || (access.frameId !== undefined && input.frameIds.has(access.frameId)))
      && access.slot !== undefined
      && access.value !== undefined
      && (access.storageAddress ?? access.address).toLowerCase() === manager,
  )
  if (!writes.length) return { writes, bySlot: new Map<string, { account: Address; currency: Address; slot: Hex }>() }

  const bySlot = new Map<string, { account: Address; currency: Address; slot: Hex }>()
  for (const account of new Set(input.accounts.map((value) => value.toLowerCase() as Address))) {
    for (const currency of new Set(input.currencies.map((value) => value.toLowerCase() as Address))) {
      const slot = currencyDeltaSlot(account, currency)
      bySlot.set(slot.toLowerCase(), { account, currency, slot })
    }
  }
  return { writes, bySlot }
}

/** Ordered, signed histories for known `(account, currency)` delta slots. */
export function decodeCurrencyDeltaTimelines(input: {
  proof: RevmExecutionProof
  poolManager: Address
  accounts: readonly Address[]
  currencies: readonly Address[]
  frameIds?: ReadonlySet<number>
}): CurrencyDeltaTimeline[] {
  const { writes, bySlot } = matchingDeltaWrites(input)
  const observed = new Map<string, CurrencyDeltaTimeline>()

  for (const write of writes) {
    const identity = write.slot!.toLowerCase()
    const pair = bySlot.get(identity)
    if (!pair) continue
    const value = decodeSignedDelta(write.value!).toString()
    const current = observed.get(identity)
    if (current) {
      current.values.push(value)
      current.finalDelta = value
      current.settled = value === '0'
    } else {
      observed.set(identity, {
        account: pair.account,
        currency: pair.currency,
        slot: pair.slot,
        values: [value],
        finalDelta: value,
        settled: value === '0',
      })
    }
  }

  return [...observed.values()]
}

/**
 * Decodes PoolManager transient writes into per-account currency deltas.
 *
 * Only slots that match a computed `(account, currency)` pair are reported, so
 * an unrelated transient write can never be presented as settlement. Candidate
 * accounts and currencies come from the pinned pool context rather than guessed.
 */
export function decodeCurrencyDeltas(input: {
  proof: RevmExecutionProof
  poolManager: Address
  accounts: readonly Address[]
  currencies: readonly Address[]
  frameIds?: ReadonlySet<number>
}): CurrencyDeltaObservation[] {
  return decodeCurrencyDeltaTimelines(input)
    .map((timeline) => ({
      account: timeline.account,
      currency: timeline.currency,
      slot: timeline.slot,
      delta: timeline.finalDelta,
      writes: timeline.values.length,
    }))
    .filter((item) => item.delta !== '0' || item.writes > 1)
}

/** True when every observed delta settled back to zero, which is what a completed unlock requires. */
export function deltasFullySettled(deltas: readonly CurrencyDeltaObservation[]): boolean {
  return deltas.every((item) => item.delta === '0')
}

export function currencyDeltaSummary(deltas: readonly CurrencyDeltaObservation[]): string | undefined {
  if (!deltas.length) return undefined
  const unsettled = deltas.filter((item) => item.delta !== '0')
  return unsettled.length
    ? `${deltas.length} currency delta${deltas.length === 1 ? '' : 's'} observed, ${unsettled.length} still non-zero at the end of execution`
    : `${deltas.length} currency delta${deltas.length === 1 ? '' : 's'} observed, all settled to zero`
}
