import type { Address, Hex } from 'viem'
import type { SelectorSignatureLookup } from '../data/signatureDatabase'
import type { Evidence, PoolDescriptor } from '../domain/report'
import { decodeHookPermissions, type HookPermission } from '../domain/hooks'
import type { ProtocolScenarioOutcome } from './protocolScenarioRunner'
import type { PublicHackenRuntimeProbe } from './publicHackenRuntime'
import {
  decodeProtocolRevert,
  summarizeProtocolSwapMovement,
  type ProtocolRevertDiagnostic,
  type ProtocolSwapMovement,
} from './protocolScenarioDiagnostics'

/**
 * Public-pool assertion adaptation of the Hacken scenario catalogue.
 *
 * The deterministic fixture remains the oracle for the complete upstream port.
 * This module evaluates portable upstream expectations against the selected
 * deployed PoolManager + hook at the pinned block. It reuses the exact generated
 * executions instead of replaying equivalent calldata a second time. The result
 * is deliberately bounded to those executions; it is not a universal verdict.
 */

// 0.6.0 requires paired PoolManager-mediated/direct callback evidence, isolates
// optional selector failures, and counts only runtime calls that returned an
// execution proof. Older direct-revert results are not semantically equivalent.
export const PUBLIC_HACKEN_VERSION = 'hacken-public-pool-assertions/0.6.0'
export const PUBLIC_HACKEN_UPSTREAM_COMMIT = '965be6006eab54ff65b83285ef40a245c8735149'

export type PublicHackenClassification = 'portable' | 'conditional' | 'fixture-only'
export type PublicHackenStatus = 'passed' | 'warning' | 'failed' | 'observed' | 'unavailable' | 'error' | 'not-applicable'

type PublicHackenExpectation =
  | { kind: 'must-complete'; requireNonZeroSwap?: boolean }
  | { kind: 'must-revert'; expectedError?: string }
  | { kind: 'observe' }

type ScenarioRequirement = {
  /** Exact scenario id, or a prefix ending in `*`. */
  patterns: string[]
  minMatches?: number
}

type PublicCondition =
  | { kind: 'hook-permissions'; all?: HookPermission[]; any?: HookPermission[] }
  | { kind: 'dynamic-fee' }
  | { kind: 'runtime-probe'; reason: string }

export type PublicHackenCaseDefinition = {
  id: string
  upstream: string
  section: string
  description: string
  classification: PublicHackenClassification
  requirements: ScenarioRequirement[]
  expectation?: PublicHackenExpectation
  condition?: PublicCondition
  reason?: string
}

const exact = (...patterns: string[]): ScenarioRequirement => ({ patterns })
const prefix = (pattern: string, minMatches = 1): ScenarioRequirement => ({ patterns: [`${pattern}*`], minMatches })

/**
 * The catalogue intentionally contains all 40 upstream-derived cases.
 * Fixture-only cases remain in this machine-readable inventory for auditability
 * but are omitted from public-pool test lines.
 */
