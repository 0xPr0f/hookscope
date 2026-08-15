import type { AnalysisReport, Evidence } from '../../domain/report'

export type ScenarioConsoleStatus = 'PASS' | 'COMPATIBLE' | 'WARN' | 'FAIL' | 'CONTRADICTED' | 'OBSERVED' | 'REVERT' | 'NOOP' | 'COVERED' | 'UNAVAILABLE' | 'ERROR' | 'SKIP'

/** Console labels. Kept apart from the status so a label may contain a space. */
export const SCENARIO_STATUS_LABELS: Record<ScenarioConsoleStatus, string> = {
  PASS: 'PASS',
  COMPATIBLE: 'COMPATIBLE',
  WARN: 'BEHAVIOR DIFFERS',
  FAIL: 'FAIL',
  CONTRADICTED: 'CONTRADICTED',
  OBSERVED: 'OBSERVED',
  REVERT: 'OBSERVED REVERT',
  NOOP: 'NO MOVEMENT',
  COVERED: 'COVERED BY ROUND TRIP',
  UNAVAILABLE: 'UNAVAILABLE',
  ERROR: 'ERROR',
  SKIP: 'SKIP',
}

export type ScenarioConsoleLine = {
  id: string
  section: string
  name: string
  status: ScenarioConsoleStatus
  /** What the test is designed to exercise, independent of its outcome. */
  description?: string
  gasUsed?: string
  /** What happened in this execution. */
  detail?: string
  /** Raw EVM calls represented by this one reported scenario. */
  executions?: number
}

export type ScenarioConsoleSuite = {
  id: 'hacken-port' | 'hacken-public' | 'generated-protocol' | 'erc20-lane' | 'live-context'
  name: string
  description: string
  version: string
  ran: boolean
  lines: ScenarioConsoleLine[]
  passed: number
  warned?: number
  failed: number
  observed: number
  covered?: number
  unavailable: number
  errored: number
  skipped: number
  executions: number
  elapsedMs?: number
  reason?: string
}

/**
 * The public-pool adaptation evaluates bounded Hacken-derived expectations over
 * generated pinned executions. It does not rerun equivalent calldata, and its
 * pass/fail result remains scoped to the named operation and pinned state.
 */
function diagnosticSummaries(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const diagnostic = record(item)
    const summary = stringValue(diagnostic?.summary)
    return summary ? [summary] : []
  })
}

function movementResult(value: unknown) {
  const movement = record(value)
  if (!movement) return undefined
  const events = numberValue(movement.events)
  const movedEvents = numberValue(movement.movedEvents)
  const zeroMovement = movement.zeroMovement === true
  if (events === undefined || movedEvents === undefined) return undefined
  return { events, movedEvents, zeroMovement }
}

