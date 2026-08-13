import { autoload, providers } from '@shazow/whatsabi'
import { getAddress, isHex, keccak256, type Address, type Hex, type PublicClient } from 'viem'
import { runForkReplay, type ForkReplayResult } from '../analysis/revmProof'
import type { ChainConfig } from '../config/chains'
import type {
  AnalysisReport,
  ContractNode,
  PoolDescriptor,
  PoolReplayKind,
  PoolReplayReference,
  ReplayWitness,
} from '../domain/report'
import { pinBlock } from './loadScan'
import {
  loadPoolReplayCandidate,
  replayReferencesForPool,
  type PoolReplayCandidate,
} from './replay'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const RUNTIME_ROLES = ['token', 'hook', 'implementation'] as const
const REPLAY_KINDS = new Set<PoolReplayKind>(['initialize', 'swap', 'modify-liquidity', 'donate'])
const TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/

export type ReportCurrentnessStatus = 'current' | 'stale' | 'unavailable'
export type RuntimeRole = (typeof RUNTIME_ROLES)[number]

export type ReportRuntimeContractExpectation = {
  address: Address
  roles: RuntimeRole[]
  expectedCodeHashes: Hex[]
}

export type ReportProxyExpectation = {
  proxyAddress: Address
  expectedImplementations: Address[]
}

export type ReportRuntimeExpectations = {
  contracts: ReportRuntimeContractExpectation[]
  proxies: ReportProxyExpectation[]
}

export type RuntimeCodeObservation =
  | { address: Address; status: 'available'; codeHash: Hex }
  | { address: Address; status: 'unavailable'; reason: string }

export type ProxyImplementationObservation =
  | { proxyAddress: Address; status: 'available'; implementation: Address }
  | { proxyAddress: Address; status: 'unavailable'; reason: string }

export type ReportBlockObservation =
  | { status: 'available'; number: bigint; hash: Hex }
  | { status: 'unavailable'; reason: string }

export type ReportRuntimeSnapshot = {
  status: 'available'
  currentBlock: { number: bigint; hash: Hex; policy: string }
  reportBlock: ReportBlockObservation
  contracts: RuntimeCodeObservation[]
  proxies: ProxyImplementationObservation[]
}

export type UnavailableRuntimeSnapshot = { status: 'unavailable'; reason: string }
export type ReportRuntimeSnapshotResult = ReportRuntimeSnapshot | UnavailableRuntimeSnapshot

export type RuntimeContractCheck = ReportRuntimeContractExpectation & {
  status: ReportCurrentnessStatus
  currentCodeHash?: Hex
  reason?: string
}

export type RuntimeProxyCheck = ReportProxyExpectation & {
  status: ReportCurrentnessStatus
  currentImplementation?: Address
  reason?: string
}

export type ReportBlockCheck = {
  status: ReportCurrentnessStatus
  expectedNumber: string
  expectedHash: Hex
  currentHash?: Hex
  reason?: string
}

export type ReportRuntimeCurrentness = {
  status: ReportCurrentnessStatus
  checkedAtBlockNumber?: string
  checkedAtBlockHash?: Hex
  blockTagPolicy?: string
  reportBlock: ReportBlockCheck
  contracts: RuntimeContractCheck[]
  proxies: RuntimeProxyCheck[]
  reason?: string
}

export type PositiveBehaviorSample = {
  findingId: string
  witness: ReplayWitness
  pool: PoolDescriptor
  reference: PoolReplayReference
  mode: 'historical-transaction' | 'historical-fork-call'
  historicalRouter?: Address
  recordedGasUsed?: number
}

export type BehaviorSampleOutcome = {
  findingId: string
  transactionHash: Hex
  status: 'matched' | 'changed' | 'unavailable'
  reason?: string
  replay?: ForkReplayResult
}

export type BehaviorSampleReplay = {
  status: 'matched' | 'changed' | 'unavailable'
  selectedSamples: number
  matchedSamples: number
  changedSamples: number
  unavailableSamples: number
  outcomes: BehaviorSampleOutcome[]
  reason?: string
}

