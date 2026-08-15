import {
  decodeAbiParameters,
  encodeFunctionData,
  getAddress,
  parseAbi,
  size,
  toFunctionSelector,
  type Address,
  type Hex,
} from 'viem'
import type { PoolDescriptor } from '../domain/report'
import { decodeHookPermissions, HOOK_FLAGS, type HookPermission } from '../domain/hooks'
import {
  buildProtocolScenarioMatrix,
  MIN_SQRT_PRICE_PLUS_ONE,
  type ProtocolScenario,
} from './protocolNativeScenarios'
import type { ProtocolScenarioContext } from './protocolScenarioContext'
import { validateScenarioExecution } from './protocolScenarioValidation'
import type { ForkExecutionSession, ForkReplayResult } from './revmProof'

/**
 * Runtime-only adaptations for public hooks.
 *
 * These probes deliberately use the same pinned fork session as the generated
 * PoolManager scenarios. They do not infer a getter from a successful fallback:
 * every return value is checked against the exact canonical ABI shape before it
 * becomes evidence.
 */

const PROBE_GAS_LIMIT = 2_000_000n
const PROBE_TIMEOUT_MS = 20_000
const ZERO_BYTES32 = `0x${'0'.repeat(64)}` as Hex

const GET_HOOK_PERMISSIONS_SELECTOR = toFunctionSelector('getHookPermissions()')
const POOL_MANAGER_SELECTOR = toFunctionSelector('poolManager()')
const SUPPORTS_INTERFACE_ABI = parseAbi(['function supportsInterface(bytes4 interfaceId) view returns (bool)'])

const POOL_KEY = 'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }'
const MODIFY_PARAMS = 'struct ModifyLiquidityParams { int24 tickLower; int24 tickUpper; int256 liquidityDelta; bytes32 salt; }'
const SWAP_PARAMS = 'struct SwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }'

const BEFORE_INITIALIZE_ABI = parseAbi([
  POOL_KEY,
  'function beforeInitialize(address sender, PoolKey key, uint160 sqrtPriceX96)',
])
const AFTER_INITIALIZE_ABI = parseAbi([
  POOL_KEY,
  'function afterInitialize(address sender, PoolKey key, uint160 sqrtPriceX96, int24 tick)',
])
const BEFORE_ADD_LIQUIDITY_ABI = parseAbi([
  POOL_KEY,
  MODIFY_PARAMS,
  'function beforeAddLiquidity(address sender, PoolKey key, ModifyLiquidityParams params, bytes hookData)',
])
const AFTER_ADD_LIQUIDITY_ABI = parseAbi([
  POOL_KEY,
  MODIFY_PARAMS,
  'function afterAddLiquidity(address sender, PoolKey key, ModifyLiquidityParams params, int256 delta, int256 feesAccrued, bytes hookData)',
])
const BEFORE_REMOVE_LIQUIDITY_ABI = parseAbi([
  POOL_KEY,
  MODIFY_PARAMS,
  'function beforeRemoveLiquidity(address sender, PoolKey key, ModifyLiquidityParams params, bytes hookData)',
])
const AFTER_REMOVE_LIQUIDITY_ABI = parseAbi([
  POOL_KEY,
  MODIFY_PARAMS,
  'function afterRemoveLiquidity(address sender, PoolKey key, ModifyLiquidityParams params, int256 delta, int256 feesAccrued, bytes hookData)',
])
const BEFORE_SWAP_ABI = parseAbi([
  POOL_KEY,
  SWAP_PARAMS,
  'function beforeSwap(address sender, PoolKey key, SwapParams params, bytes hookData)',
])
const AFTER_SWAP_ABI = parseAbi([
  POOL_KEY,
  SWAP_PARAMS,
  'function afterSwap(address sender, PoolKey key, SwapParams params, int256 delta, bytes hookData)',
])
const BEFORE_DONATE_ABI = parseAbi([
  POOL_KEY,
  'function beforeDonate(address sender, PoolKey key, uint256 amount0, uint256 amount1, bytes hookData)',
])
const AFTER_DONATE_ABI = parseAbi([
  POOL_KEY,
  'function afterDonate(address sender, PoolKey key, uint256 amount0, uint256 amount1, bytes hookData)',
])

