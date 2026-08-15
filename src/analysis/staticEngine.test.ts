import { describe, expect, it } from 'vitest'
import { contractInfo } from 'evmole'
import { STATIC_FIXTURES } from '../fixtures/bytecode'
import type { StaticSubject } from '../domain/report'
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

describe('EVMole-derived contract surface', () => {
  const subject: StaticSubject = {
    address: '0x1111111111111111111111111111111111111111',
    role: 'hook',
    codeHash: `0x${'ab'.repeat(32)}`,
    bytecode: '0x00',
    affectedPools: [],
  }

  function withEngine(info: Record<string, unknown>) {
    registerEvmoleContractInfo(() => info as never)
    try {
      return analyzeStaticSubjects([{ ...subject }])
    } finally {
      registerEvmoleContractInfo(contractInfo)
    }
  }

  it('reports payable entrypoints as a decoded fact', () => {
    const result = withEngine({
      functions: [
        { selector: 'aabbccdd', bytecodeOffset: 0, dispatch: 'abi', stateMutability: 'payable', arguments: 'uint256' },
        { selector: '11223344', bytecodeOffset: 4, dispatch: 'abi', stateMutability: 'view' },
      ],
    })
    const finding = result.findings.find((item) => item.detectorId === 'evmole-payable-entrypoints')!
    expect(finding.evidenceClass).toBe('deterministic-fact')
    expect(finding.claim).toContain('0xaabbccdd')
    expect(finding.claim).not.toContain('0x11223344')
  })

  it('maps which selector writes which storage slot', () => {
    const result = withEngine({
      storage: [
        { slot: '0', offset: 0, type: 'address', reads: ['8da5cb5b'], writes: ['f2fde38b'] },
        { slot: '1', offset: 0, type: 'uint256', reads: ['70a08231'], writes: [] },
      ],
      transientStorage: [
        { slot: 'a', offset: 0, type: 'uint256', reads: [], writes: ['deadbeef'] },
      ],
    })
    const persistent = result.findings.find((item) => item.detectorId === 'evmole-persistent-storage-writers')!
    expect(persistent.claim).toContain('slot 0 (address) by 0xf2fde38b')
    // A slot that is only read is not reported as written.
    expect(persistent.claim).not.toContain('slot 1')
    const transient = result.findings.find((item) => item.detectorId === 'evmole-transient-storage-writers')!
    expect(transient.severity).toBe('medium')
    expect(transient.claim).toContain('0xdeadbeef')
  })

  it('decodes the compiler version embedded in trailing CBOR metadata', () => {
    // 0x00,0x08,0x23 is how Solidity encodes 0.8.35.
    const result = withEngine({
      metadata: { bytecodeOffset: 100, cborLength: 51, entries: [{ key: 'solc', value: { type: 'bytes', value: '000823' } }] },
    })
    const finding = result.findings.find((item) => item.detectorId === 'evmole-embedded-compiler')!
    expect(finding.claim).toContain('solc 0.8.35')
    expect(finding.evidenceClass).toBe('deterministic-fact')
  })

  it('discloses computed jumps as an under-approximation rather than a finding', () => {
    const result = withEngine({
      controlFlowGraph: {
        blocks: [
          { id: 0, start: 0, end: 4, type: 'Jumpi', data: {} },
          { id: 1, start: 5, end: 9, type: 'DynamicJump', data: {} },
        ],
      },
    })
    const finding = result.findings.find((item) => item.detectorId === 'evmole-unresolved-control-flow')!
    expect(finding.evidenceClass).toBe('static-reachability')
    expect(finding.confidence).toBe('supported')
    expect(finding.claim).toContain('under-approximates')
  })

  it('stays silent when the contract has none of these traits', () => {
    const result = withEngine({ functions: [{ selector: 'aabbccdd', bytecodeOffset: 0, dispatch: 'abi', stateMutability: 'view' }] })
    for (const detector of [
      'evmole-payable-entrypoints',
      'evmole-fallback-dispatch',
      'evmole-persistent-storage-writers',
      'evmole-embedded-compiler',
      'evmole-unresolved-control-flow',
    ]) expect(result.findings.some((item) => item.detectorId === detector), detector).toBe(false)
  })
})
