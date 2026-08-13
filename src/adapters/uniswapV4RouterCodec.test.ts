import { describe, expect, it } from 'vitest'
import {
  bytesToHex,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
} from 'viem'
import {
  UNIVERSAL_ROUTER_COMMANDS,
  V4_ACTIONS,
  cloneAndMutateUniswapV4Operation,
  collectUniswapV4Operations,
  decodeUniswapV4Calldata,
  decodeV4ActionPlan,
  encodeUniswapV4Calldata,
  encodeV4ActionPlan,
  locateUniswapV4Operations,
  type V4PoolKey,
} from './uniswapV4RouterCodec'

const CURRENCY0 = '0x0000000000000000000000000000000000000000' as Address
const CURRENCY1 = '0x1111111111111111111111111111111111111111' as Address
const HOOK = '0x2222222222222222222222222222222222222222' as Address
const OWNER = '0x3333333333333333333333333333333333333333' as Address

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
const SINGLE_OUT_PARAMETERS = [{
  type: 'tuple',
  components: [
    POOL_KEY_PARAMETER,
    { name: 'zeroForOne', type: 'bool' },
    { name: 'amountOut', type: 'uint128' },
    { name: 'amountInMaximum', type: 'uint128' },
    { name: 'hookData', type: 'bytes' },
  ],
}] as const
const MULTI_OUT_PARAMETERS = [{
  type: 'tuple',
  components: [
    { name: 'currencyOut', type: 'address' },
    { name: 'path', type: 'tuple[]', components: PATH_KEY_COMPONENTS },
    { name: 'amountOut', type: 'uint128' },
    { name: 'amountInMaximum', type: 'uint128' },
  ],
}] as const
const SINGLE_IN_V2_PARAMETERS = [{
  type: 'tuple',
  components: [
    POOL_KEY_PARAMETER,
    { name: 'zeroForOne', type: 'bool' },
    { name: 'amountIn', type: 'uint128' },
    { name: 'amountOutMinimum', type: 'uint128' },
    { name: 'minHopPriceX36', type: 'uint256' },
    { name: 'hookData', type: 'bytes' },
  ],
}] as const
const MULTI_IN_V2_PARAMETERS = [{
  type: 'tuple',
  components: [
    { name: 'currencyIn', type: 'address' },
    { name: 'path', type: 'tuple[]', components: PATH_KEY_COMPONENTS },
    { name: 'minHopPriceX36', type: 'uint256[]' },
    { name: 'amountIn', type: 'uint128' },
    { name: 'amountOutMinimum', type: 'uint128' },
  ],
}] as const
const SINGLE_OUT_V2_PARAMETERS = [{
  type: 'tuple',
  components: [
    POOL_KEY_PARAMETER,
    { name: 'zeroForOne', type: 'bool' },
    { name: 'amountOut', type: 'uint128' },
    { name: 'amountInMaximum', type: 'uint128' },
    { name: 'minHopPriceX36', type: 'uint256' },
    { name: 'hookData', type: 'bytes' },
  ],
}] as const
const MULTI_OUT_V2_PARAMETERS = [{
  type: 'tuple',
  components: [
    { name: 'currencyOut', type: 'address' },
    { name: 'path', type: 'tuple[]', components: PATH_KEY_COMPONENTS },
    { name: 'minHopPriceX36', type: 'uint256[]' },
    { name: 'amountOut', type: 'uint128' },
    { name: 'amountInMaximum', type: 'uint128' },
  ],
}] as const

const EXECUTE_ABI = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable'])
const EXECUTE_NO_DEADLINE_ABI = parseAbi(['function execute(bytes commands, bytes[] inputs) payable'])
const MODIFY_LIQUIDITIES_ABI = parseAbi(['function modifyLiquidities(bytes unlockData, uint256 deadline) payable'])
const MODIFY_LIQUIDITIES_WITHOUT_UNLOCK_ABI = parseAbi([
  'function modifyLiquiditiesWithoutUnlock(bytes actions, bytes[] params) payable',
])
const INITIALIZE_POOL_ABI = [{
  type: 'function',
  name: 'initializePool',
  stateMutability: 'payable',
  inputs: [POOL_KEY_PARAMETER, { name: 'sqrtPriceX96', type: 'uint160' }],
  outputs: [{ type: 'int24' }],
}] as const
const MULTICALL_ABI = parseAbi(['function multicall(bytes[] data) payable returns (bytes[] results)'])

