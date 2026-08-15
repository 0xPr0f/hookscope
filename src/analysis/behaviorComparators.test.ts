import { describe, expect, it } from 'vitest'
import { getAddress, type Address, type Hex } from 'viem'
import { compareExecutions, describeControlledComparison } from './behaviorComparators'
import { CALLER_PROBES, buildProtocolScenarioMatrix } from './protocolNativeScenarios'
import type { RevmExecutionProof } from './revmProof'

const A = getAddress('0x00000000000000000000000000000000000ac7a1')
const B = getAddress('0x00000000000000000000000000000000000ac7a2')
const HOOK = getAddress('0x2222222222222222222222222222222222222222')

function proof(options: Partial<RevmExecutionProof> = {}): RevmExecutionProof {
  return {
    engine: 'revm/36.0.0', success: true, gasUsed: 100_000, output: '0x',
    steps: [], storageOperations: [], storageDiffs: [], balanceChanges: [],
    calls: [], logs: [], logCount: 0, selfdestructs: [], truncated: false,
    ...options,
  }
}

function call(target: Address, selector: Hex) {
  return { caller: A, target, bytecodeAddress: target, scheme: 'Call', value: '0', inputLength: 4, selector }
}

describe('four-way caller probe', () => {
  const scenarios = buildProtocolScenarioMatrix({
    key: { currency0: '0x0000000000000000000000000000000000000000', currency1: HOOK, fee: 3000, tickSpacing: 60, hooks: HOOK },
    currentTick: 0,
    actor: A,
  }).scenarios

  it('generates all four corners of caller and sender', () => {
    const probes = scenarios.filter((scenario) => scenario.id.startsWith('caller-probe:'))
    expect(probes.map((probe) => probe.id)).toEqual([
      'caller-probe:baseline', 'caller-probe:tx-caller', 'caller-probe:hook-sender', 'caller-probe:both',
    ])
    expect(probes.map((probe) => `${probe.caller}/${probe.via}`)).toEqual([
      'actor/router', 'alternateActor/router', 'actor/alternateRouter', 'alternateActor/alternateRouter',
    ])
  })

  it('varies exactly one input between the baseline and each single-variable probe', () => {
    const byId = new Map(CALLER_PROBES.map((probe) => [probe.id, probe]))
    const baseline = byId.get('baseline')!
    const txCaller = byId.get('tx-caller')!
    const hookSender = byId.get('hook-sender')!

    // One variable each, which is what makes attribution possible at all.
    expect(txCaller.via).toBe(baseline.via)
    expect(txCaller.caller).not.toBe(baseline.caller)
    expect(hookSender.caller).toBe(baseline.caller)
    expect(hookSender.via).not.toBe(baseline.via)
  })

  it('sends identical calldata for every corner, so only context differs', () => {
    const probes = scenarios.filter((scenario) => scenario.id.startsWith('caller-probe:'))
    const distinct = new Set(probes.map((probe) => probe.calldata))
    expect(distinct.size).toBe(1)
  })
})

