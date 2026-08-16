import { describe, expect, it } from 'vitest'
import { encodeFunctionData, type Address, type Hex, type PublicClient } from 'viem'
import type { ForkReplayResult } from './revmProof'
import type { PoolDescriptor } from '../domain/report'
import { runLivePoolReplays } from './livePoolReplay'
import { computePoolId } from '../adapters/uniswapV4Pool'
import type { IndexedReplayTransaction } from '../data/replay'

const ZERO = '0x0000000000000000000000000000000000000000' as Address
const POOL_MANAGER = '0x2222222222222222222222222222222222222222' as Address
const TOKEN = '0x1111111111111111111111111111111111111111' as Address

const INITIALIZE_POOL_ABI = [{
  type: 'function',
  name: 'initializePool',
  stateMutability: 'payable',
  inputs: [{
    name: 'key',
    type: 'tuple',
    components: [
      { name: 'currency0', type: 'address' },
      { name: 'currency1', type: 'address' },
      { name: 'fee', type: 'uint24' },
      { name: 'tickSpacing', type: 'int24' },
      { name: 'hooks', type: 'address' },
    ],
  }, { name: 'sqrtPriceX96', type: 'uint160' }],
  outputs: [{ type: 'int24' }],
}] as const

function initializeCalldata(input: Pick<PoolDescriptor, 'currency0' | 'currency1' | 'fee' | 'tickSpacing' | 'hook'>) {
  return encodeFunctionData({
    abi: INITIALIZE_POOL_ABI,
    functionName: 'initializePool',
    args: [{
      currency0: input.currency0,
      currency1: input.currency1,
      fee: input.fee,
      tickSpacing: input.tickSpacing,
      hooks: input.hook,
    }, 2n ** 96n],
  })
}

function indexedTransaction(reference: { blockNumber: string }, input: Hex): IndexedReplayTransaction {
  return {
    blockNumber: BigInt(reference.blockNumber),
    to: POOL_MANAGER,
    from: TOKEN,
    input,
    value: 0n,
    gas: 500_000n,
    gasPrice: 10n,
    maxFeePerGas: 10n,
    maxPriorityFeePerGas: 1n,
    nonce: 1,
  } as unknown as IndexedReplayTransaction
}

function pool(id: string, transactionHash?: Hex): PoolDescriptor {
  return {
    poolId: `0x${id.repeat(64)}` as Hex,
    currency0: ZERO,
    currency1: '0x1111111111111111111111111111111111111111',
    fee: 3_000,
    tickSpacing: 60,
    hook: ZERO,
    initializedAtBlock: '100',
    transactionHash,
    activity: 0,
  }
}

const replayResult: ForkReplayResult = {
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
  },
  hydrationRequests: 3,
  hydratedAccounts: 1,
  hydratedStorageSlots: 1,
}

