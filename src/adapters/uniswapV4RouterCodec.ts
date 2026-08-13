import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  hexToBytes,
  toFunctionSelector,
  type Address,
  type Hex,
} from 'viem'

export const UNIVERSAL_ROUTER_COMMANDS = {
  V4_SWAP: 0x10,
  V4_INITIALIZE_POOL: 0x13,
  V4_POSITION_MANAGER_CALL: 0x14,
  EXECUTE_SUB_PLAN: 0x21,
} as const

export const V4_ACTIONS = {
  INCREASE_LIQUIDITY: 0x00,
  DECREASE_LIQUIDITY: 0x01,
  MINT_POSITION: 0x02,
  BURN_POSITION: 0x03,
  INCREASE_LIQUIDITY_FROM_DELTAS: 0x04,
  MINT_POSITION_FROM_DELTAS: 0x05,
  SWAP_EXACT_IN_SINGLE: 0x06,
  SWAP_EXACT_IN: 0x07,
  SWAP_EXACT_OUT_SINGLE: 0x08,
  SWAP_EXACT_OUT: 0x09,
} as const

export type V4PoolKey = {
  currency0: Address
  currency1: Address
  fee: number
  tickSpacing: number
  hooks: Address
}

export type V4PathKey = {
  intermediateCurrency: Address
  fee: number
  tickSpacing: number
  hooks: Address
  hookData: Hex
}

export type V4SwapOperation =
  | {
      kind: 'swap-exact-in-single'
      schema: 'v1' | 'v2'
      poolKey: V4PoolKey
      zeroForOne: boolean
      amountIn: bigint
      amountOutMinimum: bigint
      minHopPriceX36?: bigint
      hookData: Hex
    }
  | {
      kind: 'swap-exact-in'
      schema: 'v1' | 'v2'
      currencyIn: Address
      path: V4PathKey[]
      minHopPriceX36?: bigint[]
      amountIn: bigint
      amountOutMinimum: bigint
    }
  | {
      kind: 'swap-exact-out-single'
      schema: 'v1' | 'v2'
      poolKey: V4PoolKey
      zeroForOne: boolean
      amountOut: bigint
      amountInMaximum: bigint
      minHopPriceX36?: bigint
      hookData: Hex
    }
  | {
      kind: 'swap-exact-out'
      schema: 'v1' | 'v2'
      currencyOut: Address
      path: V4PathKey[]
      minHopPriceX36?: bigint[]
      amountOut: bigint
      amountInMaximum: bigint
    }

export type V4LiquidityOperation =
  | {
      kind: 'increase-liquidity' | 'decrease-liquidity'
      tokenId: bigint
      liquidity: bigint
      amount0Limit: bigint
      amount1Limit: bigint
      hookData: Hex
    }
  | {
      kind: 'mint-position'
      poolKey: V4PoolKey
      tickLower: number
      tickUpper: number
      liquidity: bigint
      amount0Max: bigint
      amount1Max: bigint
      owner: Address
      hookData: Hex
    }
  | {
      kind: 'burn-position'
      tokenId: bigint
      amount0Min: bigint
      amount1Min: bigint
      hookData: Hex
    }
  | {
      kind: 'increase-liquidity-from-deltas'
      tokenId: bigint
      amount0Max: bigint
      amount1Max: bigint
      hookData: Hex
    }
  | {
      kind: 'mint-position-from-deltas'
      poolKey: V4PoolKey
      tickLower: number
      tickUpper: number
      amount0Max: bigint
      amount1Max: bigint
      owner: Address
      hookData: Hex
    }

export type V4InitializeOperation = {
  kind: 'initialize-pool'
  poolKey: V4PoolKey
  sqrtPriceX96: bigint
}

export type V4ControlledOperation = V4SwapOperation | V4LiquidityOperation | V4InitializeOperation
export type V4ActionContext = 'router' | 'position-manager'

export type V4ActionItem = {
  index: number
  action: number
  rawParams: Hex
  operation?: V4SwapOperation | V4LiquidityOperation
}

export type V4ActionPlan = {
  context: V4ActionContext
  actions: Hex
  items: V4ActionItem[]
}

export type PositionManagerCall =
  | {
      kind: 'initialize-pool'
      operation: V4InitializeOperation
    }
  | {
      kind: 'modify-liquidities'
      deadline: bigint
      plan: V4ActionPlan
    }
  | {
      kind: 'modify-liquidities-without-unlock'
      plan: V4ActionPlan
    }
  | {
      kind: 'multicall'
      calls: PositionManagerMulticallItem[]
    }

export type PositionManagerMulticallItem = {
  index: number
  rawCalldata: Hex
  call?: PositionManagerCall
}

export type UniversalRouterDecodedCommand =
  | { kind: 'v4-swap'; plan: V4ActionPlan }
  | { kind: 'v4-initialize-pool'; operation: V4InitializeOperation }
  | { kind: 'v4-position-manager-call'; call: PositionManagerCall }
  | { kind: 'execute-sub-plan'; commands: Hex; inputs: UniversalRouterCommand[] }

export type UniversalRouterCommand = {
  index: number
  command: number
  commandType: number
  allowRevert: boolean
  rawInput: Hex
  decoded?: UniversalRouterDecodedCommand
}

export type DecodedUniswapV4Calldata =
  | {
      kind: 'universal-router'
      entrypoint: 'execute' | 'execute-with-deadline'
      commands: Hex
      inputs: UniversalRouterCommand[]
      deadline?: bigint
    }
  | {
      kind: 'position-manager'
      call: PositionManagerCall
    }

export type V4OperationLocation =
  | {
      root: 'universal-router'
      container: 'router-action'
      commandIndex: number
      subplanPath?: number[]
      actionIndex: number
    }
  | {
      root: 'universal-router'
      container: 'router-initialize'
      commandIndex: number
      subplanPath?: number[]
    }
  | {
      root: 'universal-router'
      container: 'position-manager-action'
      commandIndex: number
      subplanPath?: number[]
      multicallPath: number[]
      actionIndex: number
    }
  | {
      root: 'universal-router'
      container: 'position-manager-initialize'
      commandIndex: number
      subplanPath?: number[]
      multicallPath: number[]
    }
  | {
      root: 'position-manager'
      container: 'position-manager-action'
      multicallPath: number[]
      actionIndex: number
    }
  | {
      root: 'position-manager'
      container: 'position-manager-initialize'
      multicallPath: number[]
    }

