import { useCallback, useRef, useState } from 'react'
import { getAddress, type Address, type Hex, type PublicClient } from 'viem'
import { runStaticWorker } from '../../analysis/staticWorkerClient'
import {
  ForkExecutionSession,
  ForkExplorationSession,
  runForkReplay,
  runParallelRevmExploration,
  runRevmProof,
  type ForkReplayResult,
  type RevmExecutionProof,
  type RevmExploration,
} from '../../analysis/revmProof'
import { runLivePoolReplays, type LivePoolReplayCoverage } from '../../analysis/livePoolReplay'
import { runLiveRouterScenarios, type LiveRouterScenarioCoverage } from '../../analysis/liveRouterScenarios'
import { runLiveForkExploration, type LiveForkExplorationCoverage } from '../../analysis/liveForkExploration'
import {
  prepareHistoricalRouterContexts,
  type HistoricalRouterContexts,
} from '../../data/historicalRouterContext'
import { runProtocolScenarios, type ProtocolScenarioCoverage } from '../../analysis/protocolScenarioRunner'
import { runProtocolScenarioExploration, type ProtocolExplorationCoverage } from '../../analysis/protocolScenarioExploration'
import { runErc20LaneCoverage, type Erc20LaneCoverage } from '../../analysis/erc20LaneCoverage'
import { combinedFindings } from '../../analysis/combinedRules'
import { scenarioHarnessIdentity } from '../../analysis/protocolScenarioArtifact'
import { runVerifiedSourceAnalysis, type SourceAnalysisCoverage } from '../../analysis/liveSourceAnalysis'
import { getChainConfig } from '../../config/chains'
import { loadPoolDiscovery, loadScanSources, type PoolDiscoverySnapshot } from '../../data/loadScan'
import { loadReports, persistCompletedReport } from '../../data/reports'
import { validateCompletedReportCurrentness, type CompletedReportCurrentness } from '../../data/reportCurrentness'
import { getPublicClient } from '../../data/rpc'
import { createForkHydrationCache } from '../../data/forkHydrationCache'
import { createScanRpcClient } from '../../data/scanRpcClient'
import { fetchSourcify4ByteSignatures } from '../../data/signatureDatabase'
import { parseTokenAddress } from '../../domain/address'
import { currentClientUsesStaticOnlyMobileTier } from '../../domain/executionClient'
import {
  ADAPTER_VERSION,
  FIXTURE_SCENARIO_VERSION,
  LIVE_SCENARIO_VERSION,
  reportMatchesCurrentPipeline,
} from '../../domain/reportPipeline'
import type { AnalysisPhase, AnalysisReport, ContractNode, Evidence, PoolDescriptor, StaticSubject } from '../../domain/report'
import type { HackenSuiteResult } from '../../analysis/hackenScenarios'
import {
  FIXTURE_SCAN_ADDRESS,
  REVM_EXECUTION_FIXTURE,
  REVM_EXPLORATION_FIXTURE,
  STATIC_FIXTURES,
} from '../../fixtures/bytecode'

export type AnalyzerState = {
  status: 'idle' | 'discovering' | 'selecting' | 'cache' | 'running' | 'completed' | 'cancelled' | 'failed'
  detail?: string
  progress: number
  phases: AnalysisPhase[]
  report?: AnalysisReport
  history: AnalysisReport[]
  persistence?: 'remote' | 'local-only'
  currentnessStatus?: 'checking' | 'checked'
  currentness?: CompletedReportCurrentness
  poolSelection?: PoolDiscoverySnapshot
  error?: string
}

const phaseLabels: Record<AnalysisPhase['id'], string> = {
  pin: 'Pin block',
  discover: 'Discover pools',
  resolve: 'Resolve contracts',
  static: 'Map bytecode behavior',
  replay: 'Replay transactions',
  generated: 'Run generated scenarios',
  scenarios: 'Run pool scenarios',
  fuzz: 'Explore bounded inputs',
  report: 'Normalize evidence',
}

const basePhases = (): AnalysisPhase[] => Object.entries(phaseLabels).map(([id, label]) => ({
  id: id as AnalysisPhase['id'],
  label,
  status: 'pending',
  completed: 0,
  total: 1,
}))

function phaseCoverageDetail(detail: string, status: 'passed' | 'degraded', limitations: string[]) {
  const reason = status === 'degraded' ? limitations[0] : undefined
  return reason ? `${detail} · ${reason}` : detail
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address
const FIXTURE_CALLER = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as Address
const FIXTURE_TARGET = '0xffffffffffffffffffffffffffffffffffffffff' as Address

function fixtureHydrationClient(): PublicClient {
  const codeByAddress = new Map<string, Hex>([
    [FIXTURE_CALLER.toLowerCase(), '0x'],
    [FIXTURE_TARGET.toLowerCase(), '0x60005400'],
    [ZERO_ADDRESS.toLowerCase(), '0x'],
  ])
  return {
    getBalance: async ({ address }: { address: Address }) => address.toLowerCase() === FIXTURE_CALLER ? 10n ** 18n : 0n,
    getTransactionCount: async () => 0,
    getCode: async ({ address }: { address: Address }) => codeByAddress.get(address.toLowerCase()) ?? '0x',
    getStorageAt: async () => '0x2a',
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber, hash: `0x${blockNumber.toString(16).padStart(64, '0')}` as Hex }),
  } as unknown as PublicClient
}

function fixturePools(): PoolDescriptor[] {
  return STATIC_FIXTURES.slice(1, 4).map((fixture, index) => ({
    poolId: `0x${String(index + 1).padStart(64, '0')}` as Hex,
    currency0: ZERO_ADDRESS,
    currency1: FIXTURE_SCAN_ADDRESS,
    fee: index === 0 ? 3_000 : index === 1 ? 500 : 10_000,
    tickSpacing: index === 1 ? 10 : 60,
    hook: fixture.subject.address,
    initializedAtBlock: String(21_700_000 + index),
    activity: 10 - index,
  }))
}

function syntheticSources(): {
  subjects: StaticSubject[]
  pools: PoolDescriptor[]
  nodes: ContractNode[]
  blockNumber: bigint
  blockHash: Hex
  limitations: string[]
} {
  const subjects = STATIC_FIXTURES.map((fixture) => fixture.subject)
  return {
    subjects,
    pools: fixturePools(),
    nodes: subjects.map((subject) => ({
      address: subject.address,
      role: subject.role,
      codeHash: subject.codeHash,
      bytecodeSize: (subject.bytecode.length - 2) / 2,
      verifiedSource: true,
      selectors: [],
    })),
    blockNumber: 21_700_004n,
    blockHash: `0x${'f17e'.padStart(64, '0')}` as Hex,
    limitations: ['Deterministic local fixtures: no public-chain claim is made by this example report.'],
  }
}

function mergeNodes(resolved: ContractNode[], analyzed: ContractNode[]): ContractNode[] {
  const resolvedByIdentity = new Map(resolved.map((node) => [`${node.address}:${node.codeHash}`, node]))
  return analyzed.map((node) => {
    const source = resolvedByIdentity.get(`${node.address}:${node.codeHash}`)
    return {
      ...node,
      ...source,
      selectors: [...new Set([...(source?.selectors ?? []), ...node.selectors])],
    }
  })
}

function samePoolSet(report: AnalysisReport, selectedPoolIds: readonly Hex[]) {
  if (report.pools.length !== selectedPoolIds.length) return false
  const expected = new Set(selectedPoolIds.map((poolId) => poolId.toLowerCase()))
  return report.pools.every((pool) => expected.has(pool.poolId.toLowerCase()))
}

