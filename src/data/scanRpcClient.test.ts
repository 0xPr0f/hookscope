import { describe, expect, it, vi } from 'vitest'
import type { Address, PublicClient } from 'viem'
import { createScanRpcClient, mapWithConcurrency } from './scanRpcClient'

const ADDRESS = '0x1111111111111111111111111111111111111111' as Address

describe('scan RPC coordination', () => {
  it('coalesces identical pinned reads and evicts rejected reads', async () => {
    const getCode = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue('0x6000')
    const wrapped = createScanRpcClient({ client: { getCode } as unknown as PublicClient }).client

    await expect(wrapped.getCode({ address: ADDRESS, blockNumber: 100n })).rejects.toThrow('temporary')
    const [first, second] = await Promise.all([
      wrapped.getCode({ address: ADDRESS, blockNumber: 100n }),
      wrapped.getCode({ address: ADDRESS, blockNumber: 100n }),
    ])

    expect(first).toBe('0x6000')
    expect(second).toBe('0x6000')
    expect(getCode).toHaveBeenCalledTimes(2)
  })

  it('bounds resolution jobs while preserving input order', async () => {
    let active = 0
    let peak = 0
    const output = await mapWithConcurrency({
      items: [1, 2, 3, 4, 5, 6],
      concurrency: 3,
      map: async (value) => {
        active += 1
        peak = Math.max(peak, active)
        await Promise.resolve()
        active -= 1
        return value * 2
      },
    })
    expect(output).toEqual([2, 4, 6, 8, 10, 12])
    expect(peak).toBe(3)
  })

  it('uses a smaller independent ceiling for log reads', async () => {
    let active = 0
    let peak = 0
    const getLogs = vi.fn(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 2))
      active -= 1
      return []
    })
    const scan = createScanRpcClient({
      client: { getLogs } as unknown as PublicClient,
      readConcurrency: 4,
      logConcurrency: 1,
    })
    await Promise.all(Array.from({ length: 4 }, () => scan.client.getLogs({ address: ADDRESS })))
    expect(peak).toBe(1)
    expect(scan.metrics().logs.peak).toBe(1)
  })
})
