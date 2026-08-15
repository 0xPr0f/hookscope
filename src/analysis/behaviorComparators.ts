import type { Address, Hex } from 'viem'
import type { CurrencyDeltaObservation } from './currencyDeltas'
import type { RevmCallEvidence, RevmExecutionProof, RevmStorageDiff } from './revmProof'

/**
 * Compares two executions that differ in exactly one controlled input.
 *
 * This is what replaces guessing at data flow from opcode co-presence. Seeing
 * `CALLER` and `SSTORE` in the same bytecode says nothing about whether one
 * reaches the other. Running the identical scenario twice, changing only the
 * caller, and observing a different storage write says a great deal — not as a
 * universal property, but as a fact about these two executions at this state.
 *
 * The output is deliberately descriptive rather than judgmental. It reports what
 * differed; deciding whether a difference matters belongs to a rule that can
 * weigh it, not to the comparison itself.
 */

export type ControlledDifference =
  | { kind: 'transaction-caller'; before: Address; after: Address }
  | { kind: 'hook-sender'; before: Address; after: Address }
  | { kind: 'swap-direction'; before: boolean; after: boolean }
  | { kind: 'swap-mode'; before: 'exact-input' | 'exact-output'; after: 'exact-input' | 'exact-output' }
  | { kind: 'amount'; before: bigint; after: bigint }
  | { kind: 'hook-data'; before: Hex; after: Hex }

export type StorageDifference = {
  address: string
  slot: Hex
  /** The value each side wrote, when it wrote at all. */
  before?: Hex
  after?: Hex
}

export type BalanceDifference = { address: string; before: string; after: string }

export type BranchEdgeDifference = {
  edge: string
  onlyIn: 'before' | 'after'
}

export type TransientWriteDifference = {
  address: string
  slot: Hex
  before?: Hex
  after?: Hex
}

export type CurrencyDeltaDifference = {
  account: Address
  currency: Address
  slot: Hex
  before?: string
  after?: string
}

/**
 * One delegated call whose target changed at the same trace position.
 *
 * `caller` is the storage context used by DELEGATECALL. Rules can therefore
 * require a surviving storage difference at that address instead of joining an
 * unrelated delegated call and an unrelated write from different executions.
 */
export type DelegatecallDifference = {
  /** EVM message sender for the delegated frame. */
  caller: string
  /** Contract whose storage context the delegated code executes in. */
  storageAddress: string
  beforeTarget: string
  afterTarget: string
  beforeFrameId: number
  afterFrameId: number
  selector?: Hex
  ordinal: number
  /** Final state differences whose last writes came from these exact frames. */
  storageEffects: StorageDifference[]
}

/** Pool-specific observations decoded by the scenario owner. */
export type ComparisonObservations = {
  fees?: number[]
  currencyDeltas?: CurrencyDeltaObservation[]
}

/**
 * Differences that follow from the varied input itself rather than from
 * behavior.
 *
 * Routing the same swap through a second harness instance necessarily changes
 * the outer call target, the `sender` the PoolManager indexes into its events,
 * the ERC-6909 claim slots keyed by that instance, and those instances' own
 * balances. None of that is the hook behaving differently — it is the
 * substitution being visible. Counting it would make every hook look
 * caller-dependent, which is the opposite of what the comparison is for.
 *
 * Only differences that survive this normalization are reported.
 */
export type ComparisonNormalization = {
  /** Address pairs that differ between the two runs by construction. */
  substituted?: { before: Address; after: Address }[]
  /** Storage slots derived from those addresses, such as claim balances. */
  ignoredSlots?: Hex[]
}

/** Canonical stand-in for a substituted address, so both sides hash alike. */
const SUBSTITUTED = '0x{substituted}'

function substitutionSet(normalization: ComparisonNormalization | undefined) {
  const addresses = new Set<string>()
  for (const pair of normalization?.substituted ?? []) {
    addresses.add(pair.before.toLowerCase())
    addresses.add(pair.after.toLowerCase())
  }
  return addresses
}

