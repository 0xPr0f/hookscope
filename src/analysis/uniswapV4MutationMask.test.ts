import { describe, expect, it } from 'vitest'
import {
  bytesToHex,
  encodeAbiParameters,
  encodeFunctionData,
  hexToBytes,
  parseAbi,
  type Address,
  type Hex,
} from 'viem'
import {
  V4_ACTIONS,
  decodeUniswapV4Calldata,
  locateUniswapV4Operations,
  type V4PoolKey,
} from '../adapters/uniswapV4RouterCodec'
import {
  deriveUniswapV4MutationMask,
  isUniswapV4MaskedDerivative,
  uniswapV4MutationDistance,
} from './uniswapV4MutationMask'

const CURRENCY0 = '0x0000000000000000000000000000000000000000' as Address
const CURRENCY1 = '0x1111111111111111111111111111111111111111' as Address
const CURRENCY2 = '0x2222222222222222222222222222222222222222' as Address
const HOOK = '0x3333333333333333333333333333333333333333' as Address
const OWNER = '0x4444444444444444444444444444444444444444' as Address

const POOL_KEY: V4PoolKey = {
  currency0: CURRENCY0,
  currency1: CURRENCY1,
  fee: 3_000,
  tickSpacing: 60,
  hooks: HOOK,
}

