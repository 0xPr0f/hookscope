import { describe, expect, it, vi } from 'vitest'
import {
  bytesToHex,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { V4_ACTIONS, decodeUniswapV4Calldata, locateUniswapV4Operations } from '../adapters/uniswapV4RouterCodec'
import { computePoolId } from '../adapters/uniswapV4Pool'
import type { PoolDescriptor } from '../domain/report'
import type { LivePoolReplayCoverage } from './livePoolReplay'
import { buildLiveRouterScenarios, runLiveRouterScenarios } from './liveRouterScenarios'
import type { ForkExecutionSession, ForkReplayResult } from './revmProof'

const CURRENCY0 = '0x0000000000000000000000000000000000000000' as Address
const CURRENCY1 = '0x1111111111111111111111111111111111111111' as Address
const HOOK = '0x2222222222222222222222222222222222222222' as Address
const ACTOR = '0x3333333333333333333333333333333333333333' as Address
const ROUTER = '0x4444444444444444444444444444444444444444' as Address
const POSITION_MANAGER = '0x7777777777777777777777777777777777777777' as Address
const MANAGER = '0x5555555555555555555555555555555555555555' as Address
const ZERO_BYTES32 = `0x${'0'.repeat(64)}` as Hex

const POOL_KEY_COMPONENTS = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
] as const
const POOL_KEY_PARAMETER = { name: 'poolKey', type: 'tuple', components: POOL_KEY_COMPONENTS } as const
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
const ACTION_PLAN_PARAMETERS = [{ type: 'bytes' }, { type: 'bytes[]' }] as const
const EXECUTE_ABI = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable'])
const MODIFY_LIQUIDITIES_ABI = parseAbi(['function modifyLiquidities(bytes unlockData, uint256 deadline) payable'])
const MODIFY_LIQUIDITY_PARAMETERS = [
  { name: 'tokenId', type: 'uint256' },
  { name: 'liquidity', type: 'uint128' },
  { name: 'amount0Limit', type: 'uint128' },
  { name: 'amount1Limit', type: 'uint128' },
  { name: 'hookData', type: 'bytes' },
] as const

const poolKey = { currency0: CURRENCY0, currency1: CURRENCY1, fee: 3_000, tickSpacing: 60, hooks: HOOK }
const poolId = computePoolId({ currency0: CURRENCY0, currency1: CURRENCY1, fee: 3_000, tickSpacing: 60, hook: HOOK })
const pool: PoolDescriptor = {
  poolId,
  currency0: CURRENCY0,
  currency1: CURRENCY1,
  fee: 3_000,
  tickSpacing: 60,
  hook: HOOK,
  initializedAtBlock: '9',
  activity: 1,
}

function routerCalldata(): Hex {
  const swap = encodeAbiParameters(SINGLE_IN_PARAMETERS, [{
    poolKey,
    zeroForOne: true,
    amountIn: 100n,
    amountOutMinimum: 5n,
    hookData: '0x1234',
  }])
  const settle = '0xfeed' as Hex
  const plan = encodeAbiParameters(ACTION_PLAN_PARAMETERS, [
    bytesToHex(new Uint8Array([V4_ACTIONS.SWAP_EXACT_IN_SINGLE, 0x0f])),
    [swap, settle],
  ])
  return encodeFunctionData({
    abi: EXECUTE_ABI,
    functionName: 'execute',
    args: ['0x1002', [plan, '0xcafebabe'], 1_000n],
  })
}

function nestedSwapCalldata(): Hex {
  const swap = encodeAbiParameters(SINGLE_IN_PARAMETERS, [{
    poolKey,
    zeroForOne: true,
    amountIn: 100n,
    amountOutMinimum: 5n,
    hookData: '0x1234',
  }])
  const v4Plan = encodeAbiParameters(ACTION_PLAN_PARAMETERS, [
    bytesToHex(new Uint8Array([V4_ACTIONS.SWAP_EXACT_IN_SINGLE])),
    [swap],
  ])
  const subplan = encodeAbiParameters(ACTION_PLAN_PARAMETERS, ['0x10', [v4Plan]])
  return encodeFunctionData({
    abi: EXECUTE_ABI,
    functionName: 'execute',
    args: ['0x21', [subplan], 1_000n],
  })
}

function positionManagerCalldata(): Hex {
  const modify = encodeAbiParameters(MODIFY_LIQUIDITY_PARAMETERS, [42n, 100n, 5n, 6n, '0x1234'])
  const plan = encodeAbiParameters(ACTION_PLAN_PARAMETERS, [
    bytesToHex(new Uint8Array([V4_ACTIONS.INCREASE_LIQUIDITY])),
    [modify],
  ])
  return encodeFunctionData({
    abi: MODIFY_LIQUIDITIES_ABI,
    functionName: 'modifyLiquidities',
    args: [plan, 1_000n],
  })
}

