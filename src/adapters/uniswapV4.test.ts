import { describe, expect, it } from 'vitest'
import type { Address, Hex, PublicClient } from 'viem'
import type { ChainConfig } from '../config/chains'
import type { PoolDescriptor } from '../domain/report'
import { computePoolId, computePoolStateSlot, discoverPools } from './uniswapV4'

const TOKEN = '0x1111111111111111111111111111111111111111' as Address
const POOL_MANAGER = '0x2222222222222222222222222222222222222222' as Address
const ZERO = '0x0000000000000000000000000000000000000000' as Address

function pool(block: bigint, fee = 3_000): PoolDescriptor {
  const descriptor = {
    currency0: ZERO,
    currency1: TOKEN,
    fee,
    tickSpacing: 60,
    hook: ZERO,
    initializedAtBlock: block.toString(),
    liquidity: '100',
    activity: 2,
  }
  return { ...descriptor, poolId: computePoolId(descriptor) }
}

function initializeLog(descriptor: PoolDescriptor) {
  return {
    args: {
      id: descriptor.poolId,
      currency0: descriptor.currency0,
      currency1: descriptor.currency1,
      fee: descriptor.fee,
      tickSpacing: descriptor.tickSpacing,
      hooks: descriptor.hook,
      sqrtPriceX96: 1n,
      tick: 0,
    },
    blockNumber: BigInt(descriptor.initializedAtBlock),
    transactionHash: `0x${'ab'.repeat(32)}` as Hex,
  }
}

function chain(overrides: Partial<ChainConfig> = {}): ChainConfig {
  return {
    id: 1,
    slug: 'ethereum',
    name: 'Ethereum',
    shortName: 'ETH',
    explorerUrl: 'https://example.test',
    rpcUrls: ['https://rpc.example.test'],
    poolManager: POOL_MANAGER,
    deploymentBlock: 90n,
    poolIndexUrl: 'https://index.example.test/{chainId}/{token}.json',
    evmVariant: 'ethereum',
    confirmations: 12,
    deepExecution: true,
    ...overrides,
  }
}

function staticIndexResponse(indexedPool: PoolDescriptor, indexedThroughBlock = 100n) {
  return new Response(JSON.stringify({
    schemaVersion: '1',
    chainId: 1,
    poolManager: POOL_MANAGER,
    token: TOKEN,
    indexedThroughBlock: indexedThroughBlock.toString(),
    pools: [indexedPool],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('Uniswap v4 PoolId', () => {
  it('reconstructs the observed HFA pool id', () => {
    expect(
      computePoolId({
        currency0: '0x0000000000000000000000000000000000000000',
        currency1: '0xD0a606aDf58b69a28D479aA510CE6FE96E0a1eb2',
        fee: 0x800000,
        tickSpacing: 200,
        hook: '0x07f49E9FFb3A275004b7af057888d02a75690040',
      }),
    ).toBe('0xdea61bc786351aea1567f7110eaa590b051beec9fad227a8b2411c427ad0b210')
  })

  it('derives the canonical Pool.State storage slot', () => {
    expect(computePoolStateSlot(`0x${'00'.repeat(32)}`)).toMatch(/^0x[0-9a-f]{64}$/)
    expect(computePoolStateSlot(`0x${'00'.repeat(32)}`)).not.toBe(`0x${'00'.repeat(32)}`)
  })
})

describe('Uniswap v4 index-first discovery', () => {
  it('validates indexed candidates in one extsload call and scans only the recent log tail', async () => {
    const indexedPool = pool(95n)
    const tailPool = pool(110n, 500)
    const logRanges: [bigint, bigint][] = []
    let stateReads = 0
    const client = {
      readContract: async () => {
        stateReads += 1
        return [`0x${'00'.repeat(31)}01`]
      },
      getLogs: async ({ args, fromBlock, toBlock }: { args: { currency0?: Address; currency1?: Address }; fromBlock: bigint; toBlock: bigint }) => {
        logRanges.push([fromBlock, toBlock])
        return args.currency1 === TOKEN && fromBlock <= 110n && toBlock >= 110n ? [initializeLog(tailPool)] : []
      },
    } as unknown as PublicClient

    const result = await discoverPools(
      client,
      chain(),
      TOKEN,
      120n,
      undefined,
      async () => staticIndexResponse(indexedPool),
    )

    expect(result.source).toBe('index+tail')
    expect(result.completeHistory).toBe(true)
    expect(result.indexedThroughBlock).toBe('100')
    expect(result.pools.map((item) => item.poolId)).toEqual([indexedPool.poolId, tailPool.poolId])
    expect(stateReads).toBe(1)
    expect(logRanges).toEqual([[101n, 120n], [101n, 120n]])
  })

  it('excludes an indexed candidate whose PoolManager state is not initialized', async () => {
    const indexedPool = pool(95n)
    const client = {
      readContract: async () => ['0x0'],
      getLogs: async () => [],
    } as unknown as PublicClient

    const result = await discoverPools(
      client,
      chain(),
      TOKEN,
      100n,
      undefined,
      async () => staticIndexResponse(indexedPool),
    )

    expect(result.pools).toEqual([])
    expect(result.limitation).toContain('no initialized PoolManager state')
  })

  it('uses the bounded full-history log fallback when no index is configured or available', async () => {
    const fallbackPool = pool(95n)
    const client = {
      getLogs: async ({ args }: { args: { currency0?: Address; currency1?: Address } }) =>
        args.currency1 === TOKEN ? [initializeLog(fallbackPool)] : [],
    } as unknown as PublicClient

    const result = await discoverPools(
      client,
      chain(),
      TOKEN,
      100n,
      undefined,
      async () => new Response(null, { status: 404 }),
    )

    expect(result.source).toBe('logs')
    expect(result.completeHistory).toBe(true)
    expect(result.pools).toHaveLength(1)
    expect(result.pools[0]?.poolId).toBe(fallbackPool.poolId)
  })
})
