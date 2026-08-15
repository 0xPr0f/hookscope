import { describe, expect, it } from 'vitest'
import { CHAINS, getChainConfig, resolveSubgraphSource } from './chains'

describe('chain registry subgraph configuration', () => {
  it('defaults to the same-origin proxy so the key stays on the server', () => {
    expect(resolveSubgraphSource({ chainId: 1, subgraphId: 'SUBGRAPH_ID' })).toEqual({
      url: '/api/subgraph/1',
    })
  })

  it('sends a browser key as a bearer token instead of embedding it in the URL', () => {
    const source = resolveSubgraphSource({ chainId: 1, subgraphId: 'SUBGRAPH_ID', browserApiKey: 'KEY' })
    expect(source.url).toBe('https://gateway.thegraph.com/api/subgraphs/id/SUBGRAPH_ID')
    expect(source.url).not.toContain('KEY')
    expect(source.headers).toEqual({ authorization: 'Bearer KEY' })
  })

  it('prefers an explicit private indexer over both', () => {
    expect(resolveSubgraphSource({
      chainId: 1,
      subgraphId: 'SUBGRAPH_ID',
      explicitUrl: 'https://private.example/graphql',
      browserApiKey: 'KEY',
    })).toEqual({ url: 'https://private.example/graphql' })
  })

  it('resolves nothing for a chain with no published subgraph', () => {
    expect(resolveSubgraphSource({ chainId: 42161, browserApiKey: 'KEY' })).toEqual({})
  })

  it('leaves chains without a verified subgraph on the log-scan fallback', () => {
    expect(getChainConfig(42161).subgraphId).toBeUndefined()
    expect(getChainConfig(324).subgraphId).toBeUndefined()
    expect(getChainConfig(130).subgraphId).toBe('EoCvJ5tyMLMJcTnLQwWpjAtPdn74PcrZgzfcT5bYxNBH')
    expect(getChainConfig(1).subgraphSchema).toBe('pool-entities')
  })

  it('keeps published subgraph IDs in the registry rather than in environment configuration', () => {
    const configured = CHAINS.filter((chain) => chain.subgraphId)
    // Only subgraphs verified to answer the production discovery query are listed.
    expect(configured.map((chain) => chain.slug).sort()).toEqual([
      'avalanche', 'base', 'bnb', 'ethereum', 'optimism', 'polygon', 'unichain', 'xlayer',
    ])
    for (const chain of configured) {
      // Graph Network subgraph IDs are base58 and carry no credential material.
      expect(chain.subgraphId).toMatch(/^[1-9A-HJ-NP-Za-km-z]{40,50}$/)
    }
  })

  it('leaves discovery unconfigured rather than guessing an endpoint for other chains', () => {
    expect(getChainConfig(42161).subgraphId).toBeUndefined()
    expect(getChainConfig(324).subgraphId).toBeUndefined()
  })
})
