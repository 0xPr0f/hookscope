import { describe, expect, it, vi } from 'vitest'
import { toEventSelector, type Address, type Hex } from 'viem'
import {
  CUSTOM_ROUTER_POOL_MANAGER,
  CUSTOM_ROUTER_SAMPLES,
  customRouterPoolKey,
  customRouterRuntime,
} from '../fixtures/customRouter9409'
import { prepareHistoricalRouterContexts } from '../data/historicalRouterContext'
import { customRouterScenarios } from './liveRouterScenarios'
import { selectForkExplorationTargets, exchangeCorpus } from './liveForkExploration'
import { decodeCustomV4UnlockCalldata, AMOUNT_LOW_OFFSET, AMOUNT_WORD_END } from '../adapters/customV4UnlockRouterCodec'
import type { LivePoolReplayCoverage } from './livePoolReplay'
import type { PoolDescriptor } from '../domain/report'
import type { ForkExplorationEpoch } from './revmProof'

/**
 * The whole recognized-custom-router path, from a real mainnet transaction to
 * generated variants and an exploration target, with nothing synthesized.
 */

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

const replay = {
  status: 'passed', selectedPools: 1, candidateTransactions: 1, passedTransactions: 1, coveredPools: 1,
  hydrationReads: 0, findings: [], limitations: [],
  outcomes: [{
    poolId: pool.poolId, hook: pool.hook, kind: 'swap', transactionHash: sample.transactionHash, status: 'passed',
    candidate: {
      kind: 'swap', poolId: pool.poolId, transactionHash: sample.transactionHash,
      stateBlockNumber: sample.stateBlockNumber,
      transaction: {
        caller: sample.actor, to: sample.router, calldata: sample.calldata, value: sample.value,
        gasLimit: 1_000_000n, gasPrice: 0n, nonce: 0, chainId: 1,
      },
      block: {
        number: sample.blockNumber, beneficiary: sample.router, timestamp: 1n,
        gasLimit: 30_000_000n, baseFee: 0n, difficulty: 0n, prevrandao: `0x${'0'.repeat(64)}` as Hex,
      },
      expected: { success: true, gasUsed: BigInt(sample.receipt.gasUsed), logCount: sample.receipt.logCount },
    },
    replay: {
      hydrationRequests: 0, hydratedAccounts: 0, hydratedStorageSlots: 0,
      proof: {
        engine: 'revm/36.0.0', success: true, gasUsed: sample.receipt.gasUsed, output: '0x' as Hex,
        steps: [], storageOperations: [], storageDiffs: [], balanceChanges: [], selfdestructs: [], truncated: false,
        calls: sample.tracedCalls!.map((call) => ({
          caller: call.from, target: call.to, bytecodeAddress: call.to,
          scheme: 'Call', value: '0', inputLength: 68, selector: call.selector,
        })),
        logs: [{
          address: CUSTOM_ROUTER_POOL_MANAGER,
          topics: [
            toEventSelector('event Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)'),
            sample.expected.poolId,
          ] as Hex[],
          data: '0x' as Hex,
        }],
        logCount: sample.receipt.logCount,
      },
    },
  }],
} as unknown as LivePoolReplayCoverage

const loadHydration = vi.fn(async (_block: bigint, request: { kind: string; address?: Address }) => ({
  kind: 'account' as const,
  account: {
    address: request.address!, exists: true, balance: '0x0' as Hex, nonce: 1,
    code: request.address?.toLowerCase() === sample.router.toLowerCase()
      ? customRouterRuntime(sample.runtimeKey) : '0x' as Hex,
    storage: {}, storageComplete: false,
  },
}))

async function contexts() {
  return prepareHistoricalRouterContexts({
    replay, pools: [pool], poolManager: CUSTOM_ROUTER_POOL_MANAGER,
    loadHydration, signal: new AbortController().signal,
  })
}