function publicHackenSuite(report: AnalysisReport): ScenarioConsoleSuite {
  const manifest = report.findings.find((finding) => finding.detectorId === 'hacken-public-pool-suite')
  const cases = Array.isArray(manifest?.technical?.cases) ? manifest.technical.cases : []
  const lines = cases.flatMap((value, index): ScenarioConsoleLine[] => {
    const item = record(value)
    if (!item || stringValue(item.classification) === 'fixture-only') return []
    const status = stringValue(item.status)
    const poolId = stringValue(item.poolId) ?? ''
    const upstream = stringValue(item.upstream) ?? stringValue(item.id) ?? `case-${index}`
    const observedOutcome = stringValue(item.observedOutcome)
    const movement = movementResult(item.swapMovement)
    const diagnostics = diagnosticSummaries(item.revertDiagnostics)
    const executionCount = Array.isArray(item.scenarioIds) ? item.scenarioIds.length : 0
    const expectation = stringValue(item.expectation)
    const reason = stringValue(item.reason)
    const observationDetail = status === 'observed'
      ? observedOutcome === 'no-movement' && movement
        ? `${movement.events} Swap event${movement.events === 1 ? '' : 's'} emitted, but every amount0/amount1 delta was zero. No currency exchange was observed.`
        : observedOutcome === 'reverted'
          ? diagnostics.join(' · ') || `${executionCount} pinned execution${executionCount === 1 ? '' : 's'} reached the PoolManager and reverted.`
          : observedOutcome === 'mixed'
            ? `The mapped executions produced mixed completed and reverted outcomes${diagnostics.length ? ` · ${diagnostics.join(' · ')}` : '.'}`
            : `${executionCount} pinned generated execution${executionCount === 1 ? '' : 's'} completed with a matching PoolManager event.`
      : [reason, ...diagnostics].filter(Boolean).join(' · ')
        || 'The prerequisites for this public-pool case were not proven.'
    const resultDetail = [
      expectation ? `Expected: ${expectation}` : undefined,
      `Result: ${observationDetail}`,
    ].filter(Boolean).join(' ')
    return [{
      id: `${poolId}:${stringValue(item.id) ?? index}`,
      section: `${stringValue(item.section)?.toUpperCase() ?? 'SCENARIO'} · POOL ${poolId.slice(0, 10)}`,
      name: normalizedTestName(upstream),
      status: status === 'passed' ? 'COMPATIBLE'
        : status === 'warning' ? 'WARN'
        : status === 'failed' ? 'CONTRADICTED'
        : status === 'observed'
        ? observedOutcome === 'reverted' ? 'REVERT'
          : observedOutcome === 'no-movement' ? 'NOOP'
          : 'OBSERVED'
        : status === 'error' ? 'ERROR'
        : 'UNAVAILABLE',
      description: stringValue(item.description) ?? 'Exercise the corresponding upstream scenario intent against the selected public pool.',
      gasUsed: numberValue(item.gasUsed)?.toString(),
      detail: resultDetail,
      executions: executionCount || undefined,
    }]
  })
  const statusCount = (status: ScenarioConsoleStatus) => lines.filter((line) => line.status === status).length
  const ran = Boolean(manifest)
  const skippedReason = 'The public Hacken-derived adaptation requires generated PoolManager executions against a selected hooked pool on a chain with certified deep execution.'
  return {
    id: 'hacken-public',
    name: 'HackenPublicPoolAssertions',
    description: 'Evaluates portable and proven conditional Hacken expectations against pinned executions on the selected deployed PoolManager and hook.',
    version: stringValue(report.engineVersions.hackenPublicPort)
      ?? stringValue(manifest?.technical?.version)
      ?? 'not-run',
    ran,
    lines: ran ? lines : [{
      id: 'hacken-public-skipped',
      section: 'SUITE',
      name: 'test_public_pool_adaptation()',
      status: 'SKIP',
      description: 'Map the portable Hacken catalogue to generated public-pool executions.',
      detail: skippedReason,
    }],
    passed: statusCount('COMPATIBLE'),
    warned: statusCount('WARN'),
    failed: statusCount('CONTRADICTED'),
    observed: statusCount('OBSERVED') + statusCount('REVERT') + statusCount('NOOP'),
    unavailable: statusCount('UNAVAILABLE'),
    errored: statusCount('ERROR'),
    skipped: ran ? 0 : 1,
    executions: numberValue(manifest?.technical?.executionCount) ?? 0,
    reason: ran ? undefined : skippedReason,
  }
}

const HACKEN_COMMIT = '965be6006eab54ff65b83285ef40a245c8735149'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : undefined
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function statusFromHackenFinding(finding: Evidence): ScenarioConsoleStatus {
  const status = stringValue(finding.technical?.status)
  if (status === 'failed') return 'FAIL'
  if (status === 'observed') return 'OBSERVED'
  return 'PASS'
}

function gasFromStepOutcomes(finding: Evidence) {
  const outcomes = finding.technical?.stepOutcomes
  if (!Array.isArray(outcomes)) return undefined
  let gas = 0n
  let found = false
  for (const value of outcomes) {
    const outcome = record(value)
    const raw = outcome?.gasUsed
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'bigint') continue
    try {
      gas += BigInt(raw)
      found = true
    } catch {
      // A malformed optional display field must never invalidate a report.
    }
  }
  return found ? gas.toString() : undefined
}

