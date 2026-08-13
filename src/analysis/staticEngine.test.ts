import { describe, expect, it } from 'vitest'
import { contractInfo } from 'evmole'
import { STATIC_FIXTURES } from '../fixtures/bytecode'
import { analyzeStaticSubjects, registerEvmoleContractInfo } from './staticEngine'

registerEvmoleContractInfo(contractInfo)

describe('static evidence engine', () => {
  for (const fixture of STATIC_FIXTURES) {
    it(`finds the declared evidence for ${fixture.name}`, () => {
      const result = analyzeStaticSubjects([fixture.subject])
      const detectors = new Set(result.findings.map((finding) => finding.detectorId))
      for (const expected of fixture.expectedDetectors) expect(detectors.has(expected)).toBe(true)
      if (fixture.expectedDetectors.length === 0) {
        expect(result.findings.filter((finding) => ['critical', 'high'].includes(finding.severity))).toEqual([])
      }
      expect(result.engineAvailability.evmole?.available).toBe(true)
      expect(result.engineAvailability.whatsabi?.available).toBe(true)
      expect(result.nodes.flatMap((node) => node.selectors).every((selector) => /^0x[0-9a-fA-F]*$/.test(selector))).toBe(true)
    })
  }

  it('validates Uniswap return-delta address-bit relationships', () => {
    const invalid = analyzeStaticSubjects([{
      address: '0x0000000000000000000000000000000000000008',
      role: 'hook',
      bytecode: '0x00',
      codeHash: '0x01',
      affectedPools: [],
    }])
    expect(invalid.findings.find((finding) => finding.detectorId === 'hook-return-delta-flag-relationship')?.severity).toBe('high')

    const valid = analyzeStaticSubjects([{
      address: '0x0000000000000000000000000000000000000088',
      role: 'hook',
      bytecode: '0x00',
      codeHash: '0x02',
      affectedPools: [],
    }])
    expect(valid.findings.find((finding) => finding.detectorId === 'hook-return-delta-flag-relationship')?.severity).toBe('info')
  })
})
