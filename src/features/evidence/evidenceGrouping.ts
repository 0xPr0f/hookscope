import type { Evidence, Severity } from '../../domain/report'

export const EVIDENCE_SEVERITY_ORDER: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info']

export const EVIDENCE_SEVERITY_META: Record<Severity, { label: string; shortLabel: string; description: string }> = {
  critical: { label: 'Critical', shortLabel: 'C', description: 'Material behavior requiring immediate attention.' },
  high: { label: 'High', shortLabel: 'H', description: 'Significant behavior that should be reviewed first.' },
  medium: { label: 'Medium', shortLabel: 'M', description: 'Notable behavior that needs protocol and pool context.' },
  low: { label: 'Low', shortLabel: 'L', description: 'Limited-impact structural or implementation detail.' },
  info: { label: 'Observed', shortLabel: 'I', description: 'Decoded facts, execution results, and coverage records.' },
}

export type EvidenceGroup = {
  severity: Severity
  label: string
  description: string
  findings: Evidence[]
}

export function groupEvidenceBySeverity(findings: readonly Evidence[]): EvidenceGroup[] {
  return EVIDENCE_SEVERITY_ORDER.map((severity) => ({
    severity,
    ...EVIDENCE_SEVERITY_META[severity],
    findings: findings.filter((finding) => finding.severity === severity),
  })).filter((group) => group.findings.length > 0)
}
