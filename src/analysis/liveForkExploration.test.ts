import { describe, expect, it, vi } from 'vitest'
import {
  bytesToHex,
  encodeAbiParameters,
  encodeFunctionData,
  hexToBytes,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { V4_ACTIONS, decodeUniswapV4Calldata, locateUniswapV4Operations } from '../adapters/uniswapV4RouterCodec'
import { computePoolId } from '../adapters/uniswapV4Pool'
import type { PoolDescriptor } from '../domain/report'
import type { LivePoolReplayCoverage } from './livePoolReplay'
import {
  poolScopedMutationMask,
  runLiveForkExploration,
  selectForkExplorationTargets,
} from './liveForkExploration'
import type { ForkExplorationEpoch, ForkReplayResult, RevmExplorationWitness } from './revmProof'
import { deriveUniswapV4MutationMask, isUniswapV4MaskedDerivative } from './uniswapV4MutationMask'

const CURRENCY0 = '0x0000000000000000000000000000000000000000' as Address
const CURRENCY1 = '0x1111111111111111111111111111111111111111' as Address
const HOOK = '0x2222222222222222222222222222222222222222' as Address
const OTHER_HOOK = '0x6666666666666666666666666666666666666666' as Address
const ACTOR = '0x3333333333333333333333333333333333333333' as Address
const ROUTER = '0x4444444444444444444444444444444444444444' as Address
const MANAGER = '0x5555555555555555555555555555555555555555' as Address
const ZERO_BYTES32 = `0x${'0'.repeat(64)}` as Hex

const POOL_KEY_COMPONENTS = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
] as const
const POOL_KEY_PARAMETER = { name: 'poolKey', type: 'tuple', components: POOL_KEY_COMPONENTS } as const
const SINGLE_IN_PARAMETERS = [{
  type: 'tuple',
  components: [
    POOL_KEY_PARAMETER,
    { name: 'zeroForOne', type: 'bool' },
    { name: 'amountIn', type: 'uint128' },
    { name: 'amountOutMinimum', type: 'uint128' },
    { name: 'hookData', type: 'bytes' },
  ],
}] as const
const ACTION_PLAN_PARAMETERS = [{ type: 'bytes' }, { type: 'bytes[]' }] as const
const EXECUTE_ABI = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable'])

const poolKey = { currency0: CURRENCY0, currency1: CURRENCY1, fee: 3_000, tickSpacing: 60, hooks: HOOK }
const otherPoolKey = { currency0: CURRENCY0, currency1: CURRENCY1, fee: 500, tickSpacing: 10, hooks: OTHER_HOOK }
const poolId = computePoolId({ ...poolKey, hook: HOOK })
const otherPoolId = computePoolId({ ...otherPoolKey, hook: OTHER_HOOK })

const pool: PoolDescriptor = {
  poolId,
  currency0: CURRENCY0,
  currency1: CURRENCY1,
  fee: 3_000,
  tickSpacing: 60,
  hook: HOOK,
  initializedAtBlock: '9',
  activity: 1,
}

function swapInput(key: typeof poolKey, amountIn: bigint, hookData: Hex) {
  return encodeAbiParameters(SINGLE_IN_PARAMETERS, [{
    poolKey: key,
    zeroForOne: true,
    amountIn,
    amountOutMinimum: 5n,
    hookData,
  }])
}

/** One canonical Universal Router call carrying a swap for each of two pools. */
function twoPoolRouterCalldata(): Hex {
  const plan = encodeAbiParameters(ACTION_PLAN_PARAMETERS, [
    bytesToHex(new Uint8Array([V4_ACTIONS.SWAP_EXACT_IN_SINGLE, V4_ACTIONS.SWAP_EXACT_IN_SINGLE, 0x0f])),
    [swapInput(poolKey, 100n, '0x1234'), swapInput(otherPoolKey, 200n, '0xabcdef'), '0xfeed'],
  ])
  return encodeFunctionData({
    abi: EXECUTE_ABI,
    functionName: 'execute',
    args: ['0x1002', [plan, '0xcafebabe'], 1_000n],
  })
}

