import { encodeFunctionData, getAddress, type Abi, type Address, type Hex, type PublicClient } from 'viem'
import { decodeHookPermissions, type HookPermission } from '../domain/hooks'
import type { Evidence, PoolDescriptor } from '../domain/report'
import type { LivePoolReplayCoverage, PoolReplayOutcome } from './livePoolReplay'
import {
  ForkExecutionSession,
  type ForkReplayResult,
  type ForkSessionMetrics,
  type ForkStatePrefetch,
} from './revmProof'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address
const ZERO_BYTES32 = `0x${'0'.repeat(64)}` as Hex
const SQRT_PRICE_1_1 = 79_228_162_514_264_337_593_543_950_336n

const POOL_KEY_COMPONENTS = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
] as const

const SWAP_PARAMS_COMPONENTS = [
  { name: 'zeroForOne', type: 'bool' },
  { name: 'amountSpecified', type: 'int256' },
  { name: 'sqrtPriceLimitX96', type: 'uint160' },
] as const

const LIQUIDITY_PARAMS_COMPONENTS = [
  { name: 'tickLower', type: 'int24' },
  { name: 'tickUpper', type: 'int24' },
  { name: 'liquidityDelta', type: 'int256' },
  { name: 'salt', type: 'bytes32' },
] as const

