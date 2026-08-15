import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import artifact from '../fixtures/generated/dependency-fixtures-ast.json'

/**
 * Exercised against a checked-in real solc 0.8.26 AST emitted by
 * `forge build --ast`, not a hand-written approximation. The native CI lane
 * regenerates and diffs this fixture, while Vitest does not depend on Foundry's
 * ignored `out/` directory or on CI job ordering.
 */
// Evaluated from the exact file the worker loads with importScripts, rather
// than a copy: the package is ESM, so a plain require() would resolve it as an
// ES module and silently miss the UMD export.
function loadWorkerModule<T>(path: string): T {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8')
  const scope = { exports: {} as T }
  new Function('module', 'exports', 'self', source)(scope, scope.exports, {})
  return scope.exports
}

const { analyzeAstDependencies, SOURCE_KINDS, SINK_KINDS } = loadWorkerModule<{
  analyzeAstDependencies: (roots: { path: string; node: unknown }[]) => {
    sink: string
    sources: string[]
    function: string
    detail?: string
    sourcePath: string
    src?: string
  }[]
  SOURCE_KINDS: string[]
  SINK_KINDS: string[]
}>('../../public/astDependencies.js')

const dependencies = analyzeAstDependencies([
  { path: artifact.sourcePath, node: artifact.ast },
])

function forFunction(name: string) {
  return dependencies.filter((item) => item.function === name)
}

function has(name: string, sink: string, source: string) {
  return forFunction(name).some((item) => item.sink === sink && item.sources.includes(source))
}

describe('AST dependency analysis on real solc output', () => {
  it('parsed a real AST', () => {
    expect(artifact.compiler).toBe('0.8.26+commit.8a97fa7a')
    expect(artifact.ast.absolutePath).toBe(artifact.sourcePath)
    expect(artifact.ast).toBeTruthy()
    expect(dependencies.length).toBeGreaterThan(0)
    expect(SOURCE_KINDS).toContain('msg.sender')
    expect(SINK_KINDS).toContain('state-assignment')
    expect(SINK_KINDS).toContain('guarded-state-assignment')
  })

  it('finds msg.sender guarding a condition', () => {
    expect(has('senderGuardsAssignment', 'condition', 'msg.sender')).toBe(true)
    expect(has('senderGuardsAssignment', 'guarded-state-assignment', 'msg.sender')).toBe(true)
  })

  it('finds msg.sender written as the stored value', () => {
    expect(has('senderBecomesStoredValue', 'state-assignment', 'msg.sender')).toBe(true)
  })

  it('finds tx.origin guarding a require', () => {
    expect(has('originGuardsAssignment', 'condition', 'tx.origin')).toBe(true)
    expect(has('originGuardsAssignment', 'guarded-state-assignment', 'tx.origin')).toBe(true)
  })

  it('follows a parameter through a local into a state write', () => {
    // The write is `counter = doubled`, and `doubled` came from the parameter.
    expect(has('parameterReachesStorageThroughLocal', 'state-assignment', 'parameter')).toBe(true)
  })

  it('finds a parameter controlling a low-level call target', () => {
    expect(has('parameterControlsCallTarget', 'call-target', 'parameter')).toBe(true)
  })

  it('finds msg.value forwarded as the call value', () => {
    expect(has('valueControlsCallValue', 'call-value', 'msg.value')).toBe(true)
  })

  it('finds caller influence through a mapping key', () => {
    expect(has('senderChoosesMappingKey', 'state-assignment', 'msg.sender')).toBe(true)
  })

  it('uses the recipient and amount positions of four-argument safeTransferFrom', () => {
    expect(has('fourArgumentSafeTransfer', 'transfer-recipient', 'msg.sender')).toBe(true)
    expect(has('fourArgumentSafeTransfer', 'transfer-amount', 'msg.sender')).toBe(false)
  })
})

describe('benign cases stay benign', () => {
  it('does not claim a logged msg.sender reaches storage', () => {
    // The function writes storage and reads msg.sender, but the two are unrelated.
    expect(has('senderOnlyLogged', 'state-assignment', 'msg.sender')).toBe(false)
    expect(has('senderOnlyLogged', 'condition', 'msg.sender')).toBe(false)
  })

  it('does not promote a same-function condition that does not guard the write', () => {
    expect(has('senderConditionDoesNotGuardWrite', 'condition', 'msg.sender')).toBe(true)
    expect(has('senderConditionDoesNotGuardWrite', 'guarded-state-assignment', 'msg.sender')).toBe(false)
  })

  it('clears local taint when a parameter-derived local is overwritten by a constant', () => {
    expect(has('localTaintIsCleared', 'state-assignment', 'parameter')).toBe(false)
  })

  it('does not claim a logged tx.origin guards anything', () => {
    expect(forFunction('originOnlyLogged').filter((item) => item.sink === 'condition')).toEqual([])
    expect(forFunction('originOnlyLogged').filter((item) => item.sink === 'state-assignment')).toEqual([])
  })

  it('reports a configured call target as state, not as caller-controlled', () => {
    expect(has('configuredCallTarget', 'call-target', 'state')).toBe(true)
    expect(has('configuredCallTarget', 'call-target', 'parameter')).toBe(false)
    expect(has('configuredCallTarget', 'call-target', 'msg.sender')).toBe(false)
  })

  it('does not invent a state write from a local that never reaches one', () => {
    expect(forFunction('localNeverReachesStorage').some((item) => item.sink === 'state-assignment')).toBe(false)
    // It does return the value, which is a different and weaker claim.
    expect(has('localNeverReachesStorage', 'return-value', 'parameter')).toBe(true)
  })
})
