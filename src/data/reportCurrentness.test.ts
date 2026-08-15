import { describe, expect, it, vi } from 'vitest'
import { keccak256, type Address, type Hex, type PublicClient } from 'viem'
import type { ForkReplayResult, runForkReplay } from '../analysis/revmProof'
import type { ChainConfig } from '../config/chains'
import type { AnalysisReport, Evidence, PoolDescriptor } from '../domain/report'
import type { PoolReplayCandidate } from './replay'
import {
  behaviorReplayTransaction,
  fetchReportRuntimeSnapshot,
  mapReportRuntimeCurrentness,
  reportRuntimeExpectations,
  selectPositiveBehaviorSamples,
  validateCompletedReportCurrentness,
  type ReportRuntimeSnapshot,
} from './reportCurrentness'

const TOKEN = '0x1111111111111111111111111111111111111111' as Address
const HOOK = '0x2222222222222222222222222222222222222222' as Address
const IMPLEMENTATION = '0x3333333333333333333333333333333333333333' as Address
const NEXT_IMPLEMENTATION = '0x4444444444444444444444444444444444444444' as Address
const POOL_MANAGER = '0x5555555555555555555555555555555555555555' as Address
const CALLER = '0x6666666666666666666666666666666666666666' as Address
const POOL_ID = `0x${'12'.repeat(32)}` as Hex
const TRANSACTION_HASH = `0x${'ab'.repeat(32)}` as Hex
const REPORT_BLOCK_HASH = `0x${'10'.repeat(32)}` as Hex
const CURRENT_BLOCK_HASH = `0x${'20'.repeat(32)}` as Hex
const TOKEN_CODE = '0x6000' as Hex
const HOOK_CODE = '0x6001' as Hex
const IMPLEMENTATION_CODE = '0x6002' as Hex

const chain: ChainConfig = {
  id: 1,
  slug: 'ethereum',
  name: 'Ethereum',
  shortName: 'ETH',
  explorerUrl: 'https://example.test',
  rpcUrls: ['https://rpc.example.test'],
  poolManager: POOL_MANAGER,
  deploymentBlock: 1n,
  evmVariant: 'ethereum',
  confirmations: 12,
  deepExecution: true,
}

function pool(): PoolDescriptor {
  return {
    poolId: POOL_ID,
    currency0: TOKEN,
    currency1: '0x0000000000000000000000000000000000000000',
    fee: 3_000,
    tickSpacing: 60,
    hook: HOOK,
    initializedAtBlock: '90',
    replayTransactions: [{ kind: 'swap', transactionHash: TRANSACTION_HASH, blockNumber: '100' }],
    activity: 1,
  }
}

function positiveFinding(overrides: Partial<Evidence> = {}): Evidence {
  return {
    id: 'saved-positive-sample',
    detectorId: 'revm-pool-replay',
    detectorVersion: '0.2.0',
    severity: 'info',
    evidenceClass: 'concrete-observation',
    subject: POOL_MANAGER,
    title: 'Historical transaction reproduced',
    claim: 'The saved transaction matched its receipt.',
    confidence: 'confirmed',
    affectedPools: [POOL_ID],
    witness: {
      from: CALLER,
      to: POOL_MANAGER,
      input: '0x1234',
      value: '0',
      blockNumber: '100',
      expectedOutcome: 'success',
    },
    reproducibility: 'replayed',
    technical: { eventKind: 'swap', transactionHash: TRANSACTION_HASH, stateBlockNumber: '99' },
    ...overrides,
  }
}

