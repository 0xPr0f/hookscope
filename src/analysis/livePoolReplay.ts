import type { Address, Hex, PublicClient } from 'viem'
import { runForkReplay, type ForkReplayResult } from './revmProof'
import type { Evidence, PoolDescriptor, PoolReplayKind, PoolReplayReference } from '../domain/report'
import { loadPoolReplayCandidate, replayReferencesForPool, type PoolReplayCandidate } from '../data/replay'

export type PoolReplayOutcome = {
  poolId: Hex
  hook: Address
  kind?: PoolReplayKind
  transactionHash?: Hex
  status: 'passed' | 'unavailable' | 'failed'
  reason?: string
  candidate?: PoolReplayCandidate
  replay?: ForkReplayResult
}

export type LivePoolReplayCoverage = {
  status: 'passed' | 'degraded'
  selectedPools: number
  candidateTransactions: number
  passedTransactions: number
  failedTransactions: number
  coveredPools: number
  outcomes: PoolReplayOutcome[]
  findings: Evidence[]
  hydrationRequests: number
  limitations: string[]
}

type CandidateLoader = typeof loadPoolReplayCandidate
type ForkReplayer = typeof runForkReplay

function expectedReceiptMismatches(replay: ForkReplayResult, candidate: PoolReplayCandidate) {
  const mismatches: string[] = []
  if (replay.proof.success !== candidate.expected.success) mismatches.push('transaction outcome')
  if (replay.proof.logCount !== candidate.expected.logCount) mismatches.push('log count')
  if (BigInt(replay.proof.gasUsed) !== candidate.expected.gasUsed) mismatches.push('gas used')
  return mismatches
}

export function assertReplayMatchesReceipt(replay: ForkReplayResult, candidate: PoolReplayCandidate) {
  const mismatches = expectedReceiptMismatches(replay, candidate)
  if (mismatches.length) throw new Error(`revm replay did not match the chain receipt: ${mismatches.join(', ')}.`)
}

function replayEvidence(outcome: PoolReplayOutcome): Evidence | undefined {
  const { candidate, replay } = outcome
  if (!candidate || !replay) return
  const firstStorage = replay.proof.storageDiffs[0]
  return {
    id: `revm-pool-replay:${candidate.kind}:${candidate.transactionHash}`,
    detectorId: 'revm-pool-replay',
    detectorVersion: '0.2.0',
    severity: 'info',
    evidenceClass: 'concrete-observation',
    subject: candidate.transaction.to,
    title: `${candidate.kind.replace('-', ' ')} transaction reproduced in revm`,
    claim: `The historical transaction reproduced its ${replay.proof.success ? 'successful' : 'reverted'} outcome, ${replay.proof.logCount} logs, and ${replay.proof.gasUsed} gas after ${replay.hydrationRequests} pinned-state reads.`,
    confidence: 'confirmed',
    storage: firstStorage ? [{ slot: firstStorage.slot, before: firstStorage.before, after: firstStorage.after }] : undefined,
    affectedPools: [candidate.poolId],
    witness: {
      from: candidate.transaction.caller,
      to: candidate.transaction.to,
      input: candidate.transaction.calldata,
      value: candidate.transaction.value.toString(),
      blockNumber: candidate.block.number.toString(),
      expectedOutcome: candidate.expected.success ? 'success' : 'revert',
    },
    reproducibility: 'replayed',
    technical: {
      eventKind: candidate.kind,
      transactionHash: candidate.transactionHash,
      stateBlockNumber: candidate.stateBlockNumber.toString(),
      engine: replay.proof.engine,
      hydrationRequests: replay.hydrationRequests,
      hydratedAccounts: replay.hydratedAccounts,
      hydratedStorageSlots: replay.hydratedStorageSlots,
      calls: replay.proof.calls,
      storageOperations: replay.proof.storageOperations,
    },
  }
}