export const PUBLIC_HACKEN_CASES: readonly PublicHackenCaseDefinition[] = [
  { id: 'swap-small', upstream: 'SwapSuite.run_Swap_SmallAmount', section: 'swap', description: 'Tiny exact-input swap', classification: 'portable', requirements: [exact('swap:exact-input:0-for-1:small')], expectation: { kind: 'must-complete', requireNonZeroSwap: true } },
  { id: 'swap-both-directions', upstream: 'SwapSuite.run_Swap_BothDirections', section: 'swap', description: 'Exact input in both pool directions', classification: 'portable', requirements: [exact('swap:exact-input:0-for-1:small'), exact('swap:exact-input:1-for-0:small')], expectation: { kind: 'must-complete', requireNonZeroSwap: true } },
  { id: 'swap-exact-input-output', upstream: 'SwapSuite.run_Swap_ExactInput_vs_ExactOutput', section: 'swap', description: 'Exact input and exact output', classification: 'portable', requirements: [exact('swap:exact-input:0-for-1:small'), exact('swap:exact-output:0-for-1:small')], expectation: { kind: 'must-complete', requireNonZeroSwap: true } },
  { id: 'swap-sequential', upstream: 'SwapSuite.run_Swap_MultipleSequential', section: 'swap', description: 'Three alternating swaps in one state sequence', classification: 'portable', requirements: [exact('sequence:alternating-swaps')], expectation: { kind: 'must-complete', requireNonZeroSwap: true } },
  { id: 'swap-bounded-corpus', upstream: 'FuzzTestEntry.test_Fuzz_Swap_Amounts', section: 'swap', description: 'Bounded swap amount corpus', classification: 'portable', requirements: [prefix('swap:exact-input:', 6), prefix('swap:exact-output:', 6)], expectation: { kind: 'must-complete', requireNonZeroSwap: true } },
  { id: 'hook-data-empty', upstream: 'HookDataDetectionSuite.run_DetectHookDataRequirement', section: 'hook-data', description: 'Observe empty hookData behavior', classification: 'portable', requirements: [exact('swap:hook-data:empty')], expectation: { kind: 'observe' } },
  { id: 'hook-data-formats', upstream: 'HookDataDetectionSuite.run_ObserveHookDataFormats', section: 'hook-data', description: 'Empty, raw, and ABI-encoded hookData formats', classification: 'portable', requirements: [exact('swap:hook-data:empty'), exact('swap:hook-data:raw-four-byte'), exact('swap:hook-data:abi-actor')], expectation: { kind: 'observe' } },
  { id: 'liquidity-add-remove', upstream: 'LiquiditySuite.run_Liq_AddThenRemove', section: 'liquidity', description: 'Add then remove the same liquidity range', classification: 'portable', requirements: [exact('sequence:add-then-remove')] },
  { id: 'liquidity-multiple-adds', upstream: 'LiquiditySuite.run_Liq_MultipleAdds', section: 'liquidity', description: 'Three additions to one range', classification: 'portable', requirements: [exact('sequence:three-liquidity-adds')] },
  { id: 'liquidity-ranges', upstream: 'LiquiditySuite.run_Liq_DifferentRanges', section: 'liquidity', description: 'Multiple aligned liquidity ranges', classification: 'portable', requirements: [exact('liquidity:add:narrow'), exact('liquidity:add:wide'), exact('liquidity:add:range-full')] },
  { id: 'liquidity-partial-remove', upstream: 'LiquiditySuite.run_Liq_RemovePartial', section: 'liquidity', description: 'Add then remove half', classification: 'portable', requirements: [exact('sequence:partial-removal')] },
  { id: 'liquidity-bounded-amounts', upstream: 'FuzzTestEntry.test_Fuzz_Liq_Amounts', section: 'liquidity', description: 'Bounded liquidity amount corpus', classification: 'portable', requirements: [prefix('liquidity:add:amount-', 3)] },
  { id: 'liquidity-bounded-ranges', upstream: 'FuzzTestEntry.test_Fuzz_Liq_TickRanges', section: 'liquidity', description: 'Aligned boundary and full tick ranges', classification: 'portable', requirements: [prefix('liquidity:add:range-', 3)] },
  { id: 'donate-dust', upstream: 'DonateSuite.run_Donate_Dust', section: 'donate', description: 'Minimal donation', classification: 'portable', requirements: [exact('donate:minimal')] },
  { id: 'donate-both', upstream: 'DonateSuite.run_Donate_BothTokens', section: 'donate', description: 'Donate both currencies', classification: 'portable', requirements: [exact('donate:both')] },
  { id: 'donate-single', upstream: 'DonateSuite.run_Donate_SingleToken', section: 'donate', description: 'Donate each currency separately', classification: 'portable', requirements: [exact('donate:currency0'), exact('donate:currency1')] },
  { id: 'donate-sequential', upstream: 'DonateSuite.run_Donate_Multiple', section: 'donate', description: 'Three sequential donations', classification: 'portable', requirements: [exact('sequence:three-donations')] },
  { id: 'donate-bounded-corpus', upstream: 'FuzzTestEntry.test_Fuzz_Donate_Amounts', section: 'donate', description: 'Bounded donation amount corpus', classification: 'portable', requirements: [exact('donate:minimal'), exact('donate:currency0'), exact('donate:currency1'), exact('donate:both')] },
  { id: 'reinitialize', upstream: 'InitializeSuite.run_Reinitialize_Reverts', section: 'initialize', description: 'A second initialize call must revert', classification: 'portable', requirements: [exact('initialize:reinitialize')], expectation: { kind: 'must-revert', expectedError: 'PoolAlreadyInitialized' } },
  { id: 'only-pool-manager', upstream: 'HookAuthorization.run_Auth_OnlyPoolManager_OnEntrypoints', section: 'authorization', description: 'Direct non-PoolManager callback is rejected', classification: 'conditional', requirements: [], condition: { kind: 'runtime-probe', reason: 'Requires permission-selected direct callback executions in the pinned fork session.' } },
  { id: 'config-only-pool-manager', upstream: 'HookConfiguration.run_Config_OnlyPoolManagerGuard', section: 'configuration', description: 'Configuration guard rejects a direct callback', classification: 'fixture-only', requirements: [], reason: 'Depends on the fixture hook’s bespoke configuration policy.' },
  { id: 'secondary-pool-open-policy', upstream: 'HookAuthorization.run_Auth_ObserveSecondaryPool_OpenPolicy', section: 'authorization', description: 'Open pool policy accepts a second initialized PoolId', classification: 'conditional', requirements: [], condition: { kind: 'runtime-probe', reason: 'Requires a second discovered PoolId using the same deployed hook and currency pair.' } },
  { id: 'secondary-pool-restricted-policy', upstream: 'HookAuthorization.run_Auth_Rejects_UntrustedPoolKey', section: 'authorization', description: 'Restricted pool policy rejects a second PoolId', classification: 'fixture-only', requirements: [], reason: 'Depends on the fixture hook’s configurePoolPolicy mutator.' },
  { id: 'external-mutator-open-policy', upstream: 'HookAuthorization.run_Auth_ObserveOpenExternalMutator', section: 'authorization', description: 'Open configuration policy permits a second caller', classification: 'fixture-only', requirements: [], reason: 'Depends on the fixture hook’s configureRouter mutator.' },
  { id: 'external-mutator-restricted-policy', upstream: 'HookAuthorization.run_Auth_NoOpenExternalMutators', section: 'authorization', description: 'Restricted configuration policy rejects a second caller', classification: 'fixture-only', requirements: [], reason: 'Depends on the fixture hook’s configurePolicy and configureRouter mutators.' },
  { id: 'router-policy-pair', upstream: 'HookAuthorization.run_Auth_RouterPolicyPair', section: 'authorization', description: 'Open and selected-router operation paths', classification: 'fixture-only', requirements: [], reason: 'Depends on the fixture hook’s configurable router policy.' },
  { id: 'permissions-match-address', upstream: 'HookConfiguration.run_PermissionsMatchAddressFlags_ifExposed', section: 'configuration', description: 'Exposed permissions match hook address flags', classification: 'conditional', requirements: [], condition: { kind: 'runtime-probe', reason: 'Requires a canonical 14-boolean getHookPermissions() result at the pinned block.' } },
  { id: 'introspect-public-getters', upstream: 'HookIntrospectionSuite.run_Introspect_PublicGetters', section: 'configuration', description: 'PoolManager and permission getters are callable', classification: 'conditional', requirements: [], condition: { kind: 'runtime-probe', reason: 'Requires canonical getHookPermissions() and poolManager() results at the pinned block.' } },
  { id: 'introspect-optional-interface', upstream: 'HookIntrospectionSuite.run_Introspect_OptionalInterfaces', section: 'configuration', description: 'ERC-165 interface response is observed', classification: 'conditional', requirements: [], condition: { kind: 'runtime-probe', reason: 'Requires a canonical supportsInterface(bytes4) boolean result; absence is not a hook failure.' } },
  { id: 'base-hook-pool-manager', upstream: 'HookConfiguration.run_Config_BaseHookInheritanceHint', section: 'configuration', description: 'Exposed PoolManager identity matches the deployed manager', classification: 'conditional', requirements: [], condition: { kind: 'runtime-probe', reason: 'Requires a canonical poolManager() address result at the pinned block.' } },
  { id: 'selector-through-manager', upstream: 'HookConfiguration.run_Config_ReturnsOwnSelector_WhenCalledByManager', section: 'configuration', description: 'PoolManager accepts the hook callback selector', classification: 'portable', requirements: [exact('swap:exact-input:0-for-1:small')], expectation: { kind: 'must-complete', requireNonZeroSwap: true }, condition: { kind: 'hook-permissions', any: ['beforeSwap', 'afterSwap'] } },
  { id: 'swap-return-delta-signature', upstream: 'HookConfiguration.run_SwapReturnDelta_SignatureChecks', section: 'configuration', description: 'PoolManager decodes enabled swap return-delta tuple shapes', classification: 'conditional', requirements: [exact('swap:exact-input:0-for-1:small')], expectation: { kind: 'must-complete', requireNonZeroSwap: true }, condition: { kind: 'hook-permissions', any: ['beforeSwapReturnDelta', 'afterSwapReturnDelta'] } },
  { id: 'swap-non-zero-return-deltas', upstream: 'SwapDeltaEffects.run_NonZeroReturnDeltas', section: 'delta', description: 'PoolManager settles configured non-zero swap hook deltas', classification: 'fixture-only', requirements: [], reason: 'The upstream case forces values through the fixture-only configureReturnDeltas mutator.' },
  { id: 'swap-no-type-flip', upstream: 'SwapDeltaEffects.run_NoSwapTypeFlip_from_BeforeSwap', section: 'delta', description: 'Exact-input swaps remain executable in both directions', classification: 'portable', requirements: [exact('swap:exact-input:0-for-1:small'), exact('swap:exact-input:1-for-0:small')], expectation: { kind: 'must-complete', requireNonZeroSwap: true } },
  { id: 'swap-delta-settlement', upstream: 'SwapDeltaEffects.run_Settlement_SmokeSwap', section: 'delta', description: 'Tiny swaps settle in both directions', classification: 'portable', requirements: [exact('swap:exact-input:0-for-1:small'), exact('swap:exact-input:1-for-0:small')], expectation: { kind: 'must-complete', requireNonZeroSwap: true } },
  { id: 'lp-fee-override', upstream: 'SwapDeltaEffects.run_LPFeeOverride_Sanity', section: 'delta', description: 'Dynamic-fee swap settlement is observed', classification: 'conditional', requirements: [exact('swap:exact-input:0-for-1:small')], expectation: { kind: 'must-complete', requireNonZeroSwap: true }, condition: { kind: 'dynamic-fee' } },
  { id: 'liquidity-delta-settlement', upstream: 'LiquidityDeltaEffects.run_Settlement_Smoke_AddAndRemove', section: 'delta', description: 'Liquidity add/remove settlement', classification: 'portable', requirements: [exact('sequence:add-then-remove')] },
  { id: 'after-add-return-delta', upstream: 'LiquidityDeltaEffects.run_AfterAdd_ReturnsDelta_Informational', section: 'delta', description: 'PoolManager decodes enabled after-add return delta', classification: 'conditional', requirements: [exact('liquidity:add:amount-medium')], condition: { kind: 'hook-permissions', all: ['afterAddLiquidity', 'afterAddLiquidityReturnDelta'] } },
  { id: 'after-remove-return-delta', upstream: 'LiquidityDeltaEffects.run_AfterRemove_ReturnsDelta_Informational', section: 'delta', description: 'PoolManager decodes enabled after-remove return delta', classification: 'conditional', requirements: [exact('sequence:add-then-remove')], condition: { kind: 'hook-permissions', all: ['afterRemoveLiquidity', 'afterRemoveLiquidityReturnDelta'] } },
  { id: 'liquidity-non-zero-return-deltas', upstream: 'LiquidityDeltaEffects.run_NonZeroReturnDeltas', section: 'delta', description: 'PoolManager settles configured non-zero liquidity hook deltas', classification: 'fixture-only', requirements: [], reason: 'The upstream case forces values through the fixture-only configureReturnDeltas mutator.' },
] as const