function revmFinding(proof: RevmExecutionProof, affectedPool?: Hex): Evidence {
  const firstStorage = proof.storageDiffs[0]
  return {
    id: `revm-storage-diff:${REVM_EXECUTION_FIXTURE.subject.address}`,
    detectorId: 'revm-storage-diff',
    detectorVersion: '0.1.0',
    severity: 'medium',
    evidenceClass: 'concrete-observation',
    subject: REVM_EXECUTION_FIXTURE.subject.address,
    title: 'Concrete state change reproduced in revm',
    claim: `The deterministic execution wrote ${proof.storageDiffs.length} storage slot(s) and completed using ${proof.gasUsed} gas.`,
    confidence: 'confirmed',
    programCounter: proof.storageOperations.find((step) => step.opcode === 'SSTORE')?.pc,
    storage: firstStorage ? [{ slot: firstStorage.slot, before: firstStorage.before, after: firstStorage.after }] : undefined,
    affectedPools: affectedPool ? [affectedPool] : [],
    witness: {
      from: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      to: '0xffffffffffffffffffffffffffffffffffffffff',
      input: '0x',
      value: '0',
      blockNumber: 'fixture',
      expectedOutcome: 'success',
    },
    reproducibility: 'replayed',
    technical: { engine: proof.engine, calls: proof.calls, storageOperations: proof.storageOperations, truncated: proof.truncated },
  }
}

function explorationFinding(exploration: RevmExploration | undefined, affectedPool?: Hex): Evidence | undefined {
  if (!exploration || exploration.uniqueOutcomes < 2) return
  const witness = exploration.witnesses.find((item) => item.storageDiffs.length > 0)
  const firstStorage = witness?.storageDiffs[0]
  return {
    id: `revm-input-outcomes:${REVM_EXPLORATION_FIXTURE.subject.address}`,
    detectorId: 'revm-input-outcomes',
    detectorVersion: '0.1.0',
    severity: 'medium',
    evidenceClass: 'fuzz-discovery',
    subject: REVM_EXPLORATION_FIXTURE.subject.address,
    title: 'Inputs produce different state outcomes',
    claim: `Bounded revm execution reached ${exploration.uniqueOutcomes} distinct outcomes across ${exploration.executions.toLocaleString()} inputs and ${exploration.coverageEdges} execution edges.`,
    confidence: 'confirmed',
    storage: firstStorage ? [{ slot: firstStorage.slot, before: firstStorage.before, after: firstStorage.after }] : undefined,
    affectedPools: affectedPool ? [affectedPool] : [],
    witness: witness ? {
      from: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      to: '0xffffffffffffffffffffffffffffffffffffffff',
      input: witness.calldata,
      value: '0',
      blockNumber: 'fixture',
      expectedOutcome: witness.success ? 'success' : 'revert',
    } : undefined,
    reproducibility: 'replayed',
    technical: {
      engine: exploration.engine,
      strategy: exploration.strategy,
      elapsedMs: exploration.elapsedMs,
      witnesses: exploration.witnesses,
    },
  }
}

/**
 * Status for the generated phase, covering both settlement lanes.
 *
 * The claims suite alone decided this before, so an ERC-20 lane that was
 * unavailable, degraded, or that threw outright still left the phase reading as
 * completed. A lane that produced nothing has to be visible: it is the
 * difference between "the token path was exercised" and "it was not".
 */
function generatedPhase(
  claims: ProtocolScenarioCoverage,
  lane: Erc20LaneCoverage | undefined,
  laneFailure: string | undefined,
): Pick<AnalysisPhase, 'status' | 'completed' | 'total' | 'detail'> {
  const base = protocolScenarioPhase(claims)
  const laneDetail = laneFailure
    ? `ERC-20 lane failed · ${laneFailure}`
    : lane
      ? `ERC-20 lane: ${lane.completed} settled, ${lane.reverted} reverted, ${lane.coveredByRoundTrip} covered by round trip, ${lane.unavailable} unavailable${lane.failed ? `, ${lane.failed} errored` : ''}`
      : 'ERC-20 lane did not run'
  const laneHealthy = Boolean(lane) && lane!.status === 'passed'
  return {
    ...base,
    status: base.status === 'completed' && laneHealthy ? 'completed' : 'degraded',
    detail: `${base.detail} · ${laneDetail}`,
  }
}

/** Progress is counted in pools, since a pool owns one generated scenario suite. */
function protocolScenarioPhase(
  coverage: ProtocolScenarioCoverage,
): Pick<AnalysisPhase, 'status' | 'completed' | 'total' | 'detail'> {
  return {
    status: coverage.status === 'passed' ? 'completed' : 'degraded',
    completed: coverage.completed,
    total: coverage.scenarios,
    detail: phaseCoverageDetail(
      `${coverage.executedPools}/${coverage.eligiblePools} hooked pools · ${coverage.completed} completed · ${coverage.reverted} observed reverts · ${coverage.hydrationReads} logical pinned reads`,
      coverage.status,
      coverage.limitations,
    ),
  }
}

/**
 * Summarizes both exploration suites in one phase.
 *
 * They are reported side by side rather than merged: the generated suite needs
 * only a pool, the historical suite needs a receipt-matched router transaction,
 * and collapsing them would let one suite's absence read as the other's failure.
 */
function explorationPhase(
  generated: ProtocolExplorationCoverage | undefined,
  historical: LiveForkExplorationCoverage | undefined,
  historicalReason: string,
): Pick<AnalysisPhase, 'status' | 'completed' | 'total' | 'detail'> {
  if (!generated && !historical) {
    return { status: 'degraded', completed: 0, total: 1, detail: `No bounded exploration ran · ${historicalReason}` }
  }
  const parts = [
    generated
      ? `generated: ${generated.exploredPools}/${generated.eligiblePools} pools · ${generated.executions.toLocaleString()} executions · ${generated.coverageEdges} edges`
      : 'generated: unavailable',
    historical
      ? `historical router: ${historical.exploredPools}/${historical.eligiblePools} pools · ${historical.executions.toLocaleString()} executions · ${historical.coverageEdges} edges`
      : `historical router: unavailable · ${historicalReason}`,
  ]
  const limitations = [...(generated?.limitations ?? []), ...(historical?.limitations ?? [])]
  // The generated suite decides the phase: it is the one that runs on nothing
  // more than a discovered pool, so its status is the honest floor.
  const status = generated?.status ?? 'degraded'
  return {
    status: status === 'passed' && historical?.status === 'passed' ? 'completed' : 'degraded',
    completed: (generated?.exploredPools ?? 0) + (historical?.exploredPools ?? 0),
    total: Math.max(1, (generated?.eligiblePools ?? 0) + (historical?.eligiblePools ?? 0)),
    detail: phaseCoverageDetail(parts.join(' · '), status, limitations),
  }
}

