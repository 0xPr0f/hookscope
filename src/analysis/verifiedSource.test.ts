import { describe, expect, it } from 'vitest'
import { keccak256, type Address } from 'viem'
import type { SourcifyCompilationBundle } from '../data/source'
import { buildAstCompilerInput, sourceSummaryEvidence } from './verifiedSource'

const SUBJECT = '0x1111111111111111111111111111111111111111' as Address

function bundle(): SourcifyCompilationBundle {
  return {
    match: 'match',
    language: 'Solidity',
    compilerVersion: '0.8.35+commit.47b9dedd',
    fullyQualifiedName: 'src/Hook.sol:Hook',
    compilerSettings: { optimizer: { enabled: true, runs: 1 }, evmVersion: 'cancun' },
    sources: { 'src/Hook.sol': { content: 'contract Hook {}' } },
    totalSourceBytes: 16,
    runtimeCodeHash: keccak256('0x6000'),
  }
}

describe('verified-source compiler pass', () => {
  it('preserves Sourcify settings while requesting only AST and compact target artifacts', () => {
    const input = buildAstCompilerInput(bundle())
    expect(input.settings).toMatchObject({
      optimizer: { enabled: true, runs: 1 },
      evmVersion: 'cancun',
      outputSelection: {
        '*': { '': ['ast'] },
        'src/Hook.sol': { Hook: ['abi', 'storageLayout', 'evm.methodIdentifiers'] },
      },
    })
  })

  it('normalizes compact AST facts without claiming whole-program proof', () => {
    const findings = sourceSummaryEvidence({
      subject: SUBJECT,
      affectedPools: [],
      summary: {
        fullyQualifiedName: 'src/Hook.sol:Hook',
        compilerVersion: '0.8.35+commit.47b9dedd',
        astNodeCount: 42,
        functions: [{ name: 'beforeSwap', visibility: 'external', modifiers: ['onlyPoolManager'], sourcePath: 'src/Hook.sol', src: '1:2:0' }],
        externalCalls: [{ operation: 'call', function: 'beforeSwap', modifiers: ['onlyPoolManager'], sourcePath: 'src/Hook.sol', src: '3:4:0' }],
        stateWrites: [{ variable: 'fee', function: 'beforeSwap', sourcePath: 'src/Hook.sol', src: '5:6:0' }],
        senderGates: [{ kind: 'require', function: 'beforeSwap', sourcePath: 'src/Hook.sol', src: '7:8:0' }],
        abi: [],
        storageLayout: { storage: [] },
        methodIdentifiers: {},
      },
    })
    expect(findings.map((finding) => finding.detectorId)).toEqual([
      'verified-source-surface',
      'verified-hook-callbacks',
      'verified-low-level-calls',
      'verified-state-control-map',
    ])
    expect(findings.every((finding) => finding.severity === 'info')).toBe(true)
    expect(findings.at(-1)?.claim).toContain('not a whole-program proof')
  })
})