const PERMISSION_OUTPUTS = [
  { type: 'bool', name: 'beforeInitialize' },
  { type: 'bool', name: 'afterInitialize' },
  { type: 'bool', name: 'beforeAddLiquidity' },
  { type: 'bool', name: 'afterAddLiquidity' },
  { type: 'bool', name: 'beforeRemoveLiquidity' },
  { type: 'bool', name: 'afterRemoveLiquidity' },
  { type: 'bool', name: 'beforeSwap' },
  { type: 'bool', name: 'afterSwap' },
  { type: 'bool', name: 'beforeDonate' },
  { type: 'bool', name: 'afterDonate' },
  { type: 'bool', name: 'beforeSwapReturnDelta' },
  { type: 'bool', name: 'afterSwapReturnDelta' },
  { type: 'bool', name: 'afterAddLiquidityReturnDelta' },
  { type: 'bool', name: 'afterRemoveLiquidityReturnDelta' },
] as const

export type PublicHackenRuntimeStatus =
  | 'passed'
  | 'warning'
  | 'failed'
  | 'observed'
  | 'unavailable'
  | 'error'

export type PublicHackenRuntimeProbe = {
  caseId: string
  poolId: Hex
  hook: Address
  status: PublicHackenRuntimeStatus
  reason: string
  gasUsed?: number
  scenarioIds?: string[]
  observedOutcome?: 'completed' | 'reverted' | 'mixed' | 'no-movement'
  details?: Record<string, unknown>
}

type ProbeSession = Pick<ForkExecutionSession, 'execute'>

type DirectCallback = {
  permission: HookPermission
  selector: Hex
  calldata: Hex
}

function poolKey(pool: PoolDescriptor) {
  return {
    currency0: pool.currency0,
    currency1: pool.currency1,
    fee: pool.fee,
    tickSpacing: pool.tickSpacing,
    hooks: pool.hook,
  }
}

function callbackCalldata(context: ProtocolScenarioContext): DirectCallback[] {
  const key = poolKey(context.pool)
  const sqrtPriceX96 = context.slot0?.sqrtPriceX96 ?? (1n << 96n)
  const tick = context.slot0?.tick ?? 0
  const spacing = Math.max(1, Math.abs(context.pool.tickSpacing))
  const modifyParams = {
    tickLower: -spacing,
    tickUpper: spacing,
    liquidityDelta: 1n,
    salt: ZERO_BYTES32,
  }
  const swapParams = {
    zeroForOne: true,
    amountSpecified: -1n,
    sqrtPriceLimitX96: MIN_SQRT_PRICE_PLUS_ONE,
  }
  const sender = context.router

  const entries: { permission: HookPermission; calldata: Hex }[] = [
    {
      permission: 'beforeInitialize',
      calldata: encodeFunctionData({
        abi: BEFORE_INITIALIZE_ABI,
        functionName: 'beforeInitialize',
        args: [sender, key, sqrtPriceX96],
      }),
    },
    {
      permission: 'afterInitialize',
      calldata: encodeFunctionData({
        abi: AFTER_INITIALIZE_ABI,
        functionName: 'afterInitialize',
        args: [sender, key, sqrtPriceX96, tick],
      }),
    },
    {
      permission: 'beforeAddLiquidity',
      calldata: encodeFunctionData({
        abi: BEFORE_ADD_LIQUIDITY_ABI,
        functionName: 'beforeAddLiquidity',
        args: [sender, key, modifyParams, '0x'],
      }),
    },
    {
      permission: 'afterAddLiquidity',
      calldata: encodeFunctionData({
        abi: AFTER_ADD_LIQUIDITY_ABI,
        functionName: 'afterAddLiquidity',
        args: [sender, key, modifyParams, 0n, 0n, '0x'],
      }),
    },
    {
      permission: 'beforeRemoveLiquidity',
      calldata: encodeFunctionData({
        abi: BEFORE_REMOVE_LIQUIDITY_ABI,
        functionName: 'beforeRemoveLiquidity',
        args: [sender, key, modifyParams, '0x'],
      }),
    },
    {
      permission: 'afterRemoveLiquidity',
      calldata: encodeFunctionData({
        abi: AFTER_REMOVE_LIQUIDITY_ABI,
        functionName: 'afterRemoveLiquidity',
        args: [sender, key, modifyParams, 0n, 0n, '0x'],
      }),
    },
    {
      permission: 'beforeSwap',
      calldata: encodeFunctionData({
        abi: BEFORE_SWAP_ABI,
        functionName: 'beforeSwap',
        args: [sender, key, swapParams, '0x'],
      }),
    },
    {
      permission: 'afterSwap',
      calldata: encodeFunctionData({
        abi: AFTER_SWAP_ABI,
        functionName: 'afterSwap',
        args: [sender, key, swapParams, 0n, '0x'],
      }),
    },
    {
      permission: 'beforeDonate',
      calldata: encodeFunctionData({
        abi: BEFORE_DONATE_ABI,
        functionName: 'beforeDonate',
        args: [sender, key, 1n, 1n, '0x'],
      }),
    },
    {
      permission: 'afterDonate',
      calldata: encodeFunctionData({
        abi: AFTER_DONATE_ABI,
        functionName: 'afterDonate',
        args: [sender, key, 1n, 1n, '0x'],
      }),
    },
  ]

  return entries.map((entry) => ({
    ...entry,
    selector: entry.calldata.slice(0, 10) as Hex,
  }))
}

