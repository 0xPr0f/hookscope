import { describe, expect, it } from 'vitest'
import { isEndpointCapabilityError, toViemChain } from './rpc'
import { CHAINS, getChainConfig } from '../config/chains'

describe('RPC endpoint failover', () => {
  it('rotates to the next endpoint when one cannot serve historical state', () => {
    for (const message of [
      'missing trie node e9d75c26d1306bbe',
      'historical state 8d3c625e is not available',
      'Archive requests require a personal token.',
      'Block requested not found. Request might be querying historical state',
      'header not found',
      'Unknown state. First available state is 9305',
    ]) expect(isEndpointCapabilityError(new Error(message)), message).toBe(true)
  })

  it('rotates on range, size, and rate limits rather than surfacing them', () => {
    for (const message of [
      'range 4071432 exceeds limit of 10000',
      'backend response too large',
      'You reached Public endpoint rate limit',
      'Unauthorized: You must authenticate your request',
    ]) expect(isEndpointCapabilityError(new Error(message)), message).toBe(true)
  })

  it('rotates when a router has no backend for the request', () => {
    // drpc answers historical eth_getCode but refuses historical eth_getLogs.
    const error = Object.assign(new Error('HTTP request failed.'), { status: 400 })
    error.cause = new Error("Can't route your request to suitable provider, if you specified certain providers revise the list")
    expect(isEndpointCapabilityError(error)).toBe(true)
    expect(isEndpointCapabilityError(new Error("Can't route your request to suitable provider"))).toBe(true)
  })

  it('rotates on transient HTTP failures without multiplying generic bad requests', () => {
    for (const status of [408, 425, 429, 502, 503]) {
      expect(isEndpointCapabilityError(Object.assign(new Error('HTTP request failed.'), { status })), String(status)).toBe(true)
    }
    expect(isEndpointCapabilityError(Object.assign(new Error('HTTP request failed.'), { status: 400 }))).toBe(false)
    expect(isEndpointCapabilityError(Object.assign(new Error('HTTP request failed.'), { status: 403 }))).toBe(false)
  })

  it('reads a capability complaint nested in the error cause chain', () => {
    const outer = new Error('RPC Request failed.')
    outer.cause = Object.assign(new Error('inner'), { details: 'eth_getLogs is limited to 0 - 50 blocks range' })
    expect(isEndpointCapabilityError(outer)).toBe(true)
  })

  it('surfaces a genuinely bad request instead of retrying it everywhere', () => {
    for (const message of [
      'execution reverted: insufficient allowance',
      'invalid opcode',
      'nonce too low',
    ]) expect(isEndpointCapabilityError(new Error(message)), message).toBe(false)
  })

  it('gives every deep-execution chain somewhere to fail over to', () => {
    // Failover only matters where historical reads happen; a discovery-only
    // chain degrades visibly instead of silently returning wrong state.
    for (const chain of CHAINS) {
      if (!chain.deepExecution) continue
      expect(chain.rpcUrls.length, chain.slug).toBeGreaterThan(1)
    }
  })

  it('leads with an archive-verified endpoint on the chains cleared for deep execution', () => {
    // Verified 2026-08-14 to serve eth_getCode at the PoolManager deployment block.
    // mevblocker serves both historical eth_getCode and historical eth_getLogs.
    expect(getChainConfig(1).rpcUrls[0]).toBe('https://rpc.mevblocker.io')
    expect(getChainConfig(8453).rpcUrls[0]).toBe('https://base.drpc.org')
    expect(getChainConfig(10).rpcUrls[0]).toBe('https://optimism.drpc.org')
    expect(getChainConfig(130).rpcUrls[0]).toBe('https://unichain.drpc.org')
    expect(getChainConfig(196).rpcUrls[0]).toBe('https://xlayerrpc.okx.com')
  })

  it('exposes the configured explorer through viem chain metadata', () => {
    const ethereum = toViemChain(getChainConfig(1))
    const base = toViemChain(getChainConfig(8453))

    expect(ethereum.blockExplorers?.default.url).toBe('https://etherscan.io')
    expect(base.blockExplorers?.default.url).toBe('https://basescan.org')
  })
})