function executionsFromStepOutcomes(finding: Evidence) {
  const outcomes = finding.technical?.stepOutcomes
  return Array.isArray(outcomes) ? outcomes.length : 0
}

function normalizedTestName(value: string) {
  const normalized = value
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `test_${normalized || 'scenario'}()`
}

function elapsedFromPhase(report: AnalysisReport) {
  const detail = report.phases.find((phase) => phase.id === 'scenarios')?.detail
  const match = detail?.match(/(?:^|\s)(\d+)\s*ms(?:\s|$)/i)
  return match?.[1] ? Number(match[1]) : undefined
}

function hackenSuite(report: AnalysisReport): ScenarioConsoleSuite {
  const findings = report.findings.filter((finding) => finding.detectorId.startsWith('hacken-port-'))
  const lines = findings.map((finding): ScenarioConsoleLine => {
    const upstream = stringValue(finding.technical?.upstream) ?? finding.detectorId.replace('hacken-port-', '')
    return {
      id: finding.id,
      section: stringValue(finding.technical?.section)?.toUpperCase() ?? 'SCENARIO',
      name: normalizedTestName(upstream),
      status: statusFromHackenFinding(finding),
      description: finding.title.replace(/:\s*(passed|observed|failed)$/i, ''),
      gasUsed: gasFromStepOutcomes(finding),
      detail: 'Executed against the deterministic browser conformance fixture.',
    }
  })
  const ran = lines.length > 0
  const statusCount = (status: ScenarioConsoleStatus) => lines.filter((line) => line.status === status).length
  return {
    id: 'hacken-port',
    name: 'HackenPortFixtureConformance',
    description: 'Runs the complete port against a deterministic real-PoolManager fixture, where assertions have known expected outcomes.',
    version: ran ? report.engineVersions.hackenPort ?? report.scenarioVersion : `upstream@${HACKEN_COMMIT.slice(0, 12)}`,
    ran,
    lines: ran ? lines : [{
      id: 'hacken-port-skipped',
      section: 'SUITE',
      name: 'test_All()',
      status: 'SKIP',
      description: 'Run the complete deterministic browser-port conformance matrix.',
      detail: 'The complete port is a deterministic conformance suite and runs only for the generated PoolManager fixture on desktop.',
    }],
    passed: statusCount('PASS'),
    failed: statusCount('FAIL'),
    observed: statusCount('OBSERVED'),
    unavailable: 0,
    errored: 0,
    skipped: ran ? 0 : 1,
    executions: ran ? findings.reduce((total, finding) => total + executionsFromStepOutcomes(finding), 0) : 0,
    elapsedMs: ran ? elapsedFromPhase(report) : undefined,
    reason: ran
      ? undefined
      : 'For public pools Hookscope reports receipt-matched router → PoolManager observations; the complete assertion matrix remains tied to its deterministic generated fixture.',
  }
}

function liveOutcome(finding: Evidence) {
  const suffix = finding.title.match(/:\s*(completed|reverted)$/i)?.[1]?.toLowerCase()
  return suffix === 'reverted' ? 'reverted' : 'completed'
}

function legacyLiveScenarioId(finding: Evidence) {
  return finding.id.match(/^live-router:[^:]+:(.+):[0-9a-f]{8}$/i)?.[1]
}

function legacyLiveScenarioDescription(finding: Evidence) {
  return finding.title.replace(/:\s*(completed|reverted)$/i, '')
}

