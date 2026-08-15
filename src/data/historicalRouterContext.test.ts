import { describe, expect, it, vi } from 'vitest'
import { toEventSelector, type Address, type Hex } from 'viem'
import {
  CUSTOM_ROUTER_POOL_MANAGER,
  CUSTOM_ROUTER_SAMPLES,
  customRouterPoolKey,
  customRouterRuntime,
} from '../fixtures/customRouter9409'
import { contextKey, prepareHistoricalRouterContexts } from './historicalRouterContext'
import type { LivePoolReplayCoverage } from '../analysis/livePoolReplay'
import type { PoolDescriptor } from '../domain/report'

const sample = CUSTOM_ROUTER_SAMPLES.find((item) => item.tracedCalls?.length)!
const key = customRouterPoolKey(sample)

const pool: PoolDescriptor = {
  poolId: sample.expected.poolId,
  currency0: key.currency0,
  currency1: key.currency1,
  fee: key.fee,
  tickSpacing: key.tickSpacing,
  hook: key.hooks,
  initializedAtBlock: '1',
  activity: 1,
}

function proof(overrides: Partial<{ calls: unknown[]; logs: unknown[]; success: boolean }> = {}) {
  return {
    engine: 'revm/36.0.0', success: overrides.success ?? true, gasUsed: sample.receipt.gasUsed, output: '0x' as Hex,
    steps: [], storageOperations: [], storageDiffs: [], balanceChanges: [], selfdestructs: [], truncated: false,
    calls: overrides.calls ?? sample.tracedCalls!.map((call) => ({
      caller: call.from, target: call.to, bytecodeAddress: call.to,
      scheme: 'Call', value: '0', inputLength: 68, selector: call.selector,
    })),
    logs: overrides.logs ?? [{
      address: CUSTOM_ROUTER_POOL_MANAGER,
      topics: [
        toEventSelector('event Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)'),
        sample.expected.poolId,
      ] as Hex[],
      data: '0x' as Hex,
    }],
    logCount: sample.receipt.logCount,
  }
}

function coverage(overrides: Partial<{ calldata: Hex; proofOverrides: Parameters<typeof proof>[0] }> = {}): LivePoolReplayCoverage {
  return {
    status: 'passed', selectedPools: 1, candidateTransactions: 1, passedTransactions: 1, coveredPools: 1,
    hydrationReads: 0, findings: [], limitations: [],
    outcomes: [{
      poolId: pool.poolId,
      hook: pool.hook,
      kind: 'swap',
      transactionHash: sample.transactionHash,
      status: 'passed',
      candidate: {
        kind: 'swap',
        poolId: pool.poolId,
        transactionHash: sample.transactionHash,
        stateBlockNumber: sample.stateBlockNumber,
        transaction: {
          caller: sample.actor,
          to: sample.router,
          calldata: overrides.calldata ?? sample.calldata,
          value: sample.value,
          gasLimit: 1_000_000n,
          gasPrice: 0n,
          nonce: 0,
          chainId: 1,
        },
        block: {
          number: sample.blockNumber, beneficiary: sample.router, timestamp: 1n,
          gasLimit: 30_000_000n, baseFee: 0n, difficulty: 0n, prevrandao: `0x${'0'.repeat(64)}` as Hex,
        },
        expected: { success: true, gasUsed: BigInt(sample.receipt.gasUsed), logCount: sample.receipt.logCount },
      },
      replay: { hydrationRequests: 0, hydratedAccounts: 0, hydratedStorageSlots: 0, proof: proof(overrides.proofOverrides) },
    }],
  } as unknown as LivePoolReplayCoverage
}

function hydration(code: Hex = customRouterRuntime(sample.runtimeKey)) {
  return vi.fn(async (_block: bigint, request: { kind: string; address?: Address }) => {
    if (request.kind !== 'account') throw new Error(`unexpected request ${request.kind}`)
    return {
      kind: 'account' as const,
      account: {
        address: request.address!, exists: true, balance: '0x0' as Hex, nonce: 1,
        code: request.address?.toLowerCase() === sample.router.toLowerCase() ? code : '0x' as Hex,
        storage: {}, storageComplete: false,
      },
    }
  })
}