export type CompletedReportCurrentness = {
  reportId: string
  status: ReportCurrentnessStatus
  runtime: ReportRuntimeCurrentness
  behavior: BehaviorSampleReplay
  reason?: string
}

type ImplementationResolver = (input: {
  client: PublicClient
  address: Address
  blockNumber: bigint
}) => Promise<Address>

type RuntimeSnapshotFetcher = typeof fetchReportRuntimeSnapshot
type BehaviorCandidateLoader = typeof loadPositiveBehaviorCandidate
type BehaviorReplayer = typeof runForkReplay

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function isAbort(error: unknown, signal?: AbortSignal) {
  return signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Report currentness check cancelled', 'AbortError')
}

function parseBlockNumber(value: string): bigint | undefined {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return
  try {
    return BigInt(value)
  } catch {
    return
  }
}

function sameAddress(left: Address, right: Address) {
  return left.toLowerCase() === right.toLowerCase()
}

function sameHex(left: Hex, right: Hex) {
  return left.toLowerCase() === right.toLowerCase()
}

function uniqueAddresses(addresses: Address[]) {
  const unique = new Map<string, Address>()
  for (const address of addresses) unique.set(address.toLowerCase(), address)
  return [...unique.values()].sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()))
}

function uniqueHashes(hashes: Hex[]) {
  const unique = new Map<string, Hex>()
  for (const hash of hashes) unique.set(hash.toLowerCase(), hash)
  return [...unique.values()].sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()))
}

function roleIsRuntime(role: ContractNode['role']): role is RuntimeRole {
  return (RUNTIME_ROLES as readonly string[]).includes(role)
}

/**
 * Builds the exact runtime identities that a saved report must still own.
 * Missing graph entries remain as empty-hash expectations so they cannot pass.
 */
export function reportRuntimeExpectations(report: AnalysisReport): ReportRuntimeExpectations {
  const contracts = new Map<string, { address: Address; roles: Set<RuntimeRole>; hashes: Hex[] }>()
  const proxies = new Map<string, { proxyAddress: Address; implementations: Address[] }>()
  const addContract = (address: Address, role: RuntimeRole, codeHash?: Hex, includeZero = false) => {
    if (!includeZero && address.toLowerCase() === ZERO_ADDRESS) return
    const key = address.toLowerCase()
    const current = contracts.get(key) ?? { address, roles: new Set<RuntimeRole>(), hashes: [] }
    current.roles.add(role)
    if (codeHash) current.hashes.push(codeHash)
    contracts.set(key, current)
  }

  addContract(report.token, 'token', undefined, true)
  for (const pool of report.pools) addContract(pool.hook, 'hook')
  for (const node of report.contractGraph) {
    if (!roleIsRuntime(node.role)) continue
    addContract(node.address, node.role, node.codeHash, node.role === 'token')
    if (!node.implementation) continue
    addContract(node.implementation, 'implementation')
    const key = node.address.toLowerCase()
    const current = proxies.get(key) ?? { proxyAddress: node.address, implementations: [] }
    current.implementations.push(node.implementation)
    proxies.set(key, current)
  }

  return {
    contracts: [...contracts.values()]
      .map((item) => ({
        address: item.address,
        roles: RUNTIME_ROLES.filter((role) => item.roles.has(role)),
        expectedCodeHashes: uniqueHashes(item.hashes),
      }))
      .sort((left, right) => left.address.toLowerCase().localeCompare(right.address.toLowerCase())),
    proxies: [...proxies.values()]
      .map((item) => ({
        proxyAddress: item.proxyAddress,
        expectedImplementations: uniqueAddresses(item.implementations),
      }))
      .sort((left, right) => left.proxyAddress.toLowerCase().localeCompare(right.proxyAddress.toLowerCase())),
  }
}

function whatsabiProvider(client: PublicClient, blockNumber: bigint) {
  return providers.CompatibleProvider({
    getCode: (address: string) => client.getCode({ address: getAddress(address), blockNumber }),
    getStorageAt: (address: string, slot: string | number) => client.getStorageAt({
      address: getAddress(address),
      slot: (typeof slot === 'number' ? `0x${slot.toString(16)}` : slot) as Hex,
      blockNumber,
    }),
    call: async ({ to, data }: { to: string; data: string }) =>
      (await client.call({ to: getAddress(to), data: data as Hex, blockNumber })).data ?? '0x',
    getAddress: async () => {
      throw new Error('ENS resolution is disabled during report currentness checks.')
    },
  })
}

