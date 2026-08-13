import { describe, expect, it } from 'vitest'
import type { Address, Hex, PublicClient } from 'viem'
import type { ForkReplayResult } from './revmProof'
import type { PoolDescriptor } from '../domain/report'
import { runLivePoolReplays } from './livePoolReplay'

const ZERO = '0x0000000000000000000000000000000000000000' as Address
const POOL_MANAGER = '0x2222222222222222222222222222222222222222' as Address

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
    expect(result.candidateTransactions).toBe(2)
    expect(result.passedTransactions).toBe(2)
    expect(result.coveredPools).toBe(1)
    expect(result.findings).toHaveLength(2)
    expect(result.limitations[0]).toContain('1 selected pool has')
  })
})