/** Replaces a substituted address anywhere it appears in a 32-byte word. */
function normalizeWord(word: string, substituted: Set<string>) {
  const lower = word.toLowerCase()
  for (const address of substituted) {
    if (lower.endsWith(address.slice(2))) return SUBSTITUTED
  }
  return lower
}

export type EventDifference = {
  address: string
  topic0?: Hex
  /** Which side emitted it, when only one did. */
  onlyIn?: 'before' | 'after'
}

export type BehaviorDifference = {
  /** Whether success/revert itself changed. */
  outcomeChanged: boolean
  outcomeBefore: 'success' | 'revert'
  outcomeAfter: 'success' | 'revert'
  returnDataChanged: boolean
  changedStorage: StorageDifference[]
  changedCallTargets: Address[]
  changedDelegatecalls: DelegatecallDifference[]
  changedExternalSelectors: Hex[]
  changedBranchEdges: BranchEdgeDifference[]
  changedTransientWrites: TransientWriteDifference[]
  changedFees: number[]
  changedCurrencyDeltas: CurrencyDeltaDifference[]
  changedEvents: EventDifference[]
  changedBalanceMovement: BalanceDifference[]
  /** Gas is reported but never used alone to claim a behavioral difference. */
  gasBefore: number
  gasAfter: number
  /** True when nothing observable differed. */
  identical: boolean
}

function storageKey(diff: RevmStorageDiff) {
  return `${diff.address.toLowerCase()}:${diff.slot.toLowerCase()}`
}

function compareStorage(
  before: RevmExecutionProof,
  after: RevmExecutionProof,
  normalization: ComparisonNormalization | undefined,
): StorageDifference[] {
  const ignored = new Set((normalization?.ignoredSlots ?? []).map((slot) => slot.toLowerCase()))
  const substituted = substitutionSet(normalization)
  const left = new Map(before.storageDiffs.map((diff) => [storageKey(diff), diff]))
  const right = new Map(after.storageDiffs.map((diff) => [storageKey(diff), diff]))
  const changed: StorageDifference[] = []
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const a = left.get(key)
    const b = right.get(key)
    // A slot written to the same final value by both runs is not a difference,
    // even if the paths there differed.
    if (a?.after?.toLowerCase() === b?.after?.toLowerCase()) continue
    const slot = (a ?? b)!.slot.toLowerCase()
    if (ignored.has(slot)) continue
    // A slot whose address is itself substituted, or whose value is only the
    // substituted address, differs because of the substitution.
    if (substituted.has((a ?? b)!.address.toLowerCase())) continue
    if (normalizeWord(a?.after ?? '', substituted) === normalizeWord(b?.after ?? '', substituted)) continue
    changed.push({
      address: (a ?? b)!.address,
      slot: (a ?? b)!.slot,
      before: a?.after,
      after: b?.after,
    })
  }
  return changed
}

function callTargets(proof: RevmExecutionProof) {
  return new Set(proof.calls.map((call) => call.target.toLowerCase()))
}

function externalSelectors(proof: RevmExecutionProof) {
  return new Set(proof.calls.map((call) => call.selector?.toLowerCase()).filter((value): value is string => Boolean(value)))
}

function symmetricDifference(left: Set<string>, right: Set<string>) {
  return [...new Set([...left, ...right])].filter((value) => left.has(value) !== right.has(value))
}

function branchEdges(proof: RevmExecutionProof, substituted: Set<string>) {
  const edges = new Set<string>()
  for (let index = 0; index + 1 < proof.steps.length; index++) {
    const current = proof.steps[index]!
    const next = proof.steps[index + 1]!
    if (current.opcode !== 'JUMP' && current.opcode !== 'JUMPI') continue
    const from = substituted.has(current.address.toLowerCase()) ? SUBSTITUTED : current.address.toLowerCase()
    const to = substituted.has(next.address.toLowerCase()) ? SUBSTITUTED : next.address.toLowerCase()
    edges.add(`${from}:${current.pc}->${to}:${next.pc}`)
  }
  return edges
}