describe('execution comparison', () => {
  it('reports identical executions as identical', () => {
    const behavior = compareExecutions({ before: proof(), after: proof({ gasUsed: 999_999 }) })
    // Gas alone is never a behavioral difference.
    expect(behavior.identical).toBe(true)
    expect(behavior.gasAfter).toBe(999_999)
  })

  it('detects a changed storage write', () => {
    const behavior = compareExecutions({
      before: proof({ storageDiffs: [{ address: HOOK, slot: '0x01', before: '0x00', after: '0x01' }] }),
      after: proof({ storageDiffs: [{ address: HOOK, slot: '0x01', before: '0x00', after: '0x02' }] }),
    })
    expect(behavior.identical).toBe(false)
    expect(behavior.changedStorage).toEqual([{ address: HOOK, slot: '0x01', before: '0x01', after: '0x02' }])
  })

  it('ignores a slot both runs left at the same value', () => {
    const diff = { address: HOOK, slot: '0x01' as Hex, before: '0x00' as Hex, after: '0x09' as Hex }
    const behavior = compareExecutions({ before: proof({ storageDiffs: [diff] }), after: proof({ storageDiffs: [diff] }) })
    expect(behavior.changedStorage).toEqual([])
    expect(behavior.identical).toBe(true)
  })

  it('detects a changed outcome, call target and selector', () => {
    const behavior = compareExecutions({
      before: proof({ success: true, calls: [call(HOOK, '0xaaaaaaaa')] }),
      after: proof({ success: false, calls: [call(A, '0xbbbbbbbb')] }),
    })
    expect(behavior.outcomeChanged).toBe(true)
    expect(behavior.outcomeBefore).toBe('success')
    expect(behavior.outcomeAfter).toBe('revert')
    expect(behavior.changedCallTargets).toHaveLength(2)
    expect(behavior.changedExternalSelectors).toHaveLength(2)
  })

  it('detects an event emitted by only one side', () => {
    const behavior = compareExecutions({
      before: proof({ logs: [{ address: HOOK, topics: ['0xdead' as Hex], data: '0x' }], logCount: 1 }),
      after: proof(),
    })
    expect(behavior.changedEvents).toEqual([{ address: HOOK, topic0: '0xdead', onlyIn: 'before' }])
  })

  it('detects differing balance movement', () => {
    const behavior = compareExecutions({
      before: proof({ balanceChanges: [{ address: A, before: '1', after: '2' }] }),
      after: proof({ balanceChanges: [{ address: A, before: '1', after: '5' }] }),
    })
    expect(behavior.changedBalanceMovement).toEqual([{ address: A, before: '1->2', after: '1->5' }])
  })

  it('compares branch edges, transient writes, fees and currency deltas', () => {
    const slot = `0x${'11'.repeat(32)}` as Hex
    const before = proof({
      steps: [
        { address: HOOK, pc: 1, opcode: 'JUMPI' },
        { address: HOOK, pc: 10, opcode: 'JUMPDEST' },
      ],
      storageOperations: [{ address: A, storageAddress: HOOK, pc: 2, opcode: 'TSTORE', slot, value: '0x01' }],
    })
    const after = proof({
      steps: [
        { address: HOOK, pc: 1, opcode: 'JUMPI' },
        { address: HOOK, pc: 20, opcode: 'JUMPDEST' },
      ],
      storageOperations: [{ address: B, storageAddress: HOOK, pc: 2, opcode: 'TSTORE', slot, value: '0x02' }],
    })
    const behavior = compareExecutions({
      before,
      after,
      beforeObservations: {
        fees: [500],
        currencyDeltas: [{ account: A, currency: HOOK, slot, delta: '-1', writes: 1 }],
      },
      afterObservations: {
        fees: [3_000],
        currencyDeltas: [{ account: A, currency: HOOK, slot, delta: '0', writes: 2 }],
      },
    })
    expect(behavior.changedBranchEdges).toHaveLength(2)
    expect(behavior.changedTransientWrites).toEqual([{ address: HOOK, slot, before: '0x01', after: '0x02' }])
    expect(behavior.changedFees).toEqual([500, 3_000])
    expect(behavior.changedCurrencyDeltas).toEqual([{
      account: A, currency: HOOK, slot, before: '-1', after: '0',
    }])
    expect(behavior.identical).toBe(false)
  })

  it('correlates a changed target on the same delegated frame', () => {
    const slot = `0x${'77'.repeat(32)}` as Hex
    const delegated = (bytecodeAddress: Address, frameId: number) => ({
      frameId,
      parentFrameId: 1,
      depth: 1,
      caller: A,
      // revm target_address is the storage context; bytecode_address is the
      // implementation selected by DELEGATECALL.
      target: HOOK,
      bytecodeAddress,
      scheme: 'DelegateCall',
      value: '0',
      inputLength: 4,
      selector: '0xaaaaaaaa' as Hex,
    })
    const behavior = compareExecutions({
      before: proof({
        calls: [delegated(A, 2)],
        storageOperations: [{ frameId: 2, address: A, storageAddress: HOOK, pc: 7, opcode: 'SSTORE', slot, value: '0x01' }],
        storageDiffs: [{ address: HOOK, slot, before: '0x00', after: '0x01' }],
      }),
      after: proof({
        calls: [delegated(B, 9)],
        storageOperations: [{ frameId: 9, address: B, storageAddress: HOOK, pc: 7, opcode: 'SSTORE', slot, value: '0x02' }],
        storageDiffs: [{ address: HOOK, slot, before: '0x00', after: '0x02' }],
      }),
    })
    expect(behavior.changedDelegatecalls).toEqual([{
      caller: A,
      storageAddress: HOOK,
      beforeTarget: A,
      afterTarget: B,
      beforeFrameId: 2,
      afterFrameId: 9,
      selector: '0xaaaaaaaa',
      ordinal: 0,
      storageEffects: [{ address: HOOK, slot, before: '0x01', after: '0x02' }],
    }])
  })

  it('does not attribute a later write in the same storage context to the delegated frame', () => {
    const slot = `0x${'88'.repeat(32)}` as Hex
    const delegated = (bytecodeAddress: Address, frameId: number) => ({
      frameId, parentFrameId: 1, depth: 1, caller: A, target: HOOK, bytecodeAddress,
      scheme: 'DelegateCall', value: '0', inputLength: 4, selector: '0xaaaaaaaa' as Hex,
    })
    const behavior = compareExecutions({
      before: proof({
        calls: [delegated(A, 2)],
        storageOperations: [
          { frameId: 2, address: A, storageAddress: HOOK, pc: 7, opcode: 'SSTORE', slot, value: '0x01' },
          { frameId: 3, address: HOOK, storageAddress: HOOK, pc: 20, opcode: 'SSTORE', slot, value: '0x03' },
        ],
        storageDiffs: [{ address: HOOK, slot, before: '0x00', after: '0x03' }],
      }),
      after: proof({
        calls: [delegated(B, 9)],
        storageOperations: [
          { frameId: 9, address: B, storageAddress: HOOK, pc: 7, opcode: 'SSTORE', slot, value: '0x02' },
          { frameId: 10, address: HOOK, storageAddress: HOOK, pc: 20, opcode: 'SSTORE', slot, value: '0x04' },
        ],
        storageDiffs: [{ address: HOOK, slot, before: '0x00', after: '0x04' }],
      }),
    })
    expect(behavior.changedDelegatecalls).toHaveLength(1)
    expect(behavior.changedDelegatecalls[0]!.storageEffects).toEqual([])
  })
})

