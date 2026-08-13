import { useCallback, useRef, useState } from 'react'
import { getAddress, type Address, type Hex, type PublicClient } from 'viem'
import { runStaticWorker } from '../../analysis/staticWorkerClient'
import {
  ForkExecutionSession,
  runParallelRevmExploration,
  runRevmProof,
  type ForkReplayResult,
  type RevmExecutionProof,
  type RevmExploration,
} from '../../analysis/revmProof'
import { runLivePoolReplays, type LivePoolReplayCoverage } from '../../analysis/livePoolReplay'
import { runLivePoolScenarios, type LivePoolScenarioCoverage } from '../../analysis/livePoolScenarios'
import { runLiveRouterScenarios, type LiveRouterScenarioCoverage } from '../../analysis/liveRouterScenarios'
import { runVerifiedSourceAnalysis, type SourceAnalysisCoverage } from '../../analysis/liveSourceAnalysis'
import { getChainConfig } from '../../config/chains'
import { loadScanSources } from '../../data/loadScan'
import { loadReports, persistCompletedReport } from '../../data/reports'
import { validateCompletedReportCurrentness, type CompletedReportCurrentness } from '../../data/reportCurrentness'
import { getPublicClient } from '../../data/rpc'
import { parseTokenAddress } from '../../domain/address'
import type { AnalysisPhase, AnalysisReport, ContractNode, Evidence, PoolDescriptor, StaticSubject } from '../../domain/report'
import type { HackenSuiteResult } from '../../analysis/hackenScenarios'
import {
  FIXTURE_SCAN_ADDRESS,
  REVM_EXECUTION_FIXTURE,
  REVM_EXPLORATION_FIXTURE,
  STATIC_FIXTURES,
} from '../../fixtures/bytecode'

export type AnalyzerState = {
  status: 'idle' | 'cache' | 'running' | 'completed' | 'cancelled' | 'failed'
  detail?: string
  progress: number
  phases: AnalysisPhase[]
  report?: AnalysisReport
  history: AnalysisReport[]
  persistence?: 'remote' | 'local-only'
  currentnessStatus?: 'checking' | 'checked'
  currentness?: CompletedReportCurrentness
  error?: string
}