function compareBranchEdges(
  before: RevmExecutionProof,
  after: RevmExecutionProof,
  normalization: ComparisonNormalization | undefined,
): BranchEdgeDifference[] {
  const substituted = substitutionSet(normalization)
  const left = branchEdges(before, substituted)
  const right = branchEdges(after, substituted)
  return symmetricDifference(left, right).map((edge) => ({
    edge,
    onlyIn: left.has(edge) ? 'before' : 'after',
  }))
}

function transientWrites(proof: RevmExecutionProof) {
  const writes = new Map<string, { address: string; slot: Hex; value: Hex }>()
  for (const access of proof.storageOperations) {
    if (access.opcode !== 'TSTORE' || access.slot === undefined || access.value === undefined) continue
    const storageAddress = access.storageAddress ?? access.address
    writes.set(`${storageAddress.toLowerCase()}:${access.slot.toLowerCase()}`, {
      address: storageAddress,
      slot: access.slot,
      value: access.value,
    })
  }
  return writes
}

function compareTransientWrites(
  before: RevmExecutionProof,
  after: RevmExecutionProof,
  normalization: ComparisonNormalization | undefined,
): TransientWriteDifference[] {
  const left = transientWrites(before)
  const right = transientWrites(after)
  const ignored = new Set((normalization?.ignoredSlots ?? []).map((slot) => slot.toLowerCase()))
  const substituted = substitutionSet(normalization)
  const changed: TransientWriteDifference[] = []
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const a = left.get(key)
    const b = right.get(key)
    if (ignored.has((a ?? b)!.slot.toLowerCase())) continue
    if (substituted.has((a ?? b)!.address.toLowerCase())) continue
    if (a?.value.toLowerCase() === b?.value.toLowerCase()) continue
    if (normalizeWord(a?.value ?? '', substituted) === normalizeWord(b?.value ?? '', substituted)) continue
    changed.push({ address: (a ?? b)!.address, slot: (a ?? b)!.slot, before: a?.value, after: b?.value })
  }
  return changed
}

function delegatecallFrames(proof: RevmExecutionProof, substituted: Set<string>) {
  const occurrences = new Map<string, number>()
  const frames = new Map<string, RevmCallEvidence>()
  for (const call of proof.calls) {
    if (!call.scheme.toLowerCase().includes('delegatecall')) continue
    // Old cached proofs do not carry frame identity. They remain useful as call
    // observations, but cannot support an effect-attributed high-severity claim.
    if (call.frameId === undefined) continue
    const caller = substituted.has(call.caller.toLowerCase()) ? SUBSTITUTED : call.caller.toLowerCase()
    const storage = substituted.has(call.target.toLowerCase()) ? SUBSTITUTED : call.target.toLowerCase()
    const selector = call.selector?.toLowerCase() ?? 'no-selector'
    const base = `${storage}:${caller}:${call.depth ?? 'no-depth'}:${selector}:${call.inputLength}`
    const ordinal = occurrences.get(base) ?? 0
    occurrences.set(base, ordinal + 1)
    frames.set(`${base}:${ordinal}`, call)
  }
  return frames
}

function lastPersistentWrites(proof: RevmExecutionProof) {
  const writes = new Map<string, RevmExecutionProof['storageOperations'][number]>()
  for (const access of proof.storageOperations) {
    if (
      access.opcode !== 'SSTORE'
      || access.frameId === undefined
      || access.storageAddress === undefined
      || access.slot === undefined
      || access.value === undefined
    ) continue
    writes.set(`${access.storageAddress.toLowerCase()}:${access.slot.toLowerCase()}`, access)
  }
  return writes
}

/**
 * Attributes a surviving state difference to the exact delegated frames.
 *
 * Address co-presence is insufficient: another frame can write the same
 * contract later. Requiring the last write on both sides to carry the matched
 * frame ID establishes that each delegated execution produced the final value
 * being compared.
 */
