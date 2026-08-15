import type { Hex } from 'viem'

/**
 * Hand-assembled runtime fixtures for control-flow reachability.
 *
 * Each is small enough to read opcode by opcode, which matters because these
 * are the oracle: a reachability test whose expected answer is itself derived
 * from the analyzer proves nothing. Every offset and block boundary below was
 * measured from EVMole's actual output rather than assumed.
 *
 * The benign cases carry the most weight. A reachability engine that only ever
 * sees positives will happily replace one class of false positive with another,
 * so the set deliberately includes an opcode present but dead, a `CALLER` that
 * never touches the write beside it, and an `ORIGIN` used only for logging.
 */

export type CfgFixture = {
  id: string
  description: string
  bytecode: Hex
  /** Measured EVMole blocks: [id, start, end, type]. */
  expectedBlocks: [number, number, number, string][]
  /** Offsets of the opcodes this fixture is about, with their expected verdict. */
  expectedOpcodes: {
    offset: number
    opcode: string
    reachability: 'reachable' | 'unreachable' | 'unknown'
  }[]
}

export const CFG_FIXTURES: CfgFixture[] = [
  {
    id: 'dead-delegatecall-after-stop',
    description: 'A DELEGATECALL sitting after an unconditional STOP, which nothing jumps into.',
    bytecode: '0x6000600000600060006000600060006000f400',
    expectedBlocks: [[0, 0, 4, 'Terminate']],
    // EVMole emits no block covering offset 17: the traversal never arrived.
    expectedOpcodes: [{ offset: 17, opcode: 'DELEGATECALL', reachability: 'unreachable' }],
  },
  {
    id: 'live-delegatecall',
    description: 'A DELEGATECALL on the straight-line path from the entry point.',
    bytecode: '0x600060006000600060006000f400' as Hex,
    expectedBlocks: [[0, 0, 13, 'Terminate']],
    expectedOpcodes: [{ offset: 12, opcode: 'DELEGATECALL', reachability: 'reachable' }],
  },
  {
    id: 'live-selfdestruct',
    description: 'CALLER followed immediately by SELFDESTRUCT, both on the entry path.',
    bytecode: '0x33ff' as Hex,
    expectedBlocks: [[0, 0, 1, 'Terminate']],
    expectedOpcodes: [
      { offset: 0, opcode: 'CALLER', reachability: 'reachable' },
      { offset: 1, opcode: 'SELFDESTRUCT', reachability: 'reachable' },
    ],
  },
  {
    id: 'dead-selfdestruct-after-revert',
    description: 'A SELFDESTRUCT behind a JUMPI whose target is not a JUMPDEST, so the edge does not exist.',
    bytecode: '0x3660085760016000fd5bff' as Hex,
    expectedBlocks: [[0, 0, 3, 'Jump'], [4, 4, 8, 'Terminate']],
    expectedOpcodes: [{ offset: 10, opcode: 'SELFDESTRUCT', reachability: 'unreachable' }],
  },
  {
    id: 'caller-guards-store',
    description: 'CALLER compared, branched on, and the taken branch performs the SSTORE.',
    bytecode: '0x33600014600b57600080fd5b600160005500' as Hex,
    expectedBlocks: [[0, 0, 6, 'Jumpi'], [7, 7, 10, 'Terminate'], [11, 11, 17, 'Terminate']],
    expectedOpcodes: [
      { offset: 0, opcode: 'CALLER', reachability: 'reachable' },
      { offset: 16, opcode: 'SSTORE', reachability: 'reachable' },
    ],
  },
  {
    id: 'caller-unrelated-to-store',
    description: 'CALLER read and immediately POPped; the SSTORE beside it writes a constant.',
    bytecode: '0x3350600160005500' as Hex,
    expectedBlocks: [[0, 0, 7, 'Terminate']],
    // Both reachable. Reachability is not dependence, which is the point.
    expectedOpcodes: [
      { offset: 0, opcode: 'CALLER', reachability: 'reachable' },
      { offset: 6, opcode: 'SSTORE', reachability: 'reachable' },
    ],
  },
  {
    id: 'origin-log-only',
    description: 'ORIGIN written to memory and emitted in a log, guarding nothing.',
    bytecode: '0x3260005260206000a000' as Hex,
    expectedBlocks: [[0, 0, 9, 'Terminate']],
    expectedOpcodes: [{ offset: 0, opcode: 'ORIGIN', reachability: 'reachable' }],
  },
  {
    id: 'origin-guards-store',
    description: 'ORIGIN compared, branched on, and the taken branch performs the SSTORE.',
    bytecode: '0x32600014600b57600080fd5b600160005500' as Hex,
    expectedBlocks: [[0, 0, 6, 'Jumpi'], [7, 7, 10, 'Terminate'], [11, 11, 17, 'Terminate']],
    expectedOpcodes: [
      { offset: 0, opcode: 'ORIGIN', reachability: 'reachable' },
      { offset: 16, opcode: 'SSTORE', reachability: 'reachable' },
    ],
  },
]

export function cfgFixture(id: string): CfgFixture {
  const found = CFG_FIXTURES.find((fixture) => fixture.id === id)
  if (!found) throw new Error(`No CFG fixture named ${id}.`)
  return found
}