describe('recognized custom router end to end', () => {
  it('generates amount-only variants that still reach the same pool', async () => {
    const recognized = await contexts()
    const context = [...recognized.byTransaction.values()][0]!
    const scenarios = customRouterScenarios(context)

    expect(scenarios.map((scenario) => scenario.id)).toEqual([
      'custom-router:half-amount',
      'custom-router:quarter-amount',
      'custom-router:amount-minus-one',
    ])
    const seed = Buffer.from(sample.calldata.slice(2), 'hex')
    for (const scenario of scenarios) {
      expect((scenario.calldata.length - 2) / 2).toBe(228)
      const variant = Buffer.from(scenario.calldata.slice(2), 'hex')
      const changed = [...seed.keys()].filter((index) => seed[index] !== variant[index])
      // Only the amount word may move, and only its low bytes.
      expect(Math.min(...changed)).toBeGreaterThanOrEqual(AMOUNT_LOW_OFFSET)
      expect(Math.max(...changed)).toBeLessThan(AMOUNT_WORD_END)

      const decoded = decodeCustomV4UnlockCalldata(scenario.calldata, {
        poolKey: key, poolId: sample.expected.poolId, transactionValue: 0n,
      })
      expect(decoded.ok).toBe(true)
      if (!decoded.ok) continue
      expect(decoded.decoded.poolId).toBe(sample.expected.poolId)
      expect(decoded.decoded.zeroForOne).toBe(sample.expected.zeroForOne)
      expect(decoded.decoded.settlementCurrency).toBe(sample.expected.settlementCurrency)
      expect(decoded.decoded.amountIn).toBeLessThan(sample.expected.amountIn)
    }
    // Amounts are the declared fractions, not arbitrary.
    const amounts = scenarios.map((scenario) => {
      const decoded = decodeCustomV4UnlockCalldata(scenario.calldata, { poolKey: key, poolId: sample.expected.poolId, transactionValue: 0n })
      return decoded.ok ? decoded.decoded.amountIn : 0n
    })
    expect(amounts).toEqual([
      sample.expected.amountIn / 2n,
      sample.expected.amountIn / 4n,
      sample.expected.amountIn - 1n,
    ])
  })

  it('becomes an exploration target only once recognition has passed', async () => {
    const recognized = await contexts()
    const withContext = selectForkExplorationTargets({ pools: [pool], replay, routerContexts: recognized })
    expect(withContext).toHaveLength(1)
    expect(withContext[0]!.mask.codec).toBe('custom-v4-unlock-9409-v1')
    expect(withContext[0]!.mask.byteIndices).toHaveLength(16)
    expect(withContext[0]!.recognizedTemplate?.family).toBe('custom-v4-unlock-9409-v1')

    // Without the recognition step this router is exact-replay-only, exactly as
    // it was before this adapter existed.
    expect(selectForkExplorationTargets({ pools: [pool], replay })).toHaveLength(0)
  })

  it('drops corpus candidates that escaped the amount mask', async () => {
    const recognized = await contexts()
    const [target] = selectForkExplorationTargets({ pools: [pool], replay, routerContexts: recognized })
    const mask = target!.mask

    const inMask = Buffer.from(sample.calldata.slice(2), 'hex')
    inMask[AMOUNT_WORD_END - 1] = inMask[AMOUNT_WORD_END - 1]! ^ 0x0f
    const outOfMask = Buffer.from(sample.calldata.slice(2), 'hex')
    outOfMask[60] = outOfMask[60]! ^ 0xff // token word

    const epoch = {
      engine: 'revm/36.0.0', strategy: 'test', executions: 2, coverageEdges: 1, uniqueOutcomes: 2, elapsedMs: 1,
      skippedExecutions: 0, missingRequests: [], missingCandidates: [],
      witnesses: [
        { calldata: `0x${inMask.toString('hex')}` as Hex, success: true, gasUsed: 1, newEdges: 1, output: '0x' as Hex, storageDiffs: [] },
        { calldata: `0x${outOfMask.toString('hex')}` as Hex, success: false, gasUsed: 1, newEdges: 1, output: '0x' as Hex, storageDiffs: [] },
      ],
    } as ForkExplorationEpoch

    const corpus = exchangeCorpus(mask, epoch)
    expect(corpus).toContain(`0x${inMask.toString('hex')}`)
    // A changed token address can never survive into the next round.
    expect(corpus).not.toContain(`0x${outOfMask.toString('hex')}`)
  })
})