function report(findings: Evidence[] = [positiveFinding()]): AnalysisReport {
  const completedAt = '2026-08-13T12:00:00.000Z'
  return {
    schemaVersion: '1',
    id: '123e4567-e89b-42d3-a456-426614174000',
    source: 'browser',
    status: 'completed',
    partial: false,
    chainId: 1,
    chainName: 'Ethereum',
    token: TOKEN,
    blockNumber: '110',
    blockHash: REPORT_BLOCK_HASH,
    blockTagPolicy: 'finalized',
    createdAt: completedAt,
    elapsedMs: 1_000,
    adapterVersion: 'uniswap-v4/0.1.0',
    scenarioVersion: 'hacken-live-context/0.1.0',
    engineVersions: { revm: '36.0.0' },
    capabilities: {
      discovery: { supported: true, status: 'passed', verifiedAt: completedAt },
      static: { supported: true, status: 'passed', verifiedAt: completedAt },
      replay: { supported: true, status: 'passed', verifiedAt: completedAt },
      fuzz: { supported: false, status: 'degraded' },
    },
    pools: [pool()],
    poolCoverage: { discovered: 1, analyzed: 1, hasMore: false },
    contractGraph: [
      { address: TOKEN, role: 'token', codeHash: keccak256(TOKEN_CODE), bytecodeSize: 2, verifiedSource: false, selectors: [] },
      { address: HOOK, role: 'hook', codeHash: keccak256(HOOK_CODE), bytecodeSize: 2, verifiedSource: false, implementation: IMPLEMENTATION, selectors: [] },
      { address: IMPLEMENTATION, role: 'implementation', codeHash: keccak256(IMPLEMENTATION_CODE), bytecodeSize: 2, verifiedSource: false, selectors: [] },
    ],
    findings,
    phases: [],
    scenarios: { completed: 0, total: 0 },
    coverage: { uniqueCodeHashes: 3, paths: 0, executions: 1, branches: 0 },
    limitations: [],
  }
}

function availableSnapshot(savedReport: AnalysisReport): ReportRuntimeSnapshot {
  const expectations = reportRuntimeExpectations(savedReport)
  return {
    status: 'available',
    currentBlock: { number: 120n, hash: CURRENT_BLOCK_HASH, policy: 'finalized' },
    reportBlock: { status: 'available', number: 110n, hash: REPORT_BLOCK_HASH },
    contracts: expectations.contracts.map((expectation) => ({
      address: expectation.address,
      status: 'available',
      codeHash: expectation.expectedCodeHashes[0]!,
    })),
    proxies: expectations.proxies.map((expectation) => ({
      proxyAddress: expectation.proxyAddress,
      status: 'available',
      implementation: expectation.expectedImplementations[0]!,
    })),
  }
}

function candidate(): PoolReplayCandidate {
  return {
    kind: 'swap',
    poolId: POOL_ID,
    transactionHash: TRANSACTION_HASH,
    stateBlockNumber: 99n,
    transaction: {
      caller: CALLER,
      to: POOL_MANAGER,
      calldata: '0x1234',
      value: 0n,
      gasLimit: 500_000n,
      gasPrice: 10n,
      nonce: 7,
      chainId: 1,
    },
    block: {
      number: 100n,
      beneficiary: '0x0000000000000000000000000000000000000000',
      timestamp: 1_000n,
      gasLimit: 30_000_000n,
      baseFee: 10n,
      difficulty: 0n,
    },
    expected: { success: true, gasUsed: 100n, logCount: 1 },
  }
}

function replayResult(overrides: Partial<ForkReplayResult['proof']> = {}): ForkReplayResult {
  return {
    proof: {
      engine: 'revm/36.0.0-wasm',
      success: true,
      gasUsed: 100,
      output: '0x',
      steps: [],
      storageOperations: [],
      calls: [],
      storageDiffs: [],
      balanceChanges: [],
      logs: [],
      logCount: 1,
      selfdestructs: [],
      truncated: false,
      ...overrides,
    },
    hydrationRequests: 2,
    hydratedAccounts: 2,
    hydratedStorageSlots: 0,
  }
}