async function resolveImplementationAtBlock(input: {
  client: PublicClient
  address: Address
  blockNumber: bigint
}): Promise<Address> {
  const result = await autoload(input.address, {
    provider: whatsabiProvider(input.client, input.blockNumber),
    abiLoader: false,
    signatureLookup: false,
    followProxies: true,
    onError: () => false,
  })
  return getAddress(result.address)
}

/** Source fetcher for one runtime code identity at a caller-owned block. */
export async function fetchRuntimeCodeObservation(input: {
  client: PublicClient
  address: Address
  blockNumber: bigint
  signal?: AbortSignal
}): Promise<RuntimeCodeObservation> {
  try {
    assertNotAborted(input.signal)
    const code = (await input.client.getCode({ address: input.address, blockNumber: input.blockNumber })) ?? '0x'
    assertNotAborted(input.signal)
    return { address: input.address, status: 'available', codeHash: keccak256(code) }
  } catch (error) {
    if (isAbort(error, input.signal)) throw error
    return { address: input.address, status: 'unavailable', reason: errorMessage(error) }
  }
}

/** Source fetcher for one proxy implementation identity at a caller-owned block. */
export async function fetchProxyImplementationObservation(input: {
  client: PublicClient
  proxyAddress: Address
  blockNumber: bigint
  signal?: AbortSignal
  resolveImplementation?: ImplementationResolver
}): Promise<ProxyImplementationObservation> {
  try {
    assertNotAborted(input.signal)
    const implementation = await (input.resolveImplementation ?? resolveImplementationAtBlock)({
      client: input.client,
      address: input.proxyAddress,
      blockNumber: input.blockNumber,
    })
    assertNotAborted(input.signal)
    return { proxyAddress: input.proxyAddress, status: 'available', implementation }
  } catch (error) {
    if (isAbort(error, input.signal)) throw error
    return { proxyAddress: input.proxyAddress, status: 'unavailable', reason: errorMessage(error) }
  }
}

/** Source fetcher for the canonical identity of the block saved in a report. */
export async function fetchSavedReportBlockObservation(input: {
  client: PublicClient
  blockNumber: bigint
  signal?: AbortSignal
}): Promise<ReportBlockObservation> {
  try {
    assertNotAborted(input.signal)
    const block = await input.client.getBlock({ blockNumber: input.blockNumber })
    assertNotAborted(input.signal)
    return block.hash
      ? { status: 'available', number: block.number, hash: block.hash }
      : { status: 'unavailable', reason: 'RPC returned the saved report block without a hash.' }
  } catch (error) {
    if (isAbort(error, input.signal)) throw error
    return { status: 'unavailable', reason: errorMessage(error) }
  }
}

/** Reads every runtime identity at one current pinned block. */
export async function fetchReportRuntimeSnapshot(input: {
  client: PublicClient
  chain: ChainConfig
  report: AnalysisReport
  expectations: ReportRuntimeExpectations
  signal?: AbortSignal
  resolveImplementation?: ImplementationResolver
}): Promise<ReportRuntimeSnapshot> {
  assertNotAborted(input.signal)
  const reportBlockNumber = parseBlockNumber(input.report.blockNumber)
  if (reportBlockNumber === undefined) throw new Error('The saved report block number is not a public-chain block number.')

  const reportBlockPromise = fetchSavedReportBlockObservation({
    client: input.client,
    blockNumber: reportBlockNumber,
    signal: input.signal,
  })
  const [currentBlock, reportBlock] = await Promise.all([
    pinBlock(input.client, input.chain),
    reportBlockPromise,
  ])
  assertNotAborted(input.signal)

  const [contracts, proxies] = await Promise.all([
    Promise.all(input.expectations.contracts.map((expectation) => fetchRuntimeCodeObservation({
      client: input.client,
      address: expectation.address,
      blockNumber: currentBlock.number,
      signal: input.signal,
    }))),
    Promise.all(input.expectations.proxies.map((expectation) => fetchProxyImplementationObservation({
      client: input.client,
      proxyAddress: expectation.proxyAddress,
      blockNumber: currentBlock.number,
      signal: input.signal,
      resolveImplementation: input.resolveImplementation,
    }))),
  ])
  assertNotAborted(input.signal)
  const confirmedCurrentBlock = await input.client.getBlock({ blockNumber: currentBlock.number })
  assertNotAborted(input.signal)
  if (!confirmedCurrentBlock.hash || !sameHex(confirmedCurrentBlock.hash, currentBlock.hash)) {
    throw new Error('The current pinned block changed while runtime identities were being read.')
  }
  return { status: 'available', currentBlock, reportBlock, contracts, proxies }
}