export type LocatedV4Operation = {
  location: V4OperationLocation
  operation: V4ControlledOperation
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
const PATH_PARAMETER = { name: 'path', type: 'tuple[]', components: PATH_KEY_COMPONENTS } as const

const ACTION_PLAN_PARAMETERS = [
  { name: 'actions', type: 'bytes' },
  { name: 'params', type: 'bytes[]' },
] as const

const SWAP_EXACT_IN_SINGLE_PARAMETERS = [{
  name: 'params',
  type: 'tuple',
  components: [
    POOL_KEY_PARAMETER,
    { name: 'zeroForOne', type: 'bool' },
    { name: 'amountIn', type: 'uint128' },
    { name: 'amountOutMinimum', type: 'uint128' },
    { name: 'hookData', type: 'bytes' },
  ],
}] as const

const SWAP_EXACT_IN_PARAMETERS = [{
  name: 'params',
  type: 'tuple',
  components: [
    { name: 'currencyIn', type: 'address' },
    PATH_PARAMETER,
    { name: 'amountIn', type: 'uint128' },
    { name: 'amountOutMinimum', type: 'uint128' },
  ],
}] as const

const SWAP_EXACT_OUT_SINGLE_PARAMETERS = [{
  name: 'params',
  type: 'tuple',
  components: [
    POOL_KEY_PARAMETER,
    { name: 'zeroForOne', type: 'bool' },
    { name: 'amountOut', type: 'uint128' },
    { name: 'amountInMaximum', type: 'uint128' },
    { name: 'hookData', type: 'bytes' },
  ],
}] as const

const SWAP_EXACT_OUT_PARAMETERS = [{
  name: 'params',
  type: 'tuple',
  components: [
    { name: 'currencyOut', type: 'address' },
    PATH_PARAMETER,
    { name: 'amountOut', type: 'uint128' },
    { name: 'amountInMaximum', type: 'uint128' },
  ],
}] as const

const SWAP_EXACT_IN_SINGLE_V2_PARAMETERS = [{
  name: 'params',
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

const SWAP_EXACT_IN_V2_PARAMETERS = [{
  name: 'params',
  type: 'tuple',
  components: [
    { name: 'currencyIn', type: 'address' },
    PATH_PARAMETER,
    { name: 'minHopPriceX36', type: 'uint256[]' },
    { name: 'amountIn', type: 'uint128' },
    { name: 'amountOutMinimum', type: 'uint128' },
  ],
}] as const

const SWAP_EXACT_OUT_SINGLE_V2_PARAMETERS = [{
  name: 'params',
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

const SWAP_EXACT_OUT_V2_PARAMETERS = [{
  name: 'params',
  type: 'tuple',
  components: [
    { name: 'currencyOut', type: 'address' },
    PATH_PARAMETER,
    { name: 'minHopPriceX36', type: 'uint256[]' },
    { name: 'amountOut', type: 'uint128' },
    { name: 'amountInMaximum', type: 'uint128' },
  ],
}] as const

const MODIFY_LIQUIDITY_PARAMETERS = [
  { name: 'tokenId', type: 'uint256' },
  { name: 'liquidity', type: 'uint256' },
  { name: 'amount0Limit', type: 'uint128' },
  { name: 'amount1Limit', type: 'uint128' },
  { name: 'hookData', type: 'bytes' },
] as const

const MINT_POSITION_PARAMETERS = [
  POOL_KEY_PARAMETER,
  { name: 'tickLower', type: 'int24' },
  { name: 'tickUpper', type: 'int24' },
  { name: 'liquidity', type: 'uint256' },
  { name: 'amount0Max', type: 'uint128' },
  { name: 'amount1Max', type: 'uint128' },
  { name: 'owner', type: 'address' },
  { name: 'hookData', type: 'bytes' },
] as const

const BURN_POSITION_PARAMETERS = [
  { name: 'tokenId', type: 'uint256' },
  { name: 'amount0Min', type: 'uint128' },
  { name: 'amount1Min', type: 'uint128' },
  { name: 'hookData', type: 'bytes' },
] as const

const INCREASE_FROM_DELTAS_PARAMETERS = [
  { name: 'tokenId', type: 'uint256' },
  { name: 'amount0Max', type: 'uint128' },
  { name: 'amount1Max', type: 'uint128' },
  { name: 'hookData', type: 'bytes' },
] as const

const MINT_FROM_DELTAS_PARAMETERS = [
  POOL_KEY_PARAMETER,
  { name: 'tickLower', type: 'int24' },
  { name: 'tickUpper', type: 'int24' },
  { name: 'amount0Max', type: 'uint128' },
  { name: 'amount1Max', type: 'uint128' },
  { name: 'owner', type: 'address' },
  { name: 'hookData', type: 'bytes' },
] as const

const INITIALIZE_PARAMETERS = [
  POOL_KEY_PARAMETER,
  { name: 'sqrtPriceX96', type: 'uint160' },
] as const

const EXECUTE_ABI = [{
  type: 'function',
  name: 'execute',
  stateMutability: 'payable',
  inputs: [
    { name: 'commands', type: 'bytes' },
    { name: 'inputs', type: 'bytes[]' },
  ],
  outputs: [],
}] as const

const EXECUTE_WITH_DEADLINE_ABI = [{
  type: 'function',
  name: 'execute',
  stateMutability: 'payable',
  inputs: [
    { name: 'commands', type: 'bytes' },
    { name: 'inputs', type: 'bytes[]' },
    { name: 'deadline', type: 'uint256' },
  ],
  outputs: [],
}] as const

const MODIFY_LIQUIDITIES_ABI = [{
  type: 'function',
  name: 'modifyLiquidities',
  stateMutability: 'payable',
  inputs: [
    { name: 'unlockData', type: 'bytes' },
    { name: 'deadline', type: 'uint256' },
  ],
  outputs: [],
}] as const

const MODIFY_LIQUIDITIES_WITHOUT_UNLOCK_ABI = [{
  type: 'function',
  name: 'modifyLiquiditiesWithoutUnlock',
  stateMutability: 'payable',
  inputs: [
    { name: 'actions', type: 'bytes' },
    { name: 'params', type: 'bytes[]' },
  ],
  outputs: [],
}] as const

const INITIALIZE_POOL_ABI = [{
  type: 'function',
  name: 'initializePool',
  stateMutability: 'payable',
  inputs: [POOL_KEY_PARAMETER, { name: 'sqrtPriceX96', type: 'uint160' }],
  outputs: [{ name: 'tick', type: 'int24' }],
}] as const

const MULTICALL_ABI = [{
  type: 'function',
  name: 'multicall',
  stateMutability: 'payable',
  inputs: [{ name: 'data', type: 'bytes[]' }],
  outputs: [{ name: 'results', type: 'bytes[]' }],
}] as const

const SELECTORS = {
  execute: toFunctionSelector('execute(bytes,bytes[])').toLowerCase(),
  executeWithDeadline: toFunctionSelector('execute(bytes,bytes[],uint256)').toLowerCase(),
  modifyLiquidities: toFunctionSelector('modifyLiquidities(bytes,uint256)').toLowerCase(),
  modifyLiquiditiesWithoutUnlock: toFunctionSelector('modifyLiquiditiesWithoutUnlock(bytes,bytes[])').toLowerCase(),
  initializePool: toFunctionSelector('initializePool((address,address,uint24,int24,address),uint160)').toLowerCase(),
  multicall: toFunctionSelector('multicall(bytes[])').toLowerCase(),
} as const

function selectorOf(calldata: Hex): string {
  return calldata.length >= 10 ? calldata.slice(0, 10).toLowerCase() : ''
}

function sameHex(left: Hex, right: Hex): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

function isUniversalRouterCommand(command: number, commandType: number): boolean {
  return command === commandType || command === (commandType | 0x80)
}

function copyPoolKey(poolKey: V4PoolKey): V4PoolKey {
  return { ...poolKey }
}

function copyPath(path: readonly V4PathKey[]): V4PathKey[] {
  return path.map((item) => ({ ...item }))
}

function decodeSwapOperation(action: number, params: Hex): V4SwapOperation | undefined {
  if (action === V4_ACTIONS.SWAP_EXACT_IN_SINGLE) {
    try {
      const [value] = decodeAbiParameters(SWAP_EXACT_IN_SINGLE_V2_PARAMETERS, params)
      const operation: V4SwapOperation = {
        kind: 'swap-exact-in-single',
        schema: 'v2',
        poolKey: copyPoolKey(value.poolKey),
        zeroForOne: value.zeroForOne,
        amountIn: value.amountIn,
        amountOutMinimum: value.amountOutMinimum,
        minHopPriceX36: value.minHopPriceX36,
        hookData: value.hookData,
      }
      if (sameHex(encodeActionOperation(operation), params)) return operation
    } catch {
      // Try the installed v1.0.3 tuple below.
    }
    const [value] = decodeAbiParameters(SWAP_EXACT_IN_SINGLE_PARAMETERS, params)
    return {
      kind: 'swap-exact-in-single',
      schema: 'v1',
      poolKey: copyPoolKey(value.poolKey),
      zeroForOne: value.zeroForOne,
      amountIn: value.amountIn,
      amountOutMinimum: value.amountOutMinimum,
      hookData: value.hookData,
    }
  }
  if (action === V4_ACTIONS.SWAP_EXACT_IN) {
    try {
      const [value] = decodeAbiParameters(SWAP_EXACT_IN_V2_PARAMETERS, params)
      const operation: V4SwapOperation = {
        kind: 'swap-exact-in',
        schema: 'v2',
        currencyIn: value.currencyIn,
        path: copyPath(value.path),
        minHopPriceX36: [...value.minHopPriceX36],
        amountIn: value.amountIn,
        amountOutMinimum: value.amountOutMinimum,
      }
      if (sameHex(encodeActionOperation(operation), params)) return operation
    } catch {
      // Try the installed v1.0.3 tuple below.
    }
    const [value] = decodeAbiParameters(SWAP_EXACT_IN_PARAMETERS, params)
    return {
      kind: 'swap-exact-in',
      schema: 'v1',
      currencyIn: value.currencyIn,
      path: copyPath(value.path),
      amountIn: value.amountIn,
      amountOutMinimum: value.amountOutMinimum,
    }
  }
  if (action === V4_ACTIONS.SWAP_EXACT_OUT_SINGLE) {
    try {
      const [value] = decodeAbiParameters(SWAP_EXACT_OUT_SINGLE_V2_PARAMETERS, params)
      const operation: V4SwapOperation = {
        kind: 'swap-exact-out-single',
        schema: 'v2',
        poolKey: copyPoolKey(value.poolKey),
        zeroForOne: value.zeroForOne,
        amountOut: value.amountOut,
        amountInMaximum: value.amountInMaximum,
        minHopPriceX36: value.minHopPriceX36,
        hookData: value.hookData,
      }
      if (sameHex(encodeActionOperation(operation), params)) return operation
    } catch {
      // Try the installed v1.0.3 tuple below.
    }
    const [value] = decodeAbiParameters(SWAP_EXACT_OUT_SINGLE_PARAMETERS, params)
    return {
      kind: 'swap-exact-out-single',
      schema: 'v1',
      poolKey: copyPoolKey(value.poolKey),
      zeroForOne: value.zeroForOne,
      amountOut: value.amountOut,
      amountInMaximum: value.amountInMaximum,
      hookData: value.hookData,
    }
  }
  if (action === V4_ACTIONS.SWAP_EXACT_OUT) {
    try {
      const [value] = decodeAbiParameters(SWAP_EXACT_OUT_V2_PARAMETERS, params)
      const operation: V4SwapOperation = {
        kind: 'swap-exact-out',
        schema: 'v2',
        currencyOut: value.currencyOut,
        path: copyPath(value.path),
        minHopPriceX36: [...value.minHopPriceX36],
        amountOut: value.amountOut,
        amountInMaximum: value.amountInMaximum,
      }
      if (sameHex(encodeActionOperation(operation), params)) return operation
    } catch {
      // Try the installed v1.0.3 tuple below.
    }
    const [value] = decodeAbiParameters(SWAP_EXACT_OUT_PARAMETERS, params)
    return {
      kind: 'swap-exact-out',
      schema: 'v1',
      currencyOut: value.currencyOut,
      path: copyPath(value.path),
      amountOut: value.amountOut,
      amountInMaximum: value.amountInMaximum,
    }
  }
}

function decodeLiquidityOperation(action: number, params: Hex): V4LiquidityOperation | undefined {
  if (action === V4_ACTIONS.INCREASE_LIQUIDITY || action === V4_ACTIONS.DECREASE_LIQUIDITY) {
    const [tokenId, liquidity, amount0Limit, amount1Limit, hookData] = decodeAbiParameters(MODIFY_LIQUIDITY_PARAMETERS, params)
    return {
      kind: action === V4_ACTIONS.INCREASE_LIQUIDITY ? 'increase-liquidity' : 'decrease-liquidity',
      tokenId,
      liquidity,
      amount0Limit,
      amount1Limit,
      hookData,
    }
  }
  if (action === V4_ACTIONS.MINT_POSITION) {
    const [poolKey, tickLower, tickUpper, liquidity, amount0Max, amount1Max, owner, hookData] =
      decodeAbiParameters(MINT_POSITION_PARAMETERS, params)
    return {
      kind: 'mint-position',
      poolKey: copyPoolKey(poolKey),
      tickLower,
      tickUpper,
      liquidity,
      amount0Max,
      amount1Max,
      owner,
      hookData,
    }
  }
  if (action === V4_ACTIONS.BURN_POSITION) {
    const [tokenId, amount0Min, amount1Min, hookData] = decodeAbiParameters(BURN_POSITION_PARAMETERS, params)
    return { kind: 'burn-position', tokenId, amount0Min, amount1Min, hookData }
  }
  if (action === V4_ACTIONS.INCREASE_LIQUIDITY_FROM_DELTAS) {
    const [tokenId, amount0Max, amount1Max, hookData] = decodeAbiParameters(INCREASE_FROM_DELTAS_PARAMETERS, params)
    return { kind: 'increase-liquidity-from-deltas', tokenId, amount0Max, amount1Max, hookData }
  }
  if (action === V4_ACTIONS.MINT_POSITION_FROM_DELTAS) {
    const [poolKey, tickLower, tickUpper, amount0Max, amount1Max, owner, hookData] =
      decodeAbiParameters(MINT_FROM_DELTAS_PARAMETERS, params)
    return {
      kind: 'mint-position-from-deltas',
      poolKey: copyPoolKey(poolKey),
      tickLower,
      tickUpper,
      amount0Max,
      amount1Max,
      owner,
      hookData,
    }
  }
}

function controlledAction(context: V4ActionContext, action: number): boolean {
  if (context === 'router') {
    return action >= V4_ACTIONS.SWAP_EXACT_IN_SINGLE && action <= V4_ACTIONS.SWAP_EXACT_OUT
  }
  return action >= V4_ACTIONS.INCREASE_LIQUIDITY && action <= V4_ACTIONS.MINT_POSITION_FROM_DELTAS
}

export function decodeV4ActionPlan(encoded: Hex, context: V4ActionContext): V4ActionPlan | null {
  try {
    const [actions, params] = decodeAbiParameters(ACTION_PLAN_PARAMETERS, encoded)
    const actionBytes = [...hexToBytes(actions)]
    if (actionBytes.length !== params.length) return null
    if (!sameHex(encodeAbiParameters(ACTION_PLAN_PARAMETERS, [actions, [...params]]), encoded)) return null
    const items = actionBytes.map((action, index): V4ActionItem => {
      const rawParams = params[index]
      if (!rawParams) throw new Error('Missing v4 action parameters.')
      const operation = context === 'router'
        ? decodeSwapOperation(action, rawParams)
        : decodeLiquidityOperation(action, rawParams)
      if (controlledAction(context, action) && !operation) throw new Error('Malformed controlled v4 action.')
      if (operation && !sameHex(encodeActionOperation(operation), rawParams)) {
        throw new Error('Non-canonical controlled v4 action parameters.')
      }
      return { index, action, rawParams, operation }
    })
    return { context, actions, items }
  } catch {
    return null
  }
}

function actionForOperation(operation: V4SwapOperation | V4LiquidityOperation): number {
  switch (operation.kind) {
    case 'increase-liquidity': return V4_ACTIONS.INCREASE_LIQUIDITY
    case 'decrease-liquidity': return V4_ACTIONS.DECREASE_LIQUIDITY
    case 'mint-position': return V4_ACTIONS.MINT_POSITION
    case 'burn-position': return V4_ACTIONS.BURN_POSITION
    case 'increase-liquidity-from-deltas': return V4_ACTIONS.INCREASE_LIQUIDITY_FROM_DELTAS
    case 'mint-position-from-deltas': return V4_ACTIONS.MINT_POSITION_FROM_DELTAS
    case 'swap-exact-in-single': return V4_ACTIONS.SWAP_EXACT_IN_SINGLE
    case 'swap-exact-in': return V4_ACTIONS.SWAP_EXACT_IN
    case 'swap-exact-out-single': return V4_ACTIONS.SWAP_EXACT_OUT_SINGLE
    case 'swap-exact-out': return V4_ACTIONS.SWAP_EXACT_OUT
  }
}

function encodeActionOperation(operation: V4SwapOperation | V4LiquidityOperation): Hex {
  switch (operation.kind) {
    case 'swap-exact-in-single':
      if (operation.schema === 'v2') {
        if (operation.minHopPriceX36 === undefined) throw new Error('V2 swap is missing minHopPriceX36.')
        return encodeAbiParameters(SWAP_EXACT_IN_SINGLE_V2_PARAMETERS, [{
            poolKey: operation.poolKey,
            zeroForOne: operation.zeroForOne,
            amountIn: operation.amountIn,
            amountOutMinimum: operation.amountOutMinimum,
            minHopPriceX36: operation.minHopPriceX36,
            hookData: operation.hookData,
          }])
      }
      return encodeAbiParameters(SWAP_EXACT_IN_SINGLE_PARAMETERS, [{
        poolKey: operation.poolKey,
        zeroForOne: operation.zeroForOne,
        amountIn: operation.amountIn,
        amountOutMinimum: operation.amountOutMinimum,
        hookData: operation.hookData,
      }])
    case 'swap-exact-in':
      if (operation.schema === 'v2') {
        if (operation.minHopPriceX36 === undefined) throw new Error('V2 swap is missing minHopPriceX36.')
        return encodeAbiParameters(SWAP_EXACT_IN_V2_PARAMETERS, [{
            currencyIn: operation.currencyIn,
            path: operation.path,
            minHopPriceX36: operation.minHopPriceX36,
            amountIn: operation.amountIn,
            amountOutMinimum: operation.amountOutMinimum,
          }])
      }
      return encodeAbiParameters(SWAP_EXACT_IN_PARAMETERS, [{
        currencyIn: operation.currencyIn,
        path: operation.path,
        amountIn: operation.amountIn,
        amountOutMinimum: operation.amountOutMinimum,
      }])
    case 'swap-exact-out-single':
      if (operation.schema === 'v2') {
        if (operation.minHopPriceX36 === undefined) throw new Error('V2 swap is missing minHopPriceX36.')
        return encodeAbiParameters(SWAP_EXACT_OUT_SINGLE_V2_PARAMETERS, [{
            poolKey: operation.poolKey,
            zeroForOne: operation.zeroForOne,
            amountOut: operation.amountOut,
            amountInMaximum: operation.amountInMaximum,
            minHopPriceX36: operation.minHopPriceX36,
            hookData: operation.hookData,
          }])
      }
      return encodeAbiParameters(SWAP_EXACT_OUT_SINGLE_PARAMETERS, [{
        poolKey: operation.poolKey,
        zeroForOne: operation.zeroForOne,
        amountOut: operation.amountOut,
        amountInMaximum: operation.amountInMaximum,
        hookData: operation.hookData,
      }])
    case 'swap-exact-out':
      if (operation.schema === 'v2') {
        if (operation.minHopPriceX36 === undefined) throw new Error('V2 swap is missing minHopPriceX36.')
        return encodeAbiParameters(SWAP_EXACT_OUT_V2_PARAMETERS, [{
            currencyOut: operation.currencyOut,
            path: operation.path,
            minHopPriceX36: operation.minHopPriceX36,
            amountOut: operation.amountOut,
            amountInMaximum: operation.amountInMaximum,
          }])
      }
      return encodeAbiParameters(SWAP_EXACT_OUT_PARAMETERS, [{
        currencyOut: operation.currencyOut,
        path: operation.path,
        amountOut: operation.amountOut,
        amountInMaximum: operation.amountInMaximum,
      }])
    case 'increase-liquidity':
    case 'decrease-liquidity':
      return encodeAbiParameters(MODIFY_LIQUIDITY_PARAMETERS, [
        operation.tokenId,
        operation.liquidity,
        operation.amount0Limit,
        operation.amount1Limit,
        operation.hookData,
      ])
    case 'mint-position':
      return encodeAbiParameters(MINT_POSITION_PARAMETERS, [
        operation.poolKey,
        operation.tickLower,
        operation.tickUpper,
        operation.liquidity,
        operation.amount0Max,
        operation.amount1Max,
        operation.owner,
        operation.hookData,
      ])
    case 'burn-position':
      return encodeAbiParameters(BURN_POSITION_PARAMETERS, [
        operation.tokenId,
        operation.amount0Min,
        operation.amount1Min,
        operation.hookData,
      ])
    case 'increase-liquidity-from-deltas':
      return encodeAbiParameters(INCREASE_FROM_DELTAS_PARAMETERS, [
        operation.tokenId,
        operation.amount0Max,
        operation.amount1Max,
        operation.hookData,
      ])
    case 'mint-position-from-deltas':
      return encodeAbiParameters(MINT_FROM_DELTAS_PARAMETERS, [
        operation.poolKey,
        operation.tickLower,
        operation.tickUpper,
        operation.amount0Max,
        operation.amount1Max,
        operation.owner,
        operation.hookData,
      ])
  }
}

export function encodeV4ActionPlan(plan: V4ActionPlan): Hex {
  const actionBytes = [...hexToBytes(plan.actions)]
  if (actionBytes.length !== plan.items.length) throw new Error('V4 action count changed during re-encoding.')
  const params = plan.items.map((item, index) => {
    if (item.index !== index || item.action !== actionBytes[index]) {
      throw new Error('V4 action ordering changed during re-encoding.')
    }
    if (!item.operation) return item.rawParams
    const isSwap = item.operation.kind.startsWith('swap-')
    if ((plan.context === 'router') !== isSwap) {
      throw new Error('V4 operation kind does not match its action-plan context.')
    }
    if (actionForOperation(item.operation) !== item.action) {
      throw new Error('V4 operation kind does not match its original action byte.')
    }
    return encodeActionOperation(item.operation)
  })
  return encodeAbiParameters(ACTION_PLAN_PARAMETERS, [plan.actions, params])
}

function decodeInitializeParameters(encoded: Hex): V4InitializeOperation {
  const [poolKey, sqrtPriceX96] = decodeAbiParameters(INITIALIZE_PARAMETERS, encoded)
  const operation = { kind: 'initialize-pool', poolKey: copyPoolKey(poolKey), sqrtPriceX96 } as const
  if (!sameHex(encodeInitializeParameters(operation), encoded)) {
    throw new Error('Non-canonical v4 initialize parameters.')
  }
  return operation
}

function encodeInitializeParameters(operation: V4InitializeOperation): Hex {
  return encodeAbiParameters(INITIALIZE_PARAMETERS, [operation.poolKey, operation.sqrtPriceX96])
}

function decodePositionManagerCall(calldata: Hex, depth = 0): PositionManagerCall | null {
  if (depth > 4) return null
  const selector = selectorOf(calldata)
  try {
    if (selector === SELECTORS.modifyLiquidities) {
      const decoded = decodeFunctionData({ abi: MODIFY_LIQUIDITIES_ABI, data: calldata })
      const [unlockData, deadline] = decoded.args
      const canonical = encodeFunctionData({
        abi: MODIFY_LIQUIDITIES_ABI,
        functionName: 'modifyLiquidities',
        args: [unlockData, deadline],
      })
      if (!sameHex(canonical, calldata)) return null
      const plan = decodeV4ActionPlan(unlockData, 'position-manager')
      return plan ? { kind: 'modify-liquidities', deadline, plan } : null
    }
    if (selector === SELECTORS.modifyLiquiditiesWithoutUnlock) {
      const decoded = decodeFunctionData({ abi: MODIFY_LIQUIDITIES_WITHOUT_UNLOCK_ABI, data: calldata })
      const [actions, params] = decoded.args
      const canonical = encodeFunctionData({
        abi: MODIFY_LIQUIDITIES_WITHOUT_UNLOCK_ABI,
        functionName: 'modifyLiquiditiesWithoutUnlock',
        args: [actions, [...params]],
      })
      if (!sameHex(canonical, calldata)) return null
      const plan = decodeV4ActionPlan(encodeAbiParameters(ACTION_PLAN_PARAMETERS, [actions, [...params]]), 'position-manager')
      return plan ? { kind: 'modify-liquidities-without-unlock', plan } : null
    }
    if (selector === SELECTORS.initializePool) {
      const decoded = decodeFunctionData({ abi: INITIALIZE_POOL_ABI, data: calldata })
      const [poolKey, sqrtPriceX96] = decoded.args
      const canonical = encodeFunctionData({
        abi: INITIALIZE_POOL_ABI,
        functionName: 'initializePool',
        args: [poolKey, sqrtPriceX96],
      })
      if (!sameHex(canonical, calldata)) return null
      return {
        kind: 'initialize-pool',
        operation: { kind: 'initialize-pool', poolKey: copyPoolKey(poolKey), sqrtPriceX96 },
      }
    }
    if (selector === SELECTORS.multicall) {
      const decoded = decodeFunctionData({ abi: MULTICALL_ABI, data: calldata })
      const [subcalls] = decoded.args
      const canonical = encodeFunctionData({ abi: MULTICALL_ABI, functionName: 'multicall', args: [[...subcalls]] })
      if (!sameHex(canonical, calldata)) return null
      const calls = subcalls.map((rawCalldata, index): PositionManagerMulticallItem => ({
        index,
        rawCalldata,
        call: decodePositionManagerCall(rawCalldata, depth + 1) ?? undefined,
      }))
      return calls.some((item) => item.call) ? { kind: 'multicall', calls } : null
    }
  } catch {
    return null
  }
  return null
}

function encodePositionManagerCall(call: PositionManagerCall): Hex {
  if (call.kind === 'modify-liquidities') {
    return encodeFunctionData({
      abi: MODIFY_LIQUIDITIES_ABI,
      functionName: 'modifyLiquidities',
      args: [encodeV4ActionPlan(call.plan), call.deadline],
    })
  }
  if (call.kind === 'modify-liquidities-without-unlock') {
    const plan = encodeV4ActionPlan(call.plan)
    const [actions, params] = decodeAbiParameters(ACTION_PLAN_PARAMETERS, plan)
    return encodeFunctionData({
      abi: MODIFY_LIQUIDITIES_WITHOUT_UNLOCK_ABI,
      functionName: 'modifyLiquiditiesWithoutUnlock',
      args: [actions, [...params]],
    })
  }
  if (call.kind === 'initialize-pool') {
    return encodeFunctionData({
      abi: INITIALIZE_POOL_ABI,
      functionName: 'initializePool',
      args: [call.operation.poolKey, call.operation.sqrtPriceX96],
    })
  }
  return encodeFunctionData({
    abi: MULTICALL_ABI,
    functionName: 'multicall',
    args: [call.calls.map((item, index) => {
      if (item.index !== index) throw new Error('PositionManager multicall ordering changed during re-encoding.')
      return item.call ? encodePositionManagerCall(item.call) : item.rawCalldata
    })],
  })
}

const MAX_UNIVERSAL_ROUTER_SUBPLAN_DEPTH = 4

function decodeUniversalRouterPlan(
  commands: Hex,
  rawInputs: readonly Hex[],
  depth: number,
): { inputs: UniversalRouterCommand[]; hasV4Command: boolean } {
  const commandBytes = [...hexToBytes(commands)]
  if (commandBytes.length !== rawInputs.length) throw new Error('Universal Router command/input count mismatch.')
  let hasV4Command = false
  const inputs = commandBytes.map((command, index): UniversalRouterCommand => {
    const rawInput = rawInputs[index]
    if (!rawInput) throw new Error('Missing Universal Router command input.')
    const commandType = command & 0x7f
    const base = { index, command, commandType, allowRevert: (command & 0x80) !== 0, rawInput }
    if (isUniversalRouterCommand(command, UNIVERSAL_ROUTER_COMMANDS.V4_SWAP)) {
      hasV4Command = true
      const plan = decodeV4ActionPlan(rawInput, 'router')
      if (!plan) throw new Error('Malformed Universal Router V4_SWAP input.')
      return { ...base, decoded: { kind: 'v4-swap', plan } }
    }
    if (isUniversalRouterCommand(command, UNIVERSAL_ROUTER_COMMANDS.V4_INITIALIZE_POOL)) {
      hasV4Command = true
      return { ...base, decoded: { kind: 'v4-initialize-pool', operation: decodeInitializeParameters(rawInput) } }
    }
    if (isUniversalRouterCommand(command, UNIVERSAL_ROUTER_COMMANDS.V4_POSITION_MANAGER_CALL)) {
      hasV4Command = true
      const call = decodePositionManagerCall(rawInput)
      if (call?.kind !== 'modify-liquidities') return base
      const unsafeAction = call.plan.items.some((item) =>
        item.action === V4_ACTIONS.INCREASE_LIQUIDITY
        || item.action === V4_ACTIONS.DECREASE_LIQUIDITY
        || item.action === V4_ACTIONS.BURN_POSITION)
      return unsafeAction ? base : { ...base, decoded: { kind: 'v4-position-manager-call', call } }
    }
    if (isUniversalRouterCommand(command, UNIVERSAL_ROUTER_COMMANDS.EXECUTE_SUB_PLAN) && depth < MAX_UNIVERSAL_ROUTER_SUBPLAN_DEPTH) {
      try {
        const [nestedCommands, nestedRawInputs] = decodeAbiParameters(ACTION_PLAN_PARAMETERS, rawInput)
        const canonical = encodeAbiParameters(ACTION_PLAN_PARAMETERS, [nestedCommands, [...nestedRawInputs]])
        if (!sameHex(canonical, rawInput)) return base
        const nested = decodeUniversalRouterPlan(nestedCommands, nestedRawInputs, depth + 1)
        if (!nested.hasV4Command) return base
        hasV4Command = true
        return {
          ...base,
          decoded: { kind: 'execute-sub-plan', commands: nestedCommands, inputs: nested.inputs },
        }
      } catch {
        return base
      }
    }
    return base
  })
  return { inputs, hasV4Command }
}

function decodeUniversalRouterCalldata(calldata: Hex): DecodedUniswapV4Calldata | null {
  const selector = selectorOf(calldata)
  try {
    let commands: Hex
    let rawInputs: readonly Hex[]
    let deadline: bigint | undefined
    let entrypoint: 'execute' | 'execute-with-deadline'
    if (selector === SELECTORS.execute) {
      const decoded = decodeFunctionData({ abi: EXECUTE_ABI, data: calldata })
      ;[commands, rawInputs] = decoded.args
      entrypoint = 'execute'
      const canonical = encodeFunctionData({
        abi: EXECUTE_ABI,
        functionName: 'execute',
        args: [commands, [...rawInputs]],
      })
      if (!sameHex(canonical, calldata)) return null
    } else if (selector === SELECTORS.executeWithDeadline) {
      const decoded = decodeFunctionData({ abi: EXECUTE_WITH_DEADLINE_ABI, data: calldata })
      ;[commands, rawInputs, deadline] = decoded.args
      entrypoint = 'execute-with-deadline'
      const canonical = encodeFunctionData({
        abi: EXECUTE_WITH_DEADLINE_ABI,
        functionName: 'execute',
        args: [commands, [...rawInputs], deadline],
      })
      if (!sameHex(canonical, calldata)) return null
    } else {
      return null
    }

    const plan = decodeUniversalRouterPlan(commands, rawInputs, 0)
    if (!plan.hasV4Command) return null
    return { kind: 'universal-router', entrypoint, commands, inputs: plan.inputs, deadline }
  } catch {
    return null
  }
}

export function decodeUniswapV4Calldata(calldata: Hex): DecodedUniswapV4Calldata | null {
  const router = decodeUniversalRouterCalldata(calldata)
  if (router) return router
  const call = decodePositionManagerCall(calldata)
  return call ? { kind: 'position-manager', call } : null
}

function encodeUniversalRouterInput(input: UniversalRouterCommand): Hex {
  if (!input.decoded) return input.rawInput
  if (input.decoded.kind === 'v4-swap') {
    if (!isUniversalRouterCommand(input.command, UNIVERSAL_ROUTER_COMMANDS.V4_SWAP)) {
      throw new Error('Decoded Universal Router input does not match its command byte.')
    }
    return encodeV4ActionPlan(input.decoded.plan)
  }
  if (input.decoded.kind === 'v4-initialize-pool') {
    if (!isUniversalRouterCommand(input.command, UNIVERSAL_ROUTER_COMMANDS.V4_INITIALIZE_POOL)) {
      throw new Error('Decoded Universal Router input does not match its command byte.')
    }
    return encodeInitializeParameters(input.decoded.operation)
  }
  if (input.decoded.kind === 'execute-sub-plan') {
    if (!isUniversalRouterCommand(input.command, UNIVERSAL_ROUTER_COMMANDS.EXECUTE_SUB_PLAN)) {
      throw new Error('Decoded Universal Router subplan does not match its command byte.')
    }
    return encodeAbiParameters(ACTION_PLAN_PARAMETERS, [
      input.decoded.commands,
      encodeUniversalRouterInputs(input.decoded.commands, input.decoded.inputs),
    ])
  }
  if (!isUniversalRouterCommand(input.command, UNIVERSAL_ROUTER_COMMANDS.V4_POSITION_MANAGER_CALL)) {
    throw new Error('Decoded Universal Router input does not match its command byte.')
  }
  return encodePositionManagerCall(input.decoded.call)
}

function encodeUniversalRouterInputs(commands: Hex, decodedInputs: UniversalRouterCommand[]): Hex[] {
  const commandBytes = [...hexToBytes(commands)]
  if (commandBytes.length !== decodedInputs.length) throw new Error('Universal Router command count changed during re-encoding.')
  return decodedInputs.map((input, index) => {
    if (input.index !== index || input.command !== commandBytes[index]) {
      throw new Error('Universal Router command ordering changed during re-encoding.')
    }
    return encodeUniversalRouterInput(input)
  })
}

export function encodeUniswapV4Calldata(decoded: DecodedUniswapV4Calldata): Hex {
  if (decoded.kind === 'position-manager') return encodePositionManagerCall(decoded.call)
  const inputs = encodeUniversalRouterInputs(decoded.commands, decoded.inputs)
  if (decoded.entrypoint === 'execute') {
    return encodeFunctionData({ abi: EXECUTE_ABI, functionName: 'execute', args: [decoded.commands, inputs] })
  }
  if (decoded.deadline === undefined) throw new Error('Universal Router deadline is missing.')
  return encodeFunctionData({
    abi: EXECUTE_WITH_DEADLINE_ABI,
    functionName: 'execute',
    args: [decoded.commands, inputs, decoded.deadline],
  })
}

function locatePositionManagerOperations(input: {
  call: PositionManagerCall
  operations: LocatedV4Operation[]
  root: V4OperationLocation['root']
  commandIndex?: number
  subplanPath?: number[]
  multicallPath: number[]
}) {
  const { call, operations, root, commandIndex, subplanPath, multicallPath } = input
  if (call.kind === 'initialize-pool') {
    operations.push({
      location: root === 'universal-router'
        ? {
            root,
            container: 'position-manager-initialize',
            commandIndex: commandIndex as number,
            ...(subplanPath?.length ? { subplanPath: [...subplanPath] } : {}),
            multicallPath: [...multicallPath],
          }
        : { root, container: 'position-manager-initialize', multicallPath: [...multicallPath] },
      operation: call.operation,
    })
    return
  }
  if (call.kind === 'multicall') {
    for (const item of call.calls) {
      if (item.call) {
        locatePositionManagerOperations({
          call: item.call,
          operations,
          root,
          commandIndex,
          subplanPath,
          multicallPath: [...multicallPath, item.index],
        })
      }
    }
    return
  }
  for (const item of call.plan.items) {
    if (!item.operation) continue
    operations.push({
      location: root === 'universal-router'
        ? {
            root,
            container: 'position-manager-action',
            commandIndex: commandIndex as number,
            ...(subplanPath?.length ? { subplanPath: [...subplanPath] } : {}),
            multicallPath: [...multicallPath],
            actionIndex: item.index,
          }
        : {
            root,
            container: 'position-manager-action',
            multicallPath: [...multicallPath],
            actionIndex: item.index,
          },
      operation: item.operation,
    })
  }
}

function locateUniversalRouterOperations(
  inputs: UniversalRouterCommand[],
  operations: LocatedV4Operation[],
  subplanPath: number[],
) {
  for (const input of inputs) {
    if (input.decoded?.kind === 'v4-swap') {
      for (const item of input.decoded.plan.items) {
        if (item.operation) {
          operations.push({
            location: {
              root: 'universal-router',
              container: 'router-action',
              commandIndex: input.index,
              ...(subplanPath.length ? { subplanPath: [...subplanPath] } : {}),
              actionIndex: item.index,
            },
            operation: item.operation,
          })
        }
      }
    } else if (input.decoded?.kind === 'v4-initialize-pool') {
      operations.push({
        location: {
          root: 'universal-router',
          container: 'router-initialize',
          commandIndex: input.index,
          ...(subplanPath.length ? { subplanPath: [...subplanPath] } : {}),
        },
        operation: input.decoded.operation,
      })
    } else if (input.decoded?.kind === 'v4-position-manager-call') {
      locatePositionManagerOperations({
        call: input.decoded.call,
        operations,
        root: 'universal-router',
        commandIndex: input.index,
        subplanPath,
        multicallPath: [],
      })
    } else if (input.decoded?.kind === 'execute-sub-plan') {
      locateUniversalRouterOperations(input.decoded.inputs, operations, [...subplanPath, input.index])
    }
  }
}

export function locateUniswapV4Operations(decoded: DecodedUniswapV4Calldata): LocatedV4Operation[] {
  const operations: LocatedV4Operation[] = []
  if (decoded.kind === 'position-manager') {
    locatePositionManagerOperations({
      call: decoded.call,
      operations,
      root: 'position-manager',
      multicallPath: [],
    })
    return operations
  }
  locateUniversalRouterOperations(decoded.inputs, operations, [])
  return operations
}

export function collectUniswapV4Operations(decoded: DecodedUniswapV4Calldata): V4ControlledOperation[] {
  return locateUniswapV4Operations(decoded).map((item) => item.operation)
}

export function cloneUniswapV4Calldata<T extends DecodedUniswapV4Calldata>(decoded: T): T {
  return structuredClone(decoded)
}

function sameLocation(left: V4OperationLocation, right: V4OperationLocation): boolean {
  if (left.root !== right.root || left.container !== right.container) return false
  if ('commandIndex' in left && 'commandIndex' in right && left.commandIndex !== right.commandIndex) return false
  if ('commandIndex' in left !== 'commandIndex' in right) return false
  const leftSubplan = 'subplanPath' in left ? left.subplanPath ?? [] : []
  const rightSubplan = 'subplanPath' in right ? right.subplanPath ?? [] : []
  if (leftSubplan.length !== rightSubplan.length || leftSubplan.some((item, index) => item !== rightSubplan[index])) return false
  if ('actionIndex' in left && 'actionIndex' in right && left.actionIndex !== right.actionIndex) return false
  if ('actionIndex' in left !== 'actionIndex' in right) return false
  if ('multicallPath' in left && 'multicallPath' in right) {
    return left.multicallPath.length === right.multicallPath.length
      && left.multicallPath.every((item, index) => item === right.multicallPath[index])
  }
  return 'multicallPath' in left === 'multicallPath' in right
}

export function cloneAndMutateUniswapV4Operation(
  decoded: DecodedUniswapV4Calldata,
  location: V4OperationLocation,
  mutate: (operation: V4ControlledOperation) => void,
): DecodedUniswapV4Calldata {
  const clone = cloneUniswapV4Calldata(decoded)
  const target = locateUniswapV4Operations(clone).find((item) => sameLocation(item.location, location))
  if (!target) throw new Error('The requested Uniswap v4 operation location does not exist.')
  const originalKind = target.operation.kind
  const originalSchema = 'schema' in target.operation ? target.operation.schema : undefined
  mutate(target.operation)
  if (target.operation.kind !== originalKind) {
    throw new Error('A Uniswap v4 operation kind cannot change during mutation.')
  }
  if (('schema' in target.operation ? target.operation.schema : undefined) !== originalSchema) {
    throw new Error('A Uniswap v4 operation schema cannot change during mutation.')
  }
  return clone
}
