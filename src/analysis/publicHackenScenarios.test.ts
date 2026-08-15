import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, encodeErrorResult, encodeEventTopics, parseAbi, type Address, type Hex } from 'viem'
import type { PoolDescriptor } from '../domain/report'
import { HACKEN_FIXTURE_CONTEXT } from '../fixtures/hackenBrowserFixture'
import { buildHackenScenarios } from './hackenScenarios'
import { buildProtocolScenarioMatrix } from './protocolNativeScenarios'
import type { ProtocolScenarioOutcome } from './protocolScenarioRunner'
import type { ForkReplayResult, RevmExecutionProof } from './revmProof'
import {
  evaluatePublicHackenCases,
  PUBLIC_HACKEN_CASES,
  publicHackenSuiteEvidence,
} from './publicHackenScenarios'

const POOL_MANAGER = '0x000000000004444c5dc75cB358380D2e3dE08A90' as Address
const ACTOR = '0x1111111111111111111111111111111111111111' as Address
const pool: PoolDescriptor = {
  poolId: `0x${'ab'.repeat(32)}` as Hex,
  currency0: '0x0000000000000000000000000000000000000000',
  currency1: '0x2222222222222222222222222222222222222222',
  // Dynamic fee plus every callback bit, so conditional callback cases are
  // eligible when their public execution requirement is present.
  fee: 0x80_0000,
  tickSpacing: 60,
  hook: '0x3333333333333333333333333333333333333fff',
  initializedAtBlock: '100',
  activity: 1,
}

function replayProof(input: {
  movement?: 'moved' | 'zero'
  liquidity?: bigint
  revert?: 'PoolAlreadyInitialized' | 'NoLiquidityToReceiveFees'
}): ForkReplayResult {
  const logs = input.movement ? [{
    address: POOL_MANAGER,
    topics: encodeEventTopics({
      abi: parseAbi(['event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)']),
      eventName: 'Swap',
      args: { id: pool.poolId, sender: ACTOR },
    }) as Hex[],
    data: encodeAbiParameters(
      [{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }],
      input.movement === 'moved'
        ? [-1n, 1n, 1n << 96n, input.liquidity ?? 10n, 0, 3_000]
        : [0n, 0n, 1n << 96n, input.liquidity ?? 10n, 0, 3_000],
    ),
  }] : []
  const output = input.revert
    ? encodeErrorResult({
        abi: parseAbi(['error PoolAlreadyInitialized()', 'error NoLiquidityToReceiveFees()']),
        errorName: input.revert,
      })
    : '0x'
  const proof: RevmExecutionProof = {
    engine: 'test', success: !input.revert, gasUsed: 42_000, output,
    steps: [], storageOperations: [], calls: [], storageDiffs: [], balanceChanges: [],
    logs, logCount: logs.length, selfdestructs: [], truncated: false,
  }
  return { proof, hydrationRequests: 0, hydratedAccounts: 0, hydratedStorageSlots: 0 }
}

function completedOutcomes(): ProtocolScenarioOutcome[] {
  const scenarios: ProtocolScenarioOutcome[] = buildProtocolScenarioMatrix({
    key: {
      currency0: pool.currency0,
      currency1: pool.currency1,
      fee: pool.fee,
      tickSpacing: pool.tickSpacing,
      hooks: pool.hook,
    },
    currentTick: 0,
    actor: ACTOR,
  }).scenarios.map((scenario) => ({
    poolId: pool.poolId,
    scenarioId: scenario.id,
    operation: scenario.operation,
    status: 'completed',
    proof: replayProof({
      movement: scenario.operation === 'swap' || scenario.id === 'sequence:alternating-swaps' ? 'moved' : undefined,
    }),
  }))
  return [
    ...scenarios,
    {
      poolId: pool.poolId,
      scenarioId: 'initialize:reinitialize',
      operation: 'initialize',
      status: 'reverted',
      proof: replayProof({ revert: 'PoolAlreadyInitialized' }),
    },
  ]
}