export type PublicHackenCaseResult = {
  poolId: Hex
  hook: Address
  id: string
  upstream: string
  section: string
  description: string
  classification: PublicHackenClassification
  status: PublicHackenStatus
  expectation: string
  observedOutcome?: 'completed' | 'reverted' | 'mixed' | 'no-movement'
  scenarioIds: string[]
  gasUsed?: number
  revertDiagnostics?: ProtocolRevertDiagnostic[]
  swapMovement?: ProtocolSwapMovement
  reason?: string
  probeDetails?: Record<string, unknown>
}

function matches(pattern: string, scenarioId: string) {
  return pattern.endsWith('*')
    ? scenarioId.startsWith(pattern.slice(0, -1))
    : scenarioId === pattern
}

function conditionReason(definition: PublicHackenCaseDefinition, pool: PoolDescriptor) {
  const condition = definition.condition
  if (!condition) return undefined
  if (condition.kind === 'runtime-probe') return `The pinned runtime adaptation was unavailable. ${condition.reason}`
  if (condition.kind === 'dynamic-fee') {
    return pool.fee === 0x80_0000
      ? undefined
      : 'The selected pool does not advertise Uniswap v4 dynamic fees, so an LP-fee override case is not applicable.'
  }
  const permissions = new Set(decodeHookPermissions(pool.hook))
  if (condition.all?.some((permission) => !permissions.has(permission))) {
    return `The hook address does not enable every required callback flag: ${condition.all.join(', ')}.`
  }
  if (condition.any?.length && !condition.any.some((permission) => permissions.has(permission))) {
    return `The hook address enables none of the required callback flags: ${condition.any.join(', ')}.`
  }
  return undefined
}

