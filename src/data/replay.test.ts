import { describe, expect, it } from 'vitest'
import { toEventSelector, type Address, type Hex, type PublicClient } from 'viem'
import type { PoolDescriptor, PoolReplayReference } from '../domain/report'
import { loadPoolReplayCandidate, replayReferencesForPool } from './replay'

const POOL_MANAGER = '0x2222222222222222222222222222222222222222' as Address
const TOKEN = '0x1111111111111111111111111111111111111111' as Address
const ZERO = '0x0000000000000000000000000000000000000000' as Address
const TX_HASH = `0x${'ab'.repeat(32)}` as Hex
const POOL_ID = `0x${'12'.repeat(32)}` as Hex

const pool: PoolDescriptor = {
  poolId: POOL_ID,
  currency0: ZERO,
  currency1: TOKEN,
  fee: 3_000,
  tickSpacing: 60,
  hook: ZERO,
  initializedAtBlock: '100',
  transactionHash: TX_HASH,
  activity: 0,
}

const reference: PoolReplayReference = { kind: 'swap', transactionHash: TX_HASH, blockNumber: '100' }

function client(eventPoolId = POOL_ID): PublicClient {
  return {
    getTransaction: async () => ({
      blockNumber: 100n,
      to: POOL_MANAGER,
      from: TOKEN,
      input: '0x1234',
      value: 0n,
      gas: 500_000n,
      maxFeePerGas: 20n,
      maxPriorityFeePerGas: 2n,
      gasPrice: 20n,
      nonce: 7,
    }),
    getTransactionReceipt: async () => ({
      transactionHash: TX_HASH,
      status: 'success',
      gasUsed: 123_456n,
      logs: [{
        address: POOL_MANAGER,
        topics: [toEventSelector('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)'), eventPoolId],
      }],
    }),
    getBlock: async () => ({
      number: 100n,
      miner: ZERO,
      timestamp: 1_000n,
      gasLimit: 30_000_000n,
      baseFeePerGas: 10n,
      difficulty: 0n,
      mixHash: `0x${'00'.repeat(32)}`,
    }),
  } as unknown as PublicClient
}

describe('pinned PoolManager replay candidates', () => {
  it('deduplicates the legacy initialization hash and indexed replay references', () => {
    const references = replayReferencesForPool({
      ...pool,
      replayTransactions: [
        { kind: 'initialize', transactionHash: TX_HASH, blockNumber: '100' },
        reference,
        reference,
      ],
    })
    expect(references.map((item) => item.kind)).toEqual(['swap', 'initialize'])
  })

  it('accepts only a receipt event emitted by the configured PoolManager for the selected PoolId', async () => {
    const candidate = await loadPoolReplayCandidate(client(), 1, POOL_MANAGER, pool, reference)
    expect(candidate.kind).toBe('swap')
    expect(candidate.poolId).toBe(POOL_ID)
    expect(candidate.stateBlockNumber).toBe(99n)
    expect(candidate.expected).toEqual({ success: true, gasUsed: 123_456n, logCount: 1 })

    await expect(loadPoolReplayCandidate(client(`0x${'34'.repeat(32)}`), 1, POOL_MANAGER, pool, reference))
      .rejects.toThrow('no swap event for this PoolId')
  })
})