function delegatecallStorageEffects(input: {
  before: RevmExecutionProof
  after: RevmExecutionProof
  beforeCall: RevmCallEvidence
  afterCall: RevmCallEvidence
  changedStorage: StorageDifference[]
}): StorageDifference[] {
  const { beforeCall, afterCall } = input
  if (beforeCall.frameId === undefined || afterCall.frameId === undefined) return []
  if (beforeCall.target.toLowerCase() !== afterCall.target.toLowerCase()) return []

  const beforeWrites = lastPersistentWrites(input.before)
  const afterWrites = lastPersistentWrites(input.after)
  const storageAddress = beforeCall.target.toLowerCase()
  return input.changedStorage.filter((difference) => {
    if (difference.address.toLowerCase() !== storageAddress) return false
    const key = `${storageAddress}:${difference.slot.toLowerCase()}`
    const left = beforeWrites.get(key)
    const right = afterWrites.get(key)
    return left?.frameId === beforeCall.frameId
      && right?.frameId === afterCall.frameId
      && left?.value?.toLowerCase() === difference.before?.toLowerCase()
      && right?.value?.toLowerCase() === difference.after?.toLowerCase()
  })
}

function compareDelegatecalls(
  before: RevmExecutionProof,
  after: RevmExecutionProof,
  normalization: ComparisonNormalization | undefined,
  changedStorage: StorageDifference[],
): DelegatecallDifference[] {
  const substituted = substitutionSet(normalization)
  const left = delegatecallFrames(before, substituted)
  const right = delegatecallFrames(after, substituted)
  const changed: DelegatecallDifference[] = []
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const a = left.get(key)
    const b = right.get(key)
    // `target` is revm's storage context. The implementation selected by
    // DELEGATECALL is `bytecodeAddress`, so comparing target would miss the
    // behavior this correlator exists to detect.
    if (!a || !b || a.bytecodeAddress.toLowerCase() === b.bytecodeAddress.toLowerCase()) continue
    if (a.frameId === undefined || b.frameId === undefined) continue
    const ordinal = Number(key.slice(key.lastIndexOf(':') + 1))
    const storageEffects = delegatecallStorageEffects({
      before,
      after,
      beforeCall: a,
      afterCall: b,
      changedStorage,
    })
    changed.push({
      caller: a.caller,
      storageAddress: a.target,
      beforeTarget: a.bytecodeAddress,
      afterTarget: b.bytecodeAddress,
      beforeFrameId: a.frameId,
      afterFrameId: b.frameId,
      selector: a.selector === b.selector ? a.selector : undefined,
      ordinal,
      storageEffects,
    })
  }
  return changed
}

function compareCurrencyDeltas(
  before: ComparisonObservations | undefined,
  after: ComparisonObservations | undefined,
  normalization: ComparisonNormalization | undefined,
): CurrencyDeltaDifference[] {
  const substituted = substitutionSet(normalization)
  const key = (item: CurrencyDeltaObservation) => {
    const account = substituted.has(item.account.toLowerCase()) ? SUBSTITUTED : item.account.toLowerCase()
    return `${account}:${item.currency.toLowerCase()}`
  }
  const left = new Map((before?.currencyDeltas ?? []).map((item) => [key(item), item]))
  const right = new Map((after?.currencyDeltas ?? []).map((item) => [key(item), item]))
  const changed: CurrencyDeltaDifference[] = []
  for (const identity of new Set([...left.keys(), ...right.keys()])) {
    const a = left.get(identity)
    const b = right.get(identity)
    if (a?.delta === b?.delta && a?.writes === b?.writes) continue
    changed.push({
      account: (a ?? b)!.account,
      currency: (a ?? b)!.currency,
      slot: (a ?? b)!.slot,
      before: a?.delta,
      after: b?.delta,
    })
  }
  return changed
}

function eventKey(log: RevmExecutionProof['logs'][number], substituted: Set<string>) {
  // Indexed topics carrying a substituted address are canonicalized, so a
  // PoolManager `Swap` whose only difference is which instance sent it matches.
  const topics = log.topics.map((topic) => normalizeWord(topic, substituted)).join(',')
  return `${log.address.toLowerCase()}:${topics}:${log.data.toLowerCase()}`
}