function expectationFor(definition: PublicHackenCaseDefinition): PublicHackenExpectation {
  return definition.expectation ?? { kind: 'must-complete' }
}

function expectationText(expectation: PublicHackenExpectation) {
  if (expectation.kind === 'observe') return 'Record the pinned outcome without asserting completion or rejection.'
  if (expectation.kind === 'must-revert') {
    return expectation.expectedError
      ? `Reject every required execution with ${expectation.expectedError}.`
      : 'Reject every required execution.'
  }
  return expectation.requireNonZeroSwap
    ? 'Complete every required execution and emit non-zero selected-pool Swap movement.'
    : 'Complete every required execution against the selected PoolManager and PoolId.'
}

function evaluateCase(input: {
  definition: PublicHackenCaseDefinition
  pool: PoolDescriptor
  outcomes: ProtocolScenarioOutcome[]
  runtimeProbes?: PublicHackenRuntimeProbe[]
  poolManager?: Address
  selectorSignatures?: SelectorSignatureLookup
}): PublicHackenCaseResult {
  const { definition, pool, outcomes } = input
  const expectation = expectationFor(definition)
  const base = {
    poolId: pool.poolId,
    hook: pool.hook,
    id: definition.id,
    upstream: definition.upstream,
    section: definition.section,
    description: definition.description,
    classification: definition.classification,
    expectation: expectationText(expectation),
    scenarioIds: [] as string[],
  }

  if (definition.classification === 'fixture-only') {
    return { ...base, status: 'not-applicable', reason: definition.reason ?? 'This case depends on the deterministic fixture contract.' }
  }

  const runtimeProbe = input.runtimeProbes?.find((probe) =>
    probe.caseId === definition.id
    && probe.poolId.toLowerCase() === pool.poolId.toLowerCase())
  if (runtimeProbe) {
    return {
      ...base,
      status: runtimeProbe.status,
      reason: runtimeProbe.reason,
      gasUsed: runtimeProbe.gasUsed,
      scenarioIds: runtimeProbe.scenarioIds ?? [],
      observedOutcome: runtimeProbe.observedOutcome,
      probeDetails: runtimeProbe.details,
    }
  }

  const unavailableReason = conditionReason(definition, pool)
  if (unavailableReason) return { ...base, status: 'unavailable', reason: unavailableReason }
  if (!definition.requirements.length) {
    return { ...base, status: 'unavailable', reason: definition.reason ?? 'No public execution adapter is available for this case.' }
  }

  const selected = new Map<string, ProtocolScenarioOutcome>()
  for (const requirement of definition.requirements) {
    const matched = outcomes.filter((outcome) =>
      outcome.poolId.toLowerCase() === pool.poolId.toLowerCase()
      && requirement.patterns.some((pattern) => matches(pattern, outcome.scenarioId)))
    const executed = matched.filter((outcome) => outcome.status === 'completed' || outcome.status === 'reverted')
    const minimum = requirement.minMatches ?? 1
    for (const outcome of matched) selected.set(outcome.scenarioId, outcome)
    const failed = matched.find((outcome) => outcome.status === 'failed')
    if (failed || executed.length < minimum) {
      return {
        ...base,
        status: failed ? 'error' : 'unavailable',
        scenarioIds: [...selected.keys()],
        reason: failed?.reason
          ?? matched.find((outcome) => outcome.reason)?.reason
          ?? `Required public scenario coverage was incomplete (${executed.length}/${minimum} matching executions).`,
      }
    }
  }

  const executed = [...selected.values()].filter((outcome) => outcome.status === 'completed' || outcome.status === 'reverted')
  const completed = executed.filter((outcome) => outcome.status === 'completed').length
  const reverted = executed.filter((outcome) => outcome.status === 'reverted').length
  const revertDiagnostics = executed.flatMap((outcome) => {
    if (outcome.status !== 'reverted') return []
    const diagnostic = decodeProtocolRevert(outcome.proof?.proof.output, input.selectorSignatures)
    return diagnostic ? [diagnostic] : []
  })
  const movementParts = input.poolManager
    ? executed.flatMap((outcome) => {
        if (!outcome.proof) return []
        const movement = summarizeProtocolSwapMovement({
          proof: outcome.proof.proof,
          poolManager: input.poolManager!,
          poolId: pool.poolId,
        })
        return movement ? [movement] : []
      })
    : []
  const swapMovement = movementParts.length
    ? {
        events: movementParts.reduce((sum, item) => sum + item.events, 0),
        movedEvents: movementParts.reduce((sum, item) => sum + item.movedEvents, 0),
        zeroMovement: movementParts.every((item) => item.zeroMovement),
        deltas: movementParts.flatMap((item) => item.deltas).slice(0, 8),
      }
    : undefined
  const observedOutcome = completed && reverted
    ? 'mixed'
    : reverted
      ? 'reverted'
      : swapMovement?.zeroMovement
        ? 'no-movement'
        : 'completed'
  const gasUsed = executed.reduce((sum, outcome) => sum + (outcome.proof?.proof.gasUsed ?? 0), 0)

  if (expectation.kind === 'observe') {
    return {
      ...base,
      status: 'observed',
      observedOutcome,
      scenarioIds: executed.map((outcome) => outcome.scenarioId),
      gasUsed: gasUsed || undefined,
      revertDiagnostics: revertDiagnostics.length ? revertDiagnostics : undefined,
      swapMovement,
      reason: `Recorded ${completed} completed and ${reverted} reverted pinned execution${executed.length === 1 ? '' : 's'} without converting the observation into a compatibility assertion.`,
    }
  }

  if (expectation.kind === 'must-revert') {
    const expectedReverts = expectation.expectedError
      ? executed.filter((outcome) => outcome.status === 'reverted'
        && decodeProtocolRevert(outcome.proof?.proof.output, input.selectorSignatures)?.name === expectation.expectedError).length
      : reverted
    const status: PublicHackenStatus = expectedReverts === executed.length
      ? 'passed'
      : completed === executed.length
        ? 'failed'
        : 'warning'
    const reason = status === 'passed'
      ? `Every required pinned execution was rejected with ${expectation.expectedError ?? 'the expected rejection'}.`
      : status === 'failed'
        ? `The required execution completed, contradicting the expected ${expectation.expectedError ?? 'rejection'}.`
        : `${reverted}/${executed.length} required execution${executed.length === 1 ? '' : 's'} reverted, but ${expectedReverts}/${executed.length} matched ${expectation.expectedError ?? 'the expected rejection'}.`
    return {
      ...base,
      status,
      observedOutcome,
      scenarioIds: executed.map((outcome) => outcome.scenarioId),
      gasUsed: gasUsed || undefined,
      revertDiagnostics: revertDiagnostics.length ? revertDiagnostics : undefined,
      swapMovement,
      reason,
    }
  }

  const movementByScenario = new Map(executed.flatMap((outcome) => {
    if (outcome.status !== 'completed' || !input.poolManager || !outcome.proof) return []
    const movement = summarizeProtocolSwapMovement({
      proof: outcome.proof.proof,
      poolManager: input.poolManager,
      poolId: pool.poolId,
    })
    return movement ? [[outcome.scenarioId, movement] as const] : []
  }))
  if (expectation.requireNonZeroSwap) {
    const completedWithoutProof = executed.filter((outcome) => outcome.status === 'completed' && !movementByScenario.has(outcome.scenarioId))
    if (completedWithoutProof.length) {
      return {
        ...base,
        status: 'unavailable',
        observedOutcome,
        scenarioIds: executed.map((outcome) => outcome.scenarioId),
        gasUsed: gasUsed || undefined,
        revertDiagnostics: revertDiagnostics.length ? revertDiagnostics : undefined,
        swapMovement,
        reason: `Non-zero Swap movement could not be verified for ${completedWithoutProof.length} completed execution${completedWithoutProof.length === 1 ? '' : 's'}.`,
      }
    }
  }
  const satisfying = executed.filter((outcome) => outcome.status === 'completed'
    && (!expectation.requireNonZeroSwap || movementByScenario.get(outcome.scenarioId)?.zeroMovement === false)).length
  const status: PublicHackenStatus = satisfying === executed.length
    ? 'passed'
    : satisfying === 0
      ? 'failed'
      : 'warning'
  const reason = status === 'passed'
    ? expectation.requireNonZeroSwap
      ? `All ${executed.length} required pinned execution${executed.length === 1 ? '' : 's'} completed with non-zero selected-pool Swap movement.`
      : `All ${executed.length} required pinned execution${executed.length === 1 ? '' : 's'} completed against the selected PoolManager and PoolId.`
    : status === 'failed'
      ? `None of the ${executed.length} required execution${executed.length === 1 ? '' : 's'} met the completion expectation; ${reverted} reverted${swapMovement?.zeroMovement ? ' and the matching Swap events showed zero movement' : ''}.`
      : `${satisfying}/${executed.length} required execution${executed.length === 1 ? '' : 's'} met the expectation; ${reverted} reverted and ${executed.length - satisfying - reverted} completed without the required movement.`
  return {
    ...base,
    status,
    observedOutcome,
    scenarioIds: executed.map((outcome) => outcome.scenarioId),
    gasUsed: gasUsed || undefined,
    revertDiagnostics: revertDiagnostics.length ? revertDiagnostics : undefined,
    swapMovement,
    reason,
  }
}