function liveSuite(report: AnalysisReport): ScenarioConsoleSuite {
  const fixtureSuiteRan = report.findings.some((finding) => finding.detectorId.startsWith('hacken-port-'))
  // Direct hook calls are intentionally excluded. They do not reproduce the
  // PoolManager call stack or its transient unlock context, so a revert there
  // is not a PoolManager scenario result. Only recognized-router executions that
  // reached the real PoolManager belong in this Foundry-style transcript.
  const findings = report.findings.filter((finding) => finding.detectorId === 'live-v4-router-variant')
  const lines = findings.map((finding): ScenarioConsoleLine => {
    const technical = finding.technical
    const scenarioId = stringValue(technical?.scenarioId) ?? legacyLiveScenarioId(finding)
    const scenarioDescription = stringValue(technical?.scenarioDescription) ?? legacyLiveScenarioDescription(finding)
    const label = stringValue(technical?.callback)
      ?? stringValue(technical?.mutation)
      ?? finding.detectorId
    const executionCount = numberValue(technical?.executionCount)
      ?? (stringValue(technical?.mutation) === 'repeated-sequence' ? 2 : 1)
    return {
      id: finding.id,
      section: 'ROUTER → POOLMANAGER SCENARIOS',
      name: normalizedTestName(scenarioId ?? label),
      status: 'OBSERVED',
      description: scenarioDescription,
      gasUsed: stringValue(technical?.gasUsed) ?? numberValue(technical?.gasUsed)?.toString(),
      detail: [
        `${liveOutcome(finding)} at pinned block`,
        executionCount > 1 ? `${executionCount} EVM executions; the final execution is reported` : undefined,
      ].filter(Boolean).join(' · '),
      executions: executionCount,
    }
  })
  const ran = lines.length > 0
  const phase = report.phases.find((item) => item.id === 'scenarios')
  const hasDeprecatedDirectProbes = report.findings.some((finding) => finding.detectorId === 'live-hook-callback-observation')
  const skippedReason = fixtureSuiteRan
    ? 'This deterministic fixture report already ran the complete browser port; live public-chain scenarios are a separate execution path.'
    : hasDeprecatedDirectProbes
      ? 'This older report contains direct hook probes. They are not PoolManager executions, so they are no longer presented as live scenario tests; run the analysis again for router-context results.'
    : phase?.detail ?? 'No eligible live PoolManager execution context was available.'
  return {
    id: 'live-context',
    name: 'LivePoolManagerScenarios',
    description: 'Replays receipt-matched historical router context and controlled variants when the outer calldata envelope is recognized.',
    version: report.scenarioVersion,
    ran,
    lines: ran ? lines : [{
      id: 'live-context-skipped',
      section: 'SUITE',
      name: 'test_live_context()',
      status: 'SKIP',
      description: 'Replay and vary a recognized historical router call that reached the selected PoolManager.',
      detail: skippedReason,
    }],
    passed: 0,
    failed: 0,
    observed: lines.length,
    unavailable: 0,
    errored: 0,
    skipped: ran ? 0 : 1,
    executions: ran ? lines.reduce((total, line) => total + (line.executions ?? 1), 0) : 0,
    reason: ran ? undefined : skippedReason,
  }
}

/**
 * Transcript for the generated PoolManager suite.
 *
 * Built from the suite manifest rather than from the observations alone, so a
 * scenario that was unavailable at the pinned block or that failed for
 * infrastructure reasons appears as its own line instead of vanishing. A revert
 * is labelled as an observation about the pool; only an analyzer malfunction is
 * an error.
 */
