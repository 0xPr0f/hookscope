import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { computePoolId } from '../adapters/uniswapV4Pool'
import type { ChainConfig } from '../config/chains'
import { fetchPoolIndex } from './poolIndex'

const TOKEN = '0x1111111111111111111111111111111111111111' as Address
const ZERO = '0x0000000000000000000000000000000000000000' as Address

const chain: ChainConfig = {
  id: 1,
  slug: 'ethereum',
  name: 'Ethereum',
  shortName: 'ETH',
  explorerUrl: 'https://example.test',
  rpcUrls: ['https://rpc.example.test'],
  subgraphUrl: 'https://subgraph.example.test',
  poolManager: '0x2222222222222222222222222222222222222222',
  deploymentBlock: 90n,
  evmVariant: 'ethereum',
  confirmations: 12,
  deepExecution: true,
}

describe('Uniswap v4 pool index fetcher', () => {
  it('maps and deduplicates token-filtered subgraph candidates with index-head identity', async () => {
    const poolKey = { currency0: ZERO, currency1: TOKEN, fee: 3_000, tickSpacing: 60, hook: ZERO }
    let requestBody: { variables?: { token?: string } } | undefined
    const result = await fetchPoolIndex({
      chain,
      token: TOKEN,
      fetcher: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as typeof requestBody
        const candidate = {
          id: computePoolId(poolKey),
          token0: { id: ZERO },
          token1: { id: TOKEN },
          feeTier: '3000',
          tickSpacing: '60',
          hooks: ZERO,
          liquidity: '500',
          txCount: '12',
          createdAtBlockNumber: '95',
          swaps: [{ transaction: { id: `0x${'ab'.repeat(32)}`, blockNumber: '119' } }],
          modifyLiquiditys: [{ transaction: { id: `0x${'cd'.repeat(32)}`, blockNumber: '118' } }],
        }
        return new Response(JSON.stringify({
          data: {
            token0Pools: [],
            token1Pools: [candidate, candidate],
            _meta: { block: { number: 120 }, hasIndexingErrors: false },
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })

    expect(requestBody?.variables?.token).toBe(TOKEN.toLowerCase())
    expect(result?.source).toBe('subgraph')
    expect(result?.indexedThroughBlock).toBe(120n)
    expect(result?.pools).toHaveLength(1)
    expect(result?.pools[0]?.liquidity).toBe('500')
    expect(result?.pools[0]?.activity).toBe(12)
    expect(result?.pools[0]?.replayTransactions?.map((reference) => reference.kind)).toEqual(['swap', 'modify-liquidity'])
  })

  it('accepts bounded representative transaction references from a static index', async () => {
    const poolKey = { currency0: ZERO, currency1: TOKEN, fee: 3_000, tickSpacing: 60, hook: ZERO }
    const transactionHash = `0x${'ab'.repeat(32)}`
    const result = await fetchPoolIndex({
      chain: { ...chain, poolIndexUrl: 'https://index.example.test/{chainId}/{token}.json' },
      token: TOKEN,
      fetcher: async () => new Response(JSON.stringify({
        schemaVersion: '1',
        chainId: 1,
        poolManager: chain.poolManager,
        token: TOKEN,
        indexedThroughBlock: '120',
        pools: [{
          poolId: computePoolId(poolKey),
          ...poolKey,
          initializedAtBlock: '95',
          replayTransactions: [
            { kind: 'swap', transactionHash, blockNumber: '110' },
            { kind: 'swap', transactionHash, blockNumber: '110' },
          ],
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    })

    expect(result?.source).toBe('static-index')
    expect(result?.limitations.join(' ')).toContain('checksum was not verified')
    expect(result?.pools[0]?.replayTransactions).toEqual([{ kind: 'swap', transactionHash, blockNumber: '110' }])
  })

  it('rejects a shard whose bytes disagree with the published manifest checksum', async () => {
    const document = {
      schemaVersion: '1',
      chainId: 1,
      poolManager: chain.poolManager,
      token: TOKEN,
      indexedThroughBlock: '100',
      pools: [],
    }
    const body = JSON.stringify(document)
    const fetcher = async (url: string) => {
      if (url.endsWith('manifest.json')) {
        return new Response(JSON.stringify({
          schemaVersion: '1',
          chainId: 1,
          documents: [{ token: TOKEN.toLowerCase(), checksum: `sha256:${'0'.repeat(64)}` }],
        }), { status: 200 })
      }
      return new Response(body, { status: 200 })
    }

    const result = await fetchPoolIndex({
      chain: { ...chain, poolIndexUrl: 'https://cdn.example.com/v1/{chainId}/{token}.json' },
      token: TOKEN,
      fetcher: fetcher as never,
    })

    // The substituted shard is refused; discovery degrades visibly instead of trusting it.
    expect(result?.source).not.toBe('static-index')
    expect(result?.pools).toEqual([])
    expect(result?.limitations.join(' ')).toContain('does not match its published manifest checksum')
  })
})
