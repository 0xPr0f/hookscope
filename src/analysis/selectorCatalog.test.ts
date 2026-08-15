import { describe, expect, it, vi } from 'vitest'
import { toFunctionSelector, type Address, type Hex } from 'viem'
import type { AnalysisReport } from '../domain/report'
import { resolveSelectorSignature } from '../domain/selectors'
import {
  collectReportSelectors,
  resolveReportSelectors,
} from './selectorCatalog'

const SUBJECT = '0x0000000000000000000000000000000000000001' as Address

function report(): AnalysisReport {
  return {
    contractGraph: [{
      address: SUBJECT,
      role: 'hook',
      codeHash: '0x01',
      bytecodeSize: 1,
      verifiedSource: true,
      selectors: [toFunctionSelector('owner()')],
      sourceMetadata: {
        provider: 'sourcify',
        match: 'exact_match',
        runtimeCodeHash: '0x01',
        functionSignatures: ['owner()'],
        eventSignatures: [],
      },
    }],
    findings: [{
      id: 'selector-evidence',
      detectorId: 'selector-evidence',
      detectorVersion: '1',
      severity: 'info',
      evidenceClass: 'concrete-observation',
      subject: SUBJECT,
      title: 'Selector observation',
      claim: 'The callback reverted with 0x007074c3.',
      confidence: 'confirmed',
      affectedPools: [],
      witness: {
        from: SUBJECT,
        to: SUBJECT,
        input: '0xa9059cbb00000000',
        value: '0',
        blockNumber: '1',
        expectedOutcome: 'revert',
      },
      reproducibility: 'replayed',
      technical: {
        calls: [{ selector: '0x70a08231' }],
        hookRuntime: [
          { selector: toFunctionSelector('getHookPermissions()') },
          { selector: toFunctionSelector('poolManager()') },
          { selector: toFunctionSelector('NotPoolManager()') },
          { selector: toFunctionSelector('beforeSwap(address,(address,address,uint24,int24,address),(bool,int256,uint160),bytes)') },
        ],
      },
    }],
    phases: [{ id: 'report', label: 'Normalize', status: 'completed', completed: 1, total: 1, detail: 'Saw 0x12345678' }],
    limitations: [],
    selectorSignatures: {},
  } as unknown as AnalysisReport
}

describe('report-wide selector catalog', () => {
  it('collects interface, technical, calldata, and human-readable selector surfaces', () => {
    expect(new Set(collectReportSelectors(report()))).toEqual(new Set([
      toFunctionSelector('owner()'),
      '0x007074c3',
      '0xa9059cbb',
      '0x70a08231',
      '0x12345678',
      toFunctionSelector('getHookPermissions()'),
      toFunctionSelector('poolManager()'),
      toFunctionSelector('NotPoolManager()'),
      toFunctionSelector('beforeSwap(address,(address,address,uint24,int24,address),(bool,int256,uint160),bytes)'),
    ]))
  })

  it('prefers exact ABI and canonical labels, then batches remaining selectors through Sourcify', async () => {
    const fetchCandidates = vi.fn(async (selectors: Hex[]) => Object.fromEntries(selectors.map((selector) => [
      selector,
      selector === '0x007074c3'
        ? [{ name: 'LiquidityFrozen()', source: 'sourcify-4byte' as const, hasVerifiedContract: true }]
        : [],
    ])))
    const result = await resolveReportSelectors({
      report: report(),
      signal: new AbortController().signal,
      fetchCandidates,
    })

    expect(resolveSelectorSignature(result.lookup, toFunctionSelector('owner()'), SUBJECT)?.candidate)
      .toMatchObject({ name: 'owner()', source: 'verified-contract-abi', subjects: [SUBJECT] })
    expect(resolveSelectorSignature(result.lookup, '0xa9059cbb')?.candidate)
      .toMatchObject({ name: 'transfer(address,uint256)', source: 'canonical-interface' })
    expect(resolveSelectorSignature(result.lookup, toFunctionSelector('getHookPermissions()'))?.candidate)
      .toMatchObject({ name: 'getHookPermissions()', source: 'canonical-interface' })
    expect(resolveSelectorSignature(result.lookup, toFunctionSelector('NotPoolManager()'))?.candidate)
      .toMatchObject({ name: 'NotPoolManager()', source: 'canonical-interface' })
    expect(resolveSelectorSignature(result.lookup, toFunctionSelector('beforeSwap(address,(address,address,uint24,int24,address),(bool,int256,uint160),bytes)'))?.candidate)
      .toMatchObject({
        name: 'beforeSwap(address,(address,address,uint24,int24,address),(bool,int256,uint160),bytes)',
        source: 'canonical-interface',
      })
    expect(resolveSelectorSignature(result.lookup, '0x007074c3')?.candidate)
      .toMatchObject({ name: 'LiquidityFrozen()', source: 'sourcify-4byte' })
    expect(fetchCandidates).toHaveBeenCalledWith(
      expect.arrayContaining(['0x007074c3', '0x12345678']),
      expect.any(AbortSignal),
    )
    expect(result.unresolved).toContain('0x12345678')
  })
})
