import { describe, expect, it, vi } from 'vitest'
import type { Address, PublicClient } from 'viem'
import { computePoolId } from '../adapters/uniswapV4Pool'
import { fetchPositionManagerPosition, mapPositionManagerPosition } from './positionManagerPosition'

const POSITION_MANAGER = '0x1111111111111111111111111111111111111111' as Address
const CURRENCY0 = '0x0000000000000000000000000000000000000000' as Address
const CURRENCY1 = '0x2222222222222222222222222222222222222222' as Address
const HOOK = '0x3333333333333333333333333333333333333333' as Address
const poolKey = { currency0: CURRENCY0, currency1: CURRENCY1, fee: 3_000, tickSpacing: 60, hooks: HOOK }

describe('pinned PositionManager position lookup', () => {
  it('maps the returned PoolKey to the canonical PoolId', () => {
    const position = mapPositionManagerPosition({ tokenId: 42n, poolKey, positionInfo: 9n })
    expect(position).toEqual({
      tokenId: 42n,
      poolKey,
      poolId: computePoolId({ ...poolKey, hook: poolKey.hooks }),
      positionInfo: 9n,
    })
  })

  it('pins the read to the supplied parent block', async () => {
    const readContract = vi.fn(async () => [poolKey, 9n] as const)
    const result = await fetchPositionManagerPosition({
      client: { readContract } as unknown as PublicClient,
      positionManager: POSITION_MANAGER,
      tokenId: 42n,
      blockNumber: 123n,
    })
    expect(result.poolId).toBe(computePoolId({ ...poolKey, hook: poolKey.hooks }))
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: POSITION_MANAGER,
      functionName: 'getPoolAndPositionInfo',
      args: [42n],
      blockNumber: 123n,
    }))
  })

  it('does not start an RPC read after cancellation', async () => {
    const readContract = vi.fn()
    const controller = new AbortController()
    controller.abort()
    await expect(fetchPositionManagerPosition({
      client: { readContract } as unknown as PublicClient,
      positionManager: POSITION_MANAGER,
      tokenId: 42n,
      blockNumber: 123n,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(readContract).not.toHaveBeenCalled()
  })
})