function aggregateCurrentness(statuses: ReportCurrentnessStatus[]): ReportCurrentnessStatus {
  if (statuses.includes('stale')) return 'stale'
  if (statuses.includes('unavailable')) return 'unavailable'
  return 'current'
}

/** Maps RPC observations into report semantics without performing IO. */
export function mapReportRuntimeCurrentness(input: {
  report: AnalysisReport
  expectations: ReportRuntimeExpectations
  snapshot: ReportRuntimeSnapshotResult
}): ReportRuntimeCurrentness {
  const expectedReportBlock = parseBlockNumber(input.report.blockNumber)
  if (input.snapshot.status === 'unavailable') {
    const reason = input.snapshot.reason
    return {
      status: 'unavailable',
      reportBlock: {
        status: 'unavailable',
        expectedNumber: input.report.blockNumber,
        expectedHash: input.report.blockHash,
        reason,
      },
      contracts: input.expectations.contracts.map((expectation) => ({ ...expectation, status: 'unavailable', reason })),
      proxies: input.expectations.proxies.map((expectation) => ({ ...expectation, status: 'unavailable', reason })),
      reason,
    }
  }

  let reportBlock: ReportBlockCheck
  if (expectedReportBlock === undefined) {
    reportBlock = {
      status: 'unavailable',
      expectedNumber: input.report.blockNumber,
      expectedHash: input.report.blockHash,
      reason: 'The saved report block number is not a public-chain block number.',
    }
  } else if (input.snapshot.currentBlock.number < expectedReportBlock) {
    reportBlock = {
      status: 'unavailable',
      expectedNumber: input.report.blockNumber,
      expectedHash: input.report.blockHash,
      reason: `The current pinned block ${input.snapshot.currentBlock.number} is behind saved block ${expectedReportBlock}.`,
    }
  } else if (input.snapshot.reportBlock.status === 'unavailable') {
    reportBlock = {
      status: 'unavailable',
      expectedNumber: input.report.blockNumber,
      expectedHash: input.report.blockHash,
      reason: input.snapshot.reportBlock.reason,
    }
  } else if (input.snapshot.reportBlock.number !== expectedReportBlock || !sameHex(input.snapshot.reportBlock.hash, input.report.blockHash)) {
    reportBlock = {
      status: 'stale',
      expectedNumber: input.report.blockNumber,
      expectedHash: input.report.blockHash,
      currentHash: input.snapshot.reportBlock.hash,
      reason: 'The saved block hash no longer matches the canonical chain block.',
    }
  } else {
    reportBlock = {
      status: 'current',
      expectedNumber: input.report.blockNumber,
      expectedHash: input.report.blockHash,
      currentHash: input.snapshot.reportBlock.hash,
    }
  }

  const codeByAddress = new Map(input.snapshot.contracts.map((item) => [item.address.toLowerCase(), item]))
  const contracts: RuntimeContractCheck[] = input.expectations.contracts.map((expectation) => {
    if (expectation.expectedCodeHashes.length !== 1) {
      return {
        ...expectation,
        status: 'unavailable',
        reason: expectation.expectedCodeHashes.length === 0
          ? 'The saved report has no runtime codehash for this required identity.'
          : 'The saved report has multiple runtime codehashes for one coherent identity.',
      }
    }
    const observation = codeByAddress.get(expectation.address.toLowerCase())
    if (!observation || observation.status === 'unavailable') {
      return {
        ...expectation,
        status: 'unavailable',
        reason: observation?.reason ?? 'No current runtime code observation was returned.',
      }
    }
    const expected = expectation.expectedCodeHashes[0]!
    return sameHex(expected, observation.codeHash)
      ? { ...expectation, status: 'current', currentCodeHash: observation.codeHash }
      : {
          ...expectation,
          status: 'stale',
          currentCodeHash: observation.codeHash,
          reason: 'The current runtime codehash differs from the saved report.',
        }
  })

  const implementationByProxy = new Map(input.snapshot.proxies.map((item) => [item.proxyAddress.toLowerCase(), item]))
  const proxies: RuntimeProxyCheck[] = input.expectations.proxies.map((expectation) => {
    if (expectation.expectedImplementations.length !== 1) {
      return {
        ...expectation,
        status: 'unavailable',
        reason: 'The saved report does not identify exactly one implementation for this proxy.',
      }
    }
    const observation = implementationByProxy.get(expectation.proxyAddress.toLowerCase())
    if (!observation || observation.status === 'unavailable') {
      return {
        ...expectation,
        status: 'unavailable',
        reason: observation?.reason ?? 'No current implementation observation was returned.',
      }
    }
    const expected = expectation.expectedImplementations[0]!
    return sameAddress(expected, observation.implementation)
      ? { ...expectation, status: 'current', currentImplementation: observation.implementation }
      : {
          ...expectation,
          status: 'stale',
          currentImplementation: observation.implementation,
          reason: 'The proxy now resolves to a different implementation.',
        }
  })

  const status = aggregateCurrentness([
    reportBlock.status,
    ...contracts.map((item) => item.status),
    ...proxies.map((item) => item.status),
  ])
  const firstProblem = [reportBlock, ...contracts, ...proxies].find((item) => item.status === status)
  return {
    status,
    checkedAtBlockNumber: input.snapshot.currentBlock.number.toString(),
    checkedAtBlockHash: input.snapshot.currentBlock.hash,
    blockTagPolicy: input.snapshot.currentBlock.policy,
    reportBlock,
    contracts,
    proxies,
    reason: firstProblem?.reason,
  }
}