describe('public Hacken scenario adaptation', () => {
  it('classifies every upstream-derived case without drifting from the fixture catalogue', () => {
    const fixtureCases = buildHackenScenarios(HACKEN_FIXTURE_CONTEXT)
      .map(({ id, upstream, section }) => ({ id, upstream, section }))
    const publicCases = PUBLIC_HACKEN_CASES
      .map(({ id, upstream, section }) => ({ id, upstream, section }))

    expect(publicCases).toHaveLength(40)
    expect(publicCases).toEqual(fixtureCases)
    expect(PUBLIC_HACKEN_CASES.filter((item) => item.classification === 'portable').length)
      .toBeGreaterThan(20)
  })

  it('maps portable and proven conditional intents to actual pinned public executions', () => {
    const results = evaluatePublicHackenCases({ pools: [pool], outcomes: completedOutcomes(), poolManager: POOL_MANAGER })
    const byId = new Map(results.map((item) => [item.id, item]))

    expect(byId.get('swap-both-directions')).toMatchObject({ status: 'passed', observedOutcome: 'completed' })
    expect(byId.get('hook-data-formats')?.scenarioIds).toEqual([
      'swap:hook-data:empty',
      'swap:hook-data:raw-four-byte',
      'swap:hook-data:abi-actor',
    ])
    expect(byId.get('hook-data-formats')).toMatchObject({ status: 'observed' })
    expect(byId.get('liquidity-bounded-amounts')).toMatchObject({ status: 'passed' })
    expect(byId.get('liquidity-bounded-ranges')).toMatchObject({ status: 'passed' })
    expect(byId.get('donate-sequential')).toMatchObject({ status: 'passed' })
    expect(byId.get('lp-fee-override')).toMatchObject({ status: 'passed' })
    expect(byId.get('reinitialize')).toMatchObject({ status: 'passed', observedOutcome: 'reverted' })
    expect(byId.get('external-mutator-open-policy')).toMatchObject({ status: 'not-applicable', classification: 'fixture-only' })
  })

  it('does not claim conditional dynamic-fee coverage for a fixed-fee pool', () => {
    const fixedPool = { ...pool, fee: 3_000 }
    const result = evaluatePublicHackenCases({ pools: [fixedPool], outcomes: completedOutcomes() })
      .find((item) => item.id === 'lp-fee-override')
    expect(result).toMatchObject({ status: 'unavailable', classification: 'conditional' })
    expect(result?.reason).toContain('does not advertise')
  })

  it('uses pinned runtime adaptations for conditional cases that have no generated-scenario requirement', () => {
    const results = evaluatePublicHackenCases({
      pools: [pool],
      outcomes: completedOutcomes(),
      runtimeProbes: [
        {
          caseId: 'permissions-match-address',
          poolId: pool.poolId,
          hook: pool.hook,
          status: 'passed',
          reason: 'canonical getter matched',
          gasUsed: 24_000,
          details: { returnedPermissions: ['beforeSwap'] },
        },
        {
          caseId: 'only-pool-manager',
          poolId: pool.poolId,
          hook: pool.hook,
          status: 'failed',
          reason: 'one direct callback completed',
          observedOutcome: 'completed',
        },
      ],
    })
    const byId = new Map(results.map((item) => [item.id, item]))
    expect(byId.get('permissions-match-address')).toMatchObject({
      status: 'passed',
      gasUsed: 24_000,
      probeDetails: { returnedPermissions: ['beforeSwap'] },
    })
    expect(byId.get('only-pool-manager')).toMatchObject({
      status: 'failed',
      observedOutcome: 'completed',
    })
  })

  it('turns a failed required execution into an adapter error, never hook behavior', () => {
    const outcomes = completedOutcomes().map((outcome) => outcome.scenarioId === 'sequence:alternating-swaps'
      ? { ...outcome, status: 'failed' as const, reason: 'worker terminated' }
      : outcome)
    const result = evaluatePublicHackenCases({ pools: [pool], outcomes })
      .find((item) => item.id === 'swap-sequential')
    expect(result).toMatchObject({ status: 'error', reason: 'worker terminated' })
  })

  it('distinguishes partial compatibility from a contradicted completion expectation', () => {
    const mixed = completedOutcomes().map((outcome) => outcome.scenarioId === 'swap:exact-input:1-for-0:small'
      ? { ...outcome, status: 'reverted' as const, proof: replayProof({}) }
      : outcome)
    const mixedResult = evaluatePublicHackenCases({ pools: [pool], outcomes: mixed, poolManager: POOL_MANAGER })
      .find((item) => item.id === 'swap-both-directions')
    expect(mixedResult).toMatchObject({ status: 'warning', observedOutcome: 'mixed' })
    expect(mixedResult?.reason).toContain('1/2')

    const rejected = completedOutcomes().map((outcome) => outcome.scenarioId.startsWith('swap:exact-input:')
      ? { ...outcome, status: 'reverted' as const, proof: replayProof({}) }
      : outcome)
    const failedResult = evaluatePublicHackenCases({ pools: [pool], outcomes: rejected, poolManager: POOL_MANAGER })
      .find((item) => item.id === 'swap-both-directions')
    expect(failedResult).toMatchObject({ status: 'failed', observedOutcome: 'reverted' })
  })

  it('does not call a completed zero-movement swap compatible', () => {
    const outcomes = completedOutcomes().map((outcome) => outcome.scenarioId === 'swap:exact-input:0-for-1:small'
      ? { ...outcome, proof: replayProof({ movement: 'zero' }) }
      : outcome)
    const result = evaluatePublicHackenCases({ pools: [pool], outcomes, poolManager: POOL_MANAGER })
      .find((item) => item.id === 'swap-small')
    expect(result).toMatchObject({ status: 'failed', observedOutcome: 'no-movement' })
    expect(result?.reason).toContain('zero movement')
  })

  it('marks zero-movement swaps with zero active liquidity unavailable instead of contradicted', () => {
    const outcomes = completedOutcomes().map((outcome) => outcome.scenarioId === 'swap:exact-input:0-for-1:small'
      ? { ...outcome, proof: replayProof({ movement: 'zero', liquidity: 0n }) }
      : outcome)
    const result = evaluatePublicHackenCases({ pools: [pool], outcomes, poolManager: POOL_MANAGER })
      .find((item) => item.id === 'swap-small')
    expect(result).toMatchObject({ status: 'unavailable', observedOutcome: 'no-movement' })
    expect(result?.reason).toContain('zero active liquidity')
    expect(result?.reason).toContain('unavailable rather than contradicted')
  })

  it('marks donation rejection caused only by zero active liquidity unavailable', () => {
    const outcomes = completedOutcomes().map((outcome) => outcome.scenarioId === 'donate:minimal'
      ? { ...outcome, status: 'reverted' as const, proof: replayProof({ revert: 'NoLiquidityToReceiveFees' }) }
      : outcome)
    const result = evaluatePublicHackenCases({ pools: [pool], outcomes, poolManager: POOL_MANAGER })
      .find((item) => item.id === 'donate-dust')
    expect(result).toMatchObject({ status: 'unavailable', observedOutcome: 'reverted' })
    expect(result?.reason).toContain('missing pool-state prerequisite')
  })

  it('requires the expected reinitialization rejection instead of treating any revert as a pass', () => {
    const wrongRevert = completedOutcomes().map((outcome) => outcome.scenarioId === 'initialize:reinitialize'
      ? { ...outcome, proof: replayProof({}) }
      : outcome)
    const result = evaluatePublicHackenCases({ pools: [pool], outcomes: wrongRevert, poolManager: POOL_MANAGER })
      .find((item) => item.id === 'reinitialize')
    expect(result).toMatchObject({ status: 'warning', observedOutcome: 'reverted' })
  })

  it('publishes one explicit coverage manifest and excludes fixture-only cases from public counts', () => {
    const evidence = publicHackenSuiteEvidence({
      poolManager: POOL_MANAGER,
      pools: [pool],
      outcomes: completedOutcomes(),
    })
    expect(evidence.detectorId).toBe('hacken-public-pool-suite')
    expect(evidence.technical?.catalogueSize).toBe(40)
    expect(evidence.technical?.fixtureOnly).toBeGreaterThan(0)
    expect(evidence.claim).toContain('fixture-specific cases were classified but excluded')
    expect(evidence.claim).toContain('assertions over shared execution evidence')
    expect(evidence.technical?.passed).toBeGreaterThan(0)
    expect(evidence.technical?.executionSources).toEqual([
      'protocol-native-generated',
      'hook-runtime-probe',
    ])
  })

  it('counts only runtime calls that returned execution evidence', () => {
    const evidence = publicHackenSuiteEvidence({
      poolManager: POOL_MANAGER,
      pools: [pool],
      outcomes: [],
      runtimeProbes: [
        {
          caseId: 'permissions-match-address',
          poolId: pool.poolId,
          hook: pool.hook,
          status: 'passed',
          reason: 'canonical response',
          scenarioIds: ['runtime:getHookPermissions'],
        },
        {
          caseId: 'base-hook-pool-manager',
          poolId: pool.poolId,
          hook: pool.hook,
          status: 'error',
          reason: 'shared deadline exhausted before execution',
        },
      ],
    })
    expect(evidence.technical?.runtimeExecutionCount).toBe(1)
    expect(evidence.technical?.executionCount).toBe(1)
  })
})