function generatedSuite(report: AnalysisReport): ScenarioConsoleSuite {
  const manifest = report.findings.find((finding) => finding.detectorId === 'protocol-native-scenario-suite')
  const gasById = new Map(
    report.findings
      .filter((finding) => finding.detectorId === 'protocol-native-scenario')
      .map((finding) => [
        `${stringValue(finding.affectedPools[0]) ?? ''}:${stringValue(finding.technical?.scenarioId) ?? ''}`,
        stringValue(finding.technical?.gasUsed) ?? numberValue(finding.technical?.gasUsed)?.toString(),
      ]),
  )
  const outcomes = Array.isArray(manifest?.technical?.outcomes) ? manifest.technical.outcomes : []
  const lines = outcomes.flatMap((value, index): ScenarioConsoleLine[] => {
    const outcome = record(value)
    const scenarioId = stringValue(outcome?.scenarioId)
    if (!outcome || !scenarioId) return []
    const status = stringValue(outcome.status)
    const poolId = stringValue(outcome.poolId) ?? ''
    const reason = stringValue(outcome.reason)
    const movement = movementResult(outcome.swapMovement)
    const diagnostic = record(outcome.revert)
    const diagnosticSummary = stringValue(diagnostic?.summary)
    const zeroMovement = status === 'completed' && movement?.zeroMovement
    const resultDetail = reason
      ?? diagnosticSummary
      ?? (zeroMovement
        ? `${movement.events} matching Swap event${movement.events === 1 ? '' : 's'} emitted with zero amount0 and amount1 deltas. No currency exchange was observed.`
        : status === 'reverted'
          ? 'The call entered the PoolManager and reverted; the selector was not decoded in this report.'
          : status === 'completed'
            ? 'Completed against the deployed PoolManager with a matching selected-pool event.'
            : 'The scenario did not produce a PoolManager observation.')
    return [{
      id: `${poolId}:${scenarioId}:${index}`,
      section: `${stringValue(outcome.operation)?.toUpperCase() ?? 'SCENARIO'} · POOL ${poolId.slice(0, 10)}`,
      name: normalizedTestName(scenarioId),
      status: zeroMovement ? 'NOOP'
        : status === 'completed' ? 'PASS'
        : status === 'reverted' ? 'REVERT'
        : status === 'unavailable' ? 'UNAVAILABLE'
        : 'ERROR',
      description: stringValue(outcome.description)
        ?? `Exercise the generated ${stringValue(outcome.operation) ?? 'PoolManager'} scenario ${scenarioId}.`,
      gasUsed: numberValue(outcome.gasUsed)?.toString() ?? gasById.get(`${poolId}:${scenarioId}`),
      detail: resultDetail,
    }]
  })
  const ran = lines.length > 0
  const statusCount = (status: ScenarioConsoleStatus) => lines.filter((line) => line.status === status).length
  const phase = report.phases.find((item) => item.id === 'generated')
  const skippedReason = phase?.detail
    ?? 'Generated PoolManager scenarios require a discovered pool on a chain with certified deep execution.'
  return {
    id: 'generated-protocol',
    name: 'GeneratedPoolManagerScenarios',
    description: 'Runs router-independent swaps, liquidity changes, donations, sequences, and direct invariants through a pinned generated harness.',
    version: stringValue(report.engineVersions.generatedScenarios) ?? 'not-run',
    ran,
    lines: ran ? lines : [{
      id: 'generated-protocol-skipped',
      section: 'SUITE',
      name: 'test_generated_scenarios()',
      status: 'SKIP',
      description: 'Run generated protocol-level scenarios against the selected PoolKey.',
      detail: skippedReason,
    }],
    passed: statusCount('PASS'),
    // A revert reached the PoolManager, so it is an observation, never a failure.
    failed: 0,
    observed: statusCount('REVERT') + statusCount('NOOP'),
    unavailable: statusCount('UNAVAILABLE'),
    errored: statusCount('ERROR'),
    skipped: ran ? 0 : 1,
    executions: statusCount('PASS') + statusCount('REVERT'),
    reason: ran ? undefined : skippedReason,
  }
}

/**
 * Transcript for the ERC-20 settlement lane.
 *
 * Shown beside the claims baseline rather than merged into it, because the pair
 * is the evidence: the same scenario reaching a different outcome on the two
 * settlement rails is what separates a token issue from pool or hook behavior.
 * Each line carries the lane reading, so a reader never has to infer it.
 */