function nestedPositionManagerCalldata(): Hex {
  return encodeFunctionData({
    abi: EXECUTE_ABI,
    functionName: 'execute',
    args: ['0x14', [positionManagerCalldata()], 1_000n],
  })
}

function replayResult(success = true): ForkReplayResult {
  return {
    hydrationRequests: 0,
    hydratedAccounts: 6,
    hydratedStorageSlots: 0,
    proof: {
      engine: 'revm/36.0.0',
      success,
      gasUsed: 10,
      output: '0x',
      steps: [],
      storageOperations: [],
      calls: [],
      storageDiffs: [],
      balanceChanges: [],
      logs: [],
      logCount: 0,
      selfdestructs: [],
      truncated: false,
    },
  }
}

function replayCoverage(
  calldata: Hex,
  options: { kind?: 'swap' | 'modify-liquidity'; to?: Address } = {},
): LivePoolReplayCoverage {
  const kind = options.kind ?? 'swap'
  return {
    status: 'passed',
    selectedPools: 1,
    candidateTransactions: 1,
    passedTransactions: 1,
    failedTransactions: 0,
    coveredPools: 1,
    findings: [],
    hydrationRequests: 0,
    limitations: [],
    outcomes: [{
      poolId,
      hook: HOOK,
      kind,
      transactionHash: ZERO_BYTES32,
      status: 'passed',
      replay: replayResult(),
      candidate: {
        kind,
        poolId,
        transactionHash: ZERO_BYTES32,
        stateBlockNumber: 9n,
        transaction: {
          caller: ACTOR,
          to: options.to ?? ROUTER,
          calldata,
          value: 7n,
          gasLimit: 1_000_000n,
          gasPrice: 0n,
          nonce: 0,
          chainId: 1,
        },
        block: {
          number: 10n,
          beneficiary: CURRENCY0,
          timestamp: 100n,
          gasLimit: 30_000_000n,
          baseFee: 0n,
          difficulty: 0n,
        },
        expected: { success: true, gasUsed: 10n, logCount: 0 },
      },
    }],
  }
}

