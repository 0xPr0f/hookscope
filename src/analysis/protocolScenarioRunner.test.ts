import { describe, expect, it, vi } from 'vitest'
import { toHex, type Address, type Hex, type PublicClient } from 'viem'
import type { PoolDescriptor } from '../domain/report'
import { decodeSlot0 } from './protocolScenarioContext'
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

function replay(success = true): ForkReplayResult {
  return {
    hydrationRequests: 0,
    hydratedAccounts: 0,
    hydratedStorageSlots: 0,
    proof: {
      engine: 'revm/36.0.0', success, gasUsed: 100, output: '0x',
      steps: [], storageOperations: [], calls: [], storageDiffs: [],
      balanceChanges: [], logs: [], logCount: 0, selfdestructs: [], truncated: false,
    },
  }
}

/** slot0 packs sqrtPriceX96(160) | tick(24) | protocolFee(24) | lpFee(24). */
function slot0Word(sqrtPriceX96: bigint, tick: number): Hex {
  const raw = tick < 0 ? BigInt(tick) + (1n << 24n) : BigInt(tick)
  return toHex(sqrtPriceX96 | (raw << 160n), { size: 32 })
}

function client(slot0: Hex) {
  return {
    getBalance: async () => 1n,
    getTransactionCount: async () => 0,
    getCode: async () => '0x60' as Hex,
    readContract: async () => slot0,
  } as unknown as PublicClient
}

const pinnedBlock = { timestamp: 1_000n, baseFeePerGas: 5n, gasLimit: 30_000_000n, miner: POOL_MANAGER }

function session(execute = vi.fn(async () => replay())) {
  const close = vi.fn()
  return {
    execute,
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
    expect(spy.close).toHaveBeenCalledTimes(1)
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