async function executeCall(input: {
  session: ProbeSession
  context: ProtocolScenarioContext
  to: Address
  calldata: Hex
  signal: AbortSignal
  gasLimit?: bigint
  maxHydrationRequests?: number
}): Promise<ForkReplayResult> {
  return input.session.execute({
    transaction: {
      caller: input.context.actor,
      to: input.to,
      calldata: input.calldata,
      value: 0n,
      executionMode: 'simulation',
      gasLimit: input.gasLimit ?? PROBE_GAS_LIMIT,
      gasPrice: 0n,
      nonce: 0,
      chainId: input.context.chainId,
      traceLimit: 1_024,
    },
    block: input.context.executionBlock,
    signal: input.signal,
    timeoutMs: PROBE_TIMEOUT_MS,
    maxHydrationRequests: input.maxHydrationRequests ?? 512,
    commit: false,
  })
}

function enteredTarget(replay: ForkReplayResult, target: Address, selector: Hex) {
  const address = target.toLowerCase()
  const expectedSelector = selector.toLowerCase()
  return replay.proof.calls.some((call) =>
    call.target.toLowerCase() === address && call.selector?.toLowerCase() === expectedSelector)
    || replay.proof.steps.some((step) => step.address.toLowerCase() === address)
}

function decodePermissions(output: Hex): Record<HookPermission, boolean> | undefined {
  if (size(output) !== 32 * PERMISSION_OUTPUTS.length) return undefined
  try {
    const values = decodeAbiParameters(PERMISSION_OUTPUTS, output)
    return Object.fromEntries(
      HOOK_FLAGS.map(([permission], index) => [permission, values[index]]),
    ) as Record<HookPermission, boolean>
  } catch {
    return undefined
  }
}

function decodeCanonicalAddress(output: Hex): Address | undefined {
  if (size(output) !== 32 || !/^0x0{24}[0-9a-fA-F]{40}$/.test(output)) return undefined
  try {
    return getAddress(`0x${output.slice(-40)}`)
  } catch {
    return undefined
  }
}

function decodeCanonicalBool(output: Hex): boolean | undefined {
  if (size(output) !== 32) return undefined
  const value = BigInt(output)
  return value === 0n ? false : value === 1n ? true : undefined
}