function compareEvents(
  before: RevmExecutionProof,
  after: RevmExecutionProof,
  normalization: ComparisonNormalization | undefined,
): EventDifference[] {
  const substituted = substitutionSet(normalization)
  const left = new Map(before.logs.map((log) => [eventKey(log, substituted), log]))
  const right = new Map(after.logs.map((log) => [eventKey(log, substituted), log]))
  const differences: EventDifference[] = []
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    if (left.has(key) && right.has(key)) continue
    const log = (left.get(key) ?? right.get(key))!
    differences.push({
      address: log.address,
      topic0: log.topics[0],
      onlyIn: left.has(key) ? 'before' : 'after',
    })
  }
  return differences
}

function compareBalances(
  before: RevmExecutionProof,
  after: RevmExecutionProof,
  normalization: ComparisonNormalization | undefined,
): BalanceDifference[] {
  const substituted = substitutionSet(normalization)
  const left = new Map(before.balanceChanges.map((change) => [change.address.toLowerCase(), change]))
  const right = new Map(after.balanceChanges.map((change) => [change.address.toLowerCase(), change]))
  const differences: BalanceDifference[] = []
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    // A substituted account's own balance moves because it is the one doing the
    // work, not because the hook treated it differently.
    if (substituted.has(key)) continue
    const a = left.get(key)
    const b = right.get(key)
    const movedA = a ? `${a.before}->${a.after}` : 'unchanged'
    const movedB = b ? `${b.before}->${b.after}` : 'unchanged'
    if (movedA === movedB) continue
    differences.push({ address: (a ?? b)!.address, before: movedA, after: movedB })
  }
  return differences
}

/**
 * Normalizes what differed between two executions.
 *
 * Gas is recorded but never counts toward `identical`: two runs can burn
 * different gas for reasons that say nothing about behavior — a different
 * calldata byte count, a warm versus cold slot — and letting gas alone signal a
 * difference would manufacture findings out of noise.
 */
export function compareExecutions(input: {
  before: RevmExecutionProof
  after: RevmExecutionProof
  normalization?: ComparisonNormalization
  beforeObservations?: ComparisonObservations
  afterObservations?: ComparisonObservations
}): BehaviorDifference {
  const { before, after, normalization } = input
  const substituted = substitutionSet(normalization)
  const changedStorage = compareStorage(before, after, normalization)
  // A call target that is one of the substituted addresses differs by
  // construction: the second run was routed through it deliberately.
  const changedCallTargets = symmetricDifference(callTargets(before), callTargets(after))
    .filter((target) => !substituted.has(target)) as Address[]
  const changedDelegatecalls = compareDelegatecalls(before, after, normalization, changedStorage)
  const changedExternalSelectors = symmetricDifference(externalSelectors(before), externalSelectors(after)) as Hex[]
  const changedBranchEdges = compareBranchEdges(before, after, normalization)
  const changedTransientWrites = compareTransientWrites(before, after, normalization)
  const changedFees = symmetricDifference(
    new Set((input.beforeObservations?.fees ?? []).map(String)),
    new Set((input.afterObservations?.fees ?? []).map(String)),
  ).map(Number)
  const changedCurrencyDeltas = compareCurrencyDeltas(input.beforeObservations, input.afterObservations, normalization)
  const changedEvents = compareEvents(before, after, normalization)
  const changedBalanceMovement = compareBalances(before, after, normalization)
  const outcomeChanged = before.success !== after.success
  const returnDataChanged = before.output.toLowerCase() !== after.output.toLowerCase()

  return {
    outcomeChanged,
    outcomeBefore: before.success ? 'success' : 'revert',
    outcomeAfter: after.success ? 'success' : 'revert',
    returnDataChanged,
    changedStorage,
    changedCallTargets,
    changedDelegatecalls,
    changedExternalSelectors,
    changedBranchEdges,
    changedTransientWrites,
    changedFees,
    changedCurrencyDeltas,
    changedEvents,
    changedBalanceMovement,
    gasBefore: before.gasUsed,
    gasAfter: after.gasUsed,
    identical: !outcomeChanged
      && !returnDataChanged
      && changedStorage.length === 0
      && changedCallTargets.length === 0
      && changedDelegatecalls.length === 0
      && changedExternalSelectors.length === 0
      && changedBranchEdges.length === 0
      && changedTransientWrites.length === 0
      && changedFees.length === 0
      && changedCurrencyDeltas.length === 0
      && changedEvents.length === 0
      && changedBalanceMovement.length === 0,
  }
}