const POOL_KEY_COMPONENTS = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
] as const
const PATH_KEY_COMPONENTS = [
  { name: 'intermediateCurrency', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
  { name: 'hookData', type: 'bytes' },
] as const
const POOL_KEY_PARAMETER = { name: 'poolKey', type: 'tuple', components: POOL_KEY_COMPONENTS } as const
const ACTION_PLAN_PARAMETERS = [{ type: 'bytes' }, { type: 'bytes[]' }] as const
const SINGLE_IN_PARAMETERS = [{
  type: 'tuple',
  components: [
    POOL_KEY_PARAMETER,
    { name: 'zeroForOne', type: 'bool' },
    { name: 'amountIn', type: 'uint128' },
    { name: 'amountOutMinimum', type: 'uint128' },
    { name: 'hookData', type: 'bytes' },
  ],
}] as const
const MULTI_IN_PARAMETERS = [{
  type: 'tuple',
  components: [
    { name: 'currencyIn', type: 'address' },
    { name: 'path', type: 'tuple[]', components: PATH_KEY_COMPONENTS },
    { name: 'amountIn', type: 'uint128' },
    { name: 'amountOutMinimum', type: 'uint128' },
  ],
}] as const
const MINT_POSITION_PARAMETERS = [
  POOL_KEY_PARAMETER,
  { type: 'int24' },
  { type: 'int24' },
  { type: 'uint256' },
  { type: 'uint128' },
  { type: 'uint128' },
  { type: 'address' },
  { type: 'bytes' },
] as const
const BURN_POSITION_PARAMETERS = [
  { type: 'uint256' },
  { type: 'uint128' },
  { type: 'uint128' },
  { type: 'bytes' },
] as const

const EXECUTE_ABI = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable'])
const MODIFY_LIQUIDITIES_ABI = parseAbi(['function modifyLiquidities(bytes unlockData, uint256 deadline) payable'])

function actionPlan(actions: number[], params: Hex[]): Hex {
  return encodeAbiParameters(ACTION_PLAN_PARAMETERS, [bytesToHex(new Uint8Array(actions)), params])
}

function mutateMaskedBytes(calldata: Hex, indices: readonly number[]) {
  const bytes = hexToBytes(calldata)
  for (const index of indices) bytes[index] = bytes[index]! ^ 0x01
  return bytesToHex(bytes)
}

describe('Uniswap v4 calldata mutation mask', () => {
  it('exposes only a swap primary amount and hookData contents inside a Universal Router envelope', () => {
    const swap = encodeAbiParameters(SINGLE_IN_PARAMETERS, [{
      poolKey: POOL_KEY,
      zeroForOne: true,
      amountIn: 123n,
      amountOutMinimum: 100n,
      hookData: '0xdeadbeef',
    }])
    const settlement = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [CURRENCY1, 999n])
    const signature = `0x${'a5'.repeat(65)}` as Hex
    const v4Input = actionPlan([V4_ACTIONS.SWAP_EXACT_IN_SINGLE, 0x0f], [swap, settlement])
    const calldata = encodeFunctionData({
      abi: EXECUTE_ABI,
      functionName: 'execute',
      args: ['0x100b', [v4Input, signature], 4_000_000_000n],
    })

    const mask = deriveUniswapV4MutationMask(calldata)
    expect(mask).not.toBeNull()
    expect(mask?.byteIndices).toHaveLength(20)
    expect(mask?.regions.map((region) => [region.field, region.totalValueBytes])).toEqual([
      ['amountIn', 16],
      ['hookData', 4],
    ])
    expect(mask?.byteIndices.every((index) => index >= 4)).toBe(true)

    const mutated = mutateMaskedBytes(calldata, mask!.byteIndices)
    expect(isUniswapV4MaskedDerivative(mask!, mutated)).toBe(true)
    expect(uniswapV4MutationDistance(mask!, mutated)).toBe(mask!.byteIndices.length)
    const decoded = decodeUniswapV4Calldata(mutated)
    expect(decoded?.kind).toBe('universal-router')
    if (decoded?.kind !== 'universal-router') throw new Error('Expected Universal Router calldata.')
    expect(decoded.commands).toBe('0x100b')
    expect(decoded.deadline).toBe(4_000_000_000n)
    expect(decoded.inputs[1]?.rawInput).toBe(signature)
    const operation = locateUniswapV4Operations(decoded)[0]?.operation
    expect(operation).toMatchObject({
      kind: 'swap-exact-in-single',
      poolKey: POOL_KEY,
      zeroForOne: true,
      amountOutMinimum: 100n,
    })
    expect(operation && 'amountIn' in operation ? operation.amountIn : 123n).not.toBe(123n)
    expect(operation && 'hookData' in operation ? operation.hookData : '0xdeadbeef').not.toBe('0xdeadbeef')
  })

  it('protects pool keys, owner, limits, deadline, action bytes, offsets, and lengths in PositionManager calldata', () => {
    const mint = encodeAbiParameters(MINT_POSITION_PARAMETERS, [
      POOL_KEY,
      -120,
      120,
      1_000n,
      2_000n,
      3_000n,
      OWNER,
      '0x010203',
    ])
    const burn = encodeAbiParameters(BURN_POSITION_PARAMETERS, [77n, 8n, 9n, '0xaabb'])
    const unlockData = actionPlan([V4_ACTIONS.MINT_POSITION, V4_ACTIONS.BURN_POSITION], [mint, burn])
    const calldata = encodeFunctionData({
      abi: MODIFY_LIQUIDITIES_ABI,
      functionName: 'modifyLiquidities',
      args: [unlockData, 4_100_000_000n],
    })

    const mask = deriveUniswapV4MutationMask(calldata)
    expect(mask?.byteIndices).toHaveLength(37)
    expect(mask?.regions.map((region) => [region.operationKind, region.field, region.totalValueBytes])).toEqual([
      ['mint-position', 'liquidity', 32],
      ['mint-position', 'hookData', 3],
      ['burn-position', 'hookData', 2],
    ])

    const decoded = decodeUniswapV4Calldata(mutateMaskedBytes(calldata, mask!.byteIndices))
    expect(decoded?.kind).toBe('position-manager')
    if (decoded?.kind !== 'position-manager' || decoded.call.kind !== 'modify-liquidities') {
      throw new Error('Expected PositionManager modifyLiquidities calldata.')
    }
    expect(decoded.call.deadline).toBe(4_100_000_000n)
    expect(decoded.call.plan.actions).toBe(bytesToHex(new Uint8Array([
      V4_ACTIONS.MINT_POSITION,
      V4_ACTIONS.BURN_POSITION,
    ])))
    const [mintOperation, burnOperation] = locateUniswapV4Operations(decoded).map((item) => item.operation)
    expect(mintOperation).toMatchObject({
      kind: 'mint-position',
      poolKey: POOL_KEY,
      tickLower: -120,
      tickUpper: 120,
      amount0Max: 2_000n,
      amount1Max: 3_000n,
      owner: OWNER,
    })
    expect(mintOperation && 'liquidity' in mintOperation ? mintOperation.liquidity : 1_000n).not.toBe(1_000n)
    expect(burnOperation).toMatchObject({ kind: 'burn-position', tokenId: 77n, amount0Min: 8n, amount1Min: 9n })
  })

  it('bounds operations, hook fields, bytes per field, and total mutable bytes deterministically', () => {
    const hookData = `0x${'42'.repeat(100)}` as Hex
    const swap = encodeAbiParameters(MULTI_IN_PARAMETERS, [{
      currencyIn: CURRENCY0,
      path: [
        { intermediateCurrency: CURRENCY1, fee: 500, tickSpacing: 10, hooks: HOOK, hookData },
        { intermediateCurrency: CURRENCY2, fee: 3_000, tickSpacing: 60, hooks: HOOK, hookData },
        { intermediateCurrency: CURRENCY0, fee: 10_000, tickSpacing: 200, hooks: HOOK, hookData },
      ],
      amountIn: 10n,
      amountOutMinimum: 7n,
    }])
    const calldata = encodeFunctionData({
      abi: EXECUTE_ABI,
      functionName: 'execute',
      args: ['0x10', [actionPlan([V4_ACTIONS.SWAP_EXACT_IN], [swap])], 4_200_000_000n],
    })

    const mask = deriveUniswapV4MutationMask(calldata, {
      maxOperations: 1,
      maxHookDataFields: 2,
      maxHookDataBytesPerField: 3,
      maxMutableBytes: 20,
    })
    expect(mask).toMatchObject({
      operationsSeen: 1,
      operationsConsidered: 1,
      hookDataFieldsSeen: 3,
      hookDataFieldsConsidered: 2,
      truncated: true,
    })
    expect(mask?.byteIndices).toHaveLength(20)
    expect(mask?.regions.map((region) => ({
      field: region.field,
      pathIndex: region.pathIndex,
      selected: region.byteIndices.length,
      total: region.totalValueBytes,
      truncated: region.truncated,
    }))).toEqual([
      { field: 'amountIn', pathIndex: undefined, selected: 16, total: 16, truncated: false },
      { field: 'hookData', pathIndex: 0, selected: 3, total: 100, truncated: true },
      { field: 'hookData', pathIndex: 1, selected: 1, total: 100, truncated: true },
    ])

    const disabled = deriveUniswapV4MutationMask(calldata, { maxMutableBytes: 0 })
    expect(disabled?.byteIndices).toEqual([])
    expect(disabled?.regions).toEqual([])
    expect(disabled?.truncated).toBe(true)
  })

  it('returns null instead of guessing at an unsupported calldata envelope', () => {
    expect(deriveUniswapV4MutationMask('0x12345678')).toBeNull()
  })

  it('rejects a candidate that changes the canonical router envelope outside the mask', () => {
    const swap = encodeAbiParameters(SINGLE_IN_PARAMETERS, [{
      poolKey: POOL_KEY,
      zeroForOne: true,
      amountIn: 123n,
      amountOutMinimum: 100n,
      hookData: '0xdeadbeef',
    }])
    const calldata = encodeFunctionData({
      abi: EXECUTE_ABI,
      functionName: 'execute',
      args: ['0x10', [actionPlan([V4_ACTIONS.SWAP_EXACT_IN_SINGLE], [swap])], 4_000_000_000n],
    })
    const mask = deriveUniswapV4MutationMask(calldata)!
    const bytes = hexToBytes(calldata)
    bytes[0] = bytes[0]! ^ 0x01
    const changedSelector = bytesToHex(bytes)

    expect(isUniswapV4MaskedDerivative(mask, changedSelector)).toBe(false)
    expect(uniswapV4MutationDistance(mask, changedSelector)).toBe(Number.POSITIVE_INFINITY)
  })
})