async function introspectionProbes(input: {
  session: ProbeSession
  context: ProtocolScenarioContext
  signal: AbortSignal
  maxHydrationRequests?: number
}): Promise<PublicHackenRuntimeProbe[]> {
  const { context } = input
  const base = { poolId: context.pool.poolId, hook: context.pool.hook }
  const call = (calldata: Hex) => executeCall({
    ...input,
    to: context.pool.hook,
    calldata,
  })

  const permissionReplay = await call(GET_HOOK_PERMISSIONS_SELECTOR)
  const managerReplay = await call(POOL_MANAGER_SELECTOR)
  const erc165Calldata = encodeFunctionData({
    abi: SUPPORTS_INTERFACE_ABI,
    functionName: 'supportsInterface',
    args: ['0x01ffc9a7'],
  })
  const erc165Replay = await call(erc165Calldata)

  const returnedPermissions = permissionReplay.proof.success
    ? decodePermissions(permissionReplay.proof.output)
    : undefined
  const expectedPermissions = new Set(decodeHookPermissions(context.pool.hook))
  const mismatchedPermissions = returnedPermissions
    ? HOOK_FLAGS.map(([permission]) => permission).filter((permission) =>
        returnedPermissions[permission] !== expectedPermissions.has(permission))
    : []
  const permissionStatus: PublicHackenRuntimeProbe['status'] = !returnedPermissions
    ? 'unavailable'
    : mismatchedPermissions.length
      ? 'failed'
      : 'passed'
  const permissionReason = !permissionReplay.proof.success
    ? 'getHookPermissions() reverted at the pinned block; the optional getter was not treated as present.'
    : !returnedPermissions
      ? 'getHookPermissions() did not return the canonical 14-boolean Hooks.Permissions shape.'
      : mismatchedPermissions.length
        ? `getHookPermissions() disagreed with the hook address bits for: ${mismatchedPermissions.join(', ')}.`
        : 'The canonical getHookPermissions() result matched all 14 permission bits encoded in the hook address.'

  const returnedManager = managerReplay.proof.success
    ? decodeCanonicalAddress(managerReplay.proof.output)
    : undefined
  const managerMatches = returnedManager?.toLowerCase() === context.poolManager.toLowerCase()
  const managerStatus: PublicHackenRuntimeProbe['status'] = !returnedManager
    ? 'unavailable'
    : managerMatches
      ? 'passed'
      : 'failed'
  const managerReason = !managerReplay.proof.success
    ? 'poolManager() reverted at the pinned block; the optional getter was not treated as present.'
    : !returnedManager
      ? 'poolManager() did not return one canonical ABI-encoded address.'
      : managerMatches
        ? `poolManager() returned the selected deployed PoolManager ${context.poolManager}.`
        : `poolManager() returned ${returnedManager}, not the selected deployed PoolManager ${context.poolManager}.`

  const interfaceSupport = erc165Replay.proof.success
    ? decodeCanonicalBool(erc165Replay.proof.output)
    : undefined
  const interfaceReason = !erc165Replay.proof.success
    ? 'supportsInterface(bytes4) reverted at the pinned block; ERC-165 introspection is unavailable.'
    : interfaceSupport === undefined
      ? 'supportsInterface(bytes4) did not return one canonical ABI boolean.'
      : `supportsInterface(0x01ffc9a7) returned ${interfaceSupport}; this is recorded without requiring ERC-165 support.`

  const gettersStatus: PublicHackenRuntimeProbe['status'] =
    permissionStatus === 'failed' || managerStatus === 'failed'
      ? 'failed'
      : permissionStatus === 'passed' && managerStatus === 'passed'
        ? 'passed'
        : 'unavailable'

  return [
    {
      ...base,
      caseId: 'permissions-match-address',
      status: permissionStatus,
      reason: permissionReason,
      gasUsed: permissionReplay.proof.gasUsed,
      scenarioIds: ['runtime:getHookPermissions'],
      details: {
        selector: GET_HOOK_PERMISSIONS_SELECTOR,
        returnedPermissions,
        expectedPermissions: [...expectedPermissions],
        mismatchedPermissions,
      },
    },
    {
      ...base,
      caseId: 'base-hook-pool-manager',
      status: managerStatus,
      reason: managerReason,
      gasUsed: managerReplay.proof.gasUsed,
      scenarioIds: ['runtime:poolManager'],
      details: { selector: POOL_MANAGER_SELECTOR, returnedManager, expectedManager: context.poolManager },
    },
    {
      ...base,
      caseId: 'introspect-public-getters',
      status: gettersStatus,
      reason: gettersStatus === 'passed'
        ? 'Both canonical public getters were callable and returned values consistent with the selected hook and PoolManager.'
        : gettersStatus === 'failed'
          ? 'A canonical public getter returned a value inconsistent with the selected hook or PoolManager.'
          : 'Both canonical public getter shapes could not be proven at the pinned block.',
      gasUsed: permissionReplay.proof.gasUsed + managerReplay.proof.gasUsed,
      scenarioIds: ['runtime:getHookPermissions', 'runtime:poolManager'],
      details: { permissionStatus, managerStatus },
    },
    {
      ...base,
      caseId: 'introspect-optional-interface',
      status: interfaceSupport === undefined ? 'unavailable' : 'observed',
      reason: interfaceReason,
      gasUsed: erc165Replay.proof.gasUsed,
      scenarioIds: ['runtime:supportsInterface:01ffc9a7'],
      observedOutcome: erc165Replay.proof.success ? 'completed' : 'reverted',
      details: {
        selector: erc165Calldata.slice(0, 10),
        interfaceId: '0x01ffc9a7',
        supported: interfaceSupport,
      },
    },
  ]
}

