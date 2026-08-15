import { describe, expect, it, vi } from 'vitest'
import { toHex, type Address, type Hex, type PublicClient } from 'viem'
import type { PoolDescriptor } from '../domain/report'
import { buildProtocolScenarioMatrix } from './protocolNativeScenarios'
import {
  runProtocolScenarioExploration,
  selectExplorationSeeds,
} from './protocolScenarioExploration'
import type { ForkExplorationEpoch } from './revmProof'
import { POOL_EVENT_TOPICS } from './protocolScenarioValidation'

const POOL_MANAGER = '0x000000000004444c5dc75cB358380D2e3dE08A90' as Address
const HOOK = '0x2222222222222222222222222222222222222222' as Address
const ROUTER = '0x0000000000000000000000000000000000005ce4' as Address
const ACTOR = '0x00000000000000000000000000000000000ac7a1' as Address
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

/** Only the PoolManager is occupied; the synthetic address slots must be free. */
function client() {
  const slot0 = toHex(79_228_162_514_264_337_593_543_950_336n, { size: 32 })
  const isManager = ({ address }: { address: Address }) => address.toLowerCase() === POOL_MANAGER.toLowerCase()
  return {
    getBalance: async (args: { address: Address }) => (isManager(args) ? 1n : 0n),
    getTransactionCount: async () => 0,
    getCode: async (args: { address: Address }) => (isManager(args) ? '0x60' as Hex : '0x' as Hex),
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

/** Maps a seed's calldata back to the pool event its operation must emit. */
function topicForCalldata(calldata?: Hex): Hex {
  const seed = selectExplorationSeeds(matrix(0)).find((item) => item.scenario.calldata === calldata)
  if (seed?.scenario.operation === 'liquidity') return POOL_EVENT_TOPICS.modifyLiquidity
  if (seed?.scenario.operation === 'donate') return POOL_EVENT_TOPICS.donate
  return POOL_EVENT_TOPICS.swap
}

/**
 * A warm result that really entered the PoolManager and named the pool, since
 * exploration now refuses a seed that produced no pool observation.
 *
 * The emitted event follows the seed's own operation: a donation that reported a
 * `Swap` event would be exactly the mismatch validation exists to catch.
 */
function warmProof(success = true, calldata?: Hex) {
  return {
    hydrationRequests: 0,
    hydratedAccounts: 0,
    hydratedStorageSlots: 0,
    proof: {
      engine: 'revm/36.0.0', success, gasUsed: 100, output: '0x' as Hex,
      steps: [], storageOperations: [], storageDiffs: [], balanceChanges: [], selfdestructs: [], truncated: false,
      calls: [
        { caller: ACTOR, target: ROUTER, bytecodeAddress: ROUTER, scheme: 'Call', value: '0', inputLength: 644, selector: '0x543b46f9' as Hex },
        { caller: ROUTER, target: POOL_MANAGER, bytecodeAddress: POOL_MANAGER, scheme: 'Call', value: '0', inputLength: 708, selector: '0x48c89491' as Hex },
      ],
      logs: [{ address: POOL_MANAGER, topics: [topicForCalldata(calldata), pool.poolId] as Hex[], data: '0x' as Hex }],
      logCount: 1,
    },
  }
}

function session(
  explore?: (input: { transaction: { calldata: Hex; gasPrice: bigint }; mutableIndices: number[] }) => Promise<ForkExplorationEpoch>,
  warm: (input: { transaction: { calldata: Hex; gasPrice: bigint } }) => ReturnType<typeof warmProof> =
    (input) => warmProof(true, input.transaction.calldata),
) {
  const warmedCalldata: Hex[] = []
  const gasPrices: bigint[] = []
  const close = vi.fn()
  const calls: { calldata: Hex; indices: number[]; gasPrice: bigint }[] = []
  const run = explore ?? (async ({ transaction, mutableIndices }) => {
    gasPrices.push(transaction.gasPrice)
    calls.push({ calldata: transaction.calldata, indices: mutableIndices, gasPrice: transaction.gasPrice })
    return epochFor(transaction.calldata, mutableIndices, 2)
  })
  return {
    calls,
    warmedCalldata,
    gasPrices,
    close,
    factory: () => ({
      hydrate: async () => 2,
      warm: async (input: { transaction: { calldata: Hex; gasPrice: bigint } }) => {
        gasPrices.push(input.transaction.gasPrice)
        warmedCalldata.push(input.transaction.calldata)
        return warm(input)
      },
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
    expect(spy.gasPrices.length).toBeGreaterThan(1)
    expect(spy.gasPrices.every((gasPrice) => gasPrice === pinnedBlock.baseFeePerGas)).toBe(true)
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
    const isManager = ({ address }: { address: Address }) => address.toLowerCase() === POOL_MANAGER.toLowerCase()
    const shared = {
      getBalance: async (args: { address: Address }) => (isManager(args) ? 1n : 0n),
      getTransactionCount: async () => 0,
      getCode: async (args: { address: Address }) => (isManager(args) ? '0x60' as Hex : '0x' as Hex),
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

  it('refuses a seed that never reached the PoolManager', async () => {
    const unreachable = () => {
      const warm = warmProof(false)
      return { ...warm, proof: { ...warm.proof, calls: [warm.proof.calls[0]!], logs: [], logCount: 0 } }
    }
    const coverage = await runProtocolScenarioExploration({
      scanId: 'explore-test',
      client: client(),
      chainId: 1,
      poolManager: POOL_MANAGER,
      pools: [pool],
      stateBlockNumber: 100n,
      pinnedBlock,
      signal: new AbortController().signal,
      createSession: session(undefined, unreachable).factory,
    })

    expect(coverage.outcomes[0]!.status).toBe('failed')
    expect(coverage.outcomes[0]!.reason).toContain('No generated seed reached the selected pool')
    expect(coverage.findings).toHaveLength(0)
  })

  it('validates every seed shape, not only the one that warmed the session', async () => {
    const spy = session()
    await runProtocolScenarioExploration({
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

    // One warm per seed shape: proving a swap reaches the pool says nothing
    // about whether a donation or a liquidity range does.
    const seeds = selectExplorationSeeds(matrix(0))
    expect(spy.warmedCalldata).toHaveLength(seeds.length)
    expect(new Set(spy.warmedCalldata).size).toBe(seeds.length)
  })

  it('drops only the shape whose seed missed the pool and explores the rest', async () => {
    const donateSeed = selectExplorationSeeds(matrix(0)).find((seed) => seed.scenario.operation === 'donate')!
    const failing = ({ transaction }: { transaction: { calldata: Hex } }) => {
      if (transaction.calldata !== donateSeed.scenario.calldata) return warmProof(true, transaction.calldata)
      // Reverted inside the harness before unlock: no pool observation.
      const warm = warmProof(false)
      return { ...warm, proof: { ...warm.proof, calls: [warm.proof.calls[0]!], logs: [], logCount: 0 } }
    }
    const coverage = await runProtocolScenarioExploration({
      scanId: 'explore-test',
      client: client(),
      chainId: 1,
      poolManager: POOL_MANAGER,
      pools: [pool],
      stateBlockNumber: 100n,
      pinnedBlock,
      signal: new AbortController().signal,
      createSession: session(undefined, failing).factory,
    })

    const outcome = coverage.outcomes[0]!
    expect(outcome.status).toBe('completed')
    expect(outcome.shapes.map((shape) => shape.scenarioId)).not.toContain(donateSeed.scenario.id)
    expect(outcome.rejectedSeeds?.map((item) => item.scenarioId)).toEqual([donateSeed.scenario.id])
    expect(outcome.shapes.length).toBeGreaterThan(0)
    expect(coverage.limitations.join(' ')).toContain('never reached the selected pool')
  })

  it('skips a redundant warm for a shape the scenario suite already validated', async () => {
    const seeds = selectExplorationSeeds(matrix(0))
    const spy = session()
    await runProtocolScenarioExploration({
      scanId: 'explore-test',
      client: client(),
      chainId: 1,
      poolManager: POOL_MANAGER,
      pools: [pool],
      stateBlockNumber: 100n,
      pinnedBlock,
      signal: new AbortController().signal,
      validatedScenarioIds: new Set(seeds.map((seed) => seed.scenario.id)),
      createSession: spy.factory,
    })

    // The first shape still warms, because that run performs the hydration
    // every later shape reuses; the rest are taken on the suite's evidence.
    expect(spy.warmedCalldata).toHaveLength(1)
  })

  it('explores a reverting seed but records that it reverted', async () => {
    const coverage = await runProtocolScenarioExploration({
      scanId: 'explore-test',
      client: client(),
      chainId: 1,
      poolManager: POOL_MANAGER,
      pools: [pool],
      stateBlockNumber: 100n,
      pinnedBlock,
      signal: new AbortController().signal,
      createSession: session(undefined, (input) => warmProof(false, input.transaction.calldata)).factory,
    })

    expect(coverage.outcomes[0]!.status).toBe('completed')
    expect(coverage.outcomes[0]!.seedReverted).toBe(true)
    expect(coverage.outcomes[0]!.shapes.every((shape) => shape.seedReverted)).toBe(true)
    expect(coverage.outcomes[0]!.shapes.every((shape) => shape.seedProvenance === 'warmed-here')).toBe(true)
    expect(coverage.findings[0]!.claim).toContain('rejected by the pool')
    expect(coverage.limitations.join(' ')).toContain('searched outward from a seed the pool rejected')
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
