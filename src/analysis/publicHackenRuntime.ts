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
const PROBE_CALL_TIMEOUT_MS = 20_000
const DEFAULT_PROBE_BUDGET_MS = 45_000
const DEFAULT_PROBE_HYDRATION_BUDGET = 2_048
const ZERO_BYTES32 = `0x${'0'.repeat(64)}` as Hex

const GET_HOOK_PERMISSIONS_SELECTOR = toFunctionSelector('getHookPermissions()')
const POOL_MANAGER_SELECTOR = toFunctionSelector('poolManager()')
const NOT_POOL_MANAGER_SELECTOR = toFunctionSelector('NotPoolManager()')
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

type MediatedScenarioOutcome = {
  poolId: Hex
  scenarioId: string
  status: 'completed' | 'reverted' | 'unavailable' | 'failed'
  proof?: ForkReplayResult
}

type ProbeBudget = {
  deadline: number
  hydrationRequestsRemaining: number
}

type RuntimeProbeInput = {
  session: ProbeSession
  context: ProtocolScenarioContext
  pools: PoolDescriptor[]
  outcomes: readonly MediatedScenarioOutcome[]
  signal: AbortSignal
  budget: ProbeBudget
  maxHydrationRequests?: number
  onProgress?: (detail: string) => void
}

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
  budget: ProbeBudget
  label: string
  onProgress?: (detail: string) => void
  gasLimit?: bigint
  maxHydrationRequests?: number
}): Promise<ForkReplayResult> {
  if (input.signal.aborted) throw new DOMException('Public-hook runtime probes cancelled', 'AbortError')
  const timeRemaining = input.budget.deadline - Date.now()
  if (timeRemaining <= 0) throw new Error('The shared public-hook runtime probe time budget was exhausted.')
  if (input.budget.hydrationRequestsRemaining <= 0) {
    throw new Error('The shared public-hook runtime hydration budget was exhausted.')
  }
  const hydrationLimit = Math.min(
    input.maxHydrationRequests ?? input.budget.hydrationRequestsRemaining,
    input.budget.hydrationRequestsRemaining,
  )
  input.onProgress?.(input.label)
  const replay = await input.session.execute({
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
    timeoutMs: Math.min(PROBE_CALL_TIMEOUT_MS, timeRemaining),
    maxHydrationRequests: hydrationLimit,
    commit: false,
  })
  input.budget.hydrationRequestsRemaining = Math.max(
    0,
    input.budget.hydrationRequestsRemaining - replay.hydrationRequests,
  )
  return replay
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

async function introspectionProbes(input: RuntimeProbeInput): Promise<PublicHackenRuntimeProbe[]> {
  const { context } = input
  const base = { poolId: context.pool.poolId, hook: context.pool.hook }
  const erc165Calldata = encodeFunctionData({
    abi: SUPPORTS_INTERFACE_ABI,
    functionName: 'supportsInterface',
    args: ['0x01ffc9a7'],
  })
  const attempt = async (label: string, calldata: Hex) => {
    try {
      return {
        replay: await executeCall({
          ...input,
          to: context.pool.hook,
          calldata,
          label,
        }),
      }
    } catch (error) {
      if (input.signal.aborted) throw error
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  // These reads are intentionally isolated. An absent or slow optional getter
  // must not suppress evidence from the other selectors.
  const permissionAttempt = await attempt('getHookPermissions() response', GET_HOOK_PERMISSIONS_SELECTOR)
  const managerAttempt = await attempt('poolManager() response', POOL_MANAGER_SELECTOR)
  const erc165Attempt = await attempt('supportsInterface(bytes4) response', erc165Calldata)
  const permissionReplay = permissionAttempt.replay
  const managerReplay = managerAttempt.replay
  const erc165Replay = erc165Attempt.replay

  const returnedPermissions = permissionReplay?.proof.success
    ? decodePermissions(permissionReplay.proof.output)
    : undefined
  const expectedPermissions = new Set(decodeHookPermissions(context.pool.hook))
  const mismatchedPermissions = returnedPermissions
    ? HOOK_FLAGS.map(([permission]) => permission).filter((permission) =>
        returnedPermissions[permission] !== expectedPermissions.has(permission))
    : []
  const permissionStatus: PublicHackenRuntimeProbe['status'] = permissionAttempt.error
    ? 'error'
    : !returnedPermissions
      ? 'unavailable'
    : mismatchedPermissions.length
      ? 'failed'
      : 'passed'
  const permissionReason = permissionAttempt.error
    ? `The getHookPermissions() selector probe could not complete: ${permissionAttempt.error}`
    : !permissionReplay?.proof.success
      ? 'The getHookPermissions() selector reverted at the pinned block; the optional response was not treated as present.'
    : !returnedPermissions
      ? 'The getHookPermissions() selector did not return the canonical 14-boolean Hooks.Permissions shape.'
      : mismatchedPermissions.length
        ? `The canonical response to getHookPermissions() disagreed with the hook address bits for: ${mismatchedPermissions.join(', ')}.`
        : 'The canonical response to getHookPermissions() matched all 14 permission bits encoded in the hook address. This proves the selector response, not source-level getter dispatch.'

  const returnedManager = managerReplay?.proof.success
    ? decodeCanonicalAddress(managerReplay.proof.output)
    : undefined
  const managerMatches = returnedManager?.toLowerCase() === context.poolManager.toLowerCase()
  const managerStatus: PublicHackenRuntimeProbe['status'] = managerAttempt.error
    ? 'error'
    : !returnedManager
      ? 'unavailable'
    : managerMatches
      ? 'passed'
      : 'failed'
  const managerReason = managerAttempt.error
    ? `The poolManager() selector probe could not complete: ${managerAttempt.error}`
    : !managerReplay?.proof.success
      ? 'The poolManager() selector reverted at the pinned block; the optional response was not treated as present.'
    : !returnedManager
      ? 'The poolManager() selector did not return one canonical ABI-encoded address.'
      : managerMatches
        ? `The canonical response to poolManager() named the selected deployed PoolManager ${context.poolManager}. This proves the selector response, not source-level getter dispatch.`
        : `The canonical response to poolManager() named ${returnedManager}, not the selected deployed PoolManager ${context.poolManager}.`

  const interfaceSupport = erc165Replay?.proof.success
    ? decodeCanonicalBool(erc165Replay.proof.output)
    : undefined
  const interfaceReason = erc165Attempt.error
    ? `The supportsInterface(bytes4) selector probe could not complete: ${erc165Attempt.error}`
    : !erc165Replay?.proof.success
      ? 'The supportsInterface(bytes4) selector reverted at the pinned block; ERC-165 introspection is unavailable.'
    : interfaceSupport === undefined
      ? 'The supportsInterface(bytes4) selector did not return one canonical ABI boolean.'
      : `The canonical response to supportsInterface(0x01ffc9a7) was ${interfaceSupport}; this is recorded without claiming source-level ERC-165 implementation.`

  const gettersStatus: PublicHackenRuntimeProbe['status'] =
    permissionStatus === 'error' || managerStatus === 'error'
      ? 'error'
      : permissionStatus === 'failed' || managerStatus === 'failed'
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
      gasUsed: permissionReplay?.proof.gasUsed,
      scenarioIds: permissionReplay ? ['runtime:getHookPermissions'] : undefined,
      details: {
        selector: GET_HOOK_PERMISSIONS_SELECTOR,
        responseClassification: 'canonical-response',
        selectorDispatchProven: false,
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
      gasUsed: managerReplay?.proof.gasUsed,
      scenarioIds: managerReplay ? ['runtime:poolManager'] : undefined,
      details: {
        selector: POOL_MANAGER_SELECTOR,
        responseClassification: 'canonical-response',
        selectorDispatchProven: false,
        returnedManager,
        expectedManager: context.poolManager,
      },
    },
    {
      ...base,
      caseId: 'introspect-public-getters',
      status: gettersStatus,
      reason: gettersStatus === 'passed'
        ? 'Both selectors returned canonical values consistent with the selected hook and PoolManager; source-level getter dispatch was not inferred.'
        : gettersStatus === 'failed'
          ? 'A canonical selector response was inconsistent with the selected hook or PoolManager.'
          : gettersStatus === 'error'
            ? 'At least one public-selector probe could not complete inside the shared runtime budget.'
            : 'Both canonical public-selector response shapes could not be proven at the pinned block.',
      gasUsed: (permissionReplay?.proof.gasUsed ?? 0) + (managerReplay?.proof.gasUsed ?? 0) || undefined,
      scenarioIds: [
        ...(permissionReplay ? ['runtime:getHookPermissions'] : []),
        ...(managerReplay ? ['runtime:poolManager'] : []),
      ],
      details: { permissionStatus, managerStatus },
    },
    {
      ...base,
      caseId: 'introspect-optional-interface',
      status: erc165Attempt.error ? 'error' : interfaceSupport === undefined ? 'unavailable' : 'observed',
      reason: interfaceReason,
      gasUsed: erc165Replay?.proof.gasUsed,
      scenarioIds: erc165Replay ? ['runtime:supportsInterface:01ffc9a7'] : undefined,
      observedOutcome: erc165Replay ? erc165Replay.proof.success ? 'completed' : 'reverted' : undefined,
      details: {
        selector: erc165Calldata.slice(0, 10),
        responseClassification: 'canonical-response',
        selectorDispatchProven: false,
        interfaceId: '0x01ffc9a7',
        supported: interfaceSupport,
      },
    },
  ]
}

async function callbackAuthorizationProbe(input: RuntimeProbeInput): Promise<PublicHackenRuntimeProbe> {
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

  const mediatedScenarioIds = (callback: DirectCallback) => input.outcomes.flatMap((outcome) => {
    if (
      outcome.poolId.toLowerCase() !== context.pool.poolId.toLowerCase()
      || outcome.status !== 'completed'
      || !outcome.proof?.proof.success
    ) return []
    const managerMediated = outcome.proof.proof.calls.some((call) =>
      call.caller.toLowerCase() === context.poolManager.toLowerCase()
      && call.target.toLowerCase() === context.pool.hook.toLowerCase()
      && call.selector?.toLowerCase() === callback.selector.toLowerCase())
    return managerMediated ? [outcome.scenarioId] : []
  })
  const paired = callbacks.map((callback) => ({
    ...callback,
    mediatedScenarioIds: mediatedScenarioIds(callback),
  })).filter((callback) => callback.mediatedScenarioIds.length)
  const unpaired = callbacks.filter((callback) =>
    !paired.some((candidate) => candidate.permission === callback.permission))
  if (!paired.length) {
    return {
      ...base,
      status: 'unavailable',
      reason: 'No enabled callback had both a successful PoolManager-mediated execution and a comparable direct-call input at the pinned block. A direct revert alone is not treated as an authorization result.',
      details: {
        unpairedCallbacks: unpaired.map((callback) => ({
          permission: callback.permission,
          selector: callback.selector,
        })),
      },
    }
  }

  const observations: {
    permission: HookPermission
    selector: Hex
    outcome: 'reverted' | 'completed' | 'error'
    gasUsed?: number
    output?: Hex
    rejection?: 'not-pool-manager' | 'other'
    reason?: string
    executed: boolean
    mediatedScenarioIds: string[]
  }[] = []
  for (const callback of paired) {
    try {
      const replay = await executeCall({
        ...input,
        to: context.pool.hook,
        calldata: callback.calldata,
        label: `direct ${callback.permission} comparison`,
      })
      if (!enteredTarget(replay, context.pool.hook, callback.selector)) {
        observations.push({
          permission: callback.permission,
          selector: callback.selector,
          outcome: 'error',
          executed: true,
          mediatedScenarioIds: callback.mediatedScenarioIds,
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
        rejection: !replay.proof.success && replay.proof.output.slice(0, 10).toLowerCase() === NOT_POOL_MANAGER_SELECTOR
          ? 'not-pool-manager'
          : !replay.proof.success ? 'other' : undefined,
        executed: true,
        mediatedScenarioIds: callback.mediatedScenarioIds,
      })
    } catch (error) {
      if (input.signal.aborted) throw error
      observations.push({
        permission: callback.permission,
        selector: callback.selector,
        outcome: 'error',
        executed: false,
        mediatedScenarioIds: callback.mediatedScenarioIds,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const completed = observations.filter((item) => item.outcome === 'completed')
  const reverted = observations.filter((item) => item.outcome === 'reverted')
  const guarded = reverted.filter((item) => item.rejection === 'not-pool-manager')
  const errors = observations.filter((item) => item.outcome === 'error')
  const status: PublicHackenRuntimeProbe['status'] = errors.length
    ? 'error'
    : completed.length
      ? 'failed'
      : unpaired.length || guarded.length !== reverted.length
        ? 'observed'
        : 'passed'
  const reason = errors.length
      ? `${errors.length}/${observations.length} permission-selected direct callback probes did not produce a valid hook execution trace.`
    : completed.length
      ? `${completed.length}/${observations.length} callbacks that had completed through the PoolManager also completed when called directly by a non-PoolManager account.`
      : unpaired.length
        ? `${guarded.length}/${reverted.length} compared callback${reverted.length === 1 ? '' : 's'} returned the canonical NotPoolManager() rejection after completing through the PoolManager; ${unpaired.length} enabled callback${unpaired.length === 1 ? '' : 's'} lacked a successful mediated execution, so full callback compatibility was not asserted.`
        : guarded.length !== reverted.length
          ? `${reverted.length} callbacks completed through the PoolManager and rejected the direct call, but only ${guarded.length} returned the canonical NotPoolManager() error. Other reverts were recorded without attributing them to authorization.`
          : `All ${guarded.length} enabled callbacks first completed through the deployed PoolManager and then returned the canonical NotPoolManager() error to the direct caller. This is bounded execution compatibility, not an inference about every possible input or source-level guard.`

  return {
    ...base,
    status,
    reason,
    gasUsed: observations.reduce((sum, item) => sum + (item.gasUsed ?? 0), 0) || undefined,
    scenarioIds: observations
      .filter((item) => item.executed)
      .map((item) => `runtime:direct:${item.permission}`),
    observedOutcome: completed.length && reverted.length
      ? 'mixed'
      : completed.length
        ? 'completed'
        : 'reverted',
    details: {
      callbacks: observations,
      unpairedCallbacks: unpaired.map((callback) => ({
        permission: callback.permission,
        selector: callback.selector,
      })),
      expectedAuthorizationError: {
        selector: NOT_POOL_MANAGER_SELECTOR,
        signature: 'NotPoolManager()',
      },
    },
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

async function secondaryPoolProbe(input: RuntimeProbeInput): Promise<PublicHackenRuntimeProbe> {
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
      label: `secondary PoolId ${secondary.poolId.slice(0, 10)} swap`,
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
  outcomes?: readonly MediatedScenarioOutcome[]
  signal: AbortSignal
  timeoutMs?: number
  maxHydrationRequests?: number
  onProgress?: (detail: string) => void
}): Promise<PublicHackenRuntimeProbe[]> {
  const runtimeInput: RuntimeProbeInput = {
    ...input,
    outcomes: input.outcomes ?? [],
    budget: {
      deadline: Date.now() + Math.max(1, input.timeoutMs ?? DEFAULT_PROBE_BUDGET_MS),
      hydrationRequestsRemaining: Math.max(
        1,
        input.maxHydrationRequests ?? DEFAULT_PROBE_HYDRATION_BUDGET,
      ),
    },
  }
  const probes: PublicHackenRuntimeProbe[] = []
  probes.push(...await introspectionProbes(runtimeInput))
  probes.push(await callbackAuthorizationProbe(runtimeInput))
  probes.push(await secondaryPoolProbe(runtimeInput))
  return probes
}