function singlePoolRouterCalldata(): Hex {
  const plan = encodeAbiParameters(ACTION_PLAN_PARAMETERS, [
    bytesToHex(new Uint8Array([V4_ACTIONS.SWAP_EXACT_IN_SINGLE, 0x0f])),
    [swapInput(poolKey, 100n, '0x1234'), '0xfeed'],
  ])
  return encodeFunctionData({
    abi: EXECUTE_ABI,
    functionName: 'execute',
    args: ['0x1002', [plan, '0xcafebabe'], 1_000n],
  })
}

function flipBytes(calldata: Hex, indices: readonly number[]) {
  const bytes = hexToBytes(calldata)
  for (const index of indices) bytes[index] = bytes[index]! ^ 0x01
  return bytesToHex(bytes)
}

function witness(calldata: Hex, overrides: Partial<RevmExplorationWitness> = {}): RevmExplorationWitness {
  return {
    calldata,
    success: true,
    gasUsed: 21_000,
    newEdges: 3,
    output: '0x',
    storageDiffs: [],
    ...overrides,
  }
}

function epoch(overrides: Partial<ForkExplorationEpoch> = {}): ForkExplorationEpoch {
  return {
    engine: 'revm/36.0.0 + libafl/0.15.4',
    strategy: 'libafl-masked-router-fork/0.1.0',
    executions: 10,
    coverageEdges: 12,
    uniqueOutcomes: 1,
    witnesses: [],
    elapsedMs: 5,
    skippedExecutions: 0,
    missingRequests: [],
    missingCandidates: [],
    ...overrides,
  }
}

function replayResult(): ForkReplayResult {
  return {
    hydrationRequests: 2,
    hydratedAccounts: 6,
    hydratedStorageSlots: 1,
    proof: {
      engine: 'revm/36.0.0',
      success: true,
      gasUsed: 21_000,
      output: '0x',
      steps: [],
      storageOperations: [],
      calls: [],
      storageDiffs: [],
      balanceChanges: [],
      logs: [],
      logCount: 0,
      selfdestructs: [],
      truncated: false,
    },
  }
}

function replayCoverage(calldata: Hex, options: { poolId?: Hex; hook?: Address } = {}): LivePoolReplayCoverage {
  return {
    status: 'passed',
    selectedPools: 1,
    candidateTransactions: 1,
    passedTransactions: 1,
    failedTransactions: 0,
    coveredPools: 1,
    findings: [],
    hydrationRequests: 0,
    limitations: [],
    outcomes: [{
      poolId: options.poolId ?? poolId,
      hook: options.hook ?? HOOK,
      kind: 'swap',
      transactionHash: ZERO_BYTES32,
      status: 'passed',
      candidate: {
        kind: 'swap',
        poolId: options.poolId ?? poolId,
        transactionHash: ZERO_BYTES32,
        stateBlockNumber: 9n,
        transaction: {
          caller: ACTOR,
          to: ROUTER,
          calldata,
          value: 7n,
          gasLimit: 1_000_000n,
          gasPrice: 0n,
          nonce: 0,
          chainId: 1,
        },
        block: {
          number: 10n,
          beneficiary: CURRENCY0,
          timestamp: 100n,
          gasLimit: 30_000_000n,
          baseFee: 0n,
          difficulty: 0n,
        },
        expected: { success: true, gasUsed: 21_000n, logCount: 0 },
      },
    }],
  }
}

type ExploreCall = {
  mutableIndices: number[]
  maxExecutions: number
  seedCorpus: Hex[]
  timeoutMs?: number
}