function coverageFromOutcomes(pools: PoolDescriptor[], candidateCount: number, outcomes: PoolReplayOutcome[]): LivePoolReplayCoverage {
  const passed = outcomes.filter((outcome) => outcome.status === 'passed')
  const failed = outcomes.filter((outcome) => outcome.status === 'failed')
  const coveredPoolIds = new Set(passed.map((outcome) => outcome.poolId.toLowerCase()))
  const unavailablePoolCount = pools.length - coveredPoolIds.size
  const limitations = [
    unavailablePoolCount > 0
      ? `${unavailablePoolCount} selected pool${unavailablePoolCount === 1 ? ' has' : 's have'} no receipt-matched historical replay at the pinned context.`
      : undefined,
    failed.length > 0
      ? `${failed.length} indexed replay transaction${failed.length === 1 ? ' did' : 's did'} not complete receipt-matched browser execution.`
      : undefined,
  ].filter((item): item is string => Boolean(item))
  const status = pools.length > 0 && coveredPoolIds.size === pools.length && failed.length === 0 ? 'passed' : 'degraded'
  return {
    status,
    selectedPools: pools.length,
    candidateTransactions: candidateCount,
    passedTransactions: passed.length,
    failedTransactions: failed.length,
    coveredPools: coveredPoolIds.size,
    outcomes,
    findings: passed.flatMap((outcome) => {
      const finding = replayEvidence(outcome)
      return finding ? [finding] : []
    }),
    hydrationRequests: passed.reduce((total, outcome) => total + (outcome.replay?.hydrationRequests ?? 0), 0),
    limitations,
  }
}

export async function runLivePoolReplays(input: {
  scanId: string
  client: PublicClient
  chainId: number
  poolManager: Address
  pinnedBlockNumber: bigint
  pools: PoolDescriptor[]
  signal: AbortSignal
  concurrency?: number
  timeoutMs?: number
  maxHydrationRequests?: number
  loadCandidate?: CandidateLoader
  replay?: ForkReplayer
  onProgress?: (completed: number, total: number, detail: string) => void
}): Promise<LivePoolReplayCoverage> {
  const loadCandidate = input.loadCandidate ?? loadPoolReplayCandidate
  const replay = input.replay ?? runForkReplay
  const outcomes: PoolReplayOutcome[] = []
  const tasks: { pool: PoolDescriptor; reference: PoolReplayReference; index: number }[] = []

  for (const pool of input.pools) {
    const references = replayReferencesForPool(pool)
      .filter((reference) => BigInt(reference.blockNumber) <= input.pinnedBlockNumber)
      .slice(0, 4)
    if (!references.length) {
      outcomes.push({ poolId: pool.poolId, hook: pool.hook, status: 'unavailable', reason: 'No pinned historical transaction reference is available.' })
      continue
    }
    for (const reference of references) tasks.push({ pool, reference, index: tasks.length })
  }

  let cursor = 0
  let completed = outcomes.length
  const total = outcomes.length + tasks.length
  input.onProgress?.(completed, total, total ? 'Preparing indexed replay candidates' : 'No pools require historical replay')

  const worker = async () => {
    while (cursor < tasks.length) {
      if (input.signal.aborted) throw new DOMException('Live pool replay cancelled', 'AbortError')
      const task = tasks[cursor]
      cursor += 1
      if (!task) continue
      try {
        const candidate = await loadCandidate(input.client, input.chainId, input.poolManager, task.pool, task.reference)
        const result = await replay({
          scanId: `${input.scanId}-pool-replay-${task.index}`,
          client: input.client,
          stateBlockNumber: candidate.stateBlockNumber,
          transaction: candidate.transaction,
          block: candidate.block,
          signal: input.signal,
          timeoutMs: input.timeoutMs ?? 30_000,
          maxHydrationRequests: input.maxHydrationRequests ?? 2_048,
          onHydration: (count, request) => input.onProgress?.(
            completed,
            total,
            `${task.reference.kind} · pinned-state read ${count} · ${request.kind}`,
          ),
        })
        assertReplayMatchesReceipt(result, candidate)
        outcomes.push({
          poolId: task.pool.poolId,
          hook: task.pool.hook,
          kind: task.reference.kind,
          transactionHash: task.reference.transactionHash,
          status: 'passed',
          candidate,
          replay: result,
        })
      } catch (error) {
        if (input.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
        outcomes.push({
          poolId: task.pool.poolId,
          hook: task.pool.hook,
          kind: task.reference.kind,
          transactionHash: task.reference.transactionHash,
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        })
      } finally {
        completed += 1
        input.onProgress?.(completed, total, `${completed} of ${total} historical contexts checked`)
      }
    }
  }

  const concurrency = Math.min(2, Math.max(1, input.concurrency ?? 2), tasks.length || 1)
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  outcomes.sort((left, right) => {
    const poolOrder = left.poolId.localeCompare(right.poolId)
    if (poolOrder !== 0) return poolOrder
    return (left.kind ?? '').localeCompare(right.kind ?? '')
  })
  return coverageFromOutcomes(input.pools, tasks.length, outcomes)
}
