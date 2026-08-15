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
    expect(suite(suites, 'hacken-port')).toMatchObject({ ran: true, passed: 1, failed: 0 })
    expect(suite(suites, 'hacken-port').lines[0]).toMatchObject({ status: 'PASS', name: 'test_test_Swap_SmallAmount()', gasUsed: '25' })
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

  it('maps official-router execution observations into the live suite', () => {
    const suites = buildScenarioConsoleSuites(report([finding({
      detectorId: 'live-v4-router-variant', title: 'smaller amount: completed',
      technical: { mutation: 'smaller-amount', gasUsed: '42000' },
    })]))
    expect(suite(suites, 'live-context')).toMatchObject({ ran: true, observed: 1, failed: 0 })
    expect(suite(suites, 'live-context').lines[0]).toMatchObject({ status: 'OBSERVED', detail: 'completed at pinned block', gasUsed: '42000' })
  })

  it('shows explicit skip reasons when neither scenario path ran', () => {
    const suites = buildScenarioConsoleSuites(report([]))
    expect(suite(suites, 'hacken-port')).toMatchObject({ ran: false, skipped: 1 })
    expect(suite(suites, 'live-context').lines[0]!.detail).toContain('No selected pool')
    expect(suite(suites, 'generated-protocol').lines[0]!.detail).toContain('No selected pool')
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
})
