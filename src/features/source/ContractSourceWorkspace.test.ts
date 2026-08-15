import { describe, expect, it } from 'vitest'
import type { SourcifyCompilationBundle } from '../../data/source'
import { selectPrimarySourcePath, sourceOutline } from './sourceSelection'

function bundle(): SourcifyCompilationBundle {
  return {
    match: 'exact_match',
    language: 'Solidity',
    compilerVersion: '0.8.26',
    fullyQualifiedName: 'src/Token.sol:Token',
    compilerSettings: {},
    sources: {
      'lib/Helper.sol': { content: 'library Helper {}' },
      'src/Token.sol': { content: 'contract Token {}' },
    },
    totalSourceBytes: 35,
    runtimeCodeHash: '0x01',
  }
}

describe('verified source file selection', () => {
  it('opens the compilation target first', () => {
    expect(selectPrimarySourcePath(bundle(), 'src/Token.sol:Token')).toBe('src/Token.sol')
  })

  it('falls back deterministically when the target path is unavailable', () => {
    expect(selectPrimarySourcePath(bundle(), 'src/Missing.sol:Missing')).toBe('lib/Helper.sol')
  })

  it('builds a bounded Solidity outline with source line numbers', () => {
    expect(sourceOutline('contract Token {\n  event Sent();\n  function transfer() external {}\n}')).toEqual([
      { kind: 'contract', name: 'Token', line: 1 },
      { kind: 'event', name: 'Sent', line: 2 },
      { kind: 'function', name: 'transfer', line: 3 },
    ])
  })
})