describe('normalization of expected substitution differences', () => {
  const ROUTER_A = getAddress('0x0000000000000000000000000000000000005ce4')
  const ROUTER_B = getAddress('0x0000000000000000000000000000000000005ce5')
  const normalization = { substituted: [{ before: ROUTER_A, after: ROUTER_B }] }
  const pad = (address: Address) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}` as Hex

  it('does not report the substituted router as a changed call target', () => {
    // Routing through the second instance necessarily calls it. That is the
    // substitution, not the hook behaving differently.
    const behavior = compareExecutions({
      before: proof({ calls: [call(ROUTER_A, '0xaaaaaaaa'), call(HOOK, '0xbbbbbbbb')] }),
      after: proof({ calls: [call(ROUTER_B, '0xaaaaaaaa'), call(HOOK, '0xbbbbbbbb')] }),
      normalization,
    })
    expect(behavior.changedCallTargets).toEqual([])
    expect(behavior.identical).toBe(true)
  })

  it('matches a pool event whose only difference is the indexed sender', () => {
    const swap = (sender: Address) => ({
      address: HOOK, topics: ['0x40e9cecb' as Hex, '0xpool' as Hex, pad(sender)] as Hex[], data: '0x01' as Hex,
    })
    const behavior = compareExecutions({
      before: proof({ logs: [swap(ROUTER_A)], logCount: 1 }),
      after: proof({ logs: [swap(ROUTER_B)], logCount: 1 }),
      normalization,
    })
    expect(behavior.changedEvents).toEqual([])
    expect(behavior.identical).toBe(true)
  })

  it('ignores the claim slots each instance owns', () => {
    const slotA = `0x${'a'.repeat(64)}` as Hex
    const slotB = `0x${'b'.repeat(64)}` as Hex
    const behavior = compareExecutions({
      before: proof({
        storageDiffs: [{ address: HOOK, slot: slotA, before: '0x00', after: '0x05' }],
        storageOperations: [{ address: HOOK, pc: 1, opcode: 'TSTORE', slot: slotA, value: '0x05' }],
      }),
      after: proof({
        storageDiffs: [{ address: HOOK, slot: slotA, before: '0x00', after: '0x09' }],
        storageOperations: [{ address: HOOK, pc: 1, opcode: 'TSTORE', slot: slotB, value: '0x09' }],
      }),
      normalization: { ...normalization, ignoredSlots: [slotA, slotB] },
    })
    expect(behavior.changedStorage).toEqual([])
    expect(behavior.changedTransientWrites).toEqual([])
    expect(behavior.identical).toBe(true)
  })

  it('canonicalizes decoded currency deltas owned by substituted accounts', () => {
    const slotA = `0x${'a'.repeat(64)}` as Hex
    const slotB = `0x${'b'.repeat(64)}` as Hex
    const behavior = compareExecutions({
      before: proof(),
      after: proof(),
      normalization,
      beforeObservations: {
        currencyDeltas: [{ account: ROUTER_A, currency: HOOK, slot: slotA, delta: '0', writes: 2 }],
      },
      afterObservations: {
        currencyDeltas: [{ account: ROUTER_B, currency: HOOK, slot: slotB, delta: '0', writes: 2 }],
      },
    })
    expect(behavior.changedCurrencyDeltas).toEqual([])
    expect(behavior.identical).toBe(true)
  })

  it('ignores the substituted accounts own balance movement', () => {
    const behavior = compareExecutions({
      before: proof({ balanceChanges: [{ address: ROUTER_A, before: '10', after: '5' }] }),
      after: proof({ balanceChanges: [{ address: ROUTER_B, before: '10', after: '5' }] }),
      normalization,
    })
    expect(behavior.changedBalanceMovement).toEqual([])
  })

  it('still reports a genuine difference alongside the expected ones', () => {
    // The hook wrote a different value; only that survives normalization.
    const behavior = compareExecutions({
      before: proof({
        calls: [call(ROUTER_A, '0xaaaaaaaa')],
        storageDiffs: [{ address: HOOK, slot: '0x07', before: '0x00', after: '0x01' }],
      }),
      after: proof({
        calls: [call(ROUTER_B, '0xaaaaaaaa')],
        storageDiffs: [{ address: HOOK, slot: '0x07', before: '0x00', after: '0x02' }],
      }),
      normalization,
    })
    expect(behavior.changedCallTargets).toEqual([])
    expect(behavior.changedStorage).toEqual([{ address: HOOK, slot: '0x07', before: '0x01', after: '0x02' }])
    expect(behavior.identical).toBe(false)
  })

  it('reports the substituted target when no normalization is declared', () => {
    // Without the declaration the difference is real as far as the comparator
    // knows, which is why the runner must supply it.
    const behavior = compareExecutions({
      before: proof({ calls: [call(ROUTER_A, '0xaaaaaaaa')] }),
      after: proof({ calls: [call(ROUTER_B, '0xaaaaaaaa')] }),
    })
    expect(behavior.changedCallTargets).toHaveLength(2)
  })
})

describe('controlled comparison wording', () => {
  it('names the single varied input and what moved', () => {
    const comparison = describeControlledComparison({
      difference: { kind: 'hook-sender', before: A, after: B },
      behavior: compareExecutions({
        before: proof({ storageDiffs: [{ address: HOOK, slot: '0x07', before: '0x00', after: '0x01' }] }),
        after: proof({ storageDiffs: [{ address: HOOK, slot: '0x07', before: '0x00', after: '0x02' }] }),
      }),
    })
    expect(comparison.summary).toContain('Changing only the hook-visible sender')
    expect(comparison.summary).toContain('storage slot 0x07')
    expect(comparison.summary).toContain('0x01 → 0x02')
  })

  it('states plainly when nothing moved', () => {
    const comparison = describeControlledComparison({
      difference: { kind: 'transaction-caller', before: A, after: B },
      behavior: compareExecutions({ before: proof(), after: proof() }),
    })
    expect(comparison.summary).toContain('produced no observable difference')
  })

  it('distinguishes the transaction caller from the hook-visible sender in its wording', () => {
    const behavior = compareExecutions({ before: proof({ success: true }), after: proof({ success: false }) })
    const asCaller = describeControlledComparison({ difference: { kind: 'transaction-caller', before: A, after: B }, behavior })
    const asSender = describeControlledComparison({ difference: { kind: 'hook-sender', before: A, after: B }, behavior })
    expect(asCaller.summary).toContain('transaction caller')
    expect(asCaller.summary).not.toContain('hook-visible')
    expect(asSender.summary).toContain('hook-visible sender')
  })
})
