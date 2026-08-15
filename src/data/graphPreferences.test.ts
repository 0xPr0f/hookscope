import { describe, expect, it } from 'vitest'
import type { ChainConfig } from '../config/chains'
import {
  clearGraphApiKey,
  loadGraphApiKey,
  runtimeSubgraphRequest,
  saveGraphApiKey,
} from './graphPreferences'

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) },
  }
}

const chain = {
  id: 1,
  subgraphId: 'DiYPVdygkfjDWhbxGSqAQxwBKmfKnkWQojqeM2rkLb3G',
  subgraphUrl: '/api/subgraph/1',
} as ChainConfig

describe('browser The Graph preference', () => {
  it('stores and removes the key without exposing it through another identity', () => {
    const storage = memoryStorage()
    expect(saveGraphApiKey('graph-key-123', storage)).toBe('graph-key-123')
    expect(loadGraphApiKey(storage)).toBe('graph-key-123')
    clearGraphApiKey(storage)
    expect(loadGraphApiKey(storage)).toBeUndefined()
  })

  it('uses a saved key only for a published Graph subgraph', () => {
    expect(runtimeSubgraphRequest(chain, 'graph-key-123')).toEqual({
      url: 'https://gateway.thegraph.com/api/subgraphs/id/DiYPVdygkfjDWhbxGSqAQxwBKmfKnkWQojqeM2rkLb3G',
      headers: { authorization: 'Bearer graph-key-123' },
      source: 'browser-graph-key',
    })
    expect(runtimeSubgraphRequest({ ...chain, subgraphId: undefined }, 'graph-key-123')?.source).toBe('server-proxy')
  })

  it('does not override an explicit self-hosted subgraph URL', () => {
    expect(runtimeSubgraphRequest({ ...chain, subgraphUrl: 'https://index.example/graphql' }, 'graph-key-123')).toEqual({
      url: 'https://index.example/graphql',
      headers: {},
      source: 'self-hosted',
    })
  })

  it('rejects whitespace and control characters', () => {
    expect(() => saveGraphApiKey('bad key', memoryStorage())).toThrow('without spaces')
    expect(() => saveGraphApiKey('bad\nkey', memoryStorage())).toThrow('without spaces')
  })
})