function technicalString(technical: Record<string, unknown> | undefined, key: string) {
  const value = technical?.[key]
  return typeof value === 'string' ? value : undefined
}

function findReplayReference(
  pool: PoolDescriptor,
  transactionHash: Hex,
  blockNumber: string,
  kind?: PoolReplayKind,
) {
  try {
    return replayReferencesForPool(pool).find((reference) =>
      (kind === undefined || reference.kind === kind)
        && reference.transactionHash.toLowerCase() === transactionHash.toLowerCase()
        && reference.blockNumber === blockNumber,
    )
  } catch {
    return
  }
}

/** Selects only saved, successful, receipt-backed public-chain samples. */
export function selectPositiveBehaviorSamples(
  report: AnalysisReport,
  currentBlockNumber: bigint,
  limit = 3,
): PositiveBehaviorSample[] {
  const reportBlockNumber = parseBlockNumber(report.blockNumber)
  if (reportBlockNumber === undefined) return []
  const poolsById = new Map(report.pools.map((pool) => [pool.poolId.toLowerCase(), pool]))
  const selected: PositiveBehaviorSample[] = []
  const seenTransactions = new Set<string>()
  const requestedLimit = Number.isFinite(limit) ? Math.floor(limit) : 3
  const boundedLimit = Math.min(4, Math.max(0, requestedLimit))

  for (const finding of report.findings) {
    if (selected.length >= boundedLimit) break
    const witness = finding.witness
    if (!witness
      || witness.expectedOutcome !== 'success'
      || witness.stateOverrides !== undefined
      || finding.evidenceClass !== 'concrete-observation'
      || !['replayed', 'replayable'].includes(finding.reproducibility)) continue
    const blockNumber = parseBlockNumber(witness.blockNumber)
    if (blockNumber === undefined || blockNumber === 0n || blockNumber > reportBlockNumber || blockNumber > currentBlockNumber) continue
    try {
      const value = BigInt(witness.value)
      if (value < 0n || value >= 1n << 256n) continue
    } catch {
      continue
    }
    const transactionHashValue = technicalString(finding.technical, 'transactionHash')
    const historicalTransactionValue = technicalString(finding.technical, 'historicalTransaction')
    const kindValue = technicalString(finding.technical, 'eventKind')
    const pool = finding.affectedPools
      .map((poolId) => poolsById.get(poolId.toLowerCase()))
      .find((candidate): candidate is PoolDescriptor => Boolean(candidate))
    if (!pool) continue
    const isHistoricalTransaction = Boolean(
      transactionHashValue
        && TRANSACTION_HASH.test(transactionHashValue)
        && isHex(transactionHashValue)
        && kindValue
        && REPLAY_KINDS.has(kindValue as PoolReplayKind),
    )
    const isHistoricalForkCall = Boolean(
      !isHistoricalTransaction
        && historicalTransactionValue
        && TRANSACTION_HASH.test(historicalTransactionValue)
        && isHex(historicalTransactionValue)
        && technicalString(finding.technical, 'callback')
        && sameAddress(witness.to, pool.hook),
    )
    if (!isHistoricalTransaction && !isHistoricalForkCall) continue
    const transactionHash = (isHistoricalTransaction ? transactionHashValue : historicalTransactionValue) as Hex
    const mode = isHistoricalTransaction ? 'historical-transaction' as const : 'historical-fork-call' as const
    const sampleIdentity = mode === 'historical-transaction'
      ? transactionHash.toLowerCase()
      : `${transactionHash.toLowerCase()}:${witness.to.toLowerCase()}:${witness.input.toLowerCase()}:${witness.value}`
    if (seenTransactions.has(sampleIdentity)) continue
    const reference = findReplayReference(
      pool,
      transactionHash,
      witness.blockNumber,
      mode === 'historical-transaction' ? kindValue as PoolReplayKind : undefined,
    )
    if (!reference) continue
    const historicalRouterValue = technicalString(finding.technical, 'historicalRouter')
    const historicalRouter = historicalRouterValue && /^0x[0-9a-fA-F]{40}$/.test(historicalRouterValue)
      ? historicalRouterValue as Address
      : undefined
    const recordedGasUsedValue = finding.technical?.gasUsed
    const recordedGasUsed = typeof recordedGasUsedValue === 'number'
      && Number.isSafeInteger(recordedGasUsedValue)
      && recordedGasUsedValue >= 0
      ? recordedGasUsedValue
      : undefined
    seenTransactions.add(sampleIdentity)
    selected.push({ findingId: finding.id, witness, pool, reference, mode, historicalRouter, recordedGasUsed })
  }
  return selected
}

