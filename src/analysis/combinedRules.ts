import type { Address, Hex } from 'viem'
import type { Evidence } from '../domain/report'

/**
 * Joins structural, source-level and concrete evidence into claims that no
 * single layer could justify alone.
 *
 * Each rule states its requirements and refuses to fire without them. That is
 * the whole design: the previous engine reported "delegated code path is
 * reachable" at high severity from the presence of one opcode, and a rule that
 * can fire on one weak signal will keep producing that class of finding no
 * matter how good the underlying layers get.
 *
 * The layers each answer a different question. Reachability says the graph
 * admits a path. A source dependency says a value flows somewhere consequential.
 * A controlled execution pair says behavior actually changed when exactly one
 * input changed. Requiring two of them before making a strong claim is what
 * keeps a presence signal from being promoted on its own.
 */

export type CombinedRuleInput = {
  subject: Address
  affectedPools: Hex[]
  /** Every finding produced by the earlier layers, in one list. */
  findings: Evidence[]
}

function technical(finding: Evidence): Record<string, unknown> {
  return (finding.technical ?? {}) as Record<string, unknown>
}

function byDetector(findings: Evidence[], detectorId: string) {
  return findings.filter((finding) => finding.detectorId === detectorId)
}

type SourceDependency = { sink?: string; sources?: string[]; function?: string; detail?: string }

function sourceDependencies(findings: Evidence[]): SourceDependency[] {
  return byDetector(findings, 'verified-source-dependency').flatMap((finding) => {
    const list = technical(finding).dependencies
    return Array.isArray(list) ? (list as SourceDependency[]) : []
  })
}

function dependencyReaching(dependencies: SourceDependency[], sinks: string[], sources: string[]) {
  return dependencies.filter(
    (dependency) =>
      sinks.includes(dependency.sink ?? '')
      && (dependency.sources ?? []).some((source) => sources.includes(source)),
  )
}

type BehaviorSummary = {
  identical?: boolean
  changedStorage?: { slot: Hex; before?: Hex; after?: Hex; address?: string }[]
  changedCallTargets?: string[]
  changedDelegatecalls?: {
    caller: string
    storageAddress: string
    beforeTarget: string
    afterTarget: string
    beforeFrameId: number
    afterFrameId: number
    selector?: Hex
    ordinal: number
    storageEffects: { slot: Hex; before?: Hex; after?: Hex; address?: string }[]
  }[]
  outcomeChanged?: boolean
}

function controlledPairs(findings: Evidence[], detectorId: string) {
  return byDetector(findings, detectorId)
    .map((finding) => ({ finding, behavior: technical(finding).behavior as BehaviorSummary | undefined }))
    .filter((entry): entry is { finding: Evidence; behavior: BehaviorSummary } => Boolean(entry.behavior))
}

function evidence(input: CombinedRuleInput, fields: {
  detectorId: string
  severity: Evidence['severity']
  title: string
  claim: string
  /**
   * Whether an executed observation backs this finding.
   *
   * A rule that fired on verified source alone has not replayed anything, and
   * labelling it `concrete-observation` / `replayed` would claim an execution
   * that never happened. Source-only findings are classed as static reachability
   * and marked not-applicable instead.
   */
  executed: boolean
  storage?: Evidence['storage']
  technical: Record<string, unknown>
}): Evidence {
  return {
    id: `combined:${fields.detectorId}:${input.subject.slice(2, 10)}`,
    detectorId: fields.detectorId,
    detectorVersion: '0.4.0',
    severity: fields.severity,
    evidenceClass: fields.executed ? 'concrete-observation' : 'static-reachability',
    subject: input.subject,
    title: fields.title,
    claim: fields.claim,
    confidence: fields.executed ? 'confirmed' : 'supported',
    affectedPools: input.affectedPools,
    storage: fields.storage,
    reproducibility: fields.executed ? 'replayed' : 'not-applicable',
    technical: {
      ...fields.technical,
      rule: 'combined-static-and-concrete',
      evidenceBasis: fields.executed ? 'executed-and-static' : 'verified-source-only',
    },
  }
}

/**
 * Caller-dependent state, which needs real evidence of dependence.
 *
 * Co-presence of `CALLER` and `SSTORE` is explicitly not enough, and is not
 * consulted here. Either a verified-source dependency shows a caller-derived
 * value reaching an assignment, or a controlled pair shows the storage outcome
 * changing when only the caller changed.
 */