function fakeSession(epochs: ForkExplorationEpoch[]) {
  const explores: ExploreCall[] = []
  const hydrated: unknown[][] = []
  const close = vi.fn()
  const warm = vi.fn(async () => replayResult())
  let index = 0
  const factory = () => ({
    warm,
    hydrate: vi.fn(async (requests: unknown[]) => {
      hydrated.push(requests)
      return requests.length
    }),
    explore: vi.fn(async (input: {
      mutableIndices: number[]
      maxExecutions: number
      seedCorpus?: Hex[]
      timeoutMs?: number
    }) => {
      explores.push({
        mutableIndices: input.mutableIndices,
        maxExecutions: input.maxExecutions,
        seedCorpus: [...(input.seedCorpus ?? [])],
        timeoutMs: input.timeoutMs,
      })
      return epochs[index++] ?? epoch()
    }),
    metrics: () => ({ hydratedAccounts: 6, hydratedStorageSlots: 1, hydratedBlockHashes: 0, rpcReads: 20, executions: 0 }),
    close,
  })
  return { factory, explores, hydrated, warm, close }
}

describe('pool-scoped mutation mask', () => {
  it('keeps only the operation that acts on the selected pool', () => {
    const calldata = twoPoolRouterCalldata()
    const full = deriveUniswapV4MutationMask(calldata)!
    const scoped = poolScopedMutationMask(poolId, calldata)!

    // amountIn (16) plus hookData contents for both swaps: 2 and 3 bytes.
    expect(full.byteIndices).toHaveLength(16 + 2 + 16 + 3)
    expect(scoped.byteIndices).toHaveLength(16 + 2)
    expect(scoped.operationsSeen).toBe(2)
    expect(scoped.operationsSelected).toBe(1)
    expect(scoped.regions.every((region) => region.operationIndex === 0)).toBe(true)
    expect(scoped.byteIndices.every((index) => full.byteIndices.includes(index))).toBe(true)

    const mutated = flipBytes(calldata, scoped.byteIndices)
    expect(isUniswapV4MaskedDerivative(scoped, mutated)).toBe(true)
    const operations = locateUniswapV4Operations(decodeUniswapV4Calldata(mutated)!)
    expect(operations[1]?.operation).toMatchObject({ amountIn: 200n, hookData: '0xabcdef' })
  })

  it('returns null when no operation is attributable to the pool', () => {
    expect(poolScopedMutationMask(otherPoolId, singlePoolRouterCalldata())).toBeNull()
    expect(poolScopedMutationMask(poolId, '0x12345678')).toBeNull()
  })
})