function fixtureHydrationFinding(replay: ForkReplayResult, affectedPool?: Hex): Evidence {
  return {
    id: 'revm-fixture-hydration-loop',
    detectorId: 'revm-fixture-hydration-loop',
    detectorVersion: '0.1.0',
    severity: 'info',
    evidenceClass: 'concrete-observation',
    subject: FIXTURE_TARGET,
    title: 'Pinned-state hydration loop completed',
    claim: `revm requested and received ${replay.hydratedAccounts} accounts and ${replay.hydratedStorageSlots} storage slot(s) through ${replay.hydrationRequests} typed browser reads.`,
    confidence: 'confirmed',
    affectedPools: affectedPool ? [affectedPool] : [],
    witness: {
      from: FIXTURE_CALLER,
      to: FIXTURE_TARGET,
      input: '0x',
      value: '0',
      blockNumber: 'fixture-parent',
      expectedOutcome: 'success',
    },
    reproducibility: 'replayed',
    technical: {
      engine: replay.proof.engine,
      hydrationRequests: replay.hydrationRequests,
      hydratedAccounts: replay.hydratedAccounts,
      hydratedStorageSlots: replay.hydratedStorageSlots,
      storageOperations: replay.proof.storageOperations,
    },
  }
}

export function useAnalyzer() {
  const abortRef = useRef<AbortController | null>(null)
  const [state, setState] = useState<AnalyzerState>({ status: 'idle', progress: 0, phases: basePhases(), history: [] })

  const patchPhase = useCallback((id: AnalysisPhase['id'], patch: Partial<AnalysisPhase>) => {
    setState((current) => ({ ...current, phases: current.phases.map((phase) => (phase.id === id ? { ...phase, ...patch } : phase)) }))
  }, [])

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setState((current) => ({
      ...current,
      status: 'cancelled',
      detail: 'Analysis cancelled. No report was submitted.',
      phases: current.phases.map((phase) => phase.status === 'running' ? { ...phase, status: 'cancelled' } : phase),
    }))
  }, [])

  const discover = useCallback(async (input: { chainId: number; token: string }) => {
    abortRef.current?.abort()
    let token: Address
    try {
      token = parseTokenAddress(input.token)
    } catch (error) {
      setState({ status: 'failed', progress: 0, phases: basePhases(), history: [], error: error instanceof Error ? error.message : String(error) })
      return
    }

    const chain = getChainConfig(input.chainId)
    const controller = new AbortController()
    abortRef.current = controller
    setState({
      status: 'discovering',
      detail: 'Pinning a reproducible block',
      progress: 4,
      phases: basePhases().map((phase) => phase.id === 'pin' ? { ...phase, status: 'running' } : phase),
      history: [],
    })

    try {
      const isFixture = token.toLowerCase() === FIXTURE_SCAN_ADDRESS.toLowerCase()
      const selection = isFixture
        ? (() => {
            const fixture = syntheticSources()
            return {
              chainId: chain.id,
              token,
              block: { number: fixture.blockNumber, hash: fixture.blockHash, policy: 'deterministic-fixture' },
              tokenMetadata: { symbol: 'DEMO', name: 'Hookscope deterministic fixture', decimals: 18 },
              pools: fixture.pools,
              discovery: { source: 'logs' as const, requests: 0, completeHistory: true },
            } satisfies PoolDiscoverySnapshot
          })()
        : await loadPoolDiscovery({
            client: createScanRpcClient({
              client: getPublicClient(chain),
              signal: controller.signal,
              readConcurrency: currentClientUsesStaticOnlyMobileTier() ? 2 : 4,
              logConcurrency: currentClientUsesStaticOnlyMobileTier() ? 1 : 2,
            }).client,
            chain,
            token,
            signal: controller.signal,
            onProgress: (detail) => setState((current) => ({
              ...current,
              detail,
              progress: detail.startsWith('Loading') ? 14 : current.progress,
              phases: current.phases.map((phase) => phase.id === 'discover' && detail.startsWith('Loading')
                ? { ...phase, status: 'running' }
                : phase),
            })),
          })
      if (controller.signal.aborted) return
      const history = await loadReports(chain.id, token)
      const discoveryDetail = selection.discovery.source === 'index+tail'
        ? `${selection.pools.length} pools · index verified + recent tail · ${selection.discovery.requests} reads`
        : `${selection.pools.length} pools · bounded log discovery · ${selection.discovery.requests} reads`
      setState({
        status: 'selecting',
        detail: selection.pools.length > 0 ? 'Choose pools to analyze' : 'No verified v4 pools found',
        progress: 25,
        phases: basePhases().map((phase) => {
          if (phase.id === 'pin') return { ...phase, status: 'completed', completed: 1, detail: `Block ${selection.block.number}` }
          if (phase.id === 'discover') return { ...phase, status: 'completed', completed: 1, detail: discoveryDetail }
          return phase
        }),
        history,
        poolSelection: selection,
      })
      abortRef.current = null
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setState((current) => ({ ...current, status: 'failed', error: error instanceof Error ? error.message : String(error), detail: undefined }))
      abortRef.current = null
    }
  }, [])

  const analyze = useCallback(async (input: {
    chainId: number
    token: string
    force?: boolean
    poolCursor?: string
    poolSelection?: PoolDiscoverySnapshot
    selectedPoolIds?: readonly Hex[]
  }) => {
    abortRef.current?.abort()
    let token: Address
    try {
      token = parseTokenAddress(input.token)
    } catch (error) {
      setState({ status: 'failed', progress: 0, phases: basePhases(), history: [], error: error instanceof Error ? error.message : String(error) })
      return
    }

    const chain = getChainConfig(input.chainId)
    const isFixture = token.toLowerCase() === FIXTURE_SCAN_ADDRESS.toLowerCase()
    if (input.poolSelection && (
      input.poolSelection.chainId !== chain.id
      || input.poolSelection.token.toLowerCase() !== token.toLowerCase()
    )) {
      setState({ status: 'failed', progress: 0, phases: basePhases(), history: [], error: 'The pool selection belongs to a different chain or token.' })
      return
    }
    if (input.poolSelection && (!input.selectedPoolIds || input.selectedPoolIds.length === 0)) {
      setState({ status: 'failed', progress: 0, phases: basePhases(), history: [], error: 'Select at least one pool to analyze.' })
      return
    }
    setState({ status: 'cache', detail: 'Checking completed reports', progress: 0, phases: basePhases(), history: [] })
    const cached = await loadReports(chain.id, token)
    const newest = input.selectedPoolIds
      ? cached.find((report) => samePoolSet(report, input.selectedPoolIds!))
      : cached[0]
    const history = newest ? cached.filter((report) => report.id !== newest.id) : cached
    const cacheMatchesCurrentPipeline = newest ? reportMatchesCurrentPipeline(newest, isFixture) : false
    if (newest && cacheMatchesCurrentPipeline && !input.force && !input.poolCursor) {
      if (newest.blockTagPolicy === 'deterministic-fixture') {
        setState({ status: 'completed', progress: 100, phases: newest.phases, report: newest, history })
        return
      }
      const currentnessController = new AbortController()
      abortRef.current = currentnessController
      setState({
        status: 'completed',
        progress: 100,
        detail: 'Checking saved report against current chain state',
        phases: newest.phases,
        report: newest,
        history,
        currentnessStatus: 'checking',
      })
      try {
        const currentness = await validateCompletedReportCurrentness({
          report: newest,
          chain,
          client: getPublicClient(chain),
          signal: currentnessController.signal,
          scanId: `currentness-${newest.id}`,
          maxBehaviorSamples: 3,
          onProgress: (detail) => setState((current) => current.report?.id === newest.id ? { ...current, detail } : current),
        })
        if (!currentnessController.signal.aborted) {
          setState((current) => current.report?.id === newest.id ? {
            ...current,
            detail: undefined,
            currentnessStatus: 'checked',
            currentness,
          } : current)
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setState((current) => current.report?.id === newest.id ? {
            ...current,
            detail: undefined,
            currentnessStatus: 'checked',
            currentness: undefined,
          } : current)
        }
      } finally {
        if (abortRef.current === currentnessController) abortRef.current = null
      }
      return
    }

    const controller = new AbortController()
    abortRef.current = controller
    const startedAt = performance.now()
    const scanId = crypto.randomUUID()
    setState({ status: 'running', detail: 'Preparing selected pools', progress: 25, phases: basePhases(), history: cached, poolSelection: input.poolSelection })

    try {
      let subjects: StaticSubject[]
      let pools: PoolDescriptor[]
      let preResolvedNodes: ContractNode[]
      let blockNumber: bigint
      let blockHash: Hex
      let blockPolicy: string
      let limitations: string[]
      let discovered: number
      let hasMore = false
      let nextCursor: string | undefined
      let tokenSymbol: string | undefined
      let scanClient: PublicClient | undefined
      let pinDetail: string
      let discoveryDetail: string
      let resolveDetail: string
      patchPhase('pin', { status: 'running' })
      if (isFixture) {
        const fixture = syntheticSources()
        const requested = input.selectedPoolIds
          ? new Set(input.selectedPoolIds.map((poolId) => poolId.toLowerCase()))
          : undefined
        pools = requested
          ? fixture.pools.filter((pool) => requested.has(pool.poolId.toLowerCase()))
          : fixture.pools
        if (requested && pools.length !== requested.size) throw new Error('One or more selected fixture pools were not found.')
        const selectedAddresses = new Set([
          FIXTURE_SCAN_ADDRESS.toLowerCase(),
          ...pools.map((pool) => pool.hook.toLowerCase()),
        ])
        subjects = fixture.subjects.filter((subject) => selectedAddresses.has(subject.address.toLowerCase()))
        preResolvedNodes = fixture.nodes.filter((node) => selectedAddresses.has(node.address.toLowerCase()))
        blockNumber = fixture.blockNumber
        blockHash = fixture.blockHash
        blockPolicy = 'deterministic-fixture'
        limitations = [
          ...fixture.limitations,
          pools.length < fixture.pools.length ? `This report covers ${pools.length} user-selected pool${pools.length === 1 ? '' : 's'} out of ${fixture.pools.length} discovered pools.` : '',
        ].filter(Boolean)
        discovered = fixture.pools.length
        hasMore = pools.length < discovered
        tokenSymbol = 'DEMO'
        pinDetail = `Block ${blockNumber} · deterministic fixture`
        discoveryDetail = `${pools.length} deterministic pools`
        resolveDetail = `${subjects.length} codehash fixtures`
        patchPhase('pin', { status: 'completed', completed: 1, detail: pinDetail })
        patchPhase('discover', { status: 'completed', completed: 1, detail: discoveryDetail })
        patchPhase('resolve', { status: 'completed', completed: 1, detail: resolveDetail })
      } else {
        const coordinated = createScanRpcClient({
          client: getPublicClient(chain),
          signal: controller.signal,
          readConcurrency: currentClientUsesStaticOnlyMobileTier() ? 2 : 4,
          logConcurrency: currentClientUsesStaticOnlyMobileTier() ? 1 : 2,
        })
        const client = coordinated.client
        scanClient = client
        const sources = await loadScanSources({
          client,
          chain,
          token,
          poolCursor: input.poolCursor,
          discoverySnapshot: input.poolSelection,
          selectedPoolIds: input.selectedPoolIds,
          poolLimit: 20,
          signal: controller.signal,
          onProgress: (detail) => setState((current) => ({ ...current, detail })),
        })
        subjects = sources.subjects
        pools = sources.pools
        preResolvedNodes = sources.preResolvedNodes
        blockNumber = sources.block.number
        blockHash = sources.block.hash
        blockPolicy = sources.block.policy
        limitations = sources.limitations
        discovered = sources.poolCount
        hasMore = sources.hasMore
        nextCursor = sources.nextCursor
        tokenSymbol = sources.tokenMetadata.symbol
        pinDetail = `Block ${blockNumber}`
        discoveryDetail = sources.discovery.source === 'index+tail'
          ? `${discovered} pools · index verified + recent tail · ${sources.discovery.requests} reads`
          : `${discovered} pools · bounded log fallback · ${sources.discovery.requests} reads`
        resolveDetail = `${subjects.length} unique codehashes`
        patchPhase('pin', { status: 'completed', completed: 1, detail: pinDetail })
        patchPhase('discover', { status: 'completed', completed: 1, detail: discoveryDetail })
        patchPhase('resolve', { status: 'completed', completed: 1, detail: resolveDetail })
      }

      setState((current) => ({ ...current, progress: 43, detail: 'Mapping reachable bytecode behavior' }))
      patchPhase('static', { status: 'running', total: subjects.length })
      const staticResult = await runStaticWorker({
        scanId,
        subjects,
        signal: controller.signal,
        onProgress: (completed, total, detail) => {
          patchPhase('static', { status: 'running', completed, total, detail })
          setState((current) => ({ ...current, progress: 43 + Math.round((completed / Math.max(total, 1)) * 27), detail }))
        },
      })
      let sourceCoverage: SourceAnalysisCoverage | undefined
      if (!isFixture) {
        setState((current) => ({ ...current, progress: 69, detail: 'Running verified-source passes where available' }))
        sourceCoverage = await runVerifiedSourceAnalysis({
          chainId: chain.id,
          nodes: preResolvedNodes,
          subjects,
          signal: controller.signal,
          onProgress: (completed, total, detail) => {
            patchPhase('static', { status: 'running', completed: subjects.length + completed, total: subjects.length + total, detail })
            setState((current) => ({ ...current, detail }))
          },
        })
        limitations.push(...sourceCoverage.limitations)
      }
      patchPhase('static', {
        status: 'completed',
        completed: subjects.length + (sourceCoverage?.compiled ?? 0),
        total: subjects.length + (sourceCoverage?.attempted ?? 0),
        detail: sourceCoverage?.attempted
          ? `${subjects.length} bytecode identities · ${sourceCoverage.compiled}/${sourceCoverage.attempted} exact-source AST passes`
          : `${subjects.length} bytecode identities · no verified source bundle selected`,
      })

      const mobile = currentClientUsesStaticOnlyMobileTier()
      const executionReason = mobile
        ? 'Mobile v1 provides discovery and static behavior mapping only.'
        : chain.deepExecution
          ? 'No selected pool has a pinned historical context available for browser replay.'
          : chain.limitation ?? 'Deep execution is awaiting chain conformance.'
      let executionProof: RevmExecutionProof | undefined
      let exploration: RevmExploration | undefined
      let liveReplay: LivePoolReplayCoverage | undefined
      let liveRouterScenarios: LiveRouterScenarioCoverage | undefined
      let liveForkExploration: LiveForkExplorationCoverage | undefined
      let routerContexts: HistoricalRouterContexts | undefined
      let routerContextFailure: string | undefined
      let protocolScenarios: ProtocolScenarioCoverage | undefined
      let protocolExploration: ProtocolExplorationCoverage | undefined
      let erc20Lane: Erc20LaneCoverage | undefined
      /** Why the ERC-20 lane produced nothing, when it threw rather than reporting. */
      let erc20LaneFailure: string | undefined
      let pinnedBlockContext: { timestamp: bigint; baseFeePerGas: bigint | null; gasLimit: bigint; miner: Address } | undefined
      let historicalReplayFailure = 'Historical replay did not run.'
      let generatedFailure: string | undefined
      let fixtureHydration: ForkReplayResult | undefined
      let fixtureReuseHydrationRequests: number | undefined
      let hackenSuite: HackenSuiteResult | undefined
      let hackenEvidence: Evidence[] = []
      if (isFixture && !mobile) {
        patchPhase('replay', { status: 'running', detail: 'Executing the deterministic storage fixture in revm Wasm' })
        setState((current) => ({ ...current, progress: 74, detail: 'Reproducing a state change in revm Wasm' }))
        executionProof = await runRevmProof({ scanId, bytecode: REVM_EXECUTION_FIXTURE.subject.bytecode, signal: controller.signal })
        patchPhase('replay', { status: 'running', detail: 'Verifying typed account and storage hydration' })
        const fixtureTransaction = {
            caller: FIXTURE_CALLER,
            to: FIXTURE_TARGET,
            calldata: '0x',
            value: 0n,
            gasLimit: 2_000_000n,
            gasPrice: 0n,
            nonce: 0,
            chainId: 1,
          } as const
        const fixtureBlock = {
            number: 2n,
            beneficiary: ZERO_ADDRESS,
            timestamp: 1n,
            gasLimit: 30_000_000n,
            baseFee: 0n,
            difficulty: 0n,
            prevrandao: `0x${'0'.repeat(64)}` as Hex,
          } as const
        const fixtureSession = new ForkExecutionSession({
          scanId: `${scanId}-fixture-session`,
          client: fixtureHydrationClient(),
          stateBlockNumber: 1n,
        })
        try {
          fixtureHydration = await fixtureSession.execute({
            transaction: fixtureTransaction,
            block: fixtureBlock,
            signal: controller.signal,
            timeoutMs: 10_000,
            maxHydrationRequests: 32,
          })
          const reused = await fixtureSession.execute({
            transaction: fixtureTransaction,
            block: fixtureBlock,
            signal: controller.signal,
            timeoutMs: 10_000,
            maxHydrationRequests: 32,
          })
          fixtureReuseHydrationRequests = reused.hydrationRequests
          if (reused.hydrationRequests !== 0) throw new Error('The reusable fork snapshot requested state again on an identical execution.')
        } finally {
          fixtureSession.close()
        }
        if (!fixtureHydration.proof.storageOperations.some((operation) => operation.opcode === 'SLOAD')) {
          throw new Error('The deterministic fork hydration fixture did not reproduce its storage read.')
        }
        patchPhase('replay', { status: 'completed', completed: 2, total: 2, detail: `${executionProof.steps.length} instructions · ${fixtureHydration.hydrationRequests} cold reads · ${fixtureReuseHydrationRequests} warm reads` })

        patchPhase('scenarios', { status: 'running', detail: 'Loading the generated PoolManager fixture' })
        setState((current) => ({ ...current, progress: 78, detail: 'Running the Hacken scenario port through PoolManager' }))
        const [scenarioModule, fixtureModule] = await Promise.all([
          import('../../analysis/hackenScenarios'),
          import('../../fixtures/hackenBrowserFixture'),
        ])
        const workerBudget = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1))
        const scenarioTotal = scenarioModule.buildHackenScenarios(fixtureModule.HACKEN_FIXTURE_CONTEXT).length
        patchPhase('scenarios', { status: 'running', total: scenarioTotal, detail: 'Starting PoolManager scenario workers' })
        hackenSuite = await scenarioModule.runHackenBrowserSuite({
          context: fixtureModule.HACKEN_FIXTURE_CONTEXT,
          snapshot: fixtureModule.hackenFixtureSnapshot(),
          signal: controller.signal,
          maxWorkers: workerBudget,
          onProgress: (completed, total, detail) => {
            patchPhase('scenarios', { status: 'running', completed, total, detail })
            setState((current) => ({ ...current, detail: `PoolManager scenarios · ${detail}` }))
          },
        })
        hackenEvidence = scenarioModule.hackenSuiteEvidence(hackenSuite, fixtureModule.HACKEN_FIXTURE_CONTEXT)
        if (hackenSuite.failed > 0) throw new Error(`${hackenSuite.failed} generated PoolManager scenario assertion(s) did not match.`)
        patchPhase('scenarios', {
          status: 'completed',
          completed: hackenSuite.scenarios.length,
          total: hackenSuite.scenarios.length,
          detail: `${hackenSuite.executions} real PoolManager executions · ${hackenSuite.elapsedMs} ms`,
        })
        patchPhase('fuzz', { status: 'running', total: 30_000, detail: 'Exploring a deterministic bounded input corpus' })
        setState((current) => ({ ...current, progress: 80, detail: 'Exploring calldata-dependent execution edges' }))
        exploration = await runParallelRevmExploration({
          scanId,
          bytecode: REVM_EXPLORATION_FIXTURE.subject.bytecode,
          maxExecutions: 30_000,
          timeoutMs: 30_000,
          maxWorkers: workerBudget,
          signal: controller.signal,
          onProgress: (completed, total, detail) => {
            patchPhase('fuzz', { status: 'running', completed, total, detail })
            setState((current) => ({ ...current, detail: `Bounded input workers · ${detail}` }))
          },
        })
        patchPhase('fuzz', {
          status: 'completed',
          completed: exploration.executions,
          total: 30_000,
          detail: `${exploration.coverageEdges} execution edges · ${exploration.elapsedMs} ms`,
        })
      } else if (!mobile && chain.deepExecution && chain.poolManager && pools.length > 0) {
        const client = scanClient ?? createScanRpcClient({ client: getPublicClient(chain), signal: controller.signal }).client
        const hydrationCache = createForkHydrationCache(client)
        const poolManager = chain.poolManager
        const workerBudget = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1))

        // 1. Historical replay. Independent and optional: it reproduces onchain
        //    transactions, and everything below is generated, so a replay that
        //    cannot run must degrade its own phase rather than the scan.
        patchPhase('replay', { status: 'running', completed: 0, total: pools.length, detail: 'Validating indexed transaction contexts' })
        setState((current) => ({ ...current, progress: 72, detail: 'Replaying pinned PoolManager transactions in revm' }))
        try {
          liveReplay = await runLivePoolReplays({
            scanId,
            client,
            chainId: chain.id,
            poolManager,
            pinnedBlockNumber: blockNumber,
            pools,
            signal: controller.signal,
            replay: (replayInput) => runForkReplay({
              ...replayInput,
              loadHydration: (request) => hydrationCache.load(replayInput.stateBlockNumber, request),
            }),
            onProgress: (completed, total, detail) => {
              patchPhase('replay', { status: 'running', completed, total, detail })
              setState((current) => ({ ...current, detail: `Historical replay · ${detail}` }))
            },
          })
          patchPhase('replay', {
            status: liveReplay.status === 'passed' ? 'completed' : 'degraded',
            completed: liveReplay.passedTransactions,
            total: liveReplay.candidateTransactions,
            detail: phaseCoverageDetail(
              `${liveReplay.coveredPools}/${liveReplay.selectedPools} pools · ${liveReplay.passedTransactions}/${liveReplay.candidateTransactions} transactions matched`,
              liveReplay.status,
              liveReplay.limitations,
            ),
          })
        } catch (error) {
          if (controller.signal.aborted) throw error
          historicalReplayFailure = error instanceof Error ? error.message : String(error)
          patchPhase('replay', { status: 'degraded', detail: `Historical replay unavailable · ${historicalReplayFailure}` })
        }

        // 1b. Recognize the routers behind the receipt-matched replays, once.
        //     Both later historical phases consume this, so a router's runtime
        //     is read at most once per scan and both phases necessarily agree
        //     on whether it was recognized.
        if (liveReplay) {
          patchPhase('scenarios', { status: 'running', detail: 'Recognizing historical v4 router contexts' })
          try {
            routerContexts = await prepareHistoricalRouterContexts({
              replay: liveReplay,
              pools,
              poolManager,
              loadHydration: (stateBlockNumber, request) => hydrationCache.load(stateBlockNumber, request),
              signal: controller.signal,
            })
          } catch (error) {
            if (controller.signal.aborted) throw error
            // Recognition is optional: exact replay stands without it.
            routerContextFailure = error instanceof Error ? error.message : String(error)
            routerContexts = undefined
          }
        }

        // 2. Generated PoolManager scenarios. These need a discovered pool and
        //    pinned reads, nothing else: not a replay result, not a recognized
        //    router, not historical calldata, not a PositionManager attribution.
        patchPhase('generated', { status: 'running', detail: 'Injecting the pinned scenario harness at pinned state' })
        setState((current) => ({ ...current, progress: 78, detail: 'Executing generated PoolManager scenarios' }))
        try {
          const pinned = await client.getBlock({ blockNumber })
          protocolScenarios = await runProtocolScenarios({
            scanId,
            client,
            chainId: chain.id,
            poolManager,
            pools,
            stateBlockNumber: blockNumber,
            pinnedBlock: {
              timestamp: pinned.timestamp,
              baseFeePerGas: pinned.baseFeePerGas,
              gasLimit: pinned.gasLimit,
              miner: pinned.miner ?? ZERO_ADDRESS,
            },
            signal: controller.signal,
            createSession: (options) => new ForkExecutionSession({
              ...options,
              loadHydration: (request) => hydrationCache.load(options.stateBlockNumber, request),
            }),
            resolveSelectorSignatures: (selectors, signal) => fetchSourcify4ByteSignatures(selectors, signal),
            onProgress: (completed, total, detail) => {
              patchPhase('generated', { status: 'running', completed, total, detail })
              setState((current) => ({ ...current, detail: `Generated scenarios · ${detail}` }))
            },
          })
          pinnedBlockContext = {
            timestamp: pinned.timestamp,
            baseFeePerGas: pinned.baseFeePerGas,
            gasLimit: pinned.gasLimit,
            miner: pinned.miner ?? ZERO_ADDRESS,
          }
          patchPhase('generated', protocolScenarioPhase(protocolScenarios))
        } catch (error) {
          if (controller.signal.aborted) throw error
          generatedFailure = error instanceof Error ? error.message : String(error)
          patchPhase('generated', { status: 'degraded', detail: `Generated scenarios unavailable · ${generatedFailure}` })
        }

        // 2b. The ERC-20 settlement lane, run beside the claims baseline.
        //
        //     Token-funded cases use a verified historical holder. Native-first
        //     cases use the bounded synthetic actor and need no token-specific
        //     mapping or historical holder before buying through the real pool.
        if (protocolScenarios?.contexts.length) {
          patchPhase('generated', { status: 'running', detail: 'Settling generated scenarios through the real token path' })
          try {
            erc20Lane = await runErc20LaneCoverage({
              scanId,
              contexts: protocolScenarios.contexts,
              claimsOutcomes: protocolScenarios.outcomes,
              replay: liveReplay,
              readPayerCode: async (address, stateBlockNumber) => {
                const update = await hydrationCache.load(stateBlockNumber, { kind: 'account', address })
                return update.kind === 'account' && update.account.exists ? update.account.code : undefined
              },
              signal: controller.signal,
              createSession: (options) => new ForkExecutionSession({
                scanId: options.scanId,
                client,
                stateBlockNumber: options.stateBlockNumber,
                snapshot: options.snapshot,
                loadHydration: (request) => hydrationCache.load(options.stateBlockNumber, request),
              }),
              onProgress: (completed, total, detail) => {
                patchPhase('generated', { status: 'running', completed, total, detail })
                setState((current) => ({ ...current, detail: `ERC-20 settlement lane · ${detail}` }))
              },
            })
            patchPhase('generated', generatedPhase(protocolScenarios, erc20Lane, undefined))
          } catch (error) {
            if (controller.signal.aborted) throw error
            // The claims baseline stands, so this must not retract it — but the
            // fault is recorded rather than swallowed, or the phase would look
            // clean while a whole lane silently produced nothing.
            erc20LaneFailure = error instanceof Error ? error.message : String(error)
            erc20Lane = undefined
            patchPhase('generated', generatedPhase(protocolScenarios, undefined, erc20LaneFailure))
          }
        }

        // 3. Historical-router variants. Extra evidence layered on a replay that
        //    matched its receipt, so this one legitimately depends on step 1.
        patchPhase('scenarios', { status: 'running', detail: 'Running controlled historical-router variants' })
        setState((current) => ({ ...current, progress: 82, detail: 'Running controlled historical-router variants through PoolManager' }))
        if (liveReplay) {
          liveRouterScenarios = await runLiveRouterScenarios({
            scanId,
            client,
            poolManager,
            pools,
            replay: liveReplay,
            routerContexts,
            signal: controller.signal,
            maxWorkers: workerBudget,
            createSession: (options) => new ForkExecutionSession({
              ...options,
              loadHydration: (request) => hydrationCache.load(options.stateBlockNumber, request),
            }),
            onProgress: (completed, total, detail) => {
              patchPhase('scenarios', { status: 'running', completed, total, detail })
              setState((current) => ({ ...current, detail: `Historical router context · ${detail}` }))
            },
          })
          patchPhase('scenarios', {
            status: liveRouterScenarios.status === 'passed' ? 'completed' : 'degraded',
            completed: liveRouterScenarios.scenarios,
            total: liveRouterScenarios.scenarios,
            detail: phaseCoverageDetail(
              `${liveRouterScenarios.executions} router → PoolManager scenarios · ${liveRouterScenarios.hydrationReads} logical pinned reads · ${hydrationCache.metrics().hits} reads reused · ${liveRouterScenarios.positionLookups.resolved}/${liveRouterScenarios.positionLookups.reads} position lookups`,
              liveRouterScenarios.status,
              routerContextFailure
                ? [`Historical router recognition failed: ${routerContextFailure}`, ...liveRouterScenarios.limitations]
                : liveRouterScenarios.limitations,
            ),
          })
        } else {
          patchPhase('scenarios', { status: 'degraded', detail: `Historical-router variants need a receipt-matched replay · ${historicalReplayFailure}` })
        }

        // 4. Bounded exploration of generated calldata, seeded by step 2.
        patchPhase('fuzz', { status: 'running', completed: 0, detail: 'Mutating masked generated scenario calldata at pinned state' })
        setState((current) => ({ ...current, progress: 85, detail: 'Exploring masked generated inputs against pinned pool state' }))
        if (pinnedBlockContext) {
          protocolExploration = await runProtocolScenarioExploration({
            scanId,
            client,
            chainId: chain.id,
            poolManager,
            pools,
            stateBlockNumber: blockNumber,
            pinnedBlock: pinnedBlockContext,
            contexts: protocolScenarios?.contexts,
            // Shapes the scenario suite already proved reach the selected pool
            // at this block skip a redundant warm run; anything absent here is
            // validated by exploration itself.
            validatedScenarioIds: new Set(
              (protocolScenarios?.outcomes ?? [])
                .filter((outcome) => outcome.status === 'completed' || outcome.status === 'reverted')
                .map((outcome) => outcome.scenarioId),
            ),
            signal: controller.signal,
            createSession: (options) => new ForkExplorationSession({
              ...options,
              loadHydration: (request) => hydrationCache.load(options.stateBlockNumber, request),
            }),
            onProgress: (completed, total, detail) => {
              patchPhase('fuzz', { status: 'running', completed, total, detail })
              setState((current) => ({ ...current, detail: `Generated exploration · ${detail}` }))
            },
          })
        }

        // 5. Historical-router exploration. Extra evidence, again replay-derived,
        //    and using exactly the recognition decision phase 3 used.
        setState((current) => ({ ...current, progress: 88, detail: 'Exploring masked historical-router inputs' }))
        if (liveReplay) {
          liveForkExploration = await runLiveForkExploration({
            scanId,
            client,
            poolManager,
            pools,
            replay: liveReplay,
            routerContexts,
            signal: controller.signal,
            maxWorkers: workerBudget,
            createSession: (options) => new ForkExplorationSession({
              ...options,
              loadHydration: (request) => hydrationCache.load(options.stateBlockNumber, request),
            }),
            onProgress: (completed, total, detail) => {
              patchPhase('fuzz', { status: 'running', completed, total, detail })
              setState((current) => ({ ...current, detail: `Hydrated fork exploration · ${detail}` }))
            },
          })
        }
        patchPhase('fuzz', explorationPhase(protocolExploration, liveForkExploration, historicalReplayFailure))
      } else {
        patchPhase('replay', { status: 'degraded', detail: executionReason })
        for (const phase of ['generated', 'scenarios', 'fuzz'] as const) patchPhase(phase, { status: 'degraded', detail: executionReason })
      }
      setState((current) => ({ ...current, progress: 92, detail: 'Normalizing evidence and capability coverage' }))
      patchPhase('report', { status: 'running' })

      const completedAt = new Date().toISOString()
      const harness = scenarioHarnessIdentity()

      // Joined evidence, computed last because every rule needs the layers below
      // it. A rule fires only when its stated requirements are all met, so an
      // empty result means the evidence did not support a joined claim.
      const layeredFindings: Evidence[] = [
        ...staticResult.findings,
        ...(sourceCoverage?.findings ?? []),
        ...(protocolScenarios?.findings ?? []),
        ...(liveRouterScenarios?.findings ?? []),
      ]
      const combined = [...new Map(
        subjects.map((item) => [item.address.toLowerCase(), item.address]),
      ).values()].flatMap((address) => combinedFindings({
        subject: address,
        affectedPools: pools.map((item) => item.poolId),
        findings: layeredFindings.filter((finding) => finding.subject.toLowerCase() === address.toLowerCase()),
      }))
      const finalPhases = basePhases().map((phase) => {
        if (phase.id === 'static') return {
          ...phase,
          status: sourceCoverage && sourceCoverage.compiled < sourceCoverage.attempted ? 'degraded' as const : 'completed' as const,
          completed: subjects.length + (sourceCoverage?.compiled ?? 0),
          total: subjects.length + (sourceCoverage?.attempted ?? 0),
          detail: sourceCoverage?.attempted
            ? `${subjects.length} bytecode identities · ${sourceCoverage.compiled}/${sourceCoverage.attempted} exact-source AST passes`
            : `${subjects.length} bytecode identities · no verified source bundle selected`,
        }
        if (phase.id === 'pin') return { ...phase, status: 'completed' as const, completed: 1, detail: pinDetail }
        if (phase.id === 'discover') return { ...phase, status: 'completed' as const, completed: 1, detail: discoveryDetail }
        if (phase.id === 'resolve') return { ...phase, status: 'completed' as const, completed: 1, detail: resolveDetail }
        if (phase.id === 'report') return { ...phase, status: 'completed' as const, completed: 1 }
        if (phase.id === 'replay' && executionProof) return { ...phase, status: 'completed' as const, completed: fixtureHydration ? 2 : 1, total: fixtureHydration ? 2 : 1, detail: fixtureHydration ? `${executionProof.steps.length} instructions · ${fixtureHydration.hydrationRequests} cold reads · ${fixtureReuseHydrationRequests ?? 0} warm reads` : `${executionProof.steps.length} instructions observed in revm Wasm` }
        if (phase.id === 'replay' && liveReplay) return {
          ...phase,
          status: liveReplay.status === 'passed' ? 'completed' as const : 'degraded' as const,
          completed: liveReplay.passedTransactions,
          total: liveReplay.candidateTransactions,
          detail: phaseCoverageDetail(
            `${liveReplay.coveredPools}/${liveReplay.selectedPools} pools · ${liveReplay.passedTransactions}/${liveReplay.candidateTransactions} transactions matched`,
            liveReplay.status,
            liveReplay.limitations,
          ),
        }
        if (phase.id === 'generated' && protocolScenarios) {
          return { ...phase, ...generatedPhase(protocolScenarios, erc20Lane, erc20LaneFailure) }
        }
        if (phase.id === 'generated' && !isFixture) return {
          ...phase,
          status: 'degraded' as const,
          detail: generatedFailure ? `Generated scenarios unavailable · ${generatedFailure}` : executionReason,
        }
        if (phase.id === 'scenarios' && hackenSuite) return { ...phase, status: 'completed' as const, completed: hackenSuite.scenarios.length, total: hackenSuite.scenarios.length, detail: `${hackenSuite.executions} real PoolManager executions · ${hackenSuite.elapsedMs} ms` }
        if (phase.id === 'scenarios' && liveRouterScenarios) return {
          ...phase,
          status: liveRouterScenarios.status === 'passed' ? 'completed' as const : 'degraded' as const,
          completed: liveRouterScenarios.scenarios,
          total: liveRouterScenarios.scenarios,
          detail: phaseCoverageDetail(
            `${liveRouterScenarios.executions} router → PoolManager scenarios · ${liveRouterScenarios.hydrationReads} logical pinned reads · ${liveRouterScenarios.positionLookups.resolved}/${liveRouterScenarios.positionLookups.reads} position lookups`,
            liveRouterScenarios.status,
            routerContextFailure
              ? [`Historical router recognition failed: ${routerContextFailure}`, ...liveRouterScenarios.limitations]
              : liveRouterScenarios.limitations,
          ),
        }
        if (phase.id === 'fuzz' && exploration) return { ...phase, status: 'completed' as const, completed: exploration.executions, total: 30_000, detail: `${exploration.coverageEdges} execution edges · ${exploration.elapsedMs} ms` }
        if (phase.id === 'fuzz' && (protocolExploration || liveForkExploration)) return {
          ...phase,
          ...explorationPhase(protocolExploration, liveForkExploration, historicalReplayFailure),
        }
        return { ...phase, status: 'degraded' as const, detail: executionReason }
      })
      const exploredFinding = explorationFinding(exploration, pools[0]?.poolId)
      const report: AnalysisReport = {
        schemaVersion: '1',
        id: crypto.randomUUID(),
        source: 'browser',
        status: 'completed',
        partial: false,
        chainId: chain.id,
        chainName: chain.name,
        token: getAddress(token),
        tokenSymbol,
        blockNumber: blockNumber.toString(),
        blockHash,
        blockTagPolicy: blockPolicy,
        createdAt: completedAt,
        elapsedMs: Math.round(performance.now() - startedAt),
        adapterVersion: ADAPTER_VERSION,
        scenarioVersion: hackenSuite
          ? `${hackenSuite.version}@${hackenSuite.upstreamCommit}`
          // Either live suite makes this a live report. Historical replay can
          // fail while generated scenarios pass, and stamping the fixture
          // version there would make a current public report look outdated.
          : liveRouterScenarios || protocolScenarios || protocolExploration
            ? LIVE_SCENARIO_VERSION
            : FIXTURE_SCENARIO_VERSION,
        engineVersions: {
          whatsabi: '0.27.0',
          evmole: '0.9.3',
          revm: '36.0.0',
          solc: sourceCoverage?.compilerVersions.join(',') || 'not-run',
          sourceRules: '0.2.0',
          hackenPort: hackenSuite?.version ?? 'not-run',
          hackenPublicPort: protocolScenarios?.publicHackenVersion ?? 'not-run',
          inputExplorer: exploration?.strategy ?? liveForkExploration?.strategy ?? 'libafl-worker-fanout-corpus-exchange/0.2.0',
          rules: '0.3.0',
          generatedScenarios: protocolScenarios?.version ?? 'not-run',
          erc20SettlementLane: erc20Lane?.version ?? 'not-run',
          generatedExplorer: protocolExploration?.strategy ?? 'not-run',
          signatureResolver: protocolScenarios ? 'sourcify-4byte/v1' : 'not-run',
          ...(protocolScenarios || protocolExploration
            ? {
                scenarioHarness: `${harness.contract}@${harness.templateHash}`,
                scenarioHarnessSource: harness.sourceHash,
                scenarioHarnessCompiler: harness.compiler,
                uniswapV4Core: harness.uniswapCore,
                uniswapV4Periphery: harness.uniswapPeriphery,
                poolManagerStorageLayout: harness.poolManagerStorageLayout,
              }
            : {}),
        },
        capabilities: {
          discovery: { supported: true, status: 'passed', verifiedAt: completedAt },
          static: sourceCoverage && sourceCoverage.compiled < sourceCoverage.attempted
            ? { supported: true, status: 'degraded', reason: `${sourceCoverage.compiled}/${sourceCoverage.attempted} verified-source AST passes completed; bytecode analysis completed for every codehash.` }
            : { supported: true, status: 'passed', verifiedAt: completedAt },
          replay: executionProof
            ? { supported: true, status: 'passed', verifiedAt: completedAt }
            : liveReplay
              ? liveReplay.status === 'passed'
                ? { supported: true, status: 'passed', verifiedAt: completedAt }
                : { supported: true, status: 'degraded', reason: liveReplay.limitations.join(' ') || 'Historical replay coverage was incomplete.' }
            : { supported: false, status: 'degraded', reason: executionReason },
          generated: protocolScenarios
            ? protocolScenarios.status === 'passed' && erc20Lane?.status === 'passed'
              ? { supported: true, status: 'passed', verifiedAt: completedAt }
              : {
                  supported: true,
                  status: 'degraded',
                  // Names whichever lane actually fell short, so "degraded" is
                  // never an unexplained label.
                  reason: protocolScenarios.status !== 'passed'
                    ? protocolScenarios.limitations[0] ?? 'Generated scenario coverage was incomplete.'
                    : erc20LaneFailure
                      ? `The ERC-20 settlement lane failed: ${erc20LaneFailure}`
                      : erc20Lane?.limitations[0]
                        ?? 'The ERC-20 settlement lane did not run, so only ERC-6909 claims settlement was exercised.',
                }
            : { supported: false, status: 'degraded', reason: generatedFailure ?? executionReason },
          fuzz: exploration
            ? { supported: true, status: 'passed', verifiedAt: completedAt }
            : protocolExploration || liveForkExploration
              ? protocolExploration?.status === 'passed' && liveForkExploration?.status === 'passed'
                ? { supported: true, status: 'passed', verifiedAt: completedAt }
                : {
                    supported: true,
                    status: 'degraded',
                    reason: protocolExploration?.limitations[0]
                      ?? liveForkExploration?.limitations[0]
                      ?? 'Coverage-guided exploration did not cover every hooked pool.',
                  }
              : { supported: false, status: 'degraded', reason: executionReason },
        },
        pools,
        poolCoverage: { discovered, analyzed: pools.length, hasMore, nextCursor },
        contractGraph: mergeNodes(preResolvedNodes, staticResult.nodes),
        findings: [
          ...staticResult.findings,
          ...(sourceCoverage?.findings ?? []),
          ...(executionProof ? [revmFinding(executionProof, pools[0]?.poolId)] : []),
          ...(fixtureHydration ? [fixtureHydrationFinding(fixtureHydration, pools[0]?.poolId)] : []),
          ...hackenEvidence,
          ...(liveReplay?.findings ?? []),
          ...(protocolScenarios?.findings ?? []),
          ...(erc20Lane?.findings ?? []),
          ...(liveRouterScenarios?.findings ?? []),
          ...(protocolExploration?.findings ?? []),
          ...(liveForkExploration?.findings ?? []),
          ...(exploredFinding ? [exploredFinding] : []),
          ...combined,
        ],
        phases: finalPhases,
        scenarios: hackenSuite
          ? { completed: hackenSuite.scenarios.length, total: hackenSuite.scenarios.length }
          : protocolScenarios || liveRouterScenarios
            ? {
                completed: (protocolScenarios?.completed ?? 0) + (liveRouterScenarios?.scenarios ?? 0),
                total: (protocolScenarios?.scenarios ?? 0) + (liveRouterScenarios?.scenarios ?? 0),
              }
            : { completed: 0, total: 0 },
        coverage: {
          uniqueCodeHashes: subjects.length,
          paths: staticResult.paths,
          executions: (executionProof ? 1 : 0) + (liveReplay?.passedTransactions ?? 0) + (liveRouterScenarios?.executions ?? 0) + (hackenSuite?.executions ?? 0) + (exploration?.executions ?? 0) + (liveForkExploration?.executions ?? 0) + (protocolScenarios?.completed ?? 0) + (protocolExploration?.executions ?? 0) + (erc20Lane?.completed ?? 0),
          branches: staticResult.branches,
        },
        limitations: [
          ...limitations,
          ...(staticResult.limitations ?? []),
          ...(isFixture && !mobile
            ? ['This deterministic example validates the browser engines; public-chain fork execution still requires per-chain conformance.']
            : liveReplay || protocolScenarios || protocolExploration
              ? [
                  ...(liveReplay?.limitations ?? [`Historical replay did not run · ${historicalReplayFailure}`]),
                  ...(routerContexts?.limitations ?? []),
                  ...(routerContextFailure ? [`Historical router recognition failed: ${routerContextFailure}`] : []),
                  ...(protocolScenarios?.limitations ?? []),
                  ...(erc20Lane?.limitations ?? []),
                  ...(erc20LaneFailure ? [`The ERC-20 settlement lane failed and produced no token-path evidence: ${erc20LaneFailure}`] : []),
                  ...(liveRouterScenarios?.limitations ?? []),
                  ...(protocolExploration?.limitations ?? []),
                  ...(liveForkExploration?.limitations ?? []),
                ]
            : [executionReason]),
        ],
      }
      patchPhase('report', { status: 'completed', completed: 1 })
      if (controller.signal.aborted) throw new DOMException('Analysis cancelled', 'AbortError')
      const persistence = await persistCompletedReport(report)
      setState({ status: 'completed', progress: 100, detail: 'Completed', phases: finalPhases, report, history: cached, persistence })
      abortRef.current = null
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setState((current) => ({ ...current, status: 'failed', error: error instanceof Error ? error.message : String(error), detail: undefined }))
      abortRef.current = null
    }
  }, [patchPhase])

  return { state, discover, analyze, cancel }
}
