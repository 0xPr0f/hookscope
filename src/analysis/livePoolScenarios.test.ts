import { describe, expect, it, vi } from 'vitest'
import type { Address, Hex, PublicClient } from 'viem'
import type { PoolDescriptor } from '../domain/report'
import type { LivePoolReplayCoverage } from './livePoolReplay'
import { buildLivePoolScenarios, runLivePoolScenarios } from './livePoolScenarios'
import type { ForkReplayResult } from './revmProof'

const ACTOR = '0x1111111111111111111111111111111111111111' as Address
const ROUTER = '0x2222222222222222222222222222222222222222' as Address
const MANAGER = '0x3333333333333333333333333333333333333333' as Address
const HOOK = '0x00000000000000000000000000000000000000c0' as Address
const TOKEN = '0x4444444444444444444444444444444444444444' as Address
const ZERO = '0x0000000000000000000000000000000000000000' as Address
const HASH = `0x${'ab'.repeat(32)}` as Hex

const pool: PoolDescriptor = {
  poolId: `0x${'12'.repeat(32)}` as Hex,
  currency0: ZERO,
  currency1: TOKEN,
  fee: 3_000,
  tickSpacing: 60,
  hook: HOOK,
  initializedAtBlock: '100',
  activity: 1,
}

const replayResult: ForkReplayResult = {
  proof: {
    engine: 'revm/36.0.0-wasm',
    success: false,
    gasUsed: 23_000,
    output: '0x',
    steps: [],
    storageOperations: [],
    calls: [{ caller: ACTOR, target: HOOK, bytecodeAddress: HOOK, scheme: 'Call', value: '0', inputLength: 4 }],
    storageDiffs: [],
    balanceChanges: [],
    logs: [],
    logCount: 0,
    selfdestructs: [],
    truncated: false,
  },
  hydrationRequests: 0,
  hydratedAccounts: 6,
  hydratedStorageSlots: 0,
}

function historicalReplay(): LivePoolReplayCoverage {
  return {
    status: 'passed',
    selectedPools: 1,
    candidateTransactions: 1,
    passedTransactions: 1,
    failedTransactions: 0,
    coveredPools: 1,
    findings: [],
    hydrationRequests: 10,
    limitations: [],
    outcomes: [{
      poolId: pool.poolId,
      hook: pool.hook,
      kind: 'swap',
      transactionHash: HASH,
      status: 'passed',
      candidate: {
        kind: 'swap',
        poolId: pool.poolId,
        transactionHash: HASH,
        stateBlockNumber: 100n,
        transaction: { caller: ACTOR, to: ROUTER, calldata: '0x1234', value: 0n, gasLimit: 1_000_000n, gasPrice: 1n, nonce: 7, chainId: 1 },
        block: { number: 101n, beneficiary: ZERO, timestamp: 1n, gasLimit: 30_000_000n, baseFee: 1n, difficulty: 0n },
        expected: { success: true, gasUsed: 100n, logCount: 1 },
      },
      replay: replayResult,
    }],
  }
}

describe('live pool scenarios', () => {
  it('builds only callbacks enabled by the hook address and includes swap variants', () => {
    const scenarios = buildLivePoolScenarios(pool, ACTOR)
    expect(scenarios.map((scenario) => scenario.callback)).toEqual(['beforeSwap', 'beforeSwap', 'beforeSwap', 'afterSwap'])
    expect(scenarios.map((scenario) => scenario.hookData)).toContain('0xdeadbeef')
    expect(new Set(scenarios.map((scenario) => scenario.calldata.slice(0, 10))).size).toBe(2)
  })

  it('prefetches one historical context and reuses it for every callback execution', async () => {
    const prefetch = vi.fn(async () => ({ hydratedAccounts: 6, hydratedStorageSlots: 0, hydratedBlockHashes: 0, rpcReads: 18, executions: 0 }))
    const execute = vi.fn(async () => replayResult)
    const close = vi.fn()
    const result = await runLivePoolScenarios({
      scanId: 'scan',
      client: {} as PublicClient,
      poolManager: MANAGER,
      pools: [pool],
      replay: historicalReplay(),
      signal: new AbortController().signal,
      createSession: () => ({
        prefetch,
        execute,
        close,
        metrics: () => ({ hydratedAccounts: 6, hydratedStorageSlots: 0, hydratedBlockHashes: 0, rpcReads: 18, executions: execute.mock.calls.length }),
      }),
    })

    expect(result.status).toBe('passed')
    expect(result.scenarios).toBe(4)
    expect(result.executions).toBe(4)
    expect(result.findings).toHaveLength(4)
    expect(result.findings[0]?.witness?.blockNumber).toBe('101')
    expect(prefetch).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(4)
    expect(close).toHaveBeenCalledTimes(1)
  })
})