async function callbackAuthorizationProbe(input: {
  session: ProbeSession
  context: ProtocolScenarioContext
  signal: AbortSignal
  maxHydrationRequests?: number
}): Promise<PublicHackenRuntimeProbe> {
  const { context } = input
  const enabled = new Set(decodeHookPermissions(context.pool.hook))
  const callbacks = callbackCalldata(context).filter((callback) => enabled.has(callback.permission))
  const base = {
    caseId: 'only-pool-manager',
    poolId: context.pool.poolId,
    hook: context.pool.hook,
  }
  if (!callbacks.length) {
    return {
      ...base,
      status: 'unavailable',
      reason: 'The hook address enables no action callback, so there is no permission-selected callback to probe directly.',
    }
  }

  const observations: {
    permission: HookPermission
    selector: Hex
    outcome: 'reverted' | 'completed' | 'error'
    gasUsed?: number
    output?: Hex
    reason?: string
  }[] = []
  for (const callback of callbacks) {
    try {
      const replay = await executeCall({
        ...input,
        to: context.pool.hook,
        calldata: callback.calldata,
      })
      if (!enteredTarget(replay, context.pool.hook, callback.selector)) {
        observations.push({
          permission: callback.permission,
          selector: callback.selector,
          outcome: 'error',
          reason: 'The direct call produced no trace inside the hook.',
        })
        continue
      }
      observations.push({
        permission: callback.permission,
        selector: callback.selector,
        outcome: replay.proof.success ? 'completed' : 'reverted',
        gasUsed: replay.proof.gasUsed,
        output: replay.proof.output,
      })
    } catch (error) {
      if (input.signal.aborted) throw error
      observations.push({
        permission: callback.permission,
        selector: callback.selector,
        outcome: 'error',
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const completed = observations.filter((item) => item.outcome === 'completed')
  const reverted = observations.filter((item) => item.outcome === 'reverted')
  const errors = observations.filter((item) => item.outcome === 'error')
  const status: PublicHackenRuntimeProbe['status'] = errors.length
    ? 'error'
    : completed.length
      ? 'failed'
      : 'passed'
  const reason = errors.length
    ? `${errors.length}/${observations.length} permission-selected direct callback probes did not produce a valid hook execution trace.`
    : completed.length
      ? `${completed.length}/${observations.length} permission-selected callbacks completed when called directly by a non-PoolManager account.`
      : `All ${reverted.length} permission-selected callbacks rejected the direct non-PoolManager caller. This demonstrates rejection for these concrete calls; it does not infer the hook's internal guard implementation.`

  return {
    ...base,
    status,
    reason,
    gasUsed: observations.reduce((sum, item) => sum + (item.gasUsed ?? 0), 0) || undefined,
    scenarioIds: observations.map((item) => `runtime:direct:${item.permission}`),
    observedOutcome: completed.length && reverted.length
      ? 'mixed'
      : completed.length
        ? 'completed'
        : 'reverted',
    details: { callbacks: observations },
  }
}

function compatibleSecondaryPool(context: ProtocolScenarioContext, pools: PoolDescriptor[]) {
  const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase()
  return pools
    .filter((pool) =>
      !same(pool.poolId, context.pool.poolId)
      && same(pool.hook, context.pool.hook)
      && same(pool.currency0, context.pool.currency0)
      && same(pool.currency1, context.pool.currency1))
    .sort((left, right) => left.poolId.localeCompare(right.poolId))[0]
}

async function secondaryPoolProbe(input: {
  session: ProbeSession
  context: ProtocolScenarioContext
  pools: PoolDescriptor[]
  signal: AbortSignal
  maxHydrationRequests?: number
}): Promise<PublicHackenRuntimeProbe> {
  const { context } = input
  const base = {
    caseId: 'secondary-pool-open-policy',
    poolId: context.pool.poolId,
    hook: context.pool.hook,
  }
  const secondary = compatibleSecondaryPool(context, input.pools)
  if (!secondary) {
    return {
      ...base,
      status: 'unavailable',
      reason: 'No second discovered PoolId used the same deployed hook and currency pair in this report batch.',
    }
  }

  const scenario = buildProtocolScenarioMatrix({
    key: poolKey(secondary),
    actor: context.actor,
  }).scenarios.find((item) => item.id === 'swap:exact-input:0-for-1:small') as ProtocolScenario | undefined
  if (!scenario) {
    return { ...base, status: 'error', reason: 'The secondary-pool adapter could not construct its canonical swap scenario.' }
  }

  try {
    const replay = await executeCall({
      ...input,
      to: context.router,
      calldata: scenario.calldata,
      gasLimit: 16_000_000n,
      maxHydrationRequests: input.maxHydrationRequests ?? 2_048,
    })
    const validation = validateScenarioExecution({
      proof: replay.proof,
      scenario,
      poolManager: context.poolManager,
      hook: secondary.hook,
      poolId: secondary.poolId,
      router: context.router,
    })
    if (validation.status === 'failed') {
      return {
        ...base,
        status: 'error',
        reason: validation.reason,
        gasUsed: replay.proof.gasUsed,
        scenarioIds: [`secondary:${secondary.poolId}:swap:exact-input:0-for-1:small`],
        details: { secondaryPoolId: secondary.poolId },
      }
    }
    if (validation.status === 'reverted') {
      return {
        ...base,
        status: 'observed',
        reason: `The same hook rejected a generated swap for secondary PoolId ${secondary.poolId} after the call reached the deployed PoolManager. Pool state and hook policy are not separable from this one rejection, so it is recorded rather than labelled incompatible.`,
        gasUsed: replay.proof.gasUsed,
        observedOutcome: 'reverted',
        scenarioIds: [`secondary:${secondary.poolId}:swap:exact-input:0-for-1:small`],
        details: { secondaryPoolId: secondary.poolId, output: replay.proof.output },
      }
    }
    return {
      ...base,
      status: 'passed',
      reason: `The deployed hook accepted the generated swap through secondary PoolId ${secondary.poolId}, demonstrating compatibility with a second initialized PoolKey at the pinned block.`,
      gasUsed: replay.proof.gasUsed,
      observedOutcome: 'completed',
      scenarioIds: [`secondary:${secondary.poolId}:swap:exact-input:0-for-1:small`],
      details: { secondaryPoolId: secondary.poolId },
    }
  } catch (error) {
    if (input.signal.aborted) throw error
    return {
      ...base,
      status: 'error',
      reason: error instanceof Error ? error.message : String(error),
      details: { secondaryPoolId: secondary.poolId },
    }
  }
}

export async function runPublicHackenRuntimeProbes(input: {
  session: ProbeSession
  context: ProtocolScenarioContext
  pools: PoolDescriptor[]
  signal: AbortSignal
  maxHydrationRequests?: number
}): Promise<PublicHackenRuntimeProbe[]> {
  const probes: PublicHackenRuntimeProbe[] = []
  try {
    probes.push(...await introspectionProbes(input))
  } catch (error) {
    if (input.signal.aborted) throw error
    const reason = error instanceof Error ? error.message : String(error)
    for (const caseId of [
      'permissions-match-address',
      'base-hook-pool-manager',
      'introspect-public-getters',
      'introspect-optional-interface',
    ]) {
      probes.push({
        caseId,
        poolId: input.context.pool.poolId,
        hook: input.context.pool.hook,
        status: 'error',
        reason,
      })
    }
  }
  probes.push(await callbackAuthorizationProbe(input))
  probes.push(await secondaryPoolProbe(input))
  return probes
}
