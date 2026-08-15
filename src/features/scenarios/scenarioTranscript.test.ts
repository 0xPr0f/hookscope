import { describe, expect, it } from 'vitest'
import type { AnalysisReport, Evidence } from '../../domain/report'
import { buildScenarioConsoleSuites, type ScenarioConsoleSuite } from './scenarioTranscript'

/** Indexing by id keeps a suite assertion honest if the console order changes. */
function suite(suites: ScenarioConsoleSuite[], id: ScenarioConsoleSuite['id']) {
  const found = suites.find((item) => item.id === id)
  if (!found) throw new Error(`No ${id} suite in the console output.`)
  return found
}

function report(findings: Evidence[], scenarioDetail = 'No selected pool has a pinned historical context available for browser replay.'): AnalysisReport {
  return {
    schemaVersion: '1', id: crypto.randomUUID(), source: 'browser', status: 'completed', partial: false,
    chainId: 1, chainName: 'Ethereum', token: '0x0000000000000000000000000000000000000001',
    blockNumber: '1', blockHash: `0x${'1'.repeat(64)}`, blockTagPolicy: 'safe', createdAt: new Date().toISOString(), elapsedMs: 1,
    adapterVersion: 'test', scenarioVersion: 'hacken-live-router-context/0.4.0', engineVersions: { hackenPort: 'not-run' },
    capabilities: {
      discovery: { supported: true, status: 'passed' }, static: { supported: true, status: 'passed' },
      replay: { supported: false, status: 'degraded' }, fuzz: { supported: false, status: 'degraded' },
    },
    pools: [], poolCoverage: { discovered: 0, analyzed: 0, hasMore: false }, contractGraph: [], findings,
    phases: [
      { id: 'scenarios', label: 'Run pool scenarios', status: 'degraded', completed: 0, total: 0, detail: scenarioDetail },
      { id: 'generated', label: 'Run generated scenarios', status: 'degraded', completed: 0, total: 0, detail: scenarioDetail },
    ],
    scenarios: { completed: findings.length, total: findings.length }, coverage: { uniqueCodeHashes: 0, paths: 0, executions: 0, branches: 0 }, limitations: [],
  }
}

function finding(overrides: Partial<Evidence>): Evidence {
  return {
    id: 'finding', detectorId: 'hacken-port-swap', detectorVersion: '1', severity: 'info',
    evidenceClass: 'concrete-observation', subject: '0x0000000000000000000000000000000000000002',
    title: 'Swap behavior: passed', claim: 'Observed.', confidence: 'confirmed', affectedPools: [],
    reproducibility: 'replayed', ...overrides,
  }
}

