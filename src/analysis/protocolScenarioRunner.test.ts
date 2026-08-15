import { describe, expect, it, vi } from 'vitest'
import { toHex, type Address, type Hex, type PublicClient } from 'viem'
import type { PoolDescriptor } from '../domain/report'
import { decodeSlot0 } from './protocolScenarioContext'
import { POOL_EVENT_TOPICS } from './protocolScenarioValidation'
import { runProtocolScenarios } from './protocolScenarioRunner'
import type { ForkReplayResult } from './revmProof'

const POOL_MANAGER = '0x000000000004444c5dc75cB358380D2e3dE08A90' as Address
const HOOK = '0x2222222222222222222222222222222222222222' as Address
const pool: PoolDescriptor = {
  poolId: `0x${'ab'.repeat(32)}` as Hex,
  currency0: '0x0000000000000000000000000000000000000000',
  currency1: '0x1111111111111111111111111111111111111111',
  fee: 3_000,
  tickSpacing: 60,
  hook: HOOK,
  initializedAtBlock: '100',
  activity: 1,
}

const ROUTER = '0x0000000000000000000000000000000000005ce4' as Address
const ACTOR = '0x00000000000000000000000000000000000ac7a1' as Address

/** Trace of a scenario that really entered the PoolManager and reached the hook. */
function poolCalls() {
  return [
    { caller: ACTOR, target: ROUTER, bytecodeAddress: ROUTER, scheme: 'Call', value: '0', inputLength: 644, selector: '0x543b46f9' as Hex },
    { caller: ROUTER, target: POOL_MANAGER, bytecodeAddress: POOL_MANAGER, scheme: 'Call', value: '0', inputLength: 708, selector: '0x48c89491' as Hex },
    { caller: POOL_MANAGER, target: HOOK, bytecodeAddress: HOOK, scheme: 'Call', value: '0', inputLength: 356, selector: '0x575e24b4' as Hex },
  ]
}

/** Every pool event the matrix can require, all naming the selected pool. */
function poolLogs() {
  return [
    { address: POOL_MANAGER, topics: [POOL_EVENT_TOPICS.swap, pool.poolId] as Hex[], data: '0x' as Hex },
    { address: POOL_MANAGER, topics: [POOL_EVENT_TOPICS.donate, pool.poolId] as Hex[], data: '0x' as Hex },
    { address: POOL_MANAGER, topics: [POOL_EVENT_TOPICS.modifyLiquidity, pool.poolId] as Hex[], data: '0x' as Hex },
  ]
}

function replay(success = true, overrides: Partial<ForkReplayResult['proof']> = {}): ForkReplayResult {
  return {
    hydrationRequests: 0,
    hydratedAccounts: 0,
    hydratedStorageSlots: 0,
    proof: {
      engine: 'revm/36.0.0', success, gasUsed: 100, output: '0x',
      steps: [], storageOperations: [], calls: poolCalls(), storageDiffs: [],
      balanceChanges: [], logs: poolLogs(), logCount: 3, selfdestructs: [], truncated: false,
      ...overrides,
    },
  }
}

/** The harness binding preflight: `poolManager()` returning the real manager. */
function bindingReply(manager: Address = POOL_MANAGER): ForkReplayResult {
  return replay(true, { output: `0x${manager.slice(2).toLowerCase().padStart(64, '0')}` as Hex, calls: [], logs: [], logCount: 0 })
}

/** slot0 packs sqrtPriceX96(160) | tick(24) | protocolFee(24) | lpFee(24). */
function slot0Word(sqrtPriceX96: bigint, tick: number): Hex {
  const raw = tick < 0 ? BigInt(tick) + (1n << 24n) : BigInt(tick)
  return toHex(sqrtPriceX96 | (raw << 160n), { size: 32 })
}

/**
 * Only the PoolManager holds code and balance; every other address is empty, so
 * the synthetic router and actor slots are free to claim.
 */
function client(slot0: Hex, occupied: Address[] = []) {
  const taken = new Set([POOL_MANAGER.toLowerCase(), ...occupied.map((address) => address.toLowerCase())])
  const isTaken = ({ address }: { address: Address }) => taken.has(address.toLowerCase())
  return {
    getBalance: async (args: { address: Address }) => (isTaken(args) ? 1n : 0n),
    getTransactionCount: async () => 0,
    getCode: async (args: { address: Address }) => (isTaken(args) ? '0x60' as Hex : '0x' as Hex),
    readContract: async () => slot0,
  } as unknown as PublicClient
}

const pinnedBlock = { timestamp: 1_000n, baseFeePerGas: 5n, gasLimit: 30_000_000n, miner: POOL_MANAGER }

/**
 * Answers the binding preflight first, then defers to the scenario behavior, so
 * a test only has to describe the scenario it cares about.
 */
