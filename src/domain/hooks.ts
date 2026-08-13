import type { Address } from 'viem'

export const HOOK_FLAGS = [
  ['beforeInitialize', 1 << 13],
  ['afterInitialize', 1 << 12],
  ['beforeAddLiquidity', 1 << 11],
  ['afterAddLiquidity', 1 << 10],
  ['beforeRemoveLiquidity', 1 << 9],
  ['afterRemoveLiquidity', 1 << 8],
  ['beforeSwap', 1 << 7],
  ['afterSwap', 1 << 6],
  ['beforeDonate', 1 << 5],
  ['afterDonate', 1 << 4],
  ['beforeSwapReturnDelta', 1 << 3],
  ['afterSwapReturnDelta', 1 << 2],
  ['afterAddLiquidityReturnDelta', 1 << 1],
  ['afterRemoveLiquidityReturnDelta', 1],
] as const

export type HookPermission = (typeof HOOK_FLAGS)[number][0]

export function decodeHookPermissions(address: Address): HookPermission[] {
  const value = Number(BigInt(address) & 0x3fffn)
  return HOOK_FLAGS.flatMap(([name, flag]) => (value & flag ? [name] : []))
}