describe('completed report currentness', () => {
  it('reads every runtime codehash and proxy identity at one coherent current block', async () => {
    const savedReport = report()
    const expectations = reportRuntimeExpectations(savedReport)
    const codeBlocks: bigint[] = []
    const resolutionBlocks: bigint[] = []
    const code = new Map([
      [TOKEN.toLowerCase(), TOKEN_CODE],
      [HOOK.toLowerCase(), HOOK_CODE],
      [IMPLEMENTATION.toLowerCase(), IMPLEMENTATION_CODE],
    ])
    const client = {
      getBlock: async (input: { blockNumber?: bigint; blockTag?: string }) => input.blockNumber === 110n
        ? { number: 110n, hash: REPORT_BLOCK_HASH }
        : { number: 120n, hash: CURRENT_BLOCK_HASH },
      getCode: async ({ address, blockNumber }: { address: Address; blockNumber: bigint }) => {
        codeBlocks.push(blockNumber)
        return code.get(address.toLowerCase()) ?? '0x'
      },
    } as unknown as PublicClient

    const snapshot = await fetchReportRuntimeSnapshot({
      client,
      chain,
      report: savedReport,
      expectations,
      resolveImplementation: async ({ blockNumber }) => {
        resolutionBlocks.push(blockNumber)
        return IMPLEMENTATION
      },
    })

    expect(snapshot.currentBlock.number).toBe(120n)
    expect(snapshot.reportBlock).toEqual({ status: 'available', number: 110n, hash: REPORT_BLOCK_HASH })
    expect(codeBlocks).toEqual([120n, 120n, 120n])
    expect(resolutionBlocks).toEqual([120n])
    expect(mapReportRuntimeCurrentness({ report: savedReport, expectations, snapshot }).status).toBe('current')
  })

  it('maps changed implementation identity as stale and missing RPC data as unavailable', () => {
    const savedReport = report()
    const expectations = reportRuntimeExpectations(savedReport)
    const changedProxy = availableSnapshot(savedReport)
    changedProxy.proxies = [{
      proxyAddress: HOOK,
      status: 'available',
      implementation: NEXT_IMPLEMENTATION,
    }]
    const stale = mapReportRuntimeCurrentness({ report: savedReport, expectations, snapshot: changedProxy })
    expect(stale.status).toBe('stale')
    expect(stale.proxies[0]).toMatchObject({ status: 'stale', currentImplementation: NEXT_IMPLEMENTATION })

    const missingCode = availableSnapshot(savedReport)
    missingCode.contracts = missingCode.contracts.map((observation) => observation.address === IMPLEMENTATION
      ? { address: IMPLEMENTATION, status: 'unavailable', reason: 'archive read unavailable' }
      : observation)
    const unavailable = mapReportRuntimeCurrentness({ report: savedReport, expectations, snapshot: missingCode })
    expect(unavailable.status).toBe('unavailable')
    expect(unavailable.status).not.toBe('current')
  })

  it('selects only report-owned, successful, receipt-backed public-chain witnesses', () => {
    const valid = positiveFinding()
    const duplicate = positiveFinding({ id: 'duplicate' })
    const reverted = positiveFinding({
      id: 'reverted',
      witness: { ...valid.witness!, expectedOutcome: 'revert' },
    })
    const generated = positiveFinding({
      id: 'generated',
      technical: { callback: 'beforeSwap', historicalTransaction: TRANSACTION_HASH },
    })
    const overridden = positiveFinding({
      id: 'overridden',
      witness: { ...valid.witness!, stateOverrides: {} },
    })
    const liveForkCall = positiveFinding({
      id: 'live-fork-call',
      witness: { ...valid.witness!, to: HOOK, input: '0x5678' },
      technical: {
        callback: 'beforeSwap',
        historicalTransaction: TRANSACTION_HASH,
        historicalRouter: POOL_MANAGER,
        gasUsed: 88,
      },
    })
    const selected = selectPositiveBehaviorSamples(
      report([valid, duplicate, reverted, generated, overridden, liveForkCall]),
      120n,
      4,
    )

    expect(selected.map((sample) => [sample.findingId, sample.mode])).toEqual([
      ['saved-positive-sample', 'historical-transaction'],
      ['live-fork-call', 'historical-fork-call'],
    ])
    expect(behaviorReplayTransaction(selected[1]!, candidate())).toMatchObject({
      caller: CALLER,
      to: HOOK,
      calldata: '0x5678',
      value: 0n,
      nonce: 7,
    })
  })

  it('returns current only after mocked runtime and behavior boundaries both match', async () => {
    const savedReport = report()
    const fetchRuntimeSnapshot = vi.fn(async () => availableSnapshot(savedReport))
    const loadBehaviorCandidate = vi.fn(async () => candidate())
    const replayBehavior = vi.fn(async () => replayResult())
    const result = await validateCompletedReportCurrentness({
      report: savedReport,
      chain,
      client: {} as PublicClient,
      signal: new AbortController().signal,
      fetchRuntimeSnapshot,
      loadBehaviorCandidate,
      replayBehavior,
    })

    expect(result.status).toBe('current')
    expect(result.runtime.status).toBe('current')
    expect(result.behavior).toMatchObject({ status: 'matched', selectedSamples: 1, matchedSamples: 1 })
    expect(fetchRuntimeSnapshot).toHaveBeenCalledTimes(1)
    expect(loadBehaviorCandidate).toHaveBeenCalledTimes(1)
    expect(replayBehavior).toHaveBeenCalledTimes(1)
  })

  it('replays a saved successful fork-call sample in its receipt-backed public-chain context', async () => {
    const savedReport = report([positiveFinding({
      id: 'live-fork-call',
      witness: { ...positiveFinding().witness!, to: HOOK, input: '0x5678' },
      technical: {
        callback: 'beforeSwap',
        historicalTransaction: TRANSACTION_HASH,
        historicalRouter: POOL_MANAGER,
        gasUsed: 88,
      },
    })])
    const replayBehavior = vi.fn(async (input: Parameters<typeof runForkReplay>[0]) => {
      expect(input.transaction).toMatchObject({ to: HOOK, calldata: '0x5678', nonce: 7 })
      return replayResult({ gasUsed: 88 })
    })
    const result = await validateCompletedReportCurrentness({
      report: savedReport,
      chain,
      client: {} as PublicClient,
      signal: new AbortController().signal,
      fetchRuntimeSnapshot: async () => availableSnapshot(savedReport),
      loadBehaviorCandidate: async () => candidate(),
      replayBehavior,
    })

    expect(result.status).toBe('current')
    expect(result.behavior.status).toBe('matched')
  })

  it('never maps an unavailable fetch or replay boundary to current', async () => {
    const savedReport = report()
    const replayBehavior = vi.fn(async () => replayResult())
    const fetchUnavailable = await validateCompletedReportCurrentness({
      report: savedReport,
      chain,
      client: {} as PublicClient,
      signal: new AbortController().signal,
      fetchRuntimeSnapshot: async () => { throw new Error('RPC unavailable') },
      replayBehavior,
    })
    expect(fetchUnavailable.status).toBe('unavailable')
    expect(replayBehavior).not.toHaveBeenCalled()

    const replayUnavailable = await validateCompletedReportCurrentness({
      report: savedReport,
      chain,
      client: {} as PublicClient,
      signal: new AbortController().signal,
      fetchRuntimeSnapshot: async () => availableSnapshot(savedReport),
      loadBehaviorCandidate: async () => candidate(),
      replayBehavior: async () => { throw new Error('archive state unavailable') },
    })
    expect(replayUnavailable.status).toBe('unavailable')
    expect(replayUnavailable.behavior.status).toBe('unavailable')
  })

  it('maps a receipt-visible behavior difference to stale', async () => {
    const savedReport = report()
    const result = await validateCompletedReportCurrentness({
      report: savedReport,
      chain,
      client: {} as PublicClient,
      signal: new AbortController().signal,
      fetchRuntimeSnapshot: async () => availableSnapshot(savedReport),
      loadBehaviorCandidate: async () => candidate(),
      replayBehavior: async () => replayResult({ gasUsed: 101 }),
    })

    expect(result.status).toBe('stale')
    expect(result.behavior).toMatchObject({ status: 'changed', changedSamples: 1 })
  })

})