const phaseLabels: Record<AnalysisPhase['id'], string> = {
  pin: 'Pin block',
  discover: 'Discover pools',
  resolve: 'Resolve contracts',
  static: 'Map bytecode behavior',
  replay: 'Replay transactions',
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

  const analyze = useCallback(async (input: { chainId: number; token: string; force?: boolean; poolCursor?: string }) => {
    abortRef.current?.abort()
    let token: Address
    try {
      token = parseTokenAddress(input.token)
    } catch (error) {
      setState({ status: 'failed', progress: 0, phases: basePhases(), history: [], error: error instanceof Error ? error.message : String(error) })
      return
    }

    const chain = getChainConfig(input.chainId)
    setState({ status: 'cache', detail: 'Checking completed reports', progress: 0, phases: basePhases(), history: [] })
    const cached = await loadReports(chain.id, token)
    const newest = cached[0]
    if (newest && !input.force && !input.poolCursor) {
      if (newest.blockTagPolicy === 'deterministic-fixture') {
        setState({ status: 'completed', progress: 100, phases: newest.phases, report: newest, history: cached.slice(1) })
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
        history: cached.slice(1),
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
    setState({ status: 'running', detail: 'Pinning execution context', progress: 4, phases: basePhases(), history: cached })

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
      const isFixture = token.toLowerCase() === FIXTURE_SCAN_ADDRESS.toLowerCase()

      patchPhase('pin', { status: 'running' })
      if (isFixture) {
        const fixture = syntheticSources()
        subjects = fixture.subjects
        pools = fixture.pools
        preResolvedNodes = fixture.nodes
        blockNumber = fixture.blockNumber
        blockHash = fixture.blockHash
        blockPolicy = 'deterministic-fixture'
        limitations = fixture.limitations
        discovered = pools.length
        tokenSymbol = 'DEMO'
        patchPhase('pin', { status: 'completed', completed: 1 })
        patchPhase('discover', { status: 'completed', completed: 1, detail: `${pools.length} deterministic pools` })
        patchPhase('resolve', { status: 'completed', completed: 1, detail: `${subjects.length} codehash fixtures` })
      } else {
        const client = getPublicClient(chain)
        const sources = await loadScanSources({
          client,
          chain,
          token,
          poolCursor: input.poolCursor,
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
        patchPhase('pin', { status: 'completed', completed: 1, detail: `Block ${blockNumber}` })
        const discoveryDetail = sources.discovery.source === 'index+tail'
          ? `${discovered} pools · index verified + recent tail · ${sources.discovery.requests} reads`
          : `${discovered} pools · bounded log fallback · ${sources.discovery.requests} reads`
        patchPhase('discover', { status: 'completed', completed: 1, detail: discoveryDetail })
        patchPhase('resolve', { status: 'completed', completed: 1, detail: `${subjects.length} unique codehashes` })
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

      const mobile = matchMedia('(max-width: 720px)').matches
      const executionReason = mobile
        ? 'Mobile v1 provides discovery and static behavior mapping only.'
        : chain.deepExecution
          ? 'No selected pool has a pinned historical context available for browser replay.'
          : chain.limitation ?? 'Deep execution is awaiting chain conformance.'
      let executionProof: RevmExecutionProof | undefined
      let exploration: RevmExploration | undefined
      let liveReplay: LivePoolReplayCoverage | undefined
      let liveScenarios: LivePoolScenarioCoverage | undefined
      let liveRouterScenarios: LiveRouterScenarioCoverage | undefined
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
        const client = getPublicClient(chain)
        patchPhase('replay', { status: 'running', completed: 0, total: pools.length, detail: 'Validating indexed transaction contexts' })
        setState((current) => ({ ...current, progress: 74, detail: 'Replaying pinned PoolManager transactions in revm' }))
        liveReplay = await runLivePoolReplays({
          scanId,
          client,
          chainId: chain.id,
          poolManager: chain.poolManager,
          pinnedBlockNumber: blockNumber,
          pools,
          signal: controller.signal,
          onProgress: (completed, total, detail) => {
            patchPhase('replay', { status: 'running', completed, total, detail })
            setState((current) => ({ ...current, detail: `Historical replay · ${detail}` }))
          },
        })
        patchPhase('replay', {
          status: liveReplay.status === 'passed' ? 'completed' : 'degraded',
          completed: liveReplay.passedTransactions,
          total: liveReplay.candidateTransactions,
          detail: `${liveReplay.coveredPools}/${liveReplay.selectedPools} pools · ${liveReplay.passedTransactions}/${liveReplay.candidateTransactions} transactions matched`,
        })
        const workerBudget = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1))
        patchPhase('scenarios', { status: 'running', completed: 0, total: liveReplay.coveredPools, detail: 'Hydrating historical actor and router contexts' })
        setState((current) => ({ ...current, progress: 80, detail: 'Running enabled hook callbacks in reusable pinned snapshots' }))
        liveScenarios = await runLivePoolScenarios({
          scanId,
          client,
          poolManager: chain.poolManager,
          pools,
          replay: liveReplay,
          signal: controller.signal,
          maxWorkers: workerBudget,
          onProgress: (completed, total, detail) => {
            patchPhase('scenarios', { status: 'running', completed, total, detail })
            setState((current) => ({ ...current, detail: `Live callback context · ${detail}` }))
          },
        })
        patchPhase('scenarios', {
          status: liveScenarios.status === 'passed' ? 'completed' : 'degraded',
          completed: liveScenarios.scenarios,
          total: liveScenarios.scenarios,
          detail: `${liveScenarios.coveredPools}/${liveScenarios.eligiblePools} hooked pools · ${liveScenarios.executions} callback executions · ${liveScenarios.hydrationReads} pinned reads`,
        })
        patchPhase('scenarios', { status: 'running', detail: 'Recognizing official v4 router payloads and preserving settlement commands' })
        setState((current) => ({ ...current, progress: 84, detail: 'Running controlled official-router variants in reusable pinned snapshots' }))
        liveRouterScenarios = await runLiveRouterScenarios({
          scanId,
          client,
          poolManager: chain.poolManager,
          pools,
          replay: liveReplay,
          signal: controller.signal,
          maxWorkers: workerBudget,
          onProgress: (completed, total, detail) => {
            patchPhase('scenarios', {
              status: 'running',
              completed: liveScenarios!.scenarios + completed,
              total: liveScenarios!.scenarios + total,
              detail,
            })
            setState((current) => ({ ...current, detail: `Official router context · ${detail}` }))
          },
        })
        const liveScenarioStatus = liveScenarios.status === 'passed' && liveRouterScenarios.status === 'passed' ? 'completed' : 'degraded'
        patchPhase('scenarios', {
          status: liveScenarioStatus,
          completed: liveScenarios.scenarios + liveRouterScenarios.scenarios,
          total: liveScenarios.scenarios + liveRouterScenarios.scenarios,
          detail: `${liveScenarios.executions} callback observations · ${liveRouterScenarios.executions} controlled router variants · ${liveScenarios.hydrationReads + liveRouterScenarios.hydrationReads} pinned reads · ${liveRouterScenarios.positionLookups.resolved}/${liveRouterScenarios.positionLookups.reads} position lookups`,
        })
        patchPhase('fuzz', { status: 'degraded', detail: `${liveRouterScenarios.executions} controlled router variants completed; coverage-guided live fork mutation remains a later conformance gate.` })
      } else {
        patchPhase('replay', { status: 'degraded', detail: executionReason })
        for (const phase of ['scenarios', 'fuzz'] as const) patchPhase(phase, { status: 'degraded', detail: executionReason })
      }
      setState((current) => ({ ...current, progress: 88, detail: 'Normalizing evidence and capability coverage' }))
      patchPhase('report', { status: 'running' })

      const completedAt = new Date().toISOString()
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
        if (['pin', 'discover', 'resolve', 'report'].includes(phase.id)) return { ...phase, status: 'completed' as const, completed: 1 }
        if (phase.id === 'replay' && executionProof) return { ...phase, status: 'completed' as const, completed: fixtureHydration ? 2 : 1, total: fixtureHydration ? 2 : 1, detail: fixtureHydration ? `${executionProof.steps.length} instructions · ${fixtureHydration.hydrationRequests} cold reads · ${fixtureReuseHydrationRequests ?? 0} warm reads` : `${executionProof.steps.length} instructions observed in revm Wasm` }
        if (phase.id === 'replay' && liveReplay) return {
          ...phase,
          status: liveReplay.status === 'passed' ? 'completed' as const : 'degraded' as const,
          completed: liveReplay.passedTransactions,
          total: liveReplay.candidateTransactions,
          detail: `${liveReplay.coveredPools}/${liveReplay.selectedPools} pools · ${liveReplay.passedTransactions}/${liveReplay.candidateTransactions} transactions matched`,
        }
        if (phase.id === 'scenarios' && hackenSuite) return { ...phase, status: 'completed' as const, completed: hackenSuite.scenarios.length, total: hackenSuite.scenarios.length, detail: `${hackenSuite.executions} real PoolManager executions · ${hackenSuite.elapsedMs} ms` }
        if (phase.id === 'scenarios' && liveScenarios) return {
          ...phase,
          status: liveScenarios.status === 'passed' && liveRouterScenarios?.status === 'passed' ? 'completed' as const : 'degraded' as const,
          completed: liveScenarios.scenarios + (liveRouterScenarios?.scenarios ?? 0),
          total: liveScenarios.scenarios + (liveRouterScenarios?.scenarios ?? 0),
          detail: `${liveScenarios.executions} callback observations · ${liveRouterScenarios?.executions ?? 0} controlled router variants · ${liveScenarios.hydrationReads + (liveRouterScenarios?.hydrationReads ?? 0)} pinned reads · ${liveRouterScenarios?.positionLookups.resolved ?? 0}/${liveRouterScenarios?.positionLookups.reads ?? 0} position lookups`,
        }
        if (phase.id === 'fuzz' && exploration) return { ...phase, status: 'completed' as const, completed: exploration.executions, total: 30_000, detail: `${exploration.coverageEdges} execution edges · ${exploration.elapsedMs} ms` }
        if (liveReplay && phase.id === 'fuzz') return { ...phase, status: 'degraded' as const, detail: `${liveRouterScenarios?.executions ?? 0} controlled router variants completed; coverage-guided live fork mutation remains a later conformance gate.` }
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
        adapterVersion: 'uniswap-v4/0.1.0',
        scenarioVersion: hackenSuite
          ? `${hackenSuite.version}@${hackenSuite.upstreamCommit}`
          : liveScenarios
            ? 'hacken-live-router-context/0.3.0'
            : 'hacken-browser-port/0.5.0',
        engineVersions: {
          whatsabi: '0.15.3',
          sevm: '0.7.4',
          evmole: '0.9.3',
          revm: '36.0.0',
          solc: sourceCoverage?.compilerVersions.join(',') || 'not-run',
          sourceRules: '0.1.0',
          hackenPort: hackenSuite?.version ?? 'not-run',
          inputExplorer: exploration?.strategy ?? 'libafl-worker-fanout-corpus-exchange/0.2.0',
          rules: '0.2.0',
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
          fuzz: exploration
            ? { supported: true, status: 'passed', verifiedAt: completedAt }
            : { supported: false, status: 'degraded', reason: liveReplay ? `${liveRouterScenarios?.executions ?? 0} controlled official-router variants completed; coverage-guided mutation of the hydrated live fork is not yet enabled.` : executionReason },
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
          ...(liveScenarios?.findings ?? []),
          ...(liveRouterScenarios?.findings ?? []),
          ...(exploredFinding ? [exploredFinding] : []),
        ],
        phases: finalPhases,
        scenarios: hackenSuite
          ? { completed: hackenSuite.scenarios.length, total: hackenSuite.scenarios.length }
          : liveScenarios
            ? { completed: liveScenarios.scenarios + (liveRouterScenarios?.scenarios ?? 0), total: liveScenarios.scenarios + (liveRouterScenarios?.scenarios ?? 0) }
            : { completed: 0, total: 0 },
        coverage: {
          uniqueCodeHashes: subjects.length,
          paths: staticResult.paths,
          executions: (executionProof ? 1 : 0) + (liveReplay?.passedTransactions ?? 0) + (liveScenarios?.executions ?? 0) + (liveRouterScenarios?.executions ?? 0) + (hackenSuite?.executions ?? 0) + (exploration?.executions ?? 0),
          branches: staticResult.branches,
        },
        limitations: [
          ...limitations,
          ...(isFixture && !mobile
            ? ['This deterministic example validates the browser engines; public-chain fork execution still requires per-chain conformance.']
            : liveReplay
              ? [
                  ...liveReplay.limitations,
                  ...(liveScenarios?.limitations ?? []),
                  ...(liveRouterScenarios?.limitations ?? []),
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

  return { state, analyze, cancel }
}