function session(scenarioExecute = vi.fn(async () => replay()), binding = bindingReply) {
  const close = vi.fn()
  const gasPrices: bigint[] = []
  let first = true
  const execute = vi.fn(async (input: { transaction: { gasPrice: bigint } }) => {
    gasPrices.push(input.transaction.gasPrice)
    if (first) {
      first = false
      return binding()
    }
    return scenarioExecute()
  })
  return {
    execute,
    scenarioExecute,
    gasPrices,
    close,
    factory: () => ({ execute, metrics: () => ({ hydratedAccounts: 0, hydratedStorageSlots: 0, hydratedBlockHashes: 0, rpcReads: 4, executions: 0 }), close }),
  }
}

describe('slot0 decoding', () => {
  it('sign-extends a negative tick instead of reading it as a huge positive', () => {
    expect(decodeSlot0(slot0Word(79_228_162_514_264_337_593_543_950_336n, -120)).tick).toBe(-120)
    expect(decodeSlot0(slot0Word(79_228_162_514_264_337_593_543_950_336n, 887_272)).tick).toBe(887_272)
    expect(decodeSlot0(slot0Word(79_228_162_514_264_337_593_543_950_336n, 0)).tick).toBe(0)
  })
})

describe('generated scenario runner', () => {
  it('runs the matrix without consulting any historical input', async () => {
    const spy = session()
    const coverage = await runProtocolScenarios({
      scanId: 'protocol-test',
      client: client(slot0Word(79_228_162_514_264_337_593_543_950_336n, 0)),
      chainId: 1,
      poolManager: POOL_MANAGER,
      pools: [pool],
      stateBlockNumber: 100n,
      pinnedBlock,
      signal: new AbortController().signal,
      createSession: spy.factory,
    })

    expect(coverage.status).toBe('passed')
    expect(coverage.executedPools).toBe(1)
    expect(coverage.completed).toBeGreaterThan(20)
    expect(coverage.failed).toBe(0)
    expect(coverage.hydrationReads).toBe(4)
    expect(spy.gasPrices.length).toBeGreaterThan(1)
    expect(spy.gasPrices.every((gasPrice) => gasPrice === pinnedBlock.baseFeePerGas)).toBe(true)
    expect(spy.close).toHaveBeenCalledTimes(1)
  })

  it('refuses to run scenarios when the injected harness is bound elsewhere', async () => {
    const wrong = '0x9999999999999999999999999999999999999999' as Address
    const coverage = await runProtocolScenarios({
      scanId: 'protocol-test',
      client: client(slot0Word(79_228_162_514_264_337_593_543_950_336n, 0)),
      chainId: 1,
      poolManager: POOL_MANAGER,
      pools: [pool],
      stateBlockNumber: 100n,
      pinnedBlock,
      signal: new AbortController().signal,
      createSession: session(vi.fn(async () => replay()), () => bindingReply(wrong)).factory,
    })

    expect(coverage.completed).toBe(0)
    expect(coverage.outcomes).toHaveLength(1)
    expect(coverage.outcomes[0]).toMatchObject({ scenarioId: 'harness-binding', status: 'failed' })
    expect(coverage.findings.every((finding) => finding.detectorId === 'protocol-native-scenario-suite')).toBe(true)
  })

  it('does not report a revert that never reached the PoolManager as hook behavior', async () => {
    // A harness that reverts decoding its own arguments never calls unlock.
    const decodeRevert = replay(false, { calls: [poolCalls()[0]!], logs: [], logCount: 0 })
    const coverage = await runProtocolScenarios({
      scanId: 'protocol-test',
      client: client(slot0Word(79_228_162_514_264_337_593_543_950_336n, 0)),
      chainId: 1,
      poolManager: POOL_MANAGER,
      pools: [pool],
      stateBlockNumber: 100n,
      pinnedBlock,
      signal: new AbortController().signal,
      createSession: session(vi.fn(async () => decodeRevert)).factory,
    })

    expect(coverage.reverted).toBe(0)
    expect(coverage.failed).toBeGreaterThan(0)
    expect(coverage.outcomes.some((outcome) => outcome.reason?.includes('before reaching unlock'))).toBe(true)
    // No observation may be published for a call that never touched the pool.
    expect(coverage.findings.filter((finding) => finding.detectorId === 'protocol-native-scenario')).toHaveLength(0)
  })

  it('refuses a completed swap whose event names a different pool', async () => {
    const otherPool = replay(true, {
      logs: [{ address: POOL_MANAGER, topics: [POOL_EVENT_TOPICS.swap, `0x${'99'.repeat(32)}` as Hex], data: '0x' as Hex }],
      logCount: 1,
    })
    const coverage = await runProtocolScenarios({
      scanId: 'protocol-test',
      client: client(slot0Word(79_228_162_514_264_337_593_543_950_336n, 0)),
      chainId: 1,
      poolManager: POOL_MANAGER,
      pools: [pool],
      stateBlockNumber: 100n,
      pinnedBlock,
      signal: new AbortController().signal,
      createSession: session(vi.fn(async () => otherPool)).factory,
    })

    expect(coverage.completed).toBe(0)
    expect(coverage.outcomes.some((outcome) => outcome.reason?.includes('different pool'))).toBe(true)
  })

  it('marks generated evidence as such and attaches no historical transaction', async () => {
    const coverage = await runProtocolScenarios({
      scanId: 'protocol-test',
      client: client(slot0Word(79_228_162_514_264_337_593_543_950_336n, 0)),
      chainId: 1,
      poolManager: POOL_MANAGER,
      pools: [pool],
      stateBlockNumber: 100n,
      pinnedBlock,
      signal: new AbortController().signal,
      createSession: session().factory,
    })

    const finding = coverage.findings[0]!
    expect(finding.technical!.executionSource).toBe('protocol-native-generated')
    expect(finding.technical!.stateMode).toBe('pinned-block-with-declared-overrides')
    expect(finding.claim).toContain('not an onchain transaction')
    expect(finding.technical).not.toHaveProperty('historicalTransaction')
    expect(finding.subject).toBe(HOOK)
  })

  it('records a revert as an observation rather than a failure', async () => {
    const coverage = await runProtocolScenarios({
      scanId: 'protocol-test',
      client: client(slot0Word(79_228_162_514_264_337_593_543_950_336n, 0)),
      chainId: 1,
      poolManager: POOL_MANAGER,
      pools: [pool],
      stateBlockNumber: 100n,
      pinnedBlock,
      signal: new AbortController().signal,
      createSession: session(vi.fn(async () => replay(false))).factory,
    })

    expect(coverage.reverted).toBeGreaterThan(0)
    expect(coverage.failed).toBe(0)
    expect(coverage.limitations.join(' ')).toContain('not an analyzer failure')
  })

  it('separates an infrastructure failure from a revert', async () => {
    const coverage = await runProtocolScenarios({
      scanId: 'protocol-test',
      client: client(slot0Word(79_228_162_514_264_337_593_543_950_336n, 0)),
      chainId: 1,
      poolManager: POOL_MANAGER,
      pools: [pool],
      stateBlockNumber: 100n,
      pinnedBlock,
      signal: new AbortController().signal,
      createSession: session(vi.fn(async () => { throw new Error('hydration exhausted') })).factory,
    })

    expect(coverage.failed).toBeGreaterThan(0)
    expect(coverage.completed).toBe(0)
    expect(coverage.status).toBe('degraded')
    expect(coverage.outcomes.some((o) => o.reason === 'hydration exhausted')).toBe(true)
  })

  it('reports liquidity unavailable when slot0 is unreadable, but still swaps', async () => {
    const coverage = await runProtocolScenarios({
      scanId: 'protocol-test',
      // An uninitialized pool reads as zero, which must not be treated as tick 0.
      client: client(toHex(0n, { size: 32 })),
      chainId: 1,
      poolManager: POOL_MANAGER,
      pools: [pool],
      stateBlockNumber: 100n,
      pinnedBlock,
      signal: new AbortController().signal,
      createSession: session().factory,
    })

    expect(coverage.outcomes.some((o) => o.status === 'unavailable' && o.operation === 'liquidity')).toBe(true)
    expect(coverage.completed).toBeGreaterThan(0)
  })

  it('runs for a pool that has no historical router reference at all', async () => {
    // The acceptance condition for the generated path: stripping every
    // historical reference from a pool disables historical replay only.
    const strippedPool: PoolDescriptor = {
      ...pool,
      transactionHash: undefined,
      replayTransactions: undefined,
      activity: 0,
    }
    const coverage = await runProtocolScenarios({
      scanId: 'protocol-test',
      client: client(slot0Word(79_228_162_514_264_337_593_543_950_336n, 0)),
      chainId: 1,
      poolManager: POOL_MANAGER,
      pools: [strippedPool],
      stateBlockNumber: 100n,
      pinnedBlock,
      signal: new AbortController().signal,
      createSession: session().factory,
    })

    expect(coverage.status).toBe('passed')
    expect(coverage.completed).toBeGreaterThan(20)
  })

  it('propagates cancellation and still closes its session', async () => {
    const controller = new AbortController()
    const spy = session(vi.fn(async () => { controller.abort(); throw new DOMException('x', 'AbortError') }))
    await expect(runProtocolScenarios({
      scanId: 'protocol-test',
      client: client(slot0Word(79_228_162_514_264_337_593_543_950_336n, 0)),
      chainId: 1,
      poolManager: POOL_MANAGER,
      pools: [pool],
      stateBlockNumber: 100n,
      pinnedBlock,
      signal: controller.signal,
      createSession: spy.factory,
    })).rejects.toThrow()
    expect(spy.close).toHaveBeenCalledTimes(1)
  })
})
