import type { Hex } from 'viem'
import type { RevmBalanceChange, RevmExecutionProof, RevmLogEvidence } from './revmProof'

/**
 * Report-ready normalization of one execution's observations.
 *
 * revm reports raw events; this collapses them into the facts an evidence
 * consumer can act on without re-deriving them from instruction traces.
 */
export type ExecutionObservations = {
  logs: RevmLogEvidence[]
  /** Distinct event signatures observed, in first-seen order. */
  eventSignatures: Hex[]
  balanceChanges: RevmBalanceChange[]
  /** Net native movement per address, as decimal strings. */
  netValueMovement: { address: string; delta: string }[]
  transientWrites: { address: string; slot: Hex; value: Hex }[]
  transientReads: { address: string; slot: Hex }[]
  /** Distinct four-byte selectors invoked on external targets, in first-seen order. */
  externalSelectors: Hex[]
  persistentWrites: number
}

const TRANSIENT_WRITE = 'TSTORE'
const TRANSIENT_READ = 'TLOAD'
const PERSISTENT_WRITE = 'SSTORE'

function distinct<T>(values: (T | undefined)[]): T[] {
  const seen = new Set<string>()
  const kept: T[] = []
  for (const value of values) {
    if (value === undefined) continue
    const identity = String(value).toLowerCase()
    if (seen.has(identity)) continue
    seen.add(identity)
    kept.push(value)
  }
  return kept
}

export function summarizeExecutionObservations(proof: RevmExecutionProof): ExecutionObservations {
  const transientWrites: ExecutionObservations['transientWrites'] = []
  const transientReads: ExecutionObservations['transientReads'] = []
  let persistentWrites = 0
  for (const access of proof.storageOperations) {
    const storageAddress = access.storageAddress ?? access.address
    if (access.opcode === PERSISTENT_WRITE) persistentWrites += 1
    if (access.slot === undefined) continue
    if (access.opcode === TRANSIENT_WRITE && access.value !== undefined) {
      transientWrites.push({ address: storageAddress, slot: access.slot, value: access.value })
    }
    if (access.opcode === TRANSIENT_READ) {
      transientReads.push({ address: storageAddress, slot: access.slot })
    }
  }

  return {
    logs: proof.logs,
    eventSignatures: distinct(proof.logs.map((log) => log.topics[0])),
    balanceChanges: proof.balanceChanges,
    netValueMovement: proof.balanceChanges.map((change) => ({
      address: change.address,
      delta: (BigInt(change.after) - BigInt(change.before)).toString(),
    })),
    transientWrites,
    transientReads,
    externalSelectors: distinct(proof.calls.map((call) => call.selector)),
    persistentWrites,
  }
}

/** One report-ready sentence, or undefined when nothing beyond instructions was observed. */
export function observationSummary(observations: ExecutionObservations): string | undefined {
  const parts = [
    observations.logs.length ? `${observations.logs.length} log${observations.logs.length === 1 ? '' : 's'} across ${observations.eventSignatures.length} event signature${observations.eventSignatures.length === 1 ? '' : 's'}` : undefined,
    observations.balanceChanges.length ? `${observations.balanceChanges.length} native balance change${observations.balanceChanges.length === 1 ? '' : 's'}` : undefined,
    observations.persistentWrites ? `${observations.persistentWrites} persistent storage write${observations.persistentWrites === 1 ? '' : 's'}` : undefined,
    observations.transientWrites.length ? `${observations.transientWrites.length} transient storage write${observations.transientWrites.length === 1 ? '' : 's'}` : undefined,
    observations.externalSelectors.length ? `${observations.externalSelectors.length} distinct external selector${observations.externalSelectors.length === 1 ? '' : 's'}` : undefined,
  ].filter((part): part is string => Boolean(part))
  return parts.length ? parts.join(' · ') : undefined
}