describe('scenario console transcript', () => {
  it('maps Hacken assertions and gas totals to Foundry-style lines', () => {
    const suites = buildScenarioConsoleSuites(report([finding({
      technical: { upstream: 'test_Swap_SmallAmount', section: 'swap', status: 'passed', stepOutcomes: [{ gasUsed: '10' }, { gasUsed: '15' }] },
    })]))
    expect(suite(suites, 'hacken-port')).toMatchObject({ ran: true, passed: 1, failed: 0, executions: 2 })
    expect(suite(suites, 'hacken-port').lines[0]).toMatchObject({ status: 'PASS', name: 'test_test_Swap_SmallAmount()', gasUsed: '25' })
    expect(suites).toHaveLength(1)
  })

  it('does not present deprecated direct hook probes as PoolManager tests', () => {
    const suites = buildScenarioConsoleSuites(report([finding({
      detectorId: 'live-hook-callback-observation', title: 'Pre-swap callback: reverted',
      technical: { callback: 'beforeSwap', gasUsed: '42000' },
    })]))
    expect(suite(suites, 'live-context')).toMatchObject({ ran: false, observed: 0, failed: 0, skipped: 1 })
    expect(suite(suites, 'live-context').lines[0]).toMatchObject({ status: 'SKIP' })
    expect(suite(suites, 'live-context').reason).toContain('not PoolManager executions')
  })

  it('maps recognized-router execution observations into the live suite', () => {
    const suites = buildScenarioConsoleSuites(report([finding({
      detectorId: 'live-v4-router-variant', title: 'smaller amount: completed',
      technical: {
        scenarioId: 'custom-router:half-amount',
        scenarioDescription: 'the recognized custom-router payload with half the historical input amount',
        mutation: 'reduced-amount',
        executionCount: 1,
        gasUsed: '42000',
      },
    })]))
    expect(suite(suites, 'live-context')).toMatchObject({ ran: true, observed: 1, failed: 0, executions: 1 })
    expect(suite(suites, 'live-context').lines[0]).toMatchObject({
      status: 'OBSERVED',
      name: 'test_custom_router_half_amount()',
      description: 'the recognized custom-router payload with half the historical input amount',
      detail: 'completed at pinned block',
      gasUsed: '42000',
    })
  })

  it('counts both EVM calls represented by a repeated-sequence observation', () => {
    const suites = buildScenarioConsoleSuites(report([finding({
      detectorId: 'live-v4-router-variant', title: 'repeated sequence: reverted',
      technical: {
        scenarioId: 'repeated-sequence',
        scenarioDescription: 'the historical payload executed twice in one committed session; the second execution is observed',
        mutation: 'repeated-sequence',
        executionCount: 2,
      },
    })]))
    const live = suite(suites, 'live-context')
    expect(live.executions).toBe(2)
    expect(live.lines[0]).toMatchObject({
      name: 'test_repeated_sequence()',
      executions: 2,
      status: 'OBSERVED',
    })
    expect(live.lines[0]!.detail).toContain('2 EVM executions')
  })

  it('recovers unique names and descriptions from older live findings', () => {
    const suites = buildScenarioConsoleSuites(report([finding({
      id: 'live-router:abcdef123456:custom-router:quarter-amount:deadbeef',
      detectorId: 'live-v4-router-variant',
      title: 'the recognized custom-router payload with one quarter of the historical input amount: completed',
      technical: { mutation: 'reduced-amount', gasUsed: '41000' },
    })]))
    expect(suite(suites, 'live-context').lines[0]).toMatchObject({
      name: 'test_custom_router_quarter_amount()',
      description: 'the recognized custom-router payload with one quarter of the historical input amount',
      detail: 'completed at pinned block',
    })
  })

  it('shows explicit skip reasons when neither scenario path ran', () => {
    const suites = buildScenarioConsoleSuites(report([]))
    expect(suites.some((item) => item.id === 'hacken-port')).toBe(false)
    expect(suite(suites, 'live-context').lines[0]!.detail).toContain('No selected pool')
    expect(suite(suites, 'generated-protocol').lines[0]!.detail).toContain('No selected pool')
  })

  it('does not present fixture conformance as a skipped public-pool suite', () => {
    const suites = buildScenarioConsoleSuites(report([
      finding({
        id: 'protocol-scenario-suite', detectorId: 'protocol-native-scenario-suite',
        technical: { outcomes: [{ poolId: `0x${'ab'.repeat(32)}`, scenarioId: 'swap:small', operation: 'swap', status: 'completed' }] },
      }),
    ]))
    expect(suites.some((item) => item.id === 'hacken-port')).toBe(false)
    expect(suite(suites, 'generated-protocol')).toMatchObject({ ran: true, passed: 1 })
  })

  it('renders bounded public Hacken assertions without fixture-only cases', () => {
    const suites = buildScenarioConsoleSuites(report([
      finding({
        id: 'hacken-public-pool-suite', detectorId: 'hacken-public-pool-suite',
        title: 'Hacken-derived public-pool assertion suite',
        technical: {
          version: 'hacken-public-pool-assertions/0.3.0',
          executionCount: 3,
          cases: [
            {
              poolId: `0x${'ab'.repeat(32)}`, id: 'swap-small', upstream: 'SwapSuite.run_Swap_SmallAmount',
              section: 'swap', description: 'Tiny exact-input swap', classification: 'portable',
              status: 'passed', observedOutcome: 'completed', expectation: 'Complete every required execution.',
              reason: 'All required executions completed.', scenarioIds: ['swap:exact-input:0-for-1:small'], gasUsed: 42_000,
            },
            {
              poolId: `0x${'ab'.repeat(32)}`, id: 'reinitialize', upstream: 'InitializeSuite.run_Reinitialize_Reverts',
              section: 'initialize', description: 'Second initialize', classification: 'portable',
              status: 'unavailable', scenarioIds: [], reason: 'Direct initialize adapter not available.',
            },
            {
              poolId: `0x${'ab'.repeat(32)}`, id: 'router-policy-pair', upstream: 'HookAuthorization.run_Auth_RouterPolicyPair',
              section: 'authorization', description: 'Fixture mutator', classification: 'fixture-only',
              status: 'not-applicable', scenarioIds: [], reason: 'Fixture-only.',
            },
          ],
        },
      }),
    ]))
    const adapted = suite(suites, 'hacken-public')
    expect(adapted).toMatchObject({ ran: true, passed: 1, warned: 0, observed: 0, unavailable: 1, executions: 3 })
    expect(adapted.lines.map((line) => line.status)).toEqual(['COMPATIBLE', 'UNAVAILABLE'])
    expect(adapted.lines.some((line) => line.name.includes('RouterPolicy'))).toBe(false)
  })

  it('makes zero-movement swaps and decoded reverts explicit', () => {
    const suites = buildScenarioConsoleSuites(report([
      finding({
        id: 'hacken-public-pool-suite', detectorId: 'hacken-public-pool-suite',
        technical: {
          cases: [
            {
              poolId: `0x${'ab'.repeat(32)}`, id: 'swap-small', upstream: 'SwapSuite.run_Swap_SmallAmount',
              section: 'swap', description: 'Tiny exact-input swap', classification: 'portable', status: 'failed',
              expectation: 'Complete with non-zero movement.', reason: 'The execution completed without movement.',
              observedOutcome: 'no-movement', scenarioIds: ['swap:small'], swapMovement: { events: 1, movedEvents: 0, zeroMovement: true },
            },
            {
              poolId: `0x${'ab'.repeat(32)}`, id: 'donate-dust', upstream: 'DonateSuite.run_Donate_Dust',
              section: 'donate', description: 'Minimal donation', classification: 'portable', status: 'warning',
              expectation: 'Complete the donation.', reason: 'The donation was rejected.',
              observedOutcome: 'reverted', scenarioIds: ['donate:minimal'],
              revertDiagnostics: [{ summary: 'The pool had zero active liquidity at the current tick.' }],
            },
          ],
        },
      }),
    ]))
    const lines = suite(suites, 'hacken-public').lines
    expect(lines[0]).toMatchObject({
      status: 'CONTRADICTED',
      description: 'Tiny exact-input swap',
      detail: expect.stringContaining('completed without movement'),
    })
    expect(lines[1]).toMatchObject({
      status: 'WARN',
      description: 'Minimal donation',
      detail: expect.stringContaining('zero active liquidity'),
    })
  })

  it('renders generated scenarios as their own suite, reverts included', () => {
    const suites = buildScenarioConsoleSuites(report([
      finding({
        id: 'protocol-scenario-suite', detectorId: 'protocol-native-scenario-suite',
        title: 'Generated PoolManager scenario suite',
        technical: {
          outcomes: [
            { poolId: `0x${'ab'.repeat(32)}`, scenarioId: 'swap:exact-input:0-for-1:small', operation: 'swap', status: 'completed', gasUsed: 120_000 },
            { poolId: `0x${'ab'.repeat(32)}`, scenarioId: 'swap:hook-data:marker', operation: 'swap', status: 'reverted', gasUsed: 90_000 },
            { poolId: `0x${'ab'.repeat(32)}`, scenarioId: 'liquidity:*', operation: 'liquidity', status: 'unavailable', reason: 'The pool tick was not readable.' },
            { poolId: `0x${'ab'.repeat(32)}`, scenarioId: 'donate:both', operation: 'donate', status: 'failed', reason: 'worker died' },
          ],
        },
      }),
    ]))
    const generated = suite(suites, 'generated-protocol')
    expect(generated).toMatchObject({ ran: true, passed: 1, observed: 1, unavailable: 1, errored: 1, failed: 0 })
    expect(generated.lines.map((line) => line.status)).toEqual(['PASS', 'REVERT', 'UNAVAILABLE', 'ERROR'])
    expect(generated.lines[1]).toMatchObject({ name: 'test_swap_hook_data_marker()', gasUsed: '90000' })
    expect(generated.lines[3]!.detail).toBe('worker died')
  })

  it('renders the ERC-20 settlement lane as its own suite carrying the comparison', () => {
    const suites = buildScenarioConsoleSuites(report([
      finding({
        id: 'erc20-lane:a', detectorId: 'protocol-native-erc20-lane',
        title: 'Generated scenario settled in real ERC-20 with a shortfall',
        technical: {
          scenarioId: 'swap:exact-input:0-for-1:medium', status: 'completed', shortfall: '10',
          classifications: ['pool-received-less-than-requested'],
          laneComparison: { reading: 'both-lanes-agree' }, gasUsed: 120_000,
        },
      }),
      finding({
        id: 'erc20-lane:b', detectorId: 'protocol-native-erc20-lane',
        title: 'Generated scenario reverted settling in real ERC-20',
        technical: {
          scenarioId: 'swap:exact-input:1-for-0:medium', status: 'behavior-reverted',
          classifications: ['input-transfer-reverted'],
          laneComparison: { reading: 'token-settlement-specific' },
        },
      }),
      finding({
        id: 'erc20-lane:c', detectorId: 'protocol-native-erc20-lane',
        title: 'ERC-20 settlement lane unavailable for this pool',
        technical: { scenarioId: 'lane', status: 'preparation-unavailable', reason: 'no funded holder' },
      }),
      finding({
        id: 'erc20-lane:d', detectorId: 'protocol-native-erc20-lane',
        title: 'Token-input direction covered by committed round trip',
        technical: {
          scenarioId: 'swap:exact-input:1-for-0:small', status: 'preparation-unavailable',
          reason: 'no independent holder',
          coveredByRoundTrip: {
            method: 'committed-native-token-native',
            roundTripVersion: 'protocol-native-erc20-round-trip/0.7.0',
            reason: 'A committed native → token → native round trip exercised this token-input direction.',
          },
        },
      }),
    ]))
    const lane = suite(suites, 'erc20-lane')
    expect(lane).toMatchObject({ ran: true, passed: 1, observed: 1, covered: 1, unavailable: 1, failed: 0, errored: 0 })
    expect(lane.lines.map((line) => line.status)).toEqual(['PASS', 'REVERT', 'UNAVAILABLE', 'COVERED'])
    expect(lane.lines[0]!.detail).toContain('10 short of the requested amount')
    // The reading is visible on the line, not something a reader has to infer.
    expect(lane.lines[1]!.section).toContain('TOKEN SETTLEMENT SPECIFIC')
    expect(lane.lines[2]!.detail).toContain('no funded holder')
    expect(lane.lines[3]!.detail).toContain('committed native → token → native round trip')
  })

  it('skips the ERC-20 lane explicitly when no funded holder was available', () => {
    const lane = suite(buildScenarioConsoleSuites(report([])), 'erc20-lane')
    expect(lane).toMatchObject({ ran: false, skipped: 1 })
    expect(lane.lines[0]!.detail).toContain('real account that already holds the token')
  })

  it('keeps the generated suite separate from a degraded historical path', () => {
    const suites = buildScenarioConsoleSuites(report([
      finding({
        id: 'protocol-scenario-suite', detectorId: 'protocol-native-scenario-suite',
        technical: { outcomes: [{ poolId: `0x${'ab'.repeat(32)}`, scenarioId: 'swap:small', operation: 'swap', status: 'completed' }] },
      }),
    ]))
    // Historical replay produced nothing, and that must not read as a generated failure.
    expect(suite(suites, 'live-context').ran).toBe(false)
    expect(suite(suites, 'generated-protocol')).toMatchObject({ ran: true, passed: 1, errored: 0 })
  })

  it('provides suite and per-test descriptions for every transcript family', () => {
    const suites = buildScenarioConsoleSuites(report([
      finding({
        id: 'protocol-scenario-suite', detectorId: 'protocol-native-scenario-suite',
        technical: {
          outcomes: [{
            poolId: `0x${'ab'.repeat(32)}`, scenarioId: 'swap:small', operation: 'swap', status: 'completed',
            description: 'Exchange a bounded exact-input amount.',
          }],
        },
      }),
    ]))
    for (const item of suites) {
      expect(item.description.length).toBeGreaterThan(20)
      for (const line of item.lines) expect(line.description?.length).toBeGreaterThan(10)
    }
  })
})
