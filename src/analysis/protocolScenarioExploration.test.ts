import { describe, expect, it, vi } from 'vitest'
import { toHex, type Address, type Hex, type PublicClient } from 'viem'
import type { PoolDescriptor } from '../domain/report'
import { buildProtocolScenarioMatrix } from './protocolNativeScenarios'
import {
  runProtocolScenarioExploration,
  selectExplorationSeeds,
} from './protocolScenarioExploration'
import type { ForkExplorationEpoch } from './revmProof'

const POOL_MANAGER = '0x000000000004444c5dc75cB358380D2e3dE08A90' as Address
const HOOK = '0x2222222222222222222222222222222222222222' as Address
const pool: PoolDescriptor = {
  poolId: `0x${'cd'.repeat(32)}` as Hex,
  currency0: '0x0000000000000000000000000000000000000000',
  currency1: '0x1111111111111111111111111111111111111111',
  fee: 3_000,
  tickSpacing: 60,
  hook: HOOK,
  initializedAtBlock: '100',
  activity: 1,
}
const pinnedBlock = { timestamp: 1_000n, baseFeePerGas: 5n, gasLimit: 30_000_000n, miner: POOL_MANAGER }

function matrix(currentTick?: number) {
  return buildProtocolScenarioMatrix({
    key: { currency0: pool.currency0, currency1: pool.currency1, fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: pool.hook },
    currentTick,
    actor: '0x00000000000000000000000000000000000ac7a1',
  }).scenarios
}

function client() {
  const slot0 = toHex(79_228_162_514_264_337_593_543_950_336n, { size: 32 })
  return {
    getBalance: async () => 1n,
    getTransactionCount: async () => 0,
    getCode: async () => '0x60' as Hex,
    readContract: async () => slot0,
  } as unknown as PublicClient
}

/** An epoch whose witnesses really are masked mutations of the seed. */
function epochFor(calldata: Hex, indices: number[], variants: number): ForkExplorationEpoch {
  const witnesses = Array.from({ length: variants }, (_, variant) => {
    const bytes = Buffer.from(calldata.slice(2), 'hex')
    for (const index of indices) bytes[index] = (bytes[index]! + variant + 1) & 0xff
    return {
      calldata: `0x${bytes.toString('hex')}` as Hex,
      success: variant % 2 === 0,
      gasUsed: 100 + variant,
      newEdges: 1,
      output: '0x' as Hex,
      storageDiffs: [],
    }
  })
  return {
    engine: 'revm/36.0.0',
    strategy: 'test',
    executions: 100,
    coverageEdges: 12,
    uniqueOutcomes: variants,
    witnesses,
    elapsedMs: 5,
    skippedExecutions: 0,
    missingRequests: [],
    missingCandidates: [],
  }
}

function session(explore?: (input: { transaction: { calldata: Hex }; mutableIndices: number[] }) => Promise<ForkExplorationEpoch>) {
  const close = vi.fn()
  const calls: { calldata: Hex; indices: number[] }[] = []
  const run = explore ?? (async ({ transaction, mutableIndices }) => {
    calls.push({ calldata: transaction.calldata, indices: mutableIndices })
    return epochFor(transaction.calldata, mutableIndices, 2)
  })
  return {
    calls,
    close,
    factory: () => ({
      hydrate: async () => 2,
      warm: async () => ({ hydrationRequests: 0, hydratedAccounts: 0, hydratedStorageSlots: 0, proof: {} as never }),
      explore: run as never,
      metrics: () => ({ rpcReads: 7, hydratedAccounts: 1, hydratedStorageSlots: 1 }),
      close,
    }),
  }
}

describe('generated exploration seeds', () => {
  it('picks one seed per operation shape with a non-empty mask', () => {
    const seeds = selectExplorationSeeds(matrix(0))
    expect(seeds.map((seed) => seed.scenario.operation)).toEqual(['swap', 'swap', 'swap', 'liquidity', 'donate'])
    for (const seed of seeds) expect(seed.mask.byteIndices.length).toBeGreaterThan(0)
  })

  it('omits the liquidity shape when the pool tick was unreadable', () => {
    const seeds = selectExplorationSeeds(matrix(undefined))
    expect(seeds.map((seed) => seed.scenario.operation)).toEqual(['swap', 'swap', 'swap', 'donate'])
  })
})