export function behaviorCandidateMismatch(sample: PositiveBehaviorSample, candidate: PoolReplayCandidate): string | undefined {
  const mismatches: string[] = []
  if (candidate.kind !== sample.reference.kind) mismatches.push('event kind')
  if (candidate.transactionHash.toLowerCase() !== sample.reference.transactionHash.toLowerCase()) mismatches.push('transaction hash')
  if (candidate.poolId.toLowerCase() !== sample.pool.poolId.toLowerCase()) mismatches.push('PoolId')
  if (candidate.block.number.toString() !== sample.witness.blockNumber) mismatches.push('block number')
  if (!sameAddress(candidate.transaction.caller, sample.witness.from)) mismatches.push('caller')
  if (sample.mode === 'historical-transaction') {
    if (!sameAddress(candidate.transaction.to, sample.witness.to)) mismatches.push('target')
    if (!sameHex(candidate.transaction.calldata, sample.witness.input)) mismatches.push('input')
    try {
      if (candidate.transaction.value.toString() !== BigInt(sample.witness.value).toString()) mismatches.push('value')
    } catch {
      mismatches.push('value')
    }
  } else {
    if (!sameAddress(sample.witness.to, sample.pool.hook)) mismatches.push('hook target')
    if (sample.historicalRouter && !sameAddress(candidate.transaction.to, sample.historicalRouter)) mismatches.push('historical router')
  }
  if (!candidate.expected.success) mismatches.push('successful receipt outcome')
  return mismatches.length ? `The saved behavior sample differs from its receipt-backed transaction: ${mismatches.join(', ')}.` : undefined
}

