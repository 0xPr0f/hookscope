import { describe, expect, it } from 'vitest'
import type { Hex } from 'viem'
import { observationSummary, summarizeExecutionObservations } from './executionObservations'
import type { RevmExecutionProof } from './revmProof'

const HOOK = '0x2222222222222222222222222222222222222222'
const TOKEN = '0x1111111111111111111111111111111111111111'
const TRANSFER = `0x${'dd'.repeat(32)}` as Hex
const SWAP = `0x${'ee'.repeat(32)}` as Hex

function proof(overrides: Partial<RevmExecutionProof> = {}): RevmExecutionProof {
  return {
    engine: 'revm/36.0.0',
    success: true,
    gasUsed: 21_000,
    output: '0x',
    steps: [],
    storageOperations: [],
    calls: [],
    storageDiffs: [],
    balanceChanges: [],
    logs: [],
    logCount: 0,
    selfdestructs: [],
    truncated: false,
    ...overrides,
  }
}

describe('execution observation summary', () => {
  it('separates transient writes and reads from persistent writes', () => {
    const observations = summarizeExecutionObservations(proof({
      storageOperations: [
        { address: HOOK, pc: 1, opcode: 'SSTORE', slot: '0x01', value: '0x09' },
        { address: HOOK, pc: 2, opcode: 'TSTORE', slot: '0x02', value: '0x07' },
        { address: HOOK, pc: 3, opcode: 'TLOAD', slot: '0x02' },
        { address: HOOK, pc: 4, opcode: 'SLOAD', slot: '0x01' },
      ],
    }))

    expect(observations.persistentWrites).toBe(1)
    expect(observations.transientWrites).toEqual([{ address: HOOK, slot: '0x02', value: '0x07' }])
    expect(observations.transientReads).toEqual([{ address: HOOK, slot: '0x02' }])
  })

  it('attributes delegated storage operations to the storage context, not the implementation', () => {
    const observations = summarizeExecutionObservations(proof({
      storageOperations: [{
        frameId: 2,
        address: TOKEN,
        storageAddress: HOOK,
        pc: 4,
        opcode: 'TSTORE',
        slot: '0x03',
        value: '0x08',
      }],
    }))
    expect(observations.transientWrites).toEqual([{ address: HOOK, slot: '0x03', value: '0x08' }])
  })

  it('reports distinct event signatures and external selectors in first-seen order', () => {
    const observations = summarizeExecutionObservations(proof({
      logs: [
        { address: TOKEN, topics: [TRANSFER], data: '0x01' },
        { address: TOKEN, topics: [TRANSFER], data: '0x02' },
        { address: HOOK, topics: [SWAP], data: '0x' },
      ],
      logCount: 3,
      calls: [
        { caller: HOOK, target: TOKEN, bytecodeAddress: TOKEN, scheme: 'Call', value: '0', inputLength: 68, selector: '0xa9059cbb' },
        { caller: HOOK, target: TOKEN, bytecodeAddress: TOKEN, scheme: 'Call', value: '0', inputLength: 68, selector: '0xa9059cbb' },
        { caller: HOOK, target: TOKEN, bytecodeAddress: TOKEN, scheme: 'Call', value: '0', inputLength: 4, selector: '0x70a08231' },
        { caller: HOOK, target: TOKEN, bytecodeAddress: TOKEN, scheme: 'Call', value: '0', inputLength: 0 },
      ],
    }))

    expect(observations.eventSignatures).toEqual([TRANSFER, SWAP])
    expect(observations.externalSelectors).toEqual(['0xa9059cbb', '0x70a08231'])
    expect(observations.logs).toHaveLength(3)
  })

  it('computes signed net native movement', () => {
    const observations = summarizeExecutionObservations(proof({
      balanceChanges: [
        { address: HOOK, before: '100', after: '250' },
        { address: TOKEN, before: '500', after: '350' },
      ],
    }))

    expect(observations.netValueMovement).toEqual([
      { address: HOOK, delta: '150' },
      { address: TOKEN, delta: '-150' },
    ])
  })

  it('summarizes nothing when only instructions were observed', () => {
    expect(observationSummary(summarizeExecutionObservations(proof()))).toBeUndefined()
  })

  it('describes what was observed', () => {
    const summary = observationSummary(summarizeExecutionObservations(proof({
      logs: [{ address: HOOK, topics: [SWAP], data: '0x' }],
      logCount: 1,
      balanceChanges: [{ address: HOOK, before: '1', after: '2' }],
      storageOperations: [{ address: HOOK, pc: 1, opcode: 'TSTORE', slot: '0x02', value: '0x07' }],
    })))

    expect(summary).toContain('1 log across 1 event signature')
    expect(summary).toContain('1 native balance change')
    expect(summary).toContain('1 transient storage write')
  })
})