describe('live hydrated-fork exploration', () => {
  it('selects one canonical receipt-matched router transaction per pool', () => {
    const calldata = singlePoolRouterCalldata()
    const targets = selectForkExplorationTargets({ pools: [pool], replay: replayCoverage(calldata) })
    expect(targets).toHaveLength(1)
    expect(targets[0]?.candidate.transaction.calldata).toBe(calldata)
    expect(targets[0]?.mask.byteIndices.length).toBe(16 + 2)
  })

  it('runs two rounds under one shared budget, exchanging masked seeds and hydrating between them', async () => {
    const calldata = singlePoolRouterCalldata()
    const mask = poolScopedMutationMask(poolId, calldata)!
    const interesting = flipBytes(calldata, mask.byteIndices.slice(0, 4))
    const skipped = flipBytes(calldata, mask.byteIndices.slice(4, 6))
    const session = fakeSession([
      epoch({
        executions: 600,
        uniqueOutcomes: 2,
        witnesses: [witness(interesting, { storageDiffs: [{ address: HOOK, slot: '0x01', before: '0x0', after: '0x1' }] })],
        skippedExecutions: 1,
        missingRequests: [{ kind: 'storage', address: HOOK, slot: '0x02' }],
        missingCandidates: [{ calldata: skipped, request: { kind: 'storage', address: HOOK, slot: '0x02' } }],
      }),
      epoch({ executions: 400, coverageEdges: 30, uniqueOutcomes: 1, witnesses: [witness(skipped, { success: false })] }),
    ])

    const coverage = await runLiveForkExploration({
      scanId: 'fork-test',
      client: {} as PublicClient,
      poolManager: MANAGER,
      pools: [pool],
      replay: replayCoverage(calldata),
      signal: new AbortController().signal,
      createSession: session.factory,
      maxExecutionsPerPool: 1_000,
    })

    expect(session.explores).toHaveLength(2)
    expect(session.explores[0]?.maxExecutions).toBe(600)
    expect(session.explores[1]?.maxExecutions).toBe(400)
    expect(session.explores.reduce((sum, call) => sum + call.maxExecutions, 0)).toBe(1_000)
    expect(session.explores[0]?.mutableIndices).toEqual(mask.byteIndices)
    expect(session.explores[0]?.seedCorpus).toEqual([])
    expect(session.explores[1]?.seedCorpus).toEqual([skipped, interesting])

    // Accounts first, then the state round one reported as missing.
    expect(session.hydrated).toHaveLength(2)
    expect(session.hydrated[0]).toHaveLength(5)
    expect(session.hydrated[1]).toEqual([{ kind: 'storage', address: HOOK, slot: '0x02' }])
    expect(session.warm).toHaveBeenCalledTimes(1)
    expect(session.close).toHaveBeenCalledTimes(1)

    const outcome = coverage.outcomes[0]!
    expect(outcome.status).toBe('completed')
    expect(outcome.executions).toBe(1_000)
    expect(outcome.coverageEdges).toBe(30)
    expect(outcome.uniqueOutcomes).toBe(2)
    expect(outcome.hydratedBetweenRounds).toBe(1)
    expect(outcome.rounds.map((round) => round.seedCorpus)).toEqual([0, 2])
    expect(coverage.status).toBe('passed')
    expect(coverage.exploredPools).toBe(1)
    expect(coverage.hydrationReads).toBe(20)

    const finding = coverage.findings[0]!
    expect(finding.evidenceClass).toBe('fuzz-discovery')
    expect(finding.severity).toBe('medium')
    expect(finding.reproducibility).toBe('replayed')
    expect(finding.witness?.from).toBe(ACTOR)
    expect(finding.witness?.to).toBe(ROUTER)
    expect(isUniswapV4MaskedDerivative(mask, finding.witness!.input)).toBe(true)
    expect(finding.claim).toContain('canonical router envelope')
  })

  it('never exchanges a candidate that changed the canonical envelope', async () => {
    const calldata = singlePoolRouterCalldata()
    const mask = poolScopedMutationMask(poolId, calldata)!
    const masked = flipBytes(calldata, mask.byteIndices.slice(0, 2))
    const outsideMask = flipBytes(calldata, [0])
    const session = fakeSession([
      epoch({ witnesses: [witness(outsideMask), witness(masked)] }),
      epoch(),
    ])

    await runLiveForkExploration({
      scanId: 'fork-test',
      client: {} as PublicClient,
      poolManager: MANAGER,
      pools: [pool],
      replay: replayCoverage(calldata),
      signal: new AbortController().signal,
      createSession: session.factory,
      maxExecutionsPerPool: 100,
    })

    expect(session.explores[1]?.seedCorpus).toEqual([masked])
  })

  it('reports an unsupported pool without a recognized payload as an explicit gap', async () => {
    const coverage = await runLiveForkExploration({
      scanId: 'fork-test',
      client: {} as PublicClient,
      poolManager: MANAGER,
      pools: [pool],
      replay: { ...replayCoverage(singlePoolRouterCalldata()), outcomes: [] },
      signal: new AbortController().signal,
      createSession: fakeSession([]).factory,
    })

    expect(coverage.status).toBe('degraded')
    expect(coverage.exploredPools).toBe(0)
    expect(coverage.findings).toHaveLength(0)
    expect(coverage.outcomes).toHaveLength(1)
    expect(coverage.outcomes[0]).toMatchObject({ poolId, status: 'unsupported' })
    expect(coverage.limitations[0]).toContain('no receipt-matched supported router envelope')
  })

  it('records a failed target without discarding the whole phase', async () => {
    const calldata = singlePoolRouterCalldata()
    const session = fakeSession([])
    const failing = () => ({
      ...session.factory(),
      explore: vi.fn(async () => { throw new Error('worker trapped') }),
    })

    const coverage = await runLiveForkExploration({
      scanId: 'fork-test',
      client: {} as PublicClient,
      poolManager: MANAGER,
      pools: [pool],
      replay: replayCoverage(calldata),
      signal: new AbortController().signal,
      createSession: failing,
    })

    expect(coverage.status).toBe('degraded')
    expect(coverage.outcomes[0]).toMatchObject({ status: 'failed', reason: 'worker trapped' })
    expect(coverage.findings).toHaveLength(0)
    expect(coverage.limitations.some((item) => item.includes('did not complete its bounded rounds'))).toBe(true)
  })

  it('refuses to explore a seed that no longer reproduces its chain receipt', async () => {
    const calldata = singlePoolRouterCalldata()
    const session = fakeSession([])
    const diverging = () => ({
      ...session.factory(),
      warm: vi.fn(async () => {
        const result = replayResult()
        return { ...result, proof: { ...result.proof, gasUsed: 999 } }
      }),
    })

    const coverage = await runLiveForkExploration({
      scanId: 'fork-test',
      client: {} as PublicClient,
      poolManager: MANAGER,
      pools: [pool],
      replay: replayCoverage(calldata),
      signal: new AbortController().signal,
      createSession: diverging,
    })

    expect(session.explores).toHaveLength(0)
    expect(coverage.outcomes[0]).toMatchObject({ status: 'failed' })
    expect(coverage.outcomes[0]?.reason).toContain('did not match the chain receipt')
    expect(coverage.findings).toHaveLength(0)
  })

  it('propagates cancellation instead of persisting a partial outcome', async () => {
    const calldata = singlePoolRouterCalldata()
    const controller = new AbortController()
    const close = vi.fn()
    const cancelling = () => ({
      warm: vi.fn(async () => replayResult()),
      hydrate: vi.fn(async () => 0),
      explore: vi.fn(async () => {
        controller.abort()
        throw new DOMException('Fork exploration cancelled', 'AbortError')
      }),
      metrics: () => ({ hydratedAccounts: 0, hydratedStorageSlots: 0, hydratedBlockHashes: 0, rpcReads: 0, executions: 0 }),
      close,
    })

    await expect(runLiveForkExploration({
      scanId: 'fork-test',
      client: {} as PublicClient,
      poolManager: MANAGER,
      pools: [pool],
      replay: replayCoverage(calldata),
      signal: controller.signal,
      createSession: cancelling,
    })).rejects.toThrow(/cancelled/i)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('bounds the number of hydrated fork targets per scan', async () => {
    const calldata = singlePoolRouterCalldata()
    const secondPool: PoolDescriptor = { ...pool, poolId: otherPoolId, hook: OTHER_HOOK }
    const replay = replayCoverage(calldata)
    const coverage = await runLiveForkExploration({
      scanId: 'fork-test',
      client: {} as PublicClient,
      poolManager: MANAGER,
      pools: [pool, secondPool],
      replay: {
        ...replay,
        outcomes: [
          ...replay.outcomes,
          { ...replay.outcomes[0]!, poolId: otherPoolId, hook: OTHER_HOOK },
        ],
      },
      signal: new AbortController().signal,
      createSession: fakeSession([]).factory,
      maxPools: 1,
      maxExecutionsPerPool: 10,
    })

    expect(coverage.recognizedPools).toBe(1)
    expect(coverage.exploredPools).toBe(1)
    expect(coverage.outcomes.map((outcome) => outcome.status).sort()).toEqual(['completed', 'unsupported'])
  })
})