export function behaviorReplayTransaction(sample: PositiveBehaviorSample, candidate: PoolReplayCandidate) {
  if (sample.mode === 'historical-transaction') return { ...candidate.transaction, traceLimit: 2_048 }
  return {
    ...candidate.transaction,
    caller: sample.witness.from,
    to: sample.witness.to,
    calldata: sample.witness.input,
    value: BigInt(sample.witness.value),
    traceLimit: 2_048,
  }
}

/** Fetches the receipt-validated transaction already referenced by a report sample. */
export async function loadPositiveBehaviorCandidate(input: {
  client: PublicClient
  chainId: number
  poolManager: Address
  sample: PositiveBehaviorSample
}): Promise<PoolReplayCandidate> {
  return await loadPoolReplayCandidate(
    input.client,
    input.chainId,
    input.poolManager,
    input.sample.pool,
    input.sample.reference,
  )
}

function replayMismatch(sample: PositiveBehaviorSample, replay: ForkReplayResult, candidate: PoolReplayCandidate) {
  const mismatches: string[] = []
  if (replay.proof.success !== (sample.witness.expectedOutcome === 'success')) mismatches.push('execution outcome')
  if (sample.mode === 'historical-transaction') {
    if (replay.proof.logCount !== candidate.expected.logCount) mismatches.push('log count')
    if (BigInt(replay.proof.gasUsed) !== candidate.expected.gasUsed) mismatches.push('gas use')
  } else if (sample.recordedGasUsed !== undefined && replay.proof.gasUsed !== sample.recordedGasUsed) {
    mismatches.push('gas use')
  }
  return mismatches.length ? `The behavior sample replay differs from its saved observation: ${mismatches.join(', ')}.` : undefined
}

export function summarizeBehaviorSampleOutcomes(
  selectedSamples: number,
  outcomes: BehaviorSampleOutcome[],
  reason?: string,
): BehaviorSampleReplay {
  const matchedSamples = outcomes.filter((outcome) => outcome.status === 'matched').length
  const changedSamples = outcomes.filter((outcome) => outcome.status === 'changed').length
  const unavailableSamples = outcomes.filter((outcome) => outcome.status === 'unavailable').length
  const status = changedSamples > 0
    ? 'changed'
    : selectedSamples === 0 || unavailableSamples > 0 || outcomes.length !== selectedSamples
      ? 'unavailable'
      : 'matched'
  return {
    status,
    selectedSamples,
    matchedSamples,
    changedSamples,
    unavailableSamples,
    outcomes,
    reason: status === 'matched' ? undefined : reason ?? outcomes.find((outcome) => outcome.status !== 'matched')?.reason,
  }
}

function unavailableBehavior(samples: PositiveBehaviorSample[], reason: string): BehaviorSampleReplay {
  return summarizeBehaviorSampleOutcomes(samples.length, samples.map((sample) => ({
    findingId: sample.findingId,
    transactionHash: sample.reference.transactionHash,
    status: 'unavailable',
    reason,
  })), reason)
}

