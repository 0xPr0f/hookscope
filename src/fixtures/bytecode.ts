import type { Address, Hex } from 'viem'
import type { StaticSubject } from '../domain/report'

const address = (suffix: string) => `0x${suffix.padStart(40, '0')}` as Address
const codeHash = (suffix: string) => `0x${suffix.padStart(64, '0')}` as Hex

export type StaticFixture = {
  name: string
  subject: StaticSubject
  expectedDetectors: string[]
}

export const STATIC_FIXTURES: StaticFixture[] = [
  {
    name: 'benign-return',
    subject: {
      address: address('1000'),
      role: 'hook',
      bytecode: '0x60006000f3',
      codeHash: codeHash('1000'),
      affectedPools: [],
    },
    expectedDetectors: [],
  },
  {
    name: 'unprotected-delegatecall',
    subject: {
      address: address('1040'),
      role: 'hook',
      bytecode: '0x60006000600060006000356000f400',
      codeHash: codeHash('1040'),
      affectedPools: [],
    },
    expectedDetectors: ['cfg-reachable-delegatecall'],
  },
  {
    name: 'origin-caller-gate',
    subject: {
      address: address('2080'),
      role: 'hook',
      bytecode: '0x323314600b5760016000555b00',
      codeHash: codeHash('2080'),
      affectedPools: [],
    },
    expectedDetectors: ['origin-opcode-present', 'caller-and-storage-present'],
  },
  {
    name: 'transient-sequence-gate',
    subject: {
      address: address('3040'),
      role: 'hook',
      bytecode: '0x600160005d60005c00',
      codeHash: codeHash('3040'),
      affectedPools: [],
    },
    expectedDetectors: ['transient-state'],
  },
  {
    name: 'reachable-selfdestruct',
    subject: {
      address: address('4080'),
      role: 'hook',
      bytecode: '0x33ff',
      codeHash: codeHash('4080'),
      affectedPools: [],
    },
    expectedDetectors: ['cfg-reachable-selfdestruct'],
  },
  {
    name: 'dead-delegatecall-after-stop',
    subject: {
      address: address('6010'),
      role: 'hook',
      // DELEGATECALL sits after an unconditional STOP with nothing jumping in.
      bytecode: '0x6000600000600060006000600060006000f400',
      codeHash: codeHash('6010'),
      affectedPools: [],
    },
    // Present, not reachable: the graded finding, never the reachable one.
    expectedDetectors: ['delegatecall-opcode-present'],
  },
  {
    name: 'dead-selfdestruct-behind-invalid-jump',
    subject: {
      address: address('6020'),
      role: 'hook',
      bytecode: '0x3660085760016000fd5bff',
      codeHash: codeHash('6020'),
      affectedPools: [],
    },
    expectedDetectors: ['selfdestruct-opcode-present'],
  },
  {
    name: 'revm-storage-diff',
    subject: {
      address: address('5100'),
      role: 'dependency',
      bytecode: '0x600160005500',
      codeHash: codeHash('5100'),
      affectedPools: [],
    },
    expectedDetectors: [],
  },
  {
    name: 'calldata-dependent-state',
    subject: {
      address: address('6100'),
      role: 'dependency',
      // calldata == 0 stores 2; non-zero calldata stores 1.
      bytecode: '0x600035600014600f576001600055005b600260005500',
      codeHash: codeHash('6100'),
      affectedPools: [],
    },
    expectedDetectors: [],
  },
]

export const FIXTURE_SCAN_ADDRESS = address('f17e')
export const REVM_EXECUTION_FIXTURE = STATIC_FIXTURES.find((fixture) => fixture.name === 'revm-storage-diff')!
export const REVM_EXPLORATION_FIXTURE = STATIC_FIXTURES.find((fixture) => fixture.name === 'calldata-dependent-state')!
