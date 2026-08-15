import { describe, expect, it, vi } from 'vitest'
import type { Address, PublicClient } from 'viem'
import { createForkHydrationCache } from './forkHydrationCache'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address

describe('scan-wide fork hydration cache', () => {
  it('coalesces identical pinned account reads and reports reuse', async () => {
    const client = {
      getBalance: vi.fn(async () => 1n),
      getTransactionCount: vi.fn(async () => 2),
      getCode: vi.fn(async () => '0x6000'),
    } as unknown as PublicClient
    const cache = createForkHydrationCache(client)
    const request = { kind: 'account' as const, address: ACCOUNT }

    const [first, second] = await Promise.all([cache.load(100n, request), cache.load(100n, request)])

    expect(first).toEqual(second)
    expect(client.getBalance).toHaveBeenCalledTimes(1)
    expect(client.getTransactionCount).toHaveBeenCalledTimes(1)
    expect(client.getCode).toHaveBeenCalledTimes(1)
    expect(cache.metrics()).toEqual({ entries: 1, hits: 1, misses: 1 })
  })

  it('does not reuse one block snapshot for another block', async () => {
    const client = {
      getBalance: vi.fn(async () => 0n),
      getTransactionCount: vi.fn(async () => 0),
      getCode: vi.fn(async () => '0x'),
    } as unknown as PublicClient
    const cache = createForkHydrationCache(client)
    const request = { kind: 'account' as const, address: ACCOUNT }

    await cache.load(100n, request)
    await cache.load(101n, request)

    expect(client.getBalance).toHaveBeenCalledTimes(2)
  })
})