/** Coordinates current code validation and bounded replay of saved positive samples. */
export async function validateCompletedReportCurrentness(input: {
  report: AnalysisReport
  chain: ChainConfig
  client: PublicClient
  signal: AbortSignal
  scanId?: string
  maxBehaviorSamples?: number
  timeoutMs?: number
  maxHydrationRequests?: number
  fetchRuntimeSnapshot?: RuntimeSnapshotFetcher
  loadBehaviorCandidate?: BehaviorCandidateLoader
  replayBehavior?: BehaviorReplayer
  onProgress?: (detail: string) => void
}): Promise<CompletedReportCurrentness> {
  const expectations = reportRuntimeExpectations(input.report)
  if (input.report.chainId !== input.chain.id) {
    const reason = `Saved report chain ${input.report.chainId} does not match selected chain ${input.chain.id}.`
    const runtime = mapReportRuntimeCurrentness({
      report: input.report,
      expectations,
      snapshot: { status: 'unavailable', reason },
    })
    return {
      reportId: input.report.id,
      status: 'unavailable',
      runtime,
      behavior: summarizeBehaviorSampleOutcomes(0, [], reason),
      reason,
    }
  }

  assertNotAborted(input.signal)
  input.onProgress?.('Checking saved block and current runtime identities')
  const fetchSnapshot = input.fetchRuntimeSnapshot ?? fetchReportRuntimeSnapshot
  let snapshot: ReportRuntimeSnapshotResult
  try {
    snapshot = await fetchSnapshot({
      client: input.client,
      chain: input.chain,
      report: input.report,
      expectations,
      signal: input.signal,
    })
  } catch (error) {
    if (isAbort(error, input.signal)) throw error
    snapshot = { status: 'unavailable', reason: errorMessage(error) }
  }
  const runtime = mapReportRuntimeCurrentness({ report: input.report, expectations, snapshot })
  const currentBlockNumber = snapshot.status === 'available' ? snapshot.currentBlock.number : 0n
  const samples = selectPositiveBehaviorSamples(input.report, currentBlockNumber, input.maxBehaviorSamples)

  let behavior: BehaviorSampleReplay
  if (runtime.status !== 'current') {
    behavior = unavailableBehavior(samples, `Behavior samples were not replayed because runtime currentness is ${runtime.status}.`)
  } else if (!input.chain.deepExecution || !input.chain.poolManager) {
    behavior = unavailableBehavior(samples, 'Public-chain fork replay is unavailable for the selected chain.')
  } else if (!samples.length) {
    behavior = summarizeBehaviorSampleOutcomes(0, [], 'The report has no suitable positive public-chain behavior sample.')
  } else {
    const loadCandidate = input.loadBehaviorCandidate ?? loadPositiveBehaviorCandidate
    const replay = input.replayBehavior ?? runForkReplay
    const outcomes: BehaviorSampleOutcome[] = []
    for (let index = 0; index < samples.length; index++) {
      assertNotAborted(input.signal)
      const sample = samples[index]!
      input.onProgress?.(`Replaying saved behavior sample ${index + 1}/${samples.length}`)
      try {
        const candidate = await loadCandidate({
          client: input.client,
          chainId: input.chain.id,
          poolManager: input.chain.poolManager,
          sample,
        })
        const mismatch = behaviorCandidateMismatch(sample, candidate)
        if (mismatch) {
          outcomes.push({
            findingId: sample.findingId,
            transactionHash: sample.reference.transactionHash,
            status: 'changed',
            reason: mismatch,
          })
          continue
        }
        const result = await replay({
          scanId: `${input.scanId ?? `report-${input.report.id}`}-behavior-${index}`,
          client: input.client,
          stateBlockNumber: candidate.stateBlockNumber,
          transaction: behaviorReplayTransaction(sample, candidate),
          block: candidate.block,
          signal: input.signal,
          timeoutMs: input.timeoutMs ?? 30_000,
          maxHydrationRequests: input.maxHydrationRequests ?? 2_048,
        })
        const difference = replayMismatch(sample, result, candidate)
        outcomes.push({
          findingId: sample.findingId,
          transactionHash: sample.reference.transactionHash,
          status: difference ? 'changed' : 'matched',
          reason: difference,
          replay: result,
        })
      } catch (error) {
        if (isAbort(error, input.signal)) throw error
        outcomes.push({
          findingId: sample.findingId,
          transactionHash: sample.reference.transactionHash,
          status: 'unavailable',
          reason: errorMessage(error),
        })
      }
    }
    behavior = summarizeBehaviorSampleOutcomes(samples.length, outcomes)
  }

  const status: ReportCurrentnessStatus = runtime.status === 'stale' || behavior.status === 'changed'
    ? 'stale'
    : runtime.status === 'current' && behavior.status === 'matched'
      ? 'current'
      : 'unavailable'
  return {
    reportId: input.report.id,
    status,
    runtime,
    behavior,
    reason: status === 'current' ? undefined : runtime.reason ?? behavior.reason,
  }
}