function callerDependentStorage(input: CombinedRuleInput): Evidence | undefined {
  const all = sourceDependencies(input.findings)
  // A caller-derived value reaching a state assignment is the claim. A condition
  // alone is not: a `require(msg.sender == owner)` in a function that writes
  // nothing guards nothing, and counting it would report caller-dependent
  // storage for a contract that has none.
  const assignments = dependencyReaching(all, ['state-assignment'], ['msg.sender', 'tx.origin'])
  // This sink is emitted only when the AST pass proved lexical control (an
  // enclosing if branch or a preceding require/assert in the same block). Merely
  // sharing a function with a caller-dependent condition is not enough.
  const guardedAssignments = dependencyReaching(all, ['guarded-state-assignment'], ['msg.sender', 'tx.origin'])
  const dependencies = [...assignments, ...guardedAssignments]
  const concrete = [
    ...controlledPairs(input.findings, 'concrete-transaction-caller-dependence'),
    ...controlledPairs(input.findings, 'concrete-hook-sender-dependence'),
  ].filter((entry) => !entry.behavior.identical && (entry.behavior.changedStorage?.length ?? 0) > 0)

  if (!dependencies.length && !concrete.length) return undefined

  const changed = concrete[0]?.behavior.changedStorage ?? []
  const basis = [
    assignments.length ? 'a verified-source dependency from a caller-derived value to a state assignment' : undefined,
    guardedAssignments.length ? 'a caller-derived condition proven to guard a state assignment' : undefined,
    concrete.length ? 'a controlled execution pair in which changing only the caller changed a storage write' : undefined,
  ].filter(Boolean)

  return evidence(input, {
    detectorId: 'caller-dependent-storage',
    executed: concrete.length > 0,
    severity: concrete.length ? 'medium' : 'low',
    title: 'Persistent state depends on the caller',
    claim: `Caller-dependent state was established by ${basis.join(' and ')}. Opcode co-presence alone was not treated as evidence.`,
    storage: changed.slice(0, 8).map((diff) => ({ slot: diff.slot, before: diff.before, after: diff.after })),
    technical: {
      basis: {
        stateAssignments: assignments.length,
        guardedWrites: guardedAssignments.length,
        controlledPairs: concrete.length,
      },
      dependencies: dependencies.slice(0, 16),
      changedStorage: changed.slice(0, 16),
    },
  })
}

/**
 * Delegated execution that something can actually steer.
 *
 * Four requirements, all of which must hold. Reachability alone was the old
 * high-severity finding and is deliberately insufficient here.
 */
function controllableDelegatecall(input: CombinedRuleInput): Evidence | undefined {
  const reachable = byDetector(input.findings, 'cfg-reachable-delegatecall')
  if (!reachable.length) return undefined

  const pairs = [
    ...controlledPairs(input.findings, 'concrete-transaction-caller-dependence'),
    ...controlledPairs(input.findings, 'concrete-hook-sender-dependence'),
  ]

  // All strong requirements must survive in one controlled pair. The comparator
  // identifies matching delegated frames and only attributes a surviving state
  // difference when the final write on each side carries that exact frame ID.
  const correlated = pairs.flatMap((entry) => {
    return (entry.behavior.changedDelegatecalls ?? []).flatMap((delegatecall) => {
      if (delegatecall.storageAddress.toLowerCase() !== input.subject.toLowerCase()) return []
      const effects = delegatecall.storageEffects ?? []
      return effects.length ? [{ entry, delegatecall, effects }] : []
    })
  })
  if (!correlated.length) return undefined

  // Source data flow is supporting detail, never a substitute for the correlated
  // controlled execution required by this high-severity rule.
  const targetFromSource = dependencyReaching(
    sourceDependencies(input.findings),
    ['call-target'],
    ['msg.sender', 'tx.origin', 'parameter'],
  )
  const delegated = correlated.map((item) => item.delegatecall)
  const storageChanges = correlated.flatMap((item) => item.effects)

  return evidence(input, {
    detectorId: 'controllable-delegatecall',
    // Always execution-backed: an executed delegated call is a requirement.
    executed: true,
    severity: 'high',
    title: 'Delegated execution is reachable and its target is influenceable',
    claim: `DELEGATECALL is reachable in the control-flow graph. In ${correlated.length} controlled comparison${correlated.length === 1 ? '' : 's'}, matching delegated frames changed implementation when one input changed and ${storageChanges.length} surviving storage change${storageChanges.length === 1 ? '' : 's'} was last written by those exact frames. Reachability, an unrelated changed call target, or an unrelated write were each insufficient for this claim.`,
    storage: storageChanges.slice(0, 8).map((diff) => ({ slot: diff.slot, before: diff.before, after: diff.after })),
    technical: {
      requirements: {
        cfgReachable: true,
        targetInfluenceable: true,
        delegatecallsExecuted: delegated.length,
        storageChangesRecorded: storageChanges.length,
        correlatedPairs: correlated.length,
      },
      changedDelegatecalls: delegated.slice(0, 8),
      targetDependencies: targetFromSource.slice(0, 8),
    },
  })
}

/**
 * Origin-based authorization, which requires the origin to feed something.
 *
 * A raw `ORIGIN` read stays informational wherever it is produced; this rule
 * only fires once the value is shown to reach a decision.
 */
function originAuthorization(input: CombinedRuleInput): Evidence | undefined {
  const present = byDetector(input.findings, 'origin-opcode-present')
  if (!present.length) return undefined

  const feeds = dependencyReaching(
    sourceDependencies(input.findings),
    ['condition', 'state-assignment', 'call-target', 'call-value', 'return-value'],
    ['tx.origin'],
  )
  if (!feeds.length) return undefined

  return evidence(input, {
    detectorId: 'origin-based-authorization',
    // Established from verified source, so it is not a replayed observation.
    executed: false,
    severity: 'medium',
    title: 'Transaction origin reaches an authorization decision',
    claim: `The contract reads ORIGIN and a verified-source dependency shows that value reaching ${
      [...new Set(feeds.map((dependency) => dependency.sink))].join(', ')
    }. A hook that authorizes on tx.origin behaves differently when a swap is routed through another contract. A raw ORIGIN read on its own remains informational.`,
    technical: { sinks: feeds.slice(0, 16) },
  })
}

/**
 * Runs every combined rule.
 *
 * Returns only the rules whose requirements were met, so an empty result means
 * the evidence did not support any joined claim — not that nothing was checked.
 */
export function combinedFindings(input: CombinedRuleInput): Evidence[] {
  return [
    callerDependentStorage(input),
    controllableDelegatecall(input),
    originAuthorization(input),
  ].filter((finding): finding is Evidence => Boolean(finding))
}