describe('live official-router scenarios', () => {
  it('changes one controlled operation while preserving the router envelope and settlement bytes', () => {
    const calldata = routerCalldata()
    const variants = buildLiveRouterScenarios(pool, calldata)
    expect(variants.map((variant) => variant.mutation).sort()).toEqual([
      'flipped-direction',
      'hook-data-empty',
      'hook-data-marker',
      'smaller-amount',
    ])
    for (const variant of variants) {
      const decoded = decodeUniswapV4Calldata(variant.calldata)
      expect(decoded?.kind).toBe('universal-router')
      if (!decoded || decoded.kind !== 'universal-router') throw new Error('Expected Universal Router calldata.')
      expect(decoded.commands).toBe('0x1002')
      expect(decoded.deadline).toBe(1_000n)
      expect(decoded.inputs[1]?.rawInput).toBe('0xcafebabe')
      const [located] = locateUniswapV4Operations(decoded)
      expect(located?.operation.kind).toBe('swap-exact-in-single')
    }
    const smaller = variants.find((variant) => variant.mutation === 'smaller-amount')!
    const decoded = decodeUniswapV4Calldata(smaller.calldata)!
    const operation = locateUniswapV4Operations(decoded)[0]!.operation
    expect(operation).toMatchObject({ kind: 'swap-exact-in-single', amountIn: 50n, amountOutMinimum: 5n, hookData: '0x1234' })
  })

  it('reuses one pinned fork session for every generated variant', async () => {
    const calldata = routerCalldata()
    const variants = buildLiveRouterScenarios(pool, calldata)
    const prefetch = vi.fn(async () => ({ hydratedAccounts: 6, hydratedStorageSlots: 0, hydratedBlockHashes: 0, rpcReads: 18, executions: 0 }))
    const executedInputs: Parameters<ForkExecutionSession['execute']>[0][] = []
    const execute = vi.fn(async (input: Parameters<ForkExecutionSession['execute']>[0]) => {
      executedInputs.push(input)
      return replayResult()
    })
    const close = vi.fn()
    const coverage = await runLiveRouterScenarios({
      scanId: 'router-test',
      client: {} as PublicClient,
      poolManager: MANAGER,
      pools: [pool],
      replay: replayCoverage(calldata),
      signal: new AbortController().signal,
      createSession: () => ({
        prefetch,
        execute,
        metrics: () => ({ hydratedAccounts: 6, hydratedStorageSlots: 0, hydratedBlockHashes: 0, rpcReads: 18, executions: variants.length }),
        close,
      }),
    })

    expect(coverage.status).toBe('passed')
    // Each variant, plus the two-execution sequence probe reported as one scenario.
    expect(coverage.scenarios).toBe(variants.length + 1)
    expect(prefetch).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(variants.length + 2)
    expect(executedInputs.every(({ transaction }) =>
      transaction.executionMode === 'simulation'
        && transaction.gasPrice === 0n
        && transaction.maxPriorityFeePerGas === undefined)).toBe(true)
    expect(close).toHaveBeenCalledTimes(1)
    expect(coverage.findings.every((finding) => finding.witness?.value === '7')).toBe(true)
  })

  it('flips swap direction while preserving every other field', () => {
    const variants = buildLiveRouterScenarios(pool, routerCalldata())
    const flipped = variants.find((variant) => variant.mutation === 'flipped-direction')!
    const decoded = decodeUniswapV4Calldata(flipped.calldata)!
    if (decoded.kind !== 'universal-router') throw new Error('Expected Universal Router calldata.')
    expect(decoded.commands).toBe('0x1002')
    expect(decoded.inputs[1]?.rawInput).toBe('0xcafebabe')
    expect(locateUniswapV4Operations(decoded)[0]!.operation).toMatchObject({
      kind: 'swap-exact-in-single',
      zeroForOne: false,
      amountIn: 100n,
      amountOutMinimum: 5n,
      hookData: '0x1234',
    })
  })

  it('does not offer a tick-range variant for an operation that has no range', () => {
    const variants = buildLiveRouterScenarios(pool, routerCalldata())
    expect(variants.some((variant) => variant.mutation === 'widened-tick-range')).toBe(false)
  })

  it('does not attribute a different PoolId or opaque calldata', () => {
    const otherPool = { ...pool, poolId: `0x${'9'.repeat(64)}` as Hex }
    expect(buildLiveRouterScenarios(otherPool, routerCalldata())).toEqual([])
    expect(buildLiveRouterScenarios(pool, '0x12345678')).toEqual([])
  })

  it('observes an unchanged historical custom-router sequence when its trace reaches PoolManager and the hook', async () => {
    const base = replayCoverage('0x12345678')
    const replay = {
      ...base,
      outcomes: [{
        ...base.outcomes[0]!,
        replay: {
          ...replayResult(),
          proof: {
            ...replayResult().proof,
            calls: [
              { caller: ROUTER, target: MANAGER, bytecodeAddress: MANAGER, scheme: 'Call' as const, value: '0', inputLength: 100 },
              { caller: MANAGER, target: HOOK, bytecodeAddress: HOOK, scheme: 'Call' as const, value: '0', inputLength: 100 },
            ],
          },
        },
      }],
    }
    const execute = vi.fn(async () => replayResult())
    const coverage = await runLiveRouterScenarios({
      scanId: 'custom-router-sequence',
      client: {} as PublicClient,
      poolManager: MANAGER,
      pools: [pool],
      replay,
      signal: new AbortController().signal,
      createSession: () => ({
        prefetch: vi.fn(async () => ({ hydratedAccounts: 6, hydratedStorageSlots: 0, hydratedBlockHashes: 0, rpcReads: 0, executions: 0 })),
        execute,
        metrics: () => ({ hydratedAccounts: 6, hydratedStorageSlots: 0, hydratedBlockHashes: 0, rpcReads: 0, executions: 2 }),
        close: vi.fn(),
      }),
    })

    expect(coverage.status).toBe('degraded')
    expect(coverage.recognizedPools).toBe(0)
    expect(coverage.scenarios).toBe(1)
    expect(execute).not.toHaveBeenCalled()
    expect(coverage.findings[0]?.claim).toContain('exact historical custom-router payload')
    expect(coverage.limitations.join(' ')).toContain('historical custom-router execution')
  })

  it('generates the same controlled variants inside a canonical router subplan', () => {
    const variants = buildLiveRouterScenarios(pool, nestedSwapCalldata())
    expect(variants.map((variant) => variant.mutation).sort()).toEqual([
      'flipped-direction',
      'hook-data-empty',
      'hook-data-marker',
      'smaller-amount',
    ])
    for (const variant of variants) {
      const decoded = decodeUniswapV4Calldata(variant.calldata)
      if (!decoded) throw new Error('Expected decoded nested router calldata.')
      expect(locateUniswapV4Operations(decoded)[0]?.location).toMatchObject({ subplanPath: [0] })
    }
  })

  it('resolves a direct PositionManager token ID at the replay parent block', async () => {
    const calldata = positionManagerCalldata()
    expect(buildLiveRouterScenarios(pool, calldata)).toEqual([])
    expect(buildLiveRouterScenarios(pool, calldata, new Map([[42n, poolId]]))).toHaveLength(3)

    const readContract = vi.fn(async () => [poolKey, 0n] as const)
    const execute = vi.fn(async () => replayResult())
    const coverage = await runLiveRouterScenarios({
      scanId: 'position-test',
      client: { readContract } as unknown as PublicClient,
      poolManager: MANAGER,
      pools: [pool],
      replay: replayCoverage(calldata, { kind: 'modify-liquidity', to: ROUTER }),
      signal: new AbortController().signal,
      createSession: () => ({
        prefetch: vi.fn(async () => ({ hydratedAccounts: 6, hydratedStorageSlots: 0, hydratedBlockHashes: 0, rpcReads: 12, executions: 0 })),
        execute,
        metrics: () => ({ hydratedAccounts: 6, hydratedStorageSlots: 0, hydratedBlockHashes: 0, rpcReads: 12, executions: 3 }),
        close: vi.fn(),
      }),
    })

    expect(readContract).toHaveBeenCalledTimes(1)
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: ROUTER,
      functionName: 'getPoolAndPositionInfo',
      args: [42n],
      blockNumber: 9n,
    }))
    expect(coverage.positionLookups).toEqual({ reads: 1, resolved: 1, unavailable: 0, nestedSkipped: 0, capped: 0, observedTargets: 0, ambiguous: 0 })
    expect(coverage.scenarios).toBe(4)
    expect(execute).toHaveBeenCalledTimes(5)
  })

  it('does not guess a PositionManager address when the replay trace shows no forwarded call', async () => {
    const readContract = vi.fn()
    const coverage = await runLiveRouterScenarios({
      scanId: 'nested-position-test',
      client: { readContract } as unknown as PublicClient,
      poolManager: MANAGER,
      pools: [pool],
      replay: replayCoverage(nestedPositionManagerCalldata(), { kind: 'modify-liquidity' }),
      signal: new AbortController().signal,
    })

    expect(readContract).not.toHaveBeenCalled()
    expect(coverage.positionLookups.nestedSkipped).toBe(1)
    expect(coverage.positionLookups.observedTargets).toBe(0)
    expect(coverage.scenarios).toBe(0)
    expect(coverage.limitations.join(' ')).toContain('did not identify exactly one forwarded PositionManager call')
  })

  it('attributes a nested token ID from the address the router actually called', async () => {
    const calldata = nestedPositionManagerCalldata()
    const forwarded = positionManagerCalldata()
    const readContract = vi.fn(async () => [
      { currency0: CURRENCY0, currency1: CURRENCY1, fee: 3_000, tickSpacing: 60, hooks: HOOK },
      0n,
    ])
    const base = replayCoverage(calldata, { kind: 'modify-liquidity' })
    const coverage = await runLiveRouterScenarios({
      scanId: 'nested-attribution-test',
      client: { readContract } as unknown as PublicClient,
      poolManager: MANAGER,
      pools: [pool],
      replay: {
        ...base,
        outcomes: [{
          ...base.outcomes[0]!,
          replay: {
            ...replayResult(),
            proof: {
              ...replayResult().proof,
              calls: [{
                caller: ROUTER,
                target: POSITION_MANAGER,
                bytecodeAddress: POSITION_MANAGER,
                scheme: 'Call',
                value: '0x0',
                inputLength: (forwarded.length - 2) / 2,
              }],
            },
          },
        }],
      },
      signal: new AbortController().signal,
      createSession: () => ({
        prefetch: vi.fn(async () => ({ hydratedAccounts: 6, hydratedStorageSlots: 0, hydratedBlockHashes: 0, rpcReads: 12, executions: 0 })),
        execute: vi.fn(async () => replayResult()),
        metrics: () => ({ hydratedAccounts: 6, hydratedStorageSlots: 0, hydratedBlockHashes: 0, rpcReads: 12, executions: 3 }),
        close: vi.fn(),
      }),
    })

    // The PositionManager address came from the observed call, not from the token ID.
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: POSITION_MANAGER,
      functionName: 'getPoolAndPositionInfo',
      args: [42n],
      blockNumber: 9n,
    }))
    expect(coverage.positionLookups.observedTargets).toBe(1)
    expect(coverage.positionLookups.resolved).toBe(1)
    expect(coverage.positionLookups.nestedSkipped).toBe(0)
    expect(coverage.limitations.join(' ')).toContain('the router actually called')
  })
})