function erc20LaneSuite(report: AnalysisReport): ScenarioConsoleSuite {
  const generatedManifest = report.findings.find((finding) => finding.detectorId === 'protocol-native-scenario-suite')
  const generatedOutcomes = Array.isArray(generatedManifest?.technical?.outcomes)
    ? generatedManifest.technical.outcomes
    : []
  const generatedDescriptions = new Map(generatedOutcomes.flatMap((value): [string, string][] => {
    const outcome = record(value)
    const id = stringValue(outcome?.scenarioId)
    const description = stringValue(outcome?.description)
    return id && description ? [[id, description]] : []
  }))
  const findings = report.findings.filter((finding) => finding.detectorId === 'protocol-native-erc20-lane')
  const lines = findings.map((finding): ScenarioConsoleLine => {
    const technical = finding.technical
    const status = stringValue(technical?.status)
    const comparison = record(technical?.laneComparison)
    const classifications = Array.isArray(technical?.classifications)
      ? technical.classifications.filter((item): item is string => typeof item === 'string')
      : []
    const shortfall = stringValue(technical?.shortfall)
    const roundTripCoverage = record(technical?.coveredByRoundTrip)
    const scenarioId = stringValue(technical?.scenarioId) ?? 'lane'
    return {
      id: finding.id,
      section: `ERC-20 SETTLEMENT · ${stringValue(comparison?.reading)?.toUpperCase().replaceAll('-', ' ') ?? 'LANE'}`,
      name: normalizedTestName(scenarioId),
      status: roundTripCoverage ? 'COVERED'
        : status === 'completed' ? 'PASS'
        : status === 'behavior-reverted' ? 'REVERT'
        : status === 'preparation-unavailable' ? 'UNAVAILABLE'
        : 'ERROR',
      description: stringValue(technical?.scenarioDescription)
        ?? generatedDescriptions.get(scenarioId)
        ?? (roundTripCoverage
          ? 'Exercise the token-input direction using the exact token output obtained by the committed native-to-token leg.'
          : 'Repeat the generated scenario using the deployed token transfer and allowance path instead of synthetic ERC-6909 claims.'),
      gasUsed: numberValue(technical?.gasUsed)?.toString(),
      detail: [
        stringValue(roundTripCoverage?.reason),
        classifications.join(', ') || undefined,
        shortfall && shortfall !== '0' ? `${shortfall} short of the requested amount` : undefined,
        stringValue(technical?.reason),
      ].filter(Boolean).join(' · ') || 'settled through the deployed token',
    }
  })
  const ran = lines.length > 0
  const statusCount = (status: ScenarioConsoleStatus) => lines.filter((line) => line.status === status).length
  const skippedReason = 'The ERC-20 settlement lane needs a real account that already holds the token, recovered from a receipt-matched replay. Without one the ERC-6909 claims baseline runs alone.'
  return {
    id: 'erc20-lane',
    name: 'Erc20SettlementLane',
    description: 'Repeats eligible generated scenarios through real token transfer and allowance semantics, then compares them with the claims-settlement baseline.',
    version: stringValue(report.engineVersions.erc20SettlementLane) ?? 'not-run',
    ran,
    lines: ran ? lines : [{
      id: 'erc20-lane-skipped',
      section: 'SUITE',
      name: 'test_erc20_settlement()',
      status: 'SKIP',
      description: 'Exercise the selected pool through the deployed token’s ERC-20 settlement path.',
      detail: skippedReason,
    }],
    passed: statusCount('PASS'),
    // A revert that reached the token is an observation about the token.
    failed: 0,
    observed: statusCount('REVERT'),
    covered: statusCount('COVERED'),
    unavailable: statusCount('UNAVAILABLE'),
    errored: statusCount('ERROR'),
    skipped: ran ? 0 : 1,
    executions: statusCount('PASS') + statusCount('REVERT'),
    reason: ran ? undefined : skippedReason,
  }
}

export function buildScenarioConsoleSuites(report: AnalysisReport): ScenarioConsoleSuite[] {
  const fixtureConformance = hackenSuite(report)
  const publicSuites = [publicHackenSuite(report), generatedSuite(report), erc20LaneSuite(report), liveSuite(report)]
  // Fixture and public reports are disjoint products. Mixing their suite cards
  // would make inapplicable paths look like tests that failed to run.
  return fixtureConformance.ran ? [fixtureConformance] : publicSuites
}

export const HACKEN_UPSTREAM_COMMIT = HACKEN_COMMIT