function actionPlan(actions: number[], params: Hex[]): Hex {
  return encodeAbiParameters(ACTION_PLAN_PARAMETERS, [bytesToHex(new Uint8Array(actions)), params])
}

function path(hookData: Hex = '0x1234') {
  return [{ intermediateCurrency: CURRENCY1, fee: 3_000, tickSpacing: 60, hooks: HOOK, hookData }]
}

describe('Uniswap v4 action codec', () => {
  it('round-trips every controlled router swap shape and leaves payment params opaque', () => {
    const settlement = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [CURRENCY1, 1n])
    const encoded = actionPlan(
      [
        V4_ACTIONS.SWAP_EXACT_IN_SINGLE,
        V4_ACTIONS.SWAP_EXACT_IN,
        V4_ACTIONS.SWAP_EXACT_OUT_SINGLE,
        V4_ACTIONS.SWAP_EXACT_OUT,
        0x0f,
      ],
      [
        encodeAbiParameters(SINGLE_IN_PARAMETERS, [{ poolKey: POOL_KEY, zeroForOne: true, amountIn: 10n, amountOutMinimum: 8n, hookData: '0xaaaa' }]),
        encodeAbiParameters(MULTI_IN_PARAMETERS, [{ currencyIn: CURRENCY0, path: path(), amountIn: 20n, amountOutMinimum: 16n }]),
        encodeAbiParameters(SINGLE_OUT_PARAMETERS, [{ poolKey: POOL_KEY, zeroForOne: false, amountOut: 7n, amountInMaximum: 9n, hookData: '0xbbbb' }]),
        encodeAbiParameters(MULTI_OUT_PARAMETERS, [{ currencyOut: CURRENCY1, path: path('0x5678'), amountOut: 6n, amountInMaximum: 11n }]),
        settlement,
      ],
    )

    const decoded = decodeV4ActionPlan(encoded, 'router')
    expect(decoded?.items.map((item) => item.operation?.kind)).toEqual([
      'swap-exact-in-single',
      'swap-exact-in',
      'swap-exact-out-single',
      'swap-exact-out',
      undefined,
    ])
    expect(decoded?.items[4]?.rawParams).toBe(settlement)
    expect(decoded && encodeV4ActionPlan(decoded)).toBe(encoded)
  })

  it('round-trips the current official router swap structs with per-hop price guards', () => {
    const encoded = actionPlan(
      [
        V4_ACTIONS.SWAP_EXACT_IN_SINGLE,
        V4_ACTIONS.SWAP_EXACT_IN,
        V4_ACTIONS.SWAP_EXACT_OUT_SINGLE,
        V4_ACTIONS.SWAP_EXACT_OUT,
      ],
      [
        encodeAbiParameters(SINGLE_IN_V2_PARAMETERS, [{ poolKey: POOL_KEY, zeroForOne: true, amountIn: 10n, amountOutMinimum: 8n, minHopPriceX36: 101n, hookData: '0xaaaa' }]),
        encodeAbiParameters(MULTI_IN_V2_PARAMETERS, [{ currencyIn: CURRENCY0, path: path(), minHopPriceX36: [102n], amountIn: 20n, amountOutMinimum: 16n }]),
        encodeAbiParameters(SINGLE_OUT_V2_PARAMETERS, [{ poolKey: POOL_KEY, zeroForOne: false, amountOut: 7n, amountInMaximum: 9n, minHopPriceX36: 103n, hookData: '0xbbbb' }]),
        encodeAbiParameters(MULTI_OUT_V2_PARAMETERS, [{ currencyOut: CURRENCY1, path: path('0x5678'), minHopPriceX36: [104n], amountOut: 6n, amountInMaximum: 11n }]),
      ],
    )

    const decoded = decodeV4ActionPlan(encoded, 'router')
    expect(decoded?.items.map((item) => item.operation)).toMatchObject([
      { kind: 'swap-exact-in-single', schema: 'v2', minHopPriceX36: 101n },
      { kind: 'swap-exact-in', schema: 'v2', minHopPriceX36: [102n] },
      { kind: 'swap-exact-out-single', schema: 'v2', minHopPriceX36: 103n },
      { kind: 'swap-exact-out', schema: 'v2', minHopPriceX36: [104n] },
    ])
    expect(decoded && encodeV4ActionPlan(decoded)).toBe(encoded)
  })

  it('round-trips every controlled PositionManager liquidity shape', () => {
    const modify = (tokenId: bigint, liquidity: bigint, hookData: Hex) =>
      encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }],
        [tokenId, liquidity, 100n, 200n, hookData],
      )
    const encoded = actionPlan(
      [
        V4_ACTIONS.INCREASE_LIQUIDITY,
        V4_ACTIONS.DECREASE_LIQUIDITY,
        V4_ACTIONS.MINT_POSITION,
        V4_ACTIONS.BURN_POSITION,
        V4_ACTIONS.INCREASE_LIQUIDITY_FROM_DELTAS,
        V4_ACTIONS.MINT_POSITION_FROM_DELTAS,
      ],
      [
        modify(1n, 10n, '0x01'),
        modify(2n, 5n, '0x02'),
        encodeAbiParameters(
          [POOL_KEY_PARAMETER, { type: 'int24' }, { type: 'int24' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'address' }, { type: 'bytes' }],
          [POOL_KEY, -120, 120, 50n, 60n, 70n, OWNER, '0x03'],
        ),
        encodeAbiParameters(
          [{ type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }],
          [3n, 4n, 5n, '0x04'],
        ),
        encodeAbiParameters(
          [{ type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }],
          [4n, 6n, 7n, '0x05'],
        ),
        encodeAbiParameters(
          [POOL_KEY_PARAMETER, { type: 'int24' }, { type: 'int24' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'address' }, { type: 'bytes' }],
          [POOL_KEY, -60, 60, 8n, 9n, OWNER, '0x06'],
        ),
      ],
    )

    const decoded = decodeV4ActionPlan(encoded, 'position-manager')
    expect(decoded?.items.map((item) => item.operation?.kind)).toEqual([
      'increase-liquidity',
      'decrease-liquidity',
      'mint-position',
      'burn-position',
      'increase-liquidity-from-deltas',
      'mint-position-from-deltas',
    ])
    expect(decoded && encodeV4ActionPlan(decoded)).toBe(encoded)
  })
})

