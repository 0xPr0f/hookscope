import { describe, expect, it } from 'vitest'
import type { ChainConfig } from '../config/chains'
import { clearRpcOverrides, loadRpcOverrides, removeRpcOverride, runtimeRpcUrls, saveRpcOverride } from './rpcPreferences'

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

const chain = { id: 1, rpcUrls: ['https://default.example'] } as ChainConfig

describe('browser RPC preferences', () => {
  it('stores one versioned override per chain and replaces public fallbacks', () => {
    const storage = memoryStorage()
    const overrides = saveRpcOverride(1, 'https://archive.example/v2/key', storage)
    expect(loadRpcOverrides(storage)).toEqual(overrides)
    expect(runtimeRpcUrls(chain, overrides)).toEqual(['https://archive.example/v2/key'])
  })

  it('removes individual and all overrides', () => {
    const storage = memoryStorage()
    saveRpcOverride(1, 'https://one.example', storage)
    saveRpcOverride(10, 'https://ten.example', storage)
    expect(removeRpcOverride(1, storage)).toEqual({ 10: 'https://ten.example' })
    expect(clearRpcOverrides(storage)).toEqual({})
  })

  it('rejects non-HTTP endpoint values', () => {
    expect(() => saveRpcOverride(1, 'ws://example.test', memoryStorage())).toThrow('HTTP or HTTPS')
  })
})

