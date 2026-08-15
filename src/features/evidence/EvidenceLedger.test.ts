import { describe, expect, it } from 'vitest'
import type { Evidence, Severity } from '../../domain/report'
import { groupEvidenceBySeverity } from './evidenceGrouping'

function finding(id: string, severity: Severity): Evidence {
  return {
    id,
    detectorId: `detector-${id}`,
    detectorVersion: '1.0.0',
    severity,
    evidenceClass: 'deterministic-fact',
    subject: '0x0000000000000000000000000000000000000001',
    title: id,
    claim: `${id} claim`,
    confidence: 'confirmed',
    affectedPools: [],
    reproducibility: 'not-applicable',
  }
}

describe('groupEvidenceBySeverity', () => {
  it('orders evidence from critical through informational while preserving order inside each group', () => {
    const groups = groupEvidenceBySeverity([
      finding('info-one', 'info'),
      finding('medium-one', 'medium'),
      finding('critical-one', 'critical'),
      finding('medium-two', 'medium'),
      finding('high-one', 'high'),
      finding('low-one', 'low'),
    ])

    expect(groups.map((group) => group.severity)).toEqual(['critical', 'high', 'medium', 'low', 'info'])
    expect(groups.find((group) => group.severity === 'medium')?.findings.map((item) => item.id)).toEqual(['medium-one', 'medium-two'])
  })

  it('omits empty severity sections', () => {
    const groups = groupEvidenceBySeverity([finding('observed', 'info')])

    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ severity: 'info', label: 'Observed' })
  })
})