export function evaluatePublicHackenCases(input: {
  pools: PoolDescriptor[]
  outcomes: ProtocolScenarioOutcome[]
  runtimeProbes?: PublicHackenRuntimeProbe[]
  poolManager?: Address
  selectorSignatures?: SelectorSignatureLookup
}) {
  return input.pools.flatMap((pool) => PUBLIC_HACKEN_CASES.map((definition) =>
    evaluateCase({
      definition,
      pool,
      outcomes: input.outcomes,
      runtimeProbes: input.runtimeProbes,
      poolManager: input.poolManager,
      selectorSignatures: input.selectorSignatures,
    })))
}

export function publicHackenSuiteEvidence(input: {
  poolManager: Address
  pools: PoolDescriptor[]
  outcomes: ProtocolScenarioOutcome[]
  runtimeProbes?: PublicHackenRuntimeProbe[]
  selectorSignatures?: SelectorSignatureLookup
}): Evidence {
  const cases = evaluatePublicHackenCases({
    pools: input.pools,
    outcomes: input.outcomes,
    runtimeProbes: input.runtimeProbes,
    poolManager: input.poolManager,
    selectorSignatures: input.selectorSignatures,
  })
  const publicCases = cases.filter((item) => item.classification !== 'fixture-only')
  const passed = publicCases.filter((item) => item.status === 'passed').length
  const warnings = publicCases.filter((item) => item.status === 'warning').length
  const failed = publicCases.filter((item) => item.status === 'failed').length
  const observed = publicCases.filter((item) => item.status === 'observed').length
  const unavailable = publicCases.filter((item) => item.status === 'unavailable').length
  const errors = publicCases.filter((item) => item.status === 'error').length
  const fixtureOnly = cases.filter((item) => item.classification === 'fixture-only').length
  const generatedExecutionCount = input.outcomes.filter((outcome) =>
    outcome.status === 'completed' || outcome.status === 'reverted').length
  const runtimeExecutionCount = new Set(
    (input.runtimeProbes ?? []).flatMap((probe) =>
      (probe.scenarioIds ?? []).map((scenarioId) => `${probe.poolId.toLowerCase()}:${scenarioId}`)),
  ).size
  const executionCount = generatedExecutionCount + runtimeExecutionCount
  return {
    id: 'hacken-public-pool-suite',
    detectorId: 'hacken-public-pool-suite',
    detectorVersion: '0.6.0',
    severity: failed ? 'medium' : warnings ? 'low' : 'info',
    evidenceClass: 'concrete-observation',
    subject: input.poolManager,
    title: 'Hacken-derived public-pool assertion suite',
    claim: `${passed} bounded expectations were compatible, ${warnings} produced mixed or differently explained behavior, ${failed} were contradicted, and ${observed} observation-only cases were recorded using pinned generated PoolManager executions and strict hook-runtime probes. ${unavailable} cases were unavailable and ${errors} encountered analyzer errors. ${fixtureOnly} fixture-specific cases were classified but excluded. One generated execution may satisfy more than one upstream expectation, so these case results are assertions over shared execution evidence rather than additional transactions or a universal hook verdict.`,
    confidence: 'confirmed',
    affectedPools: input.pools.map((pool) => pool.poolId).slice(0, 20),
    reproducibility: 'replayed',
    technical: {
      executionSources: ['protocol-native-generated', 'hook-runtime-probe'],
      version: PUBLIC_HACKEN_VERSION,
      upstreamCommit: PUBLIC_HACKEN_UPSTREAM_COMMIT,
      catalogueSize: PUBLIC_HACKEN_CASES.length,
      publicCaseRecords: publicCases.length,
      passed,
      warnings,
      failed,
      observed,
      unavailable,
      errors,
      fixtureOnly,
      executionCount,
      generatedExecutionCount,
      runtimeExecutionCount,
      runtimeProbeCount: input.runtimeProbes?.length ?? 0,
      cases,
    },
  }
}