describe('Uniswap v4 transaction calldata codec', () => {
  it('rewrites a flagged Universal Router V4_SWAP while preserving other commands, inputs, and deadline', () => {
    const unrelatedBefore = '0xdeadbeef' as Hex
    const unrelatedAfter = '0xcafebabe' as Hex
    const settlement = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [CURRENCY1, 1n])
    const swap = encodeAbiParameters(SINGLE_IN_PARAMETERS, [{
      poolKey: POOL_KEY,
      zeroForOne: true,
      amountIn: 10n,
      amountOutMinimum: 8n,
      hookData: '0xaaaa',
    }])
    const v4Input = actionPlan([V4_ACTIONS.SWAP_EXACT_IN_SINGLE, 0x0f], [swap, settlement])
    const commands = '0x02900b' as Hex
    const calldata = encodeFunctionData({
      abi: EXECUTE_ABI,
      functionName: 'execute',
      args: [commands, [unrelatedBefore, v4Input, unrelatedAfter], 999n],
    })

    const decoded = decodeUniswapV4Calldata(calldata)
    expect(decoded?.kind).toBe('universal-router')
    if (!decoded || decoded.kind !== 'universal-router') throw new Error('Expected Universal Router calldata.')
    expect(encodeUniswapV4Calldata(decoded)).toBe(calldata)
    expect(decoded.inputs[1]).toMatchObject({ command: 0x90, commandType: 0x10, allowRevert: true })
    const v4Swap = decoded.inputs[1]?.decoded
    if (v4Swap?.kind !== 'v4-swap') throw new Error('Expected a decoded V4_SWAP command.')
    const operation = v4Swap.plan.items[0]?.operation
    if (operation?.kind !== 'swap-exact-in-single') throw new Error('Expected a single-hop exact-input swap.')
    const [located] = locateUniswapV4Operations(decoded)
    if (!located) throw new Error('Expected a located v4 operation.')
    expect(located.location).toEqual({
      root: 'universal-router',
      container: 'router-action',
      commandIndex: 1,
      actionIndex: 0,
    })
    const variant = cloneAndMutateUniswapV4Operation(decoded, located.location, (candidate) => {
      if (candidate.kind !== 'swap-exact-in-single') throw new Error('Expected a single-hop exact-input swap.')
      candidate.amountIn = 123n
      candidate.hookData = '0xfeed'
    })
    expect(operation).toMatchObject({ amountIn: 10n, hookData: '0xaaaa' })

    const rewritten = encodeUniswapV4Calldata(variant)
    const outer = decodeFunctionData({ abi: EXECUTE_ABI, data: rewritten })
    expect(outer.args[0]).toBe(commands)
    expect(outer.args[1][0]).toBe(unrelatedBefore)
    expect(outer.args[1][2]).toBe(unrelatedAfter)
    expect(outer.args[2]).toBe(999n)

    const roundTrip = decodeUniswapV4Calldata(rewritten)
    const operations = roundTrip ? collectUniswapV4Operations(roundTrip) : []
    expect(operations[0]).toMatchObject({ kind: 'swap-exact-in-single', amountIn: 123n, hookData: '0xfeed' })
    if (!roundTrip || roundTrip.kind !== 'universal-router') throw new Error('Expected Universal Router calldata.')
    const roundTripSwap = roundTrip.inputs[1]?.decoded
    if (roundTripSwap?.kind !== 'v4-swap') throw new Error('Expected a decoded V4_SWAP command.')
    expect(roundTripSwap.plan.items[1]?.rawParams).toBe(settlement)
  })

  it('locates and rewrites one canonical EXECUTE_SUB_PLAN branch without changing its sibling', () => {
    const swapInput = (amountIn: bigint, hookData: Hex) => actionPlan(
      [V4_ACTIONS.SWAP_EXACT_IN_SINGLE],
      [encodeAbiParameters(SINGLE_IN_PARAMETERS, [{
        poolKey: POOL_KEY,
        zeroForOne: true,
        amountIn,
        amountOutMinimum: 1n,
        hookData,
      }])],
    )
    const leftSubplan = actionPlan([UNIVERSAL_ROUTER_COMMANDS.V4_SWAP], [swapInput(10n, '0xaaaa')])
    const rightLeaf = actionPlan([UNIVERSAL_ROUTER_COMMANDS.V4_SWAP], [swapInput(20n, '0xbbbb')])
    const rightSubplan = actionPlan([UNIVERSAL_ROUTER_COMMANDS.EXECUTE_SUB_PLAN], [rightLeaf])
    const calldata = encodeFunctionData({
      abi: EXECUTE_NO_DEADLINE_ABI,
      functionName: 'execute',
      args: ['0x21a1', [leftSubplan, rightSubplan]],
    })

    const decoded = decodeUniswapV4Calldata(calldata)
    if (!decoded || decoded.kind !== 'universal-router') throw new Error('Expected Universal Router calldata.')
    expect(encodeUniswapV4Calldata(decoded)).toBe(calldata)
    const located = locateUniswapV4Operations(decoded)
    expect(located.map((item) => item.location)).toEqual([
      { root: 'universal-router', container: 'router-action', commandIndex: 0, subplanPath: [0], actionIndex: 0 },
      { root: 'universal-router', container: 'router-action', commandIndex: 0, subplanPath: [1, 0], actionIndex: 0 },
    ])

    const variant = cloneAndMutateUniswapV4Operation(decoded, located[1]!.location, (operation) => {
      if (operation.kind !== 'swap-exact-in-single') throw new Error('Expected a single-hop exact-input swap.')
      operation.amountIn = 99n
      operation.hookData = '0xfeed'
    })
    const roundTrip = decodeUniswapV4Calldata(encodeUniswapV4Calldata(variant))
    expect(roundTrip && collectUniswapV4Operations(roundTrip)).toMatchObject([
      { kind: 'swap-exact-in-single', amountIn: 10n, hookData: '0xaaaa' },
      { kind: 'swap-exact-in-single', amountIn: 99n, hookData: '0xfeed' },
    ])
  })

  it('rewrites PositionManager liquidity inside the official calldata and preserves deadline and unrelated action params', () => {
    const closePair = encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [CURRENCY0, CURRENCY1])
    const increase = encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }],
      [7n, 20n, 100n, 200n, '0xabcd'],
    )
    const plan = actionPlan([V4_ACTIONS.INCREASE_LIQUIDITY, 0x0d], [increase, closePair])
    const calldata = encodeFunctionData({
      abi: MODIFY_LIQUIDITIES_ABI,
      functionName: 'modifyLiquidities',
      args: [plan, 1_234n],
    })

    const decoded = decodeUniswapV4Calldata(calldata)
    if (!decoded || decoded.kind !== 'position-manager' || decoded.call.kind !== 'modify-liquidities') {
      throw new Error('Expected PositionManager modifyLiquidities calldata.')
    }
    expect(encodeUniswapV4Calldata(decoded)).toBe(calldata)
    const operation = decoded.call.plan.items[0]?.operation
    if (operation?.kind !== 'increase-liquidity') throw new Error('Expected increase liquidity.')
    operation.liquidity = 30n
    operation.hookData = '0xeeee'

    const rewritten = encodeUniswapV4Calldata(decoded)
    const roundTrip = decodeUniswapV4Calldata(rewritten)
    if (!roundTrip || roundTrip.kind !== 'position-manager' || roundTrip.call.kind !== 'modify-liquidities') {
      throw new Error('Expected PositionManager modifyLiquidities calldata.')
    }
    expect(roundTrip.call.deadline).toBe(1_234n)
    expect(roundTrip.call.plan.items[1]?.rawParams).toBe(closePair)
    expect(roundTrip.call.plan.items[0]?.operation).toMatchObject({
      kind: 'increase-liquidity',
      liquidity: 30n,
      hookData: '0xeeee',
    })
  })

  it('recognizes initializePool inside PositionManager multicall and byte-preserves unrelated subcalls', () => {
    const initialize = encodeFunctionData({
      abi: INITIALIZE_POOL_ABI,
      functionName: 'initializePool',
      args: [POOL_KEY, 2n ** 96n],
    })
    const unrelated = '0x12345678deadbeef' as Hex
    const calldata = encodeFunctionData({ abi: MULTICALL_ABI, functionName: 'multicall', args: [[unrelated, initialize]] })

    const decoded = decodeUniswapV4Calldata(calldata)
    if (!decoded || decoded.kind !== 'position-manager' || decoded.call.kind !== 'multicall') {
      throw new Error('Expected PositionManager multicall calldata.')
    }
    expect(encodeUniswapV4Calldata(decoded)).toBe(calldata)
    const initializeCall = decoded.call.calls[1]?.call
    if (initializeCall?.kind !== 'initialize-pool') throw new Error('Expected initializePool subcall.')
    initializeCall.operation.sqrtPriceX96 += 1n

    const rewritten = encodeUniswapV4Calldata(decoded)
    const outer = decodeFunctionData({ abi: MULTICALL_ABI, data: rewritten })
    expect(outer.args[0][0]).toBe(unrelated)
    const roundTrip = decodeUniswapV4Calldata(rewritten)
    expect(roundTrip && collectUniswapV4Operations(roundTrip)).toEqual([
      { kind: 'initialize-pool', poolKey: POOL_KEY, sqrtPriceX96: 2n ** 96n + 1n },
    ])
  })

  it('recognizes direct without-unlock plans and Universal Router initialize/PositionManager commands', () => {
    const mint = encodeAbiParameters(
      [POOL_KEY_PARAMETER, { type: 'int24' }, { type: 'int24' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'address' }, { type: 'bytes' }],
      [POOL_KEY, -120, 120, 50n, 60n, 70n, OWNER, '0x1234'],
    )
    const actions = bytesToHex(new Uint8Array([V4_ACTIONS.MINT_POSITION]))
    const direct = encodeFunctionData({
      abi: MODIFY_LIQUIDITIES_WITHOUT_UNLOCK_ABI,
      functionName: 'modifyLiquiditiesWithoutUnlock',
      args: [actions, [mint]],
    })
    const directDecoded = decodeUniswapV4Calldata(direct)
    expect(directDecoded).toMatchObject({
      kind: 'position-manager',
      call: { kind: 'modify-liquidities-without-unlock' },
    })
    expect(directDecoded && encodeUniswapV4Calldata(directDecoded)).toBe(direct)

    const initializeInput = encodeAbiParameters(
      [POOL_KEY_PARAMETER, { type: 'uint160' }],
      [POOL_KEY, 2n ** 96n],
    )
    const positionManagerCall = encodeFunctionData({
      abi: MODIFY_LIQUIDITIES_ABI,
      functionName: 'modifyLiquidities',
      args: [actionPlan([V4_ACTIONS.MINT_POSITION], [mint]), 9_999n],
    })
    const router = encodeFunctionData({
      abi: EXECUTE_NO_DEADLINE_ABI,
      functionName: 'execute',
      args: ['0x1314', [initializeInput, positionManagerCall]],
    })
    const routerDecoded = decodeUniswapV4Calldata(router)
    expect(routerDecoded && encodeUniswapV4Calldata(routerDecoded)).toBe(router)
    expect(routerDecoded && collectUniswapV4Operations(routerDecoded).map((operation) => operation.kind)).toEqual([
      'initialize-pool',
      'mint-position',
    ])
    expect(routerDecoded && locateUniswapV4Operations(routerDecoded).map((item) => item.location)).toEqual([
      { root: 'universal-router', container: 'router-initialize', commandIndex: 0 },
      {
        root: 'universal-router',
        container: 'position-manager-action',
        commandIndex: 1,
        multicallPath: [],
        actionIndex: 0,
      },
    ])
  })

  it('rejects non-v4 router calls and malformed action plans without throwing', () => {
    const noV4 = encodeFunctionData({
      abi: EXECUTE_NO_DEADLINE_ABI,
      functionName: 'execute',
      args: ['0x02', ['0xdeadbeef']],
    })
    const malformedPlan = actionPlan([V4_ACTIONS.SWAP_EXACT_IN_SINGLE], [])
    const malformedV4 = encodeFunctionData({
      abi: EXECUTE_NO_DEADLINE_ABI,
      functionName: 'execute',
      args: ['0x10', [malformedPlan]],
    })
    const reservedCommandBit = encodeFunctionData({
      abi: EXECUTE_NO_DEADLINE_ABI,
      functionName: 'execute',
      args: ['0x50', [actionPlan([], [])]],
    })
    const canonicalV4 = encodeFunctionData({
      abi: EXECUTE_NO_DEADLINE_ABI,
      functionName: 'execute',
      args: ['0x10', [actionPlan([], [])]],
    })
    const canonicalSwapParams = encodeAbiParameters(SINGLE_IN_PARAMETERS, [{
      poolKey: POOL_KEY,
      zeroForOne: true,
      amountIn: 1n,
      amountOutMinimum: 0n,
      hookData: '0x',
    }])
    const nonCanonicalControlledParams = encodeFunctionData({
      abi: EXECUTE_NO_DEADLINE_ABI,
      functionName: 'execute',
      args: ['0x10', [actionPlan([V4_ACTIONS.SWAP_EXACT_IN_SINGLE], [`${canonicalSwapParams}00`])]],
    })
    const nonCanonicalOuter = `${canonicalV4}00` as Hex

    expect(decodeUniswapV4Calldata('0x12345678')).toBeNull()
    expect(decodeUniswapV4Calldata(noV4)).toBeNull()
    expect(decodeUniswapV4Calldata(malformedV4)).toBeNull()
    expect(decodeUniswapV4Calldata(reservedCommandBit)).toBeNull()
    expect(decodeUniswapV4Calldata(canonicalV4)?.kind).toBe('universal-router')
    expect(decodeUniswapV4Calldata(nonCanonicalOuter)).toBeNull()
    expect(decodeUniswapV4Calldata(nonCanonicalControlledParams)).toBeNull()
    expect(decodeV4ActionPlan(`${actionPlan([], [])}00`, 'router')).toBeNull()
  })

  it('rejects attempts to change command or action ordering during re-encoding', () => {
    const swap = encodeAbiParameters(SINGLE_IN_PARAMETERS, [{
      poolKey: POOL_KEY,
      zeroForOne: true,
      amountIn: 10n,
      amountOutMinimum: 8n,
      hookData: '0x',
    }])
    const calldata = encodeFunctionData({
      abi: EXECUTE_NO_DEADLINE_ABI,
      functionName: 'execute',
      args: ['0x10', [actionPlan([V4_ACTIONS.SWAP_EXACT_IN_SINGLE], [swap])]],
    })
    const decoded = decodeUniswapV4Calldata(calldata)
    if (!decoded || decoded.kind !== 'universal-router') throw new Error('Expected Universal Router calldata.')
    decoded.inputs[0]!.command = 0x11
    expect(() => encodeUniswapV4Calldata(decoded)).toThrow(/ordering changed/)
  })
})
