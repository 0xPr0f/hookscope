import type { AnalysisReport, Evidence } from '../../domain/report'

export type ScenarioConsoleStatus = 'PASS' | 'FAIL' | 'OBSERVED' | 'REVERT' | 'UNAVAILABLE' | 'ERROR' | 'SKIP'

/** Console labels. Kept apart from the status so a label may contain a space. */
export const SCENARIO_STATUS_LABELS: Record<ScenarioConsoleStatus, string> = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  OBSERVED: 'OBSERVED',
  REVERT: 'OBSERVED REVERT',
  UNAVAILABLE: 'UNAVAILABLE',
  ERROR: 'ERROR',
  SKIP: 'SKIP',
}

export type ScenarioConsoleLine = {
  id: string
  section: string
  name: string
  status: ScenarioConsoleStatus
  gasUsed?: string
  detail?: string
}

export type ScenarioConsoleSuite = {
  id: 'hacken-port' | 'generated-protocol' | 'live-context'
  name: string
  version: string
  ran: boolean
  lines: ScenarioConsoleLine[]
  passed: number
  failed: number
  observed: number
  unavailable: number
  errored: number
  skipped: number
  executions: number
  elapsedMs?: number
  reason?: string
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
      gasUsed: gasFromStepOutcomes(finding),
      detail: finding.title.replace(/:\s*(passed|observed|failed)$/i, ''),
    }
  })
  const ran = lines.length > 0
  const statusCount = (status: ScenarioConsoleStatus) => lines.filter((line) => line.status === status).length
  return {
    id: 'hacken-port',
    name: 'HackenBrowserPort',
    version: ran ? report.engineVersions.hackenPort ?? report.scenarioVersion : `upstream@${HACKEN_COMMIT.slice(0, 12)}`,
    ran,
    lines: ran ? lines : [{
      id: 'hacken-port-skipped',
      section: 'SUITE',
      name: 'test_All()',
      status: 'SKIP',
      detail: 'The complete port is a deterministic conformance suite and runs only for the generated PoolManager fixture on desktop.',
    }],
    passed: statusCount('PASS'),
    failed: statusCount('FAIL'),
    observed: statusCount('OBSERVED'),
    unavailable: 0,
    errored: 0,
    skipped: ran ? 0 : 1,
    executions: ran ? report.coverage.executions : 0,
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

function liveSuite(report: AnalysisReport): ScenarioConsoleSuite {
  const fixtureSuiteRan = report.findings.some((finding) => finding.detectorId.startsWith('hacken-port-'))
  // Direct hook calls are intentionally excluded. They do not reproduce the
  // PoolManager call stack or its transient unlock context, so a revert there
  // is not a PoolManager scenario result. Only official-router executions that
  // reached the real PoolManager belong in this Foundry-style transcript.
  const findings = report.findings.filter((finding) => finding.detectorId === 'live-v4-router-variant')
  const lines = findings.map((finding): ScenarioConsoleLine => {
    const technical = finding.technical
    const label = stringValue(technical?.callback)
      ?? stringValue(technical?.mutation)
      ?? finding.detectorId
    return {
      id: finding.id,
      section: 'ROUTER → POOLMANAGER SCENARIOS',
      name: normalizedTestName(label),
      status: 'OBSERVED',
      gasUsed: stringValue(technical?.gasUsed) ?? numberValue(technical?.gasUsed)?.toString(),
      detail: `${liveOutcome(finding)} at pinned block`,
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
    version: report.scenarioVersion,
    ran,
    lines: ran ? lines : [{
      id: 'live-context-skipped',
      section: 'SUITE',
      name: 'test_live_context()',
      status: 'SKIP',
      detail: skippedReason,
    }],
    passed: 0,
    failed: 0,
    observed: lines.length,
    unavailable: 0,
    errored: 0,
    skipped: ran ? 0 : 1,
    executions: ran ? report.scenarios.completed : 0,
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
    return [{
      id: `${poolId}:${scenarioId}:${index}`,
      section: `${stringValue(outcome.operation)?.toUpperCase() ?? 'SCENARIO'} · POOL ${poolId.slice(0, 10)}`,
      name: normalizedTestName(scenarioId),
      status: status === 'completed' ? 'PASS'
        : status === 'reverted' ? 'REVERT'
        : status === 'unavailable' ? 'UNAVAILABLE'
        : 'ERROR',
      gasUsed: numberValue(outcome.gasUsed)?.toString() ?? gasById.get(`${poolId}:${scenarioId}`),
      detail: reason ?? (status === 'reverted'
        ? 'reverted inside the PoolManager call at pinned state'
        : 'executed against the deployed PoolManager at pinned state'),
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
    version: stringValue(report.engineVersions.generatedScenarios) ?? 'not-run',
    ran,
    lines: ran ? lines : [{
      id: 'generated-protocol-skipped',
      section: 'SUITE',
      name: 'test_generated_scenarios()',
      status: 'SKIP',
      detail: skippedReason,
    }],
    passed: statusCount('PASS'),
    // A revert reached the PoolManager, so it is an observation, never a failure.
    failed: 0,
    observed: statusCount('REVERT'),
    unavailable: statusCount('UNAVAILABLE'),
    errored: statusCount('ERROR'),
    skipped: ran ? 0 : 1,
    executions: statusCount('PASS') + statusCount('REVERT'),
    reason: ran ? undefined : skippedReason,
  }
}

export function buildScenarioConsoleSuites(report: AnalysisReport): ScenarioConsoleSuite[] {
  return [hackenSuite(report), generatedSuite(report), liveSuite(report)]
}

export const HACKEN_UPSTREAM_COMMIT = HACKEN_COMMIT
