import { describe, expect, it } from 'vitest'
import { contractInfo } from 'evmole'
import { CFG_FIXTURES, cfgFixture } from '../fixtures/cfgReachability'
import { buildCfgReachability, classifyOffset, normalizeBlock } from './cfgReachability'
import harnessManifest from '../fixtures/generated/protocol-scenario-router.json'

function analyze(bytecode: string) {
  return contractInfo(bytecode, { selectors: true, controlFlowGraph: true, disassemble: true })
}

describe('CFG normalization', () => {
  it('reads EVMole blocks whether they arrive as Maps or plain objects', () => {
    const asObject = { id: 4, start: 4, end: 9, type: 'Jumpi', data: { true_to: 11, false_to: 7 } }
    const asMap = new Map<string, unknown>([
      ['id', 4], ['start', 4], ['end', 9], ['type', 'Jumpi'],
      ['data', new Map<string, unknown>([['true_to', 11], ['false_to', 7]])],
    ])
    expect(normalizeBlock(asObject).successors).toEqual([11, 7])
    expect(normalizeBlock(asMap).successors).toEqual([11, 7])
  })

  it('treats a resolved dynamic jump as an edge and an unresolved one as a gap', () => {
    // EVMole's Wasm build returns an array of resolutions, not a single object.
    const resolved = normalizeBlock({
      id: 1, start: 1, end: 2, type: 'DynamicJump',
      data: { to: [{ path: [0], to: 40 }, { path: [0, 5], to: 60 }] },
    })
    expect(resolved.successors).toEqual([40, 60])
    expect(resolved.unresolvedDynamicJump).toBe(false)

    const partial = normalizeBlock({
      id: 1, start: 1, end: 2, type: 'DynamicJump',
      data: { to: [{ path: [0], to: 40 }, { path: [0, 9] }] },
    })
    expect(partial.successors).toEqual([40])
    expect(partial.unresolvedDynamicJump).toBe(true)

    const none = normalizeBlock({ id: 1, start: 1, end: 2, type: 'DynamicJump', data: {} })
    expect(none.unresolvedDynamicJump).toBe(true)
  })

  it('keeps the known fall-through of a computed conditional jump', () => {
    const block = normalizeBlock({
      id: 3, start: 3, end: 4, type: 'DynamicJumpi',
      data: { true_to: [{ path: [0] }], false_to: 12 },
    })
    // The taken edge is unknown, but the fall-through is a plain offset.
    expect(block.successors).toEqual([12])
    expect(block.unresolvedDynamicJump).toBe(true)
  })

  it('reports no successors for a terminating block', () => {
    expect(normalizeBlock({ id: 0, start: 0, end: 1, type: 'Terminate', data: { success: true } }).successors).toEqual([])
  })
})

describe('fixture block structure matches EVMole exactly', () => {
  it.each(CFG_FIXTURES)('$id has the measured blocks', (fixture) => {
    const graph = buildCfgReachability(analyze(fixture.bytecode))
    const actual = graph.blocks.map((block) => [block.id, block.start, block.end, block.type])
    expect(actual).toEqual(fixture.expectedBlocks)
  })
})

describe('opcode reachability', () => {
  it.each(CFG_FIXTURES)('$id classifies its opcodes as measured', (fixture) => {
    const graph = buildCfgReachability(analyze(fixture.bytecode))
    for (const expected of fixture.expectedOpcodes) {
      const verdict = classifyOffset(graph, expected.offset)
      expect(verdict.status, `${fixture.id} @${expected.offset} (${expected.opcode})`).toBe(expected.reachability)
    }
  })

  it('does not report dead code as reachable', () => {
    const fixture = cfgFixture('dead-delegatecall-after-stop')
    const graph = buildCfgReachability(analyze(fixture.bytecode))
    // The opcode is present in the disassembly but on no path at all.
    const disassembled = analyze(fixture.bytecode).disassembled ?? []
    expect(disassembled.some((item) => String(item[1]).toUpperCase() === 'DELEGATECALL')).toBe(true)
    expect(classifyOffset(graph, 17).status).toBe('unreachable')
  })

  it('separates reachability from dependence', () => {
    // Both fixtures reach CALLER and SSTORE; only one has CALLER guarding it.
    for (const id of ['caller-guards-store', 'caller-unrelated-to-store']) {
      const fixture = cfgFixture(id)
      const graph = buildCfgReachability(analyze(fixture.bytecode))
      for (const expected of fixture.expectedOpcodes) {
        expect(classifyOffset(graph, expected.offset).status).toBe('reachable')
      }
    }
  })
})

describe('unresolved computed jumps', () => {
  it('records a limitation rather than claiming dead code, on a real contract', () => {
    // A real viaIR contract: its dispatcher uses computed jumps.
    const graph = buildCfgReachability(analyze(harnessManifest.runtimeBytecode))
    expect(graph.blocks.length).toBeGreaterThan(100)
    expect(graph.entryPoints).toContain(0)
    // Whatever the resolution rate, an unresolved jump must downgrade a
    // non-reachable verdict to unknown rather than assert dead code.
    if (graph.hasUnresolvedJumps) {
      expect(graph.limitations.join(' ')).toContain('is unknown')
      const unreached = graph.blocks.find((block) => !graph.reachable.has(block.id))
      if (unreached) expect(classifyOffset(graph, unreached.start).status).toBe('unknown')
    }
  })
})
