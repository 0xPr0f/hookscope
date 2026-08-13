import { getAddress, type Address, type Hex, type PublicClient } from 'viem'
import type { V4PoolKey } from '../adapters/uniswapV4RouterCodec'
import { computePoolId } from '../adapters/uniswapV4Pool'

const POSITION_MANAGER_POSITION_ABI = [{
  type: 'function',
  name: 'getPoolAndPositionInfo',
  stateMutability: 'view',
  inputs: [{ name: 'tokenId', type: 'uint256' }],
  outputs: [
    {
      name: 'poolKey',
      type: 'tuple',
      components: [
        { name: 'currency0', type: 'address' },
        { name: 'currency1', type: 'address' },
        { name: 'fee', type: 'uint24' },
        { name: 'tickSpacing', type: 'int24' },
        { name: 'hooks', type: 'address' },
      ],
    },
    { name: 'positionInfo', type: 'uint256' },
  ],
}] as const

export type PositionManagerPosition = {
  tokenId: bigint
  poolKey: V4PoolKey
  poolId: Hex
  positionInfo: bigint
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Position lookup cancelled', 'AbortError')
}

export function mapPositionManagerPosition(input: {
  tokenId: bigint
  poolKey: {
    currency0: Address
    currency1: Address
    fee: number
    tickSpacing: number
    hooks: Address
  }
  positionInfo: bigint
}): PositionManagerPosition {
  const poolKey: V4PoolKey = {
    currency0: getAddress(input.poolKey.currency0),
    currency1: getAddress(input.poolKey.currency1),
    fee: input.poolKey.fee,
    tickSpacing: input.poolKey.tickSpacing,
    hooks: getAddress(input.poolKey.hooks),
  }
  return {
    tokenId: input.tokenId,
    poolKey,
    poolId: computePoolId({
      currency0: poolKey.currency0,
      currency1: poolKey.currency1,
      fee: poolKey.fee,
      tickSpacing: poolKey.tickSpacing,
      hook: poolKey.hooks,
    }),
    positionInfo: input.positionInfo,
  }
}

/**
 * Reads one v4 PositionManager NFT at the exact parent-state block used by a
 * historical replay. The caller owns batching/caching because the same token
 * can appear in several actions within one router envelope.
 */
export async function fetchPositionManagerPosition(input: {
  client: PublicClient
  positionManager: Address
  tokenId: bigint
  blockNumber: bigint
  signal?: AbortSignal
}): Promise<PositionManagerPosition> {
  throwIfAborted(input.signal)
  const [poolKey, positionInfo] = await input.client.readContract({
    address: input.positionManager,
    abi: POSITION_MANAGER_POSITION_ABI,
    functionName: 'getPoolAndPositionInfo',
    args: [input.tokenId],
    blockNumber: input.blockNumber,
  })
  throwIfAborted(input.signal)
  return mapPositionManagerPosition({ tokenId: input.tokenId, poolKey, positionInfo })
}