describe('live pool replay coverage', () => {
  it('replays bounded indexed contexts and exposes an uncovered pool as degraded', async () => {
    const hash = `0x${'ab'.repeat(32)}` as Hex
    const covered = pool('1', hash)
    covered.replayTransactions = [{ kind: 'swap', transactionHash: `0x${'cd'.repeat(32)}`, blockNumber: '101' }]
    const uncovered = pool('2')
    const controller = new AbortController()

    const result = await runLivePoolReplays({
      scanId: 'test',
      client: {} as PublicClient,
      chainId: 1,
      poolManager: POOL_MANAGER,
      pinnedBlockNumber: 120n,
      pools: [covered, uncovered],
      signal: controller.signal,
      loadCandidate: async (_client, chainId, _poolManager, selectedPool, reference) => ({
        kind: reference.kind,
        poolId: selectedPool.poolId,
        transactionHash: reference.transactionHash,
        stateBlockNumber: BigInt(reference.blockNumber) - 1n,
        transaction: {
          caller: ZERO,
          to: POOL_MANAGER,
          calldata: '0x',
          value: 0n,
          gasLimit: 1_000_000n,
          gasPrice: 0n,
          nonce: 0,
          chainId,
        },
        block: { number: BigInt(reference.blockNumber), beneficiary: ZERO, timestamp: 1n, gasLimit: 30_000_000n, baseFee: 0n, difficulty: 0n },
        expected: { success: true, gasUsed: 100n, logCount: 1 },
      }),
      replay: async () => replayResult,
    })

    expect(result.status).toBe('degraded')
    expect(result.candidateTransactions).toBe(1)
    expect(result.passedTransactions).toBe(1)
    expect(result.coveredPools).toBe(1)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]?.technical).toMatchObject({
      receiptMatched: true,
      expectedOutcome: 'success',
      reproducedOutcome: 'success',
      gasUsed: '100',
      logCount: 1,
    })
    expect(result.limitations[0]).toContain('No indexed historical transaction')
    expect(result.limitations[1]).toContain('1 selected pool has')
  })

  it('reports an RPC capability failure without exposing the endpoint URL', async () => {
    const selected = pool('3')
    selected.replayTransactions = [{ kind: 'swap', transactionHash: `0x${'ef'.repeat(32)}`, blockNumber: '110' }]
    const result = await runLivePoolReplays({
      scanId: 'rpc-failure',
      client: {} as PublicClient,
      chainId: 1,
      poolManager: POOL_MANAGER,
      pinnedBlockNumber: 120n,
      pools: [selected],
      signal: new AbortController().signal,
      loadCandidate: async () => {
        throw new Error('HTTP request failed: rate limit at https://secret.example/key')
      },
    })

    expect(result.limitations[0]).toBe('The configured RPC endpoints could not provide all parent-block account or storage state required by replay.')
    expect(result.limitations.join(' ')).not.toContain('secret.example')
  })

  it('prefetches indexed transactions and prioritizes only an official envelope for the selected PoolId', async () => {
    const selected: PoolDescriptor = {
      currency0: ZERO,
      currency1: TOKEN,
      fee: 3_000,
      tickSpacing: 60,
      hook: ZERO,
      poolId: computePoolId({ currency0: ZERO, currency1: TOKEN, fee: 3_000, tickSpacing: 60, hook: ZERO }),
      initializedAtBlock: '100',
      activity: 0,
    }
    const foreign: PoolDescriptor = {
      ...selected,
      currency1: '0x3333333333333333333333333333333333333333',
      poolId: computePoolId({
        currency0: ZERO,
        currency1: '0x3333333333333333333333333333333333333333',
        fee: 3_000,
        tickSpacing: 60,
        hook: ZERO,
      }),
    }
    const unknownHash = `0x${'aa'.repeat(32)}` as Hex
    const foreignHash = `0x${'bb'.repeat(32)}` as Hex
    const selectedHash = `0x${'cc'.repeat(32)}` as Hex
    selected.replayTransactions = [
      { kind: 'swap', transactionHash: unknownHash, blockNumber: '113' },
      { kind: 'initialize', transactionHash: foreignHash, blockNumber: '112' },
      { kind: 'initialize', transactionHash: selectedHash, blockNumber: '111' },
    ]
    const prefetched: Hex[] = []
    const attempted: Hex[] = []

    const result = await runLivePoolReplays({
      scanId: 'rank-official',
      client: {} as PublicClient,
      chainId: 1,
      poolManager: POOL_MANAGER,
      pinnedBlockNumber: 120n,
      pools: [selected],
      signal: new AbortController().signal,
      loadTransaction: async (_client, reference) => {
        prefetched.push(reference.transactionHash)
        const calldata = reference.transactionHash === selectedHash
          ? initializeCalldata(selected)
          : reference.transactionHash === foreignHash
            ? initializeCalldata(foreign)
            : '0x9409a78f'
        return indexedTransaction(reference, calldata)
      },
      loadCandidate: async (_client, chainId, _poolManager, pool, reference) => {
        attempted.push(reference.transactionHash)
        return {
          kind: reference.kind,
          poolId: pool.poolId,
          transactionHash: reference.transactionHash,
          stateBlockNumber: BigInt(reference.blockNumber) - 1n,
          transaction: {
            caller: ZERO,
            to: POOL_MANAGER,
            calldata: initializeCalldata(selected),
            value: 0n,
            gasLimit: 1_000_000n,
            gasPrice: 0n,
            nonce: 0,
            chainId,
          },
          block: { number: BigInt(reference.blockNumber), beneficiary: ZERO, timestamp: 1n, gasLimit: 30_000_000n, baseFee: 0n, difficulty: 0n },
          expected: { success: true, gasUsed: 100n, logCount: 1 },
        }
      },
      replay: async () => replayResult,
    })

    expect(prefetched).toHaveLength(3)
    expect(attempted).toEqual([selectedHash])
    expect(result.outcomes[0]?.transactionHash).toBe(selectedHash)
    expect(result.candidateTransactions).toBe(1)
  })

  it('keeps the original reference order when no controllable official envelope is found', async () => {
    const selected = pool('4')
    const recent = `0x${'dd'.repeat(32)}` as Hex
    const older = `0x${'ee'.repeat(32)}` as Hex
    selected.replayTransactions = [
      { kind: 'swap', transactionHash: recent, blockNumber: '112' },
      { kind: 'swap', transactionHash: older, blockNumber: '111' },
    ]
    const attempted: Hex[] = []

    const result = await runLivePoolReplays({
      scanId: 'rank-fallback',
      client: {} as PublicClient,
      chainId: 1,
      poolManager: POOL_MANAGER,
      pinnedBlockNumber: 120n,
      pools: [selected],
      signal: new AbortController().signal,
      loadTransaction: async (_client, reference) => indexedTransaction(reference, '0x9409a78f'),
      loadCandidate: async (_client, chainId, _poolManager, pool, reference) => {
        attempted.push(reference.transactionHash)
        if (reference.transactionHash === recent) throw new Error('first candidate unavailable')
        return {
          kind: reference.kind,
          poolId: pool.poolId,
          transactionHash: reference.transactionHash,
          stateBlockNumber: BigInt(reference.blockNumber) - 1n,
          transaction: { caller: ZERO, to: POOL_MANAGER, calldata: '0x9409a78f', value: 0n, gasLimit: 1_000_000n, gasPrice: 0n, nonce: 0, chainId },
          block: { number: BigInt(reference.blockNumber), beneficiary: ZERO, timestamp: 1n, gasLimit: 30_000_000n, baseFee: 0n, difficulty: 0n },
          expected: { success: true, gasUsed: 100n, logCount: 1 },
        }
      },
      replay: async () => replayResult,
    })

    expect(attempted).toEqual([recent, older])
    expect(result.outcomes[0]?.transactionHash).toBe(older)
    expect(result.candidateTransactions).toBe(2)
  })
})