const base = { pools: [pool], poolManager: CUSTOM_ROUTER_POOL_MANAGER, signal: new AbortController().signal }

describe('historical router recognition', () => {
  it('recognizes a real custom router from runtime, calldata and trace together', async () => {
    const loadHydration = hydration()
    const result = await prepareHistoricalRouterContexts({ ...base, replay: coverage(), loadHydration })

    expect(result.rejected).toEqual([])
    const context = result.byTransaction.get(contextKey(pool.poolId, sample.transactionHash))!
    expect(context.family).toBe('custom-v4-unlock-9409-v1')
    if (context.family === 'official') return
    expect(context.codeHash).toBe(sample.runtimeCodeHash)
    expect(context.configurationAddress).toBe(sample.configurationAddress)
    expect(context.decoded.amountIn).toBe(sample.expected.amountIn)
    expect(context.attestation.swapLogPoolId).toBe(sample.expected.poolId)
    // The configuration contract the router points at is worth prefetching.
    expect(result.companions).toEqual([sample.configurationAddress])
    expect(result.limitations.join(' ')).toContain('not from verified source')
  })

  it('reuses the scan-wide cache with one account read per router', async () => {
    const loadHydration = hydration()
    await prepareHistoricalRouterContexts({ ...base, replay: coverage(), loadHydration })
    expect(loadHydration).toHaveBeenCalledTimes(1)
    expect(loadHydration.mock.calls[0]![0]).toBe(sample.stateBlockNumber)
  })

  it('rejects a router whose runtime is not the recognized template', async () => {
    const tampered = Buffer.from(customRouterRuntime(sample.runtimeKey).slice(2), 'hex')
    tampered[6_000] = tampered[6_000]! ^ 0xff
    const result = await prepareHistoricalRouterContexts({
      ...base, replay: coverage(), loadHydration: hydration(`0x${tampered.toString('hex')}` as Hex),
    })
    expect(result.byTransaction.size).toBe(0)
    expect(result.rejected[0]).toMatchObject({ stage: 'runtime', detail: 'template-mismatch' })
  })

  it('rejects calldata that does not describe the selected pool', async () => {
    const other = CUSTOM_ROUTER_SAMPLES.find((item) => item.expected.poolId !== sample.expected.poolId)!
    const result = await prepareHistoricalRouterContexts({
      ...base, replay: coverage({ calldata: other.calldata }), loadHydration: hydration(),
    })
    expect(result.byTransaction.size).toBe(0)
    expect(result.rejected[0]!.stage).toBe('calldata')
  })

  it('rejects a recognized runtime whose reproduced trace does not attest', async () => {
    // Trace missing the swap call: the router looks right and did something else.
    const withoutSwap = sample.tracedCalls!.filter((call) => call.selector !== '0xf3cd914c')
      .map((call) => ({ caller: call.from, target: call.to, bytecodeAddress: call.to, scheme: 'Call', value: '0', inputLength: 68, selector: call.selector }))
    const result = await prepareHistoricalRouterContexts({
      ...base, replay: coverage({ proofOverrides: { calls: withoutSwap } }), loadHydration: hydration(),
    })
    expect(result.byTransaction.size).toBe(0)
    expect(result.rejected[0]).toMatchObject({ stage: 'attestation' })
  })

  it('leaves an unrecognized router with exact replay and no generated variants', async () => {
    const result = await prepareHistoricalRouterContexts({
      ...base, replay: coverage({ calldata: '0xdeadbeef' }), loadHydration: hydration(),
    })
    expect(result.byTransaction.size).toBe(0)
    expect(result.limitations.join(' ')).toContain('keeps exact replay')
  })

  it('does not consider a replay that failed to match its receipt', async () => {
    const failed = coverage()
    failed.outcomes[0]!.status = 'failed'
    const loadHydration = hydration()
    const result = await prepareHistoricalRouterContexts({ ...base, replay: failed, loadHydration })
    expect(result.byTransaction.size).toBe(0)
    expect(loadHydration).not.toHaveBeenCalled()
  })
})