const CALLBACK_ABI = [
  {
    type: 'function', name: 'beforeInitialize', stateMutability: 'nonpayable',
    inputs: [{ name: 'sender', type: 'address' }, { name: 'key', type: 'tuple', components: POOL_KEY_COMPONENTS }, { name: 'sqrtPriceX96', type: 'uint160' }],
    outputs: [{ type: 'bytes4' }],
  },
  {
    type: 'function', name: 'afterInitialize', stateMutability: 'nonpayable',
    inputs: [{ name: 'sender', type: 'address' }, { name: 'key', type: 'tuple', components: POOL_KEY_COMPONENTS }, { name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' }],
    outputs: [{ type: 'bytes4' }],
  },
  {
    type: 'function', name: 'beforeAddLiquidity', stateMutability: 'nonpayable',
    inputs: [{ name: 'sender', type: 'address' }, { name: 'key', type: 'tuple', components: POOL_KEY_COMPONENTS }, { name: 'params', type: 'tuple', components: LIQUIDITY_PARAMS_COMPONENTS }, { name: 'hookData', type: 'bytes' }],
    outputs: [{ type: 'bytes4' }],
  },
  {
    type: 'function', name: 'afterAddLiquidity', stateMutability: 'nonpayable',
    inputs: [{ name: 'sender', type: 'address' }, { name: 'key', type: 'tuple', components: POOL_KEY_COMPONENTS }, { name: 'params', type: 'tuple', components: LIQUIDITY_PARAMS_COMPONENTS }, { name: 'delta', type: 'int256' }, { name: 'feesAccrued', type: 'int256' }, { name: 'hookData', type: 'bytes' }],
    outputs: [{ type: 'bytes4' }, { type: 'int256' }],
  },
  {
    type: 'function', name: 'beforeRemoveLiquidity', stateMutability: 'nonpayable',
    inputs: [{ name: 'sender', type: 'address' }, { name: 'key', type: 'tuple', components: POOL_KEY_COMPONENTS }, { name: 'params', type: 'tuple', components: LIQUIDITY_PARAMS_COMPONENTS }, { name: 'hookData', type: 'bytes' }],
    outputs: [{ type: 'bytes4' }],
  },
  {
    type: 'function', name: 'afterRemoveLiquidity', stateMutability: 'nonpayable',
    inputs: [{ name: 'sender', type: 'address' }, { name: 'key', type: 'tuple', components: POOL_KEY_COMPONENTS }, { name: 'params', type: 'tuple', components: LIQUIDITY_PARAMS_COMPONENTS }, { name: 'delta', type: 'int256' }, { name: 'feesAccrued', type: 'int256' }, { name: 'hookData', type: 'bytes' }],
    outputs: [{ type: 'bytes4' }, { type: 'int256' }],
  },
  {
    type: 'function', name: 'beforeSwap', stateMutability: 'nonpayable',
    inputs: [{ name: 'sender', type: 'address' }, { name: 'key', type: 'tuple', components: POOL_KEY_COMPONENTS }, { name: 'params', type: 'tuple', components: SWAP_PARAMS_COMPONENTS }, { name: 'hookData', type: 'bytes' }],
    outputs: [{ type: 'bytes4' }, { type: 'int256' }, { type: 'uint24' }],
  },
  {
    type: 'function', name: 'afterSwap', stateMutability: 'nonpayable',
    inputs: [{ name: 'sender', type: 'address' }, { name: 'key', type: 'tuple', components: POOL_KEY_COMPONENTS }, { name: 'params', type: 'tuple', components: SWAP_PARAMS_COMPONENTS }, { name: 'delta', type: 'int256' }, { name: 'hookData', type: 'bytes' }],
    outputs: [{ type: 'bytes4' }, { type: 'int128' }],
  },
  {
    type: 'function', name: 'beforeDonate', stateMutability: 'nonpayable',
    inputs: [{ name: 'sender', type: 'address' }, { name: 'key', type: 'tuple', components: POOL_KEY_COMPONENTS }, { name: 'amount0', type: 'uint256' }, { name: 'amount1', type: 'uint256' }, { name: 'hookData', type: 'bytes' }],
    outputs: [{ type: 'bytes4' }],
  },
  {
    type: 'function', name: 'afterDonate', stateMutability: 'nonpayable',
    inputs: [{ name: 'sender', type: 'address' }, { name: 'key', type: 'tuple', components: POOL_KEY_COMPONENTS }, { name: 'amount0', type: 'uint256' }, { name: 'amount1', type: 'uint256' }, { name: 'hookData', type: 'bytes' }],
    outputs: [{ type: 'bytes4' }],
  },
] as const satisfies Abi

export type LivePoolScenario = {
  id: string
  callback: Exclude<HookPermission, `${string}ReturnDelta`>
  description: string
  hookData: Hex
  calldata: Hex
}

export type LivePoolScenarioResult = {
  scenario: LivePoolScenario
  replay: ForkReplayResult
}

export type LivePoolScenarioOutcome = {
  poolId: Hex
  hook: Address
  actor?: Address
  router?: Address
  transactionHash?: Hex
  blockNumber?: string
  status: 'completed' | 'unavailable' | 'failed'
  reason?: string
  results: LivePoolScenarioResult[]
  metrics?: ForkSessionMetrics
}

export type LivePoolScenarioCoverage = {
  status: 'passed' | 'degraded'
  eligiblePools: number
  coveredPools: number
  scenarios: number
  executions: number
  hydrationReads: number
  outcomes: LivePoolScenarioOutcome[]
  findings: Evidence[]
  limitations: string[]
}

type ScenarioSession = Pick<ForkExecutionSession, 'prefetch' | 'execute' | 'metrics' | 'close'>
type SessionFactory = (input: { scanId: string; client: PublicClient; stateBlockNumber: bigint }) => ScenarioSession

function poolKey(pool: PoolDescriptor) {
  return {
    currency0: pool.currency0,
    currency1: pool.currency1,
    fee: pool.fee,
    tickSpacing: pool.tickSpacing,
    hooks: pool.hook,
  }
}

function encodeCallback(functionName: string, args: readonly unknown[]): Hex {
  return encodeFunctionData({ abi: CALLBACK_ABI as Abi, functionName, args })
}

export function buildLivePoolScenarios(pool: PoolDescriptor, actor: Address): LivePoolScenario[] {
  if (pool.hook.toLowerCase() === ZERO_ADDRESS) return []
  const permissions = new Set(decodeHookPermissions(pool.hook))
  const key = poolKey(pool)
  const spacing = Math.max(1, Math.abs(pool.tickSpacing))
  const liquidity = { tickLower: -2 * spacing, tickUpper: 2 * spacing, liquidityDelta: 1n, salt: ZERO_BYTES32 }
  const swap = (zeroForOne: boolean, amountSpecified: bigint) => ({
    zeroForOne,
    amountSpecified,
    sqrtPriceLimitX96: SQRT_PRICE_1_1,
  })
  const scenarios: LivePoolScenario[] = []
  const add = (scenario: LivePoolScenario) => scenarios.push(scenario)

  if (permissions.has('beforeInitialize')) add({ id: 'before-initialize', callback: 'beforeInitialize', description: 'Existing-pool initialization callback invocation', hookData: '0x', calldata: encodeCallback('beforeInitialize', [actor, key, SQRT_PRICE_1_1]) })
  if (permissions.has('afterInitialize')) add({ id: 'after-initialize', callback: 'afterInitialize', description: 'Existing-pool post-initialization callback invocation', hookData: '0x', calldata: encodeCallback('afterInitialize', [actor, key, SQRT_PRICE_1_1, 0]) })
  if (permissions.has('beforeAddLiquidity')) add({ id: 'before-add-liquidity', callback: 'beforeAddLiquidity', description: 'Pre-add-liquidity callback invocation', hookData: '0x', calldata: encodeCallback('beforeAddLiquidity', [actor, key, liquidity, '0x']) })
  if (permissions.has('afterAddLiquidity')) add({ id: 'after-add-liquidity', callback: 'afterAddLiquidity', description: 'Post-add-liquidity callback invocation', hookData: '0x', calldata: encodeCallback('afterAddLiquidity', [actor, key, liquidity, 0n, 0n, '0x']) })
  if (permissions.has('beforeRemoveLiquidity')) add({ id: 'before-remove-liquidity', callback: 'beforeRemoveLiquidity', description: 'Pre-remove-liquidity callback invocation', hookData: '0x', calldata: encodeCallback('beforeRemoveLiquidity', [actor, key, { ...liquidity, liquidityDelta: -1n }, '0x']) })
  if (permissions.has('afterRemoveLiquidity')) add({ id: 'after-remove-liquidity', callback: 'afterRemoveLiquidity', description: 'Post-remove-liquidity callback invocation', hookData: '0x', calldata: encodeCallback('afterRemoveLiquidity', [actor, key, { ...liquidity, liquidityDelta: -1n }, 0n, 0n, '0x']) })
  if (permissions.has('beforeSwap')) {
    add({ id: 'before-swap-exact-input', callback: 'beforeSwap', description: 'Pre-swap callback with exact input', hookData: '0x', calldata: encodeCallback('beforeSwap', [actor, key, swap(true, -1n), '0x']) })
    add({ id: 'before-swap-exact-output', callback: 'beforeSwap', description: 'Pre-swap callback with exact output and reverse direction', hookData: '0x', calldata: encodeCallback('beforeSwap', [actor, key, swap(false, 1n), '0x']) })
    add({ id: 'before-swap-hook-data', callback: 'beforeSwap', description: 'Pre-swap callback with non-empty hook data', hookData: '0xdeadbeef', calldata: encodeCallback('beforeSwap', [actor, key, swap(true, -1n), '0xdeadbeef']) })
  }
  if (permissions.has('afterSwap')) add({ id: 'after-swap', callback: 'afterSwap', description: 'Post-swap callback invocation', hookData: '0x', calldata: encodeCallback('afterSwap', [actor, key, swap(true, -1n), 0n, '0x']) })
  if (permissions.has('beforeDonate')) add({ id: 'before-donate', callback: 'beforeDonate', description: 'Pre-donation callback invocation', hookData: '0x', calldata: encodeCallback('beforeDonate', [actor, key, 1n, 1n, '0x']) })
  if (permissions.has('afterDonate')) add({ id: 'after-donate', callback: 'afterDonate', description: 'Post-donation callback invocation', hookData: '0x', calldata: encodeCallback('afterDonate', [actor, key, 1n, 1n, '0x']) })
  return scenarios
}

function selectHistoricalContexts(pools: PoolDescriptor[], replay: LivePoolReplayCoverage) {
  const poolsById = new Map(pools.map((pool) => [pool.poolId.toLowerCase(), pool]))
  const selected = new Map<string, { pool: PoolDescriptor; outcome: PoolReplayOutcome }>()
  for (const outcome of replay.outcomes) {
    const pool = poolsById.get(outcome.poolId.toLowerCase())
    if (!pool || pool.hook.toLowerCase() === ZERO_ADDRESS || outcome.status !== 'passed' || !outcome.candidate) continue
    if (!selected.has(pool.poolId.toLowerCase())) selected.set(pool.poolId.toLowerCase(), { pool, outcome })
  }
  return [...selected.values()]
}

function scenarioEvidence(outcome: LivePoolScenarioOutcome, result: LivePoolScenarioResult): Evidence {
  const proof = result.replay.proof
  const firstStorage = proof.storageDiffs[0]
  const callPath = proof.calls.map((call) => getAddress(call.target)).slice(0, 64)
  return {
    id: `live-callback:${outcome.poolId.slice(2, 14)}:${result.scenario.id}`,
    detectorId: 'live-hook-callback-observation',
    detectorVersion: '0.1.0',
    severity: 'info',
    evidenceClass: 'concrete-observation',
    subject: outcome.hook,
    title: `${result.scenario.description}: ${proof.success ? 'completed' : 'reverted'}`,
    claim: `Using the actor and block context from transaction ${outcome.transactionHash}, the ${result.scenario.callback} callback ${proof.success ? 'completed' : 'reverted'} after ${result.replay.hydrationRequests} additional pinned-state reads.`,
    confidence: 'confirmed',
    callPath: callPath.length ? callPath : undefined,
    storage: firstStorage ? [{ slot: firstStorage.slot, before: firstStorage.before, after: firstStorage.after }] : undefined,
    affectedPools: [outcome.poolId],
    witness: outcome.actor ? {
      from: outcome.actor,
      to: outcome.hook,
      input: result.scenario.calldata,
      value: '0',
      blockNumber: outcome.blockNumber ?? 'historical-context',
      expectedOutcome: proof.success ? 'success' : 'revert',
    } : undefined,
    reproducibility: 'replayed',
    technical: {
      callback: result.scenario.callback,
      hookData: result.scenario.hookData,
      historicalTransaction: outcome.transactionHash,
      historicalRouter: outcome.router,
      engine: proof.engine,
      gasUsed: proof.gasUsed,
      calls: proof.calls,
      storageOperations: proof.storageOperations,
      sessionMetrics: outcome.metrics,
    },
  }
}

function emptyCoverage(eligiblePools: number, limitations: string[]): LivePoolScenarioCoverage {
  return { status: eligiblePools === 0 ? 'passed' : 'degraded', eligiblePools, coveredPools: 0, scenarios: 0, executions: 0, hydrationReads: 0, outcomes: [], findings: [], limitations }
}

export async function runLivePoolScenarios(input: {
  scanId: string
  client: PublicClient
  poolManager: Address
  pools: PoolDescriptor[]
  replay: LivePoolReplayCoverage
  signal: AbortSignal
  maxWorkers?: number
  timeoutMs?: number
  maxHydrationRequests?: number
  createSession?: SessionFactory
  onProgress?: (completed: number, total: number, detail: string) => void
}): Promise<LivePoolScenarioCoverage> {
  const eligiblePools = input.pools.filter((pool) => pool.hook.toLowerCase() !== ZERO_ADDRESS).length
  const contexts = selectHistoricalContexts(input.pools, input.replay)
  if (!eligiblePools) return emptyCoverage(0, [])
  if (!contexts.length) return emptyCoverage(eligiblePools, ['No receipt-matched historical actor and router context was available for live callback execution.'])

  const createSession = input.createSession ?? ((options) => new ForkExecutionSession(options))
  const outcomes = new Array<LivePoolScenarioOutcome>(contexts.length)
  let cursor = 0
  let completed = 0
  const worker = async () => {
    while (true) {
      const index = cursor++
      const context = contexts[index]
      if (!context) return
      const { pool, outcome } = context
      const candidate = outcome.candidate!
      const scenarios = buildLivePoolScenarios(pool, candidate.transaction.caller)
      if (!scenarios.length) {
        outcomes[index] = { poolId: pool.poolId, hook: pool.hook, status: 'unavailable', reason: 'The hook address exposes no callback permission bits.', results: [] }
        completed++
        input.onProgress?.(completed, contexts.length, `${completed}/${contexts.length} live contexts checked`)
        continue
      }
      const session = createSession({ scanId: `${input.scanId}-live-scenarios-${index}`, client: input.client, stateBlockNumber: candidate.stateBlockNumber })
      const results: LivePoolScenarioResult[] = []
      try {
        const prefetch: ForkStatePrefetch = {
          accounts: [candidate.transaction.caller, candidate.transaction.to, input.poolManager, pool.hook, pool.currency0, pool.currency1],
        }
        await session.prefetch(prefetch)
        for (const scenario of scenarios) {
          if (input.signal.aborted) throw new DOMException('Live pool scenarios cancelled', 'AbortError')
          input.onProgress?.(completed, contexts.length, `${scenario.callback} · ${pool.poolId.slice(0, 10)}`)
          const replay = await session.execute({
            transaction: {
              ...candidate.transaction,
              to: pool.hook,
              calldata: scenario.calldata,
              value: 0n,
              traceLimit: 2_048,
            },
            block: candidate.block,
            signal: input.signal,
            timeoutMs: input.timeoutMs ?? 15_000,
            maxHydrationRequests: input.maxHydrationRequests ?? 1_024,
          })
          results.push({ scenario, replay })
        }
        outcomes[index] = {
          poolId: pool.poolId,
          hook: pool.hook,
          actor: candidate.transaction.caller,
          router: candidate.transaction.to,
          transactionHash: candidate.transactionHash,
          blockNumber: candidate.block.number.toString(),
          status: 'completed',
          results,
          metrics: session.metrics(),
        }
      } catch (error) {
        if (input.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
        outcomes[index] = {
          poolId: pool.poolId,
          hook: pool.hook,
          actor: candidate.transaction.caller,
          router: candidate.transaction.to,
          transactionHash: candidate.transactionHash,
          blockNumber: candidate.block.number.toString(),
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error),
          results,
          metrics: session.metrics(),
        }
      } finally {
        session.close()
        completed++
        input.onProgress?.(completed, contexts.length, `${completed}/${contexts.length} live contexts checked`)
      }
    }
  }

  const concurrency = Math.max(1, Math.min(input.maxWorkers ?? 2, contexts.length))
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  const completedOutcomes = outcomes.filter((outcome) => outcome.status === 'completed')
  const failed = outcomes.filter((outcome) => outcome.status === 'failed')
  const missing = eligiblePools - completedOutcomes.length
  const limitations = [
    missing > 0 ? `${missing} hooked pool${missing === 1 ? ' lacks' : 's lack'} a completed live callback context.` : undefined,
    failed.length > 0 ? `${failed.length} live callback worker${failed.length === 1 ? ' did' : 's did'} not complete.` : undefined,
    'These direct callback observations are kept distinct from controlled Universal Router and PositionManager variants, which execute through their original router context when the official calldata shape is recognized.',
  ].filter((item): item is string => Boolean(item))
  const findings = completedOutcomes.flatMap((outcome) => outcome.results.map((result) => scenarioEvidence(outcome, result)))
  return {
    status: completedOutcomes.length === eligiblePools && failed.length === 0 ? 'passed' : 'degraded',
    eligiblePools,
    coveredPools: completedOutcomes.length,
    scenarios: completedOutcomes.reduce((sum, outcome) => sum + outcome.results.length, 0),
    executions: outcomes.reduce((sum, outcome) => sum + outcome.results.length, 0),
    hydrationReads: outcomes.reduce((sum, outcome) => sum + (outcome.metrics?.rpcReads ?? 0), 0),
    outcomes,
    findings,
    limitations,
  }
}