/** A single controlled comparison, ready for a rule to weigh. */
export type ControlledComparison = {
  difference: ControlledDifference
  behavior: BehaviorDifference
  /** Human-readable statement of exactly what was varied and what moved. */
  summary: string
}

function describeVariable(difference: ControlledDifference): string {
  switch (difference.kind) {
    case 'transaction-caller':
      return `the transaction caller (${difference.before} → ${difference.after})`
    case 'hook-sender':
      return `the hook-visible sender (${difference.before} → ${difference.after})`
    case 'swap-direction':
      return `the swap direction (zeroForOne ${difference.before} → ${difference.after})`
    case 'swap-mode':
      return `the swap mode (${difference.before} → ${difference.after})`
    case 'amount':
      return `the amount (${difference.before} → ${difference.after})`
    case 'hook-data':
      return 'the hookData payload'
  }
}

/**
 * States what changed when exactly one input was varied.
 *
 * The wording is bounded on purpose: "changing only X changed Y" is a claim
 * about the observed pair, not an assertion that X controls Y in general.
 */
export function describeControlledComparison(input: {
  difference: ControlledDifference
  behavior: BehaviorDifference
}): ControlledComparison {
  const { difference, behavior } = input
  const variable = describeVariable(difference)

  if (behavior.identical) {
    return {
      difference,
      behavior,
      summary: `Changing only ${variable} produced no observable difference in outcome, branch edges, persistent or transient storage, calls, charged fees, currency deltas, events, or balances.`,
    }
  }

  const moved: string[] = []
  if (behavior.outcomeChanged) moved.push(`the outcome (${behavior.outcomeBefore} → ${behavior.outcomeAfter})`)
  if (behavior.changedStorage.length) {
    const first = behavior.changedStorage[0]!
    moved.push(
      behavior.changedStorage.length === 1
        ? `storage slot ${first.slot} on ${first.address} (${first.before ?? 'unwritten'} → ${first.after ?? 'unwritten'})`
        : `${behavior.changedStorage.length} storage slots`,
    )
  }
  if (behavior.changedCallTargets.length) moved.push(`${behavior.changedCallTargets.length} external call target(s)`)
  if (behavior.changedDelegatecalls.length) moved.push(`${behavior.changedDelegatecalls.length} delegated call target(s)`)
  if (behavior.changedExternalSelectors.length) moved.push(`${behavior.changedExternalSelectors.length} external selector(s)`)
  if (behavior.changedBranchEdges.length) moved.push(`${behavior.changedBranchEdges.length} branch edge(s)`)
  if (behavior.changedTransientWrites.length) moved.push(`${behavior.changedTransientWrites.length} transient write(s)`)
  if (behavior.changedFees.length) moved.push(`${behavior.changedFees.length} charged fee value(s)`)
  if (behavior.changedCurrencyDeltas.length) moved.push(`${behavior.changedCurrencyDeltas.length} currency delta(s)`)
  if (behavior.changedEvents.length) moved.push(`${behavior.changedEvents.length} emitted event(s)`)
  if (behavior.changedBalanceMovement.length) moved.push(`${behavior.changedBalanceMovement.length} balance movement(s)`)
  if (!moved.length && behavior.returnDataChanged) moved.push('the returned data')

  return {
    difference,
    behavior,
    summary: `Changing only ${variable} changed ${moved.join(', ')}.`,
  }
}