describe('generated exploration run', () => {
  it('explores every seed shape under one shared budget', async () => {
    const spy = session()
    const coverage = await runProtocolScenarioExploration({
      scanId: 'explore-test',
      client: client(),
      chainId: 1,
      poolManager: POOL_MANAGER,
      pools: [pool],
      stateBlockNumber: 100n,
      pinnedBlock,
      signal: new AbortController().signal,
      createSession: spy.factory,
    })

    expect(coverage.status).toBe('passed')
    expect(coverage.exploredPools).toBe(1)
    expect(coverage.outcomes[0]!.shapes).toHaveLength(5)
    // The shared budget is split, never handed to each shape in full.
    expect(coverage.outcomes[0]!.shapes.reduce((sum, shape) => sum + shape.executions, 0)).toBe(500)
    expect(spy.calls.every((call) => call.indices.length > 0)).toBe(true)
    expect(spy.close).toHaveBeenCalledTimes(1)
    expect(coverage.hydrationReads).toBe(7)
  })

  it('marks its evidence generated and attaches no historical transaction', async () => {
    const coverage = await runProtocolScenarioExploration({
      scanId: 'explore-test',
      client: client(),
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
    expect(finding.technical).not.toHaveProperty('historicalTransaction')
    expect(finding.technical).not.toHaveProperty('historicalRouter')
    expect(finding.claim).toContain('not onchain transactions')
    // The witness only reproduces under the overrides that injected the harness.
    expect(finding.witness!.stateOverrides).toBeTruthy()
  })

  it('discards a witness that escaped its mask instead of reporting it', async () => {
    const spy = session(async ({ transaction }) => {
      const epoch = epochFor(transaction.calldata, [4], 1)
      // Byte 0 is the selector: outside every mask, so this must not survive.
      const forged = Buffer.from(epoch.witnesses[0]!.calldata.slice(2), 'hex')
      forged[0] = forged[0]! ^ 0xff
      epoch.witnesses[0]!.calldata = `0x${forged.toString('hex')}` as Hex
      return epoch
    })
    const coverage = await runProtocolScenarioExploration({
      scanId: 'explore-test',
      client: client(),
      chainId: 1,
      poolManager: POOL_MANAGER,
      pools: [pool],
      stateBlockNumber: 100n,
      pinnedBlock,
      signal: new AbortController().signal,
      createSession: spy.factory,
    })

    expect(coverage.outcomes[0]!.witnesses).toHaveLength(0)
    expect(coverage.skippedExecutions).toBeGreaterThan(0)
  })

  it('reuses handed-in contexts rather than re-reading pinned state', async () => {
    const reader = vi.fn(async () => toHex(79_228_162_514_264_337_593_543_950_336n, { size: 32 }))
    const shared = {
      getBalance: async () => 1n,
      getTransactionCount: async () => 0,
      getCode: async () => '0x60' as Hex,
      readContract: reader,
    } as unknown as PublicClient
    const { buildProtocolScenarioContext } = await import('./protocolScenarioContext')
    const context = await buildProtocolScenarioContext({
      client: shared, chainId: 1, poolManager: POOL_MANAGER, pool, stateBlockNumber: 100n, pinnedBlock,
    })
    reader.mockClear()

    await runProtocolScenarioExploration({
      scanId: 'explore-test',
      client: shared,
      chainId: 1,
      poolManager: POOL_MANAGER,
      pools: [pool],
      stateBlockNumber: 100n,
      pinnedBlock,
      contexts: [context],
      signal: new AbortController().signal,
      createSession: session().factory,
    })
    expect(reader).not.toHaveBeenCalled()
  })

  it('explores a pool that has no historical router reference at all', async () => {
    const coverage = await runProtocolScenarioExploration({
      scanId: 'explore-test',
      client: client(),
      chainId: 1,
      poolManager: POOL_MANAGER,
      // No transactionHash and no replayTransactions: historical replay has
      // nothing to work with, and generated exploration must not care.
      pools: [{ ...pool, transactionHash: undefined, replayTransactions: undefined, activity: 0 }],
      stateBlockNumber: 100n,
      pinnedBlock,
      signal: new AbortController().signal,
      createSession: session().factory,
    })

    expect(coverage.status).toBe('passed')
    expect(coverage.exploredPools).toBe(1)
  })

  it('records an exploration failure without failing the phase', async () => {
    const coverage = await runProtocolScenarioExploration({
      scanId: 'explore-test',
      client: client(),
      chainId: 1,
      poolManager: POOL_MANAGER,
      pools: [pool],
      stateBlockNumber: 100n,
      pinnedBlock,
      signal: new AbortController().signal,
      createSession: session(async () => { throw new Error('worker died') }).factory,
    })

    expect(coverage.status).toBe('degraded')
    expect(coverage.outcomes[0]!.status).toBe('failed')
    expect(coverage.outcomes[0]!.reason).toBe('worker died')
    expect(coverage.findings).toHaveLength(0)
  })
})
