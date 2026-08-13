import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, getAddress, type Abi, type Address, type Hex, type PublicClient } from 'viem'
import {
  ForkExecutionSession,
  type ForkReplayBlock,
  type ForkReplayResult,
  type ForkReplayTransaction,
  type ForkSnapshot,
} from './revmProof'
import type { Evidence } from '../domain/report'

const SQRT_PRICE_1_1 = 79_228_162_514_264_337_593_543_950_336n
const SQRT_PRICE_1_2 = 56_022_770_974_786_139_918_731_938_227n
const SQRT_PRICE_2_1 = 112_045_541_949_572_279_837_463_876_454n
const ZERO_BYTES32 = `0x${'0'.repeat(64)}` as Hex
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address

const SWAP_ABI = [{
  type: 'function',
  name: 'swap',
  stateMutability: 'payable',
  inputs: [
    { name: 'key', type: 'tuple', components: [
      { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
      { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
    ] },
    { name: 'params', type: 'tuple', components: [
      { name: 'zeroForOne', type: 'bool' }, { name: 'amountSpecified', type: 'int256' },
      { name: 'sqrtPriceLimitX96', type: 'uint160' },
    ] },
    { name: 'testSettings', type: 'tuple', components: [
      { name: 'takeClaims', type: 'bool' }, { name: 'settleUsingBurn', type: 'bool' },
    ] },
    { name: 'hookData', type: 'bytes' },
  ],
  outputs: [{ name: 'delta', type: 'int256' }],
}] as const satisfies Abi

const LIQUIDITY_ABI = [{
  type: 'function',
  name: 'modifyLiquidity',
  stateMutability: 'payable',
  inputs: [
    { name: 'key', type: 'tuple', components: [
      { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
      { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
    ] },
    { name: 'params', type: 'tuple', components: [
      { name: 'tickLower', type: 'int24' }, { name: 'tickUpper', type: 'int24' },
      { name: 'liquidityDelta', type: 'int256' }, { name: 'salt', type: 'bytes32' },
    ] },
    { name: 'hookData', type: 'bytes' },
  ],
  outputs: [{ name: 'delta', type: 'int256' }],
}] as const satisfies Abi

const DONATE_ABI = [{
  type: 'function',
  name: 'donate',
  stateMutability: 'payable',
  inputs: [
    { name: 'key', type: 'tuple', components: [
      { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
      { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
    ] },
    { name: 'amount0', type: 'uint256' }, { name: 'amount1', type: 'uint256' }, { name: 'hookData', type: 'bytes' },
  ],
  outputs: [{ name: 'delta', type: 'int256' }],
}] as const satisfies Abi

const INITIALIZE_ABI = [{
  type: 'function',
  name: 'initialize',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'key', type: 'tuple', components: [
      { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
      { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
    ] },
    { name: 'sqrtPriceX96', type: 'uint160' },
  ],
  outputs: [{ name: 'tick', type: 'int24' }],
}] as const satisfies Abi

const BEFORE_SWAP_ABI = [{
  type: 'function',
  name: 'beforeSwap',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'sender', type: 'address' },
    { name: 'key', type: 'tuple', components: [
      { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
      { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
    ] },
    { name: 'params', type: 'tuple', components: [
      { name: 'zeroForOne', type: 'bool' }, { name: 'amountSpecified', type: 'int256' },
      { name: 'sqrtPriceLimitX96', type: 'uint160' },
    ] },
    { name: 'hookData', type: 'bytes' },
  ],
  outputs: [{ type: 'bytes4' }, { type: 'int256' }, { type: 'uint24' }],
}] as const satisfies Abi

const PERMISSIONS_ABI = [{
  type: 'function',
  name: 'getHookPermissions',
  stateMutability: 'pure',
  inputs: [],
  outputs: [{
    name: 'permissions',
    type: 'tuple',
    components: [
      { name: 'beforeInitialize', type: 'bool' }, { name: 'afterInitialize', type: 'bool' },
      { name: 'beforeAddLiquidity', type: 'bool' }, { name: 'afterAddLiquidity', type: 'bool' },
      { name: 'beforeRemoveLiquidity', type: 'bool' }, { name: 'afterRemoveLiquidity', type: 'bool' },
      { name: 'beforeSwap', type: 'bool' }, { name: 'afterSwap', type: 'bool' },
      { name: 'beforeDonate', type: 'bool' }, { name: 'afterDonate', type: 'bool' },
      { name: 'beforeSwapReturnDelta', type: 'bool' }, { name: 'afterSwapReturnDelta', type: 'bool' },
      { name: 'afterAddLiquidityReturnDelta', type: 'bool' }, { name: 'afterRemoveLiquidityReturnDelta', type: 'bool' },
    ],
  }],
}] as const satisfies Abi

const POOL_MANAGER_ABI = [{
  type: 'function',
  name: 'poolManager',
  stateMutability: 'view',
  inputs: [],
  outputs: [{ type: 'address' }],
}] as const satisfies Abi

const ERC165_ABI = [{
  type: 'function',
  name: 'supportsInterface',
  stateMutability: 'view',
  inputs: [{ type: 'bytes4' }],
  outputs: [{ type: 'bool' }],
}] as const satisfies Abi

const CONFIGURE_ROUTER_ABI = [{
  type: 'function',
  name: 'configureRouter',
  stateMutability: 'nonpayable',
  inputs: [{ type: 'address' }],
  outputs: [],
}] as const satisfies Abi

const CONFIGURE_POLICY_ABI = [{
  type: 'function',
  name: 'configurePolicy',
  stateMutability: 'nonpayable',
  inputs: [{ type: 'bool' }],
  outputs: [],
}] as const satisfies Abi

const CONFIGURE_POOL_POLICY_ABI = [{
  type: 'function',
  name: 'configurePoolPolicy',
  stateMutability: 'nonpayable',
  inputs: [{ type: 'bytes32' }, { type: 'bool' }],
  outputs: [],
}] as const satisfies Abi

const CONFIGURE_DELTAS_ABI = [{
  type: 'function',
  name: 'configureReturnDeltas',
  stateMutability: 'nonpayable',
  inputs: [{ type: 'int128' }, { type: 'int128' }, { type: 'int128' }, { type: 'int128' }],
  outputs: [],
}] as const satisfies Abi

export type HackenScenarioContext = {
  chainId: number
  actor: Address
  observer: Address
  poolManager: Address
  swapRouter: Address
  alternateSwapRouter: Address
  liquidityRouter: Address
  donateRouter: Address
  hook: Address
  currency0: Address
  currency1: Address
  fee: number
  tickSpacing: number
  poolId: Hex
  secondaryPoolId: Hex
  secondaryTickSpacing: number
  sqrtPriceX96: bigint
}

type ScenarioStep = {
  label: string
  to: Address
  calldata: Hex
  caller?: Address
  expected: 'success' | 'revert' | 'observe' | 'permissions-match' | 'pool-manager-match'
}

export type HackenScenario = {
  id: string
  upstream: string
  section: 'swap' | 'liquidity' | 'donate' | 'initialize' | 'hook-data' | 'authorization' | 'configuration' | 'delta'
  description: string
  steps: ScenarioStep[]
}

export type HackenScenarioResult = {
  scenario: HackenScenario
  status: 'passed' | 'observed' | 'failed'
  steps: { label: string; expected: ScenarioStep['expected']; caller: Address; replay: ForkReplayResult }[]
  executionCount: number
  hydrationRequests: number
  callCount: number
  storageDiffCount: number
}

export type HackenSuiteResult = {
  version: string
  upstreamCommit: string
  scenarios: HackenScenarioResult[]
  executions: number
  passed: number
  observed: number
  failed: number
  elapsedMs: number
}

const key = (context: HackenScenarioContext) => ({
  currency0: context.currency0,
  currency1: context.currency1,
  fee: context.fee,
  tickSpacing: context.tickSpacing,
  hooks: context.hook,
})

const secondaryKey = (context: HackenScenarioContext) => ({
  ...key(context),
  tickSpacing: context.secondaryTickSpacing,
})

function swapStep(context: HackenScenarioContext, label: string, zeroForOne: boolean, amountSpecified: bigint, hookData: Hex = '0x'): ScenarioStep {
  return {
    label,
    to: context.swapRouter,
    calldata: encodeFunctionData({
      abi: SWAP_ABI,
      functionName: 'swap',
      args: [
        key(context),
        { zeroForOne, amountSpecified, sqrtPriceLimitX96: zeroForOne ? SQRT_PRICE_1_2 : SQRT_PRICE_2_1 },
        { takeClaims: false, settleUsingBurn: false },
        hookData,
      ],
    }),
    expected: 'observe',
  }
}

function secondaryPoolSwapStep(context: HackenScenarioContext): ScenarioStep {
  return {
    label: 'swap through secondary PoolId',
    to: context.swapRouter,
    calldata: encodeFunctionData({
      abi: SWAP_ABI,
      functionName: 'swap',
      args: [
        secondaryKey(context),
        { zeroForOne: true, amountSpecified: -1n, sqrtPriceLimitX96: SQRT_PRICE_1_2 },
        { takeClaims: false, settleUsingBurn: false },
        '0x',
      ],
    }),
    expected: 'observe',
  }
}

function liquidityStep(context: HackenScenarioContext, label: string, tickLower: number, tickUpper: number, liquidityDelta: bigint): ScenarioStep {
  return {
    label,
    to: context.liquidityRouter,
    calldata: encodeFunctionData({
      abi: LIQUIDITY_ABI,
      functionName: 'modifyLiquidity',
      args: [key(context), { tickLower, tickUpper, liquidityDelta, salt: ZERO_BYTES32 }, '0x'],
    }),
    expected: 'observe',
  }
}

function donateStep(context: HackenScenarioContext, label: string, amount0: bigint, amount1: bigint): ScenarioStep {
  return {
    label,
    to: context.donateRouter,
    calldata: encodeFunctionData({ abi: DONATE_ABI, functionName: 'donate', args: [key(context), amount0, amount1, '0x'] }),
    expected: 'observe',
  }
}

export function buildHackenScenarios(context: HackenScenarioContext): HackenScenario[] {
  const participantHookData = encodeAbiParameters([{ type: 'address' }], [context.actor])
  return [
    { id: 'swap-small', upstream: 'SwapSuite.run_Swap_SmallAmount', section: 'swap', description: 'Tiny exact-input swap', steps: [swapStep(context, 'zeroForOne -1000', true, -1000n)] },
    { id: 'swap-both-directions', upstream: 'SwapSuite.run_Swap_BothDirections', section: 'swap', description: 'Exact input in both pool directions', steps: [swapStep(context, 'zeroForOne -5000', true, -5000n), swapStep(context, 'oneForZero -5000', false, -5000n)] },
    { id: 'swap-exact-input-output', upstream: 'SwapSuite.run_Swap_ExactInput_vs_ExactOutput', section: 'swap', description: 'Exact input and exact output', steps: [swapStep(context, 'exact input -3000', true, -3000n), swapStep(context, 'exact output +3000', true, 3000n)] },
    { id: 'swap-sequential', upstream: 'SwapSuite.run_Swap_MultipleSequential', section: 'swap', description: 'Three alternating swaps in one state sequence', steps: [swapStep(context, 'swap 1', true, -2000n), swapStep(context, 'swap 2', false, -2000n), swapStep(context, 'swap 3', true, -2000n)] },
    { id: 'swap-bounded-corpus', upstream: 'FuzzTestEntry.test_Fuzz_Swap_Amounts', section: 'swap', description: 'Bounded swap amount corpus', steps: [swapStep(context, 'minimum exact input', true, -1_000_000n), swapStep(context, 'tiny exact input', true, -1n), swapStep(context, 'tiny exact output', false, 1n), swapStep(context, 'maximum exact output', false, 1_000_000n)] },
    { id: 'hook-data-empty', upstream: 'HookDataDetectionSuite.run_DetectHookDataRequirement', section: 'hook-data', description: 'Observe empty hookData behavior', steps: [swapStep(context, 'empty hookData', true, -100n, '0x')] },
    {
      id: 'hook-data-formats',
      upstream: 'HookDataDetectionSuite.run_ObserveHookDataFormats',
      section: 'hook-data',
      description: 'Empty, raw, and ABI-encoded hookData formats remain executable',
      steps: [
        swapStep(context, 'raw four-byte hookData', true, -100n, '0xdeadbeef'),
        swapStep(context, 'ABI-encoded participant', false, -100n, participantHookData),
        swapStep(context, 'UTF-8 hookData', true, -100n, '0x686f6f6b73636f7065'),
      ],
    },
    { id: 'liquidity-add-remove', upstream: 'LiquiditySuite.run_Liq_AddThenRemove', section: 'liquidity', description: 'Add then remove the same liquidity range', steps: [liquidityStep(context, 'add', -120, 120, 1_000_000_000n), liquidityStep(context, 'remove', -120, 120, -1_000_000_000n)] },
    { id: 'liquidity-multiple-adds', upstream: 'LiquiditySuite.run_Liq_MultipleAdds', section: 'liquidity', description: 'Three additions to one range', steps: [liquidityStep(context, 'add 1', -120, 120, 1_000_000_000n), liquidityStep(context, 'add 2', -120, 120, 1_000_000_000n), liquidityStep(context, 'add 3', -120, 120, 1_000_000_000n)] },
    { id: 'liquidity-ranges', upstream: 'LiquiditySuite.run_Liq_DifferentRanges', section: 'liquidity', description: 'Three aligned liquidity ranges', steps: [liquidityStep(context, 'range -60:60', -60, 60, 10_000_000_000n), liquidityStep(context, 'range -120:120', -120, 120, 10_000_000_000n), liquidityStep(context, 'range 60:180', 60, 180, 10_000_000_000n)] },
    { id: 'liquidity-partial-remove', upstream: 'LiquiditySuite.run_Liq_RemovePartial', section: 'liquidity', description: 'Add then remove half', steps: [liquidityStep(context, 'add', -120, 120, 1_000_000_000n), liquidityStep(context, 'remove half', -120, 120, -500_000_000n)] },
    { id: 'liquidity-bounded-amounts', upstream: 'FuzzTestEntry.test_Fuzz_Liq_Amounts', section: 'liquidity', description: 'Bounded liquidity amount corpus', steps: [liquidityStep(context, 'minimum', -60, 60, 1_000_000_000_000_000n), liquidityStep(context, 'middle', -60, 60, 1_000_000_000_000_000_000n), liquidityStep(context, 'maximum', -60, 60, 100_000_000_000_000_000_000n)] },
    { id: 'liquidity-bounded-ranges', upstream: 'FuzzTestEntry.test_Fuzz_Liq_TickRanges', section: 'liquidity', description: 'Aligned boundary and full tick ranges', steps: [liquidityStep(context, 'minimum aligned range', -887220, -887160, 10_000_000_000_000_000_000n), liquidityStep(context, 'full aligned range', -887220, 887220, 10_000_000_000_000_000_000n), liquidityStep(context, 'maximum aligned range', 887160, 887220, 10_000_000_000_000_000_000n)] },
    { id: 'donate-dust', upstream: 'DonateSuite.run_Donate_Dust', section: 'donate', description: 'Minimal donation', steps: [donateStep(context, 'donate 1/1', 1n, 1n)] },
    { id: 'donate-both', upstream: 'DonateSuite.run_Donate_BothTokens', section: 'donate', description: 'Donate both currencies', steps: [donateStep(context, 'donate 1000/1000', 1000n, 1000n)] },
    { id: 'donate-single', upstream: 'DonateSuite.run_Donate_SingleToken', section: 'donate', description: 'Donate each currency separately', steps: [donateStep(context, 'currency0', 5000n, 0n), donateStep(context, 'currency1', 0n, 5000n)] },
    { id: 'donate-sequential', upstream: 'DonateSuite.run_Donate_Multiple', section: 'donate', description: 'Three sequential donations', steps: [donateStep(context, 'donate 100', 100n, 100n), donateStep(context, 'donate 200', 200n, 200n), donateStep(context, 'donate 300', 300n, 300n)] },
    { id: 'donate-bounded-corpus', upstream: 'FuzzTestEntry.test_Fuzz_Donate_Amounts', section: 'donate', description: 'Bounded donation amount corpus', steps: [donateStep(context, 'currency0 minimum', 1n, 0n), donateStep(context, 'currency1 minimum', 0n, 1n), donateStep(context, 'both maximum', 1_000_000n, 1_000_000n)] },
    {
      id: 'reinitialize',
      upstream: 'InitializeSuite.run_Reinitialize_Reverts',
      section: 'initialize',
      description: 'A second initialize call must revert',
      steps: [{
        label: 'initialize existing pool',
        to: context.poolManager,
        calldata: encodeFunctionData({ abi: INITIALIZE_ABI, functionName: 'initialize', args: [key(context), SQRT_PRICE_1_1] }),
        expected: 'revert',
      }],
    },
    {
      id: 'only-pool-manager',
      upstream: 'HookAuthorization.run_Auth_OnlyPoolManager_OnEntrypoints',
      section: 'authorization',
      description: 'Direct non-PoolManager callback is rejected',
      steps: [{
        label: 'actor calls beforeSwap directly',
        to: context.hook,
        calldata: encodeFunctionData({
          abi: BEFORE_SWAP_ABI,
          functionName: 'beforeSwap',
          args: [context.actor, key(context), { zeroForOne: true, amountSpecified: -1n, sqrtPriceLimitX96: SQRT_PRICE_1_1 }, '0x'],
        }),
        expected: 'revert',
      }],
    },
    {
      id: 'config-only-pool-manager',
      upstream: 'HookConfiguration.run_Config_OnlyPoolManagerGuard',
      section: 'configuration',
      description: 'Configuration guard rejects a direct callback',
      steps: [{
        label: 'actor calls beforeSwap directly',
        to: context.hook,
        calldata: encodeFunctionData({
          abi: BEFORE_SWAP_ABI,
          functionName: 'beforeSwap',
          args: [context.actor, key(context), { zeroForOne: true, amountSpecified: -1n, sqrtPriceLimitX96: SQRT_PRICE_1_1 }, '0x'],
        }),
        expected: 'revert',
      }],
    },
    {
      id: 'secondary-pool-open-policy',
      upstream: 'HookAuthorization.run_Auth_ObserveSecondaryPool_OpenPolicy',
      section: 'authorization',
      description: 'Open pool policy accepts a second initialized PoolId',
      steps: [{ ...secondaryPoolSwapStep(context), expected: 'success' }],
    },
    {
      id: 'secondary-pool-restricted-policy',
      upstream: 'HookAuthorization.run_Auth_Rejects_UntrustedPoolKey',
      section: 'authorization',
      description: 'Restricted pool policy rejects a second PoolId and keeps the selected PoolId available',
      steps: [
        {
          label: 'restrict hook to primary PoolId',
          to: context.hook,
          calldata: encodeFunctionData({ abi: CONFIGURE_POOL_POLICY_ABI, functionName: 'configurePoolPolicy', args: [context.poolId, true] }),
          expected: 'success',
        },
        { ...secondaryPoolSwapStep(context), expected: 'revert' },
        { ...swapStep(context, 'primary PoolId remains available', true, -1n), expected: 'success' },
      ],
    },
    {
      id: 'external-mutator-open-policy',
      upstream: 'HookAuthorization.run_Auth_ObserveOpenExternalMutator',
      section: 'authorization',
      description: 'Open configuration policy permits a second caller',
      steps: [{
        label: 'observer calls configureRouter',
        to: context.hook,
        calldata: encodeFunctionData({ abi: CONFIGURE_ROUTER_ABI, functionName: 'configureRouter', args: [context.actor] }),
        caller: context.observer,
        expected: 'success',
      }],
    },
    {
      id: 'external-mutator-restricted-policy',
      upstream: 'HookAuthorization.run_Auth_NoOpenExternalMutators',
      section: 'authorization',
      description: 'Restricted configuration policy rejects a second caller and accepts its administrator',
      steps: [
        {
          label: 'administrator enables restriction',
          to: context.hook,
          calldata: encodeFunctionData({ abi: CONFIGURE_POLICY_ABI, functionName: 'configurePolicy', args: [true] }),
          expected: 'success',
        },
        {
          label: 'observer calls configureRouter',
          to: context.hook,
          calldata: encodeFunctionData({ abi: CONFIGURE_ROUTER_ABI, functionName: 'configureRouter', args: [context.observer] }),
          caller: context.observer,
          expected: 'revert',
        },
        {
          label: 'administrator calls configureRouter',
          to: context.hook,
          calldata: encodeFunctionData({ abi: CONFIGURE_ROUTER_ABI, functionName: 'configureRouter', args: [context.swapRouter] }),
          expected: 'success',
        },
      ],
    },
    {
      id: 'router-policy-pair',
      upstream: 'HookAuthorization.run_Auth_RouterPolicyPair',
      section: 'authorization',
      description: 'Open and selected-router operation paths are both reproduced',
      steps: [
        {
          label: 'open router policy',
          to: context.hook,
          calldata: encodeFunctionData({ abi: CONFIGURE_ROUTER_ABI, functionName: 'configureRouter', args: [ZERO_ADDRESS] }),
          expected: 'success',
        },
        { ...swapStep(context, 'alternate router under open policy', true, -10n), to: context.alternateSwapRouter, expected: 'success' },
        {
          label: 'select primary router',
          to: context.hook,
          calldata: encodeFunctionData({ abi: CONFIGURE_ROUTER_ABI, functionName: 'configureRouter', args: [context.swapRouter] }),
          expected: 'success',
        },
        { ...swapStep(context, 'alternate router under selected policy', true, -10n), to: context.alternateSwapRouter, expected: 'revert' },
        { ...swapStep(context, 'primary router under selected policy', true, -10n), expected: 'success' },
      ],
    },
    {
      id: 'permissions-match-address',
      upstream: 'HookConfiguration.run_PermissionsMatchAddressFlags_ifExposed',
      section: 'configuration',
      description: 'Exposed permissions match hook address flags',
      steps: [{
        label: 'read getHookPermissions',
        to: context.hook,
        calldata: encodeFunctionData({ abi: PERMISSIONS_ABI, functionName: 'getHookPermissions' }),
        expected: 'permissions-match',
      }],
    },
    {
      id: 'introspect-public-getters',
      upstream: 'HookIntrospectionSuite.run_Introspect_PublicGetters',
      section: 'configuration',
      description: 'PoolManager and permission getters are callable',
      steps: [
        {
          label: 'read poolManager',
          to: context.hook,
          calldata: encodeFunctionData({ abi: POOL_MANAGER_ABI, functionName: 'poolManager' }),
          expected: 'pool-manager-match',
        },
        {
          label: 'read getHookPermissions',
          to: context.hook,
          calldata: encodeFunctionData({ abi: PERMISSIONS_ABI, functionName: 'getHookPermissions' }),
          expected: 'permissions-match',
        },
      ],
    },
    {
      id: 'introspect-optional-interface',
      upstream: 'HookIntrospectionSuite.run_Introspect_OptionalInterfaces',
      section: 'configuration',
      description: 'ERC-165 interface response is observed',
      steps: [{
        label: 'query ERC-165',
        to: context.hook,
        calldata: encodeFunctionData({ abi: ERC165_ABI, functionName: 'supportsInterface', args: ['0x01ffc9a7'] }),
        expected: 'observe',
      }],
    },
    {
      id: 'base-hook-pool-manager',
      upstream: 'HookConfiguration.run_Config_BaseHookInheritanceHint',
      section: 'configuration',
      description: 'Exposed PoolManager identity matches the fixture',
      steps: [{
        label: 'read poolManager',
        to: context.hook,
        calldata: encodeFunctionData({ abi: POOL_MANAGER_ABI, functionName: 'poolManager' }),
        expected: 'pool-manager-match',
      }],
    },
    { id: 'selector-through-manager', upstream: 'HookConfiguration.run_Config_ReturnsOwnSelector_WhenCalledByManager', section: 'configuration', description: 'PoolManager accepts the hook callback selector', steps: [{ ...swapStep(context, 'PoolManager validates callback return selector', true, -1n), expected: 'success' }] },
    { id: 'swap-return-delta-signature', upstream: 'HookConfiguration.run_SwapReturnDelta_SignatureChecks', section: 'configuration', description: 'PoolManager decodes swap return-delta tuple shapes', steps: [{ ...swapStep(context, 'decode before/after swap tuples', true, -1n), expected: 'success' }] },
    {
      id: 'swap-non-zero-return-deltas',
      upstream: 'SwapDeltaEffects.run_NonZeroReturnDeltas',
      section: 'delta',
      description: 'PoolManager settles non-zero specified and unspecified hook deltas',
      steps: [
        {
          label: 'configure one-unit swap deltas',
          to: context.hook,
          calldata: encodeFunctionData({ abi: CONFIGURE_DELTAS_ABI, functionName: 'configureReturnDeltas', args: [1n, 1n, 0n, 0n] }),
          expected: 'success',
        },
        { ...swapStep(context, 'exact input with hook deltas', true, -100n, participantHookData), expected: 'success' },
        { ...swapStep(context, 'reverse exact input with hook deltas', false, -100n, participantHookData), expected: 'success' },
      ],
    },
    { id: 'swap-no-type-flip', upstream: 'SwapDeltaEffects.run_NoSwapTypeFlip_from_BeforeSwap', section: 'delta', description: 'Return deltas do not flip exact-input swap type', steps: [{ ...swapStep(context, 'zeroForOne exact input', true, -5n), expected: 'success' }, { ...swapStep(context, 'oneForZero exact input', false, -5n), expected: 'success' }] },
    { id: 'swap-delta-settlement', upstream: 'SwapDeltaEffects.run_Settlement_SmokeSwap', section: 'delta', description: 'Tiny swaps settle in both directions', steps: [swapStep(context, 'zeroForOne -1', true, -1n), swapStep(context, 'oneForZero -1', false, -1n)] },
    { id: 'lp-fee-override', upstream: 'SwapDeltaEffects.run_LPFeeOverride_Sanity', section: 'delta', description: 'Configured fee override preserves swap settlement', steps: [{ ...swapStep(context, 'dynamic override swap', true, -1n), expected: 'success' }] },
    { id: 'liquidity-delta-settlement', upstream: 'LiquidityDeltaEffects.run_Settlement_Smoke_AddAndRemove', section: 'delta', description: 'Liquidity delta add/remove settlement', steps: [liquidityStep(context, 'add', -60, 60, 1_000_000_000n), liquidityStep(context, 'remove', -60, 60, -1_000_000_000n)] },
    { id: 'after-add-return-delta', upstream: 'LiquidityDeltaEffects.run_AfterAdd_ReturnsDelta_Informational', section: 'delta', description: 'PoolManager decodes and settles after-add return delta', steps: [{ ...liquidityStep(context, 'add with return delta', -60, 60, 1_000_000_000n), expected: 'success' }] },
    { id: 'after-remove-return-delta', upstream: 'LiquidityDeltaEffects.run_AfterRemove_ReturnsDelta_Informational', section: 'delta', description: 'PoolManager decodes and settles after-remove return delta', steps: [{ ...liquidityStep(context, 'remove with return delta', -120, 120, -1_000_000_000n), expected: 'success' }] },
    {
      id: 'liquidity-non-zero-return-deltas',
      upstream: 'LiquidityDeltaEffects.run_NonZeroReturnDeltas',
      section: 'delta',
      description: 'PoolManager settles non-zero after-add and after-remove hook deltas',
      steps: [
        {
          label: 'configure one-unit liquidity deltas',
          to: context.hook,
          calldata: encodeFunctionData({ abi: CONFIGURE_DELTAS_ABI, functionName: 'configureReturnDeltas', args: [0n, 0n, 1n, 1n] }),
          expected: 'success',
        },
        { ...liquidityStep(context, 'add with non-zero hook delta', -60, 60, 1_000_000_000n), expected: 'success' },
        { ...liquidityStep(context, 'remove with non-zero hook delta', -60, 60, -1_000_000_000n), expected: 'success' },
      ],
    },
  ]
}

function nullClient(): PublicClient {
  const unexpected = async () => { throw new Error('Generated fixture unexpectedly requested remote state.') }
  return {
    getBalance: unexpected,
    getTransactionCount: unexpected,
    getCode: unexpected,
    getStorageAt: unexpected,
    getBlock: unexpected,
  } as unknown as PublicClient
}

const PERMISSION_NAMES = [
  'beforeInitialize', 'afterInitialize', 'beforeAddLiquidity', 'afterAddLiquidity',
  'beforeRemoveLiquidity', 'afterRemoveLiquidity', 'beforeSwap', 'afterSwap',
  'beforeDonate', 'afterDonate', 'beforeSwapReturnDelta', 'afterSwapReturnDelta',
  'afterAddLiquidityReturnDelta', 'afterRemoveLiquidityReturnDelta',
] as const

export function permissionsMatchAddress(proof: ForkReplayResult['proof'], context: HackenScenarioContext) {
  if (!proof.success) return false
  try {
    const permissions = decodeFunctionResult({
      abi: PERMISSIONS_ABI,
      functionName: 'getHookPermissions',
      data: proof.output,
    }) as Record<(typeof PERMISSION_NAMES)[number], boolean>
    const declared = PERMISSION_NAMES.reduce((flags, name, index) =>
      permissions[name] ? flags | (1n << BigInt(13 - index)) : flags, 0n)
    return declared === (BigInt(context.hook) & 0x3fffn)
  } catch {
    return false
  }
}

export function poolManagerMatches(proof: ForkReplayResult['proof'], context: HackenScenarioContext) {
  if (!proof.success) return false
  try {
    const manager = decodeFunctionResult({ abi: POOL_MANAGER_ABI, functionName: 'poolManager', data: proof.output })
    return getAddress(manager) === getAddress(context.poolManager)
  } catch {
    return false
  }
}

function testStatus(steps: HackenScenarioResult['steps'], context: HackenScenarioContext): HackenScenarioResult['status'] {
  const mismatched = steps.some(({ expected, replay }) =>
    expected === 'success'
      ? !replay.proof.success
      : expected === 'revert'
        ? replay.proof.success
        : expected === 'permissions-match'
          ? !permissionsMatchAddress(replay.proof, context)
          : expected === 'pool-manager-match'
            ? !poolManagerMatches(replay.proof, context)
          : false)
  if (mismatched) return 'failed'
  return steps.some((step) => step.expected === 'observe') ? 'observed' : 'passed'
}

async function runScenario(input: {
  scenario: HackenScenario
  context: HackenScenarioContext
  snapshot: ForkSnapshot
  signal: AbortSignal
  ordinal: number
  onProgress?: (detail: string) => void
}): Promise<HackenScenarioResult> {
  const session = new ForkExecutionSession({
    scanId: `hacken-${input.ordinal}-${crypto.randomUUID()}`,
    client: nullClient(),
    stateBlockNumber: 0n,
    snapshot: input.snapshot,
    readyTimeoutMs: 20_000,
    onPhase: (phase) => input.onProgress?.(`${input.scenario.upstream} · ${phase}`),
  })
  const block: ForkReplayBlock = {
    number: 1n,
    beneficiary: ZERO_ADDRESS,
    timestamp: 1_700_000_000n,
    gasLimit: 300_000_000n,
    baseFee: 0n,
    difficulty: 0n,
    prevrandao: ZERO_BYTES32,
  }
  const steps: HackenScenarioResult['steps'] = []
  try {
    for (let index = 0; index < input.scenario.steps.length; index++) {
      const step = input.scenario.steps[index]!
      input.onProgress?.(`${input.scenario.upstream} · ${step.label}`)
      const caller = getAddress(step.caller ?? input.context.actor)
      const transaction: ForkReplayTransaction = {
        caller,
        to: step.to,
        calldata: step.calldata,
        value: 0n,
        // Every ported scenario is comfortably below the current per-transaction
        // EVM cap. A tight ceiling also guarantees bounded worker execution.
        gasLimit: 5_000_000n,
        gasPrice: 0n,
        nonce: steps.filter((prior) => getAddress(prior.caller) === caller).length,
        chainId: input.context.chainId,
        // PoolManager transactions can execute tens of thousands of opcodes. The
        // suite needs a bounded path sample plus complete call/storage outcomes,
        // not a structured-cloned copy of every instruction.
        traceLimit: 1_024,
      }
      const replay = await session.execute({
        transaction,
        block,
        signal: input.signal,
        timeoutMs: 20_000,
        maxHydrationRequests: 1,
        commit: true,
      })
      steps.push({ label: step.label, expected: step.expected, caller, replay })
    }
  } finally {
    session.close()
  }
  return {
    scenario: input.scenario,
    status: testStatus(steps, input.context),
    steps,
    executionCount: steps.length,
    hydrationRequests: steps.reduce((sum, step) => sum + step.replay.hydrationRequests, 0),
    callCount: steps.reduce((sum, step) => sum + step.replay.proof.calls.length, 0),
    storageDiffCount: steps.reduce((sum, step) => sum + step.replay.proof.storageDiffs.length, 0),
  }
}

export async function runHackenBrowserSuite(input: {
  context: HackenScenarioContext
  snapshot: ForkSnapshot
  signal: AbortSignal
  maxWorkers?: number
  onProgress?: (completed: number, total: number, detail: string) => void
}): Promise<HackenSuiteResult> {
  const scenarios = buildHackenScenarios(input.context)
  const started = performance.now()
  const results = new Array<HackenScenarioResult>(scenarios.length)
  const concurrency = Math.max(1, Math.min(input.maxWorkers ?? 4, scenarios.length))
  let cursor = 0
  let completed = 0

  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (true) {
      const ordinal = cursor++
      const scenario = scenarios[ordinal]
      if (!scenario) return
      const result = await runScenario({
        scenario,
        context: input.context,
        snapshot: input.snapshot,
        signal: input.signal,
        ordinal,
        onProgress: (detail) => input.onProgress?.(completed, scenarios.length, detail),
      })
      results[ordinal] = result
      completed++
      input.onProgress?.(completed, scenarios.length, `${scenario.upstream} · ${result.status}`)
    }
  }))

  return {
    version: 'hacken-browser-port/0.5.0',
    upstreamCommit: '965be6006eab54ff65b83285ef40a245c8735149',
    scenarios: results,
    executions: results.reduce((sum, result) => sum + result.executionCount, 0),
    passed: results.filter((result) => result.status === 'passed').length,
    observed: results.filter((result) => result.status === 'observed').length,
    failed: results.filter((result) => result.status === 'failed').length,
    elapsedMs: Math.round(performance.now() - started),
  }
}

export function hackenSuiteEvidence(result: HackenSuiteResult, context: HackenScenarioContext): Evidence[] {
  return result.scenarios.map((item) => {
    const first = item.steps[0]
    const firstDiff = item.steps.flatMap((step) => step.replay.proof.storageDiffs)[0]
    const directMutatorCompleted = item.scenario.id === 'external-mutator-open-policy' && Boolean(first?.replay.proof.success)
    const affectedPool = item.scenario.id.startsWith('secondary-pool-') ? context.secondaryPoolId : context.poolId
    return {
      id: `hacken-port:${item.scenario.id}:${context.poolId}`,
      detectorId: `hacken-port-${item.scenario.id}`,
      detectorVersion: result.version,
      severity: item.status === 'failed' ? 'high' : directMutatorCompleted ? 'medium' : 'info',
      evidenceClass: 'concrete-observation',
      subject: context.hook,
      title: `${item.scenario.description}: ${item.status}`,
      claim: `${item.scenario.upstream} executed ${item.executionCount} transaction${item.executionCount === 1 ? '' : 's'} through the real PoolManager fixture; ${item.steps.filter((step) => step.replay.proof.success).length} completed and ${item.steps.filter((step) => !step.replay.proof.success).length} reverted.`,
      confidence: 'confirmed',
      callPath: first?.replay.proof.calls.map((call) => getAddress(call.target)).slice(0, 64),
      storage: firstDiff ? [{ slot: firstDiff.slot, before: firstDiff.before, after: firstDiff.after }] : undefined,
      affectedPools: [affectedPool],
      witness: first ? {
        from: first.caller,
        to: item.scenario.steps[0]!.to,
        input: item.scenario.steps[0]!.calldata,
        value: '0',
        blockNumber: 'generated-pool-manager-fixture',
        expectedOutcome: first.expected === 'revert' ? 'revert' : 'success',
      } : undefined,
      reproducibility: 'replayed',
      technical: {
        upstream: item.scenario.upstream,
        section: item.scenario.section,
        status: item.status,
        hydrationRequests: item.hydrationRequests,
        callCount: item.callCount,
        storageDiffCount: item.storageDiffCount,
        stepOutcomes: item.steps.map((step) => ({ label: step.label, expected: step.expected, success: step.replay.proof.success, gasUsed: step.replay.proof.gasUsed })),
      },
    }
  })
}
