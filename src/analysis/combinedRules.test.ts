import { describe, expect, it } from 'vitest'
import { getAddress, type Hex } from 'viem'
import { combinedFindings } from './combinedRules'
import type { Evidence } from '../domain/report'

const SUBJECT = getAddress('0x2222222222222222222222222222222222222222')
const POOL = `0x${'ab'.repeat(32)}` as Hex

function finding(detectorId: string, technical: Record<string, unknown> = {}): Evidence {
  return {
    id: detectorId, detectorId, detectorVersion: '0.1.0', severity: 'info',
    evidenceClass: 'static-reachability', subject: SUBJECT, title: detectorId,
    claim: 'x', confidence: 'supported', affectedPools: [POOL],
    reproducibility: 'not-applicable', technical,
  }
}

const changedStorage = [{ address: SUBJECT, slot: '0x07' as Hex, before: '0x01' as Hex, after: '0x99' as Hex }]

function run(findings: Evidence[]) {
  return combinedFindings({ subject: SUBJECT, affectedPools: [POOL], findings })
}

function ids(findings: Evidence[]) {
  return findings.map((item) => item.detectorId).sort()
}

describe('caller-dependent storage', () => {
  it('does not fire on opcode co-presence alone', () => {
    // This is precisely the old false positive.
    const result = run([finding('caller-and-storage-present'), finding('origin-opcode-present')])
    expect(ids(result)).not.toContain('caller-dependent-storage')
  })

  it('fires on a verified-source dependency alone, at reduced severity', () => {
    const result = run([finding('verified-source-dependency', {
      dependencies: [{ sink: 'state-assignment', sources: ['msg.sender'], function: 'setRouter' }],
    })])
    const caller = result.find((item) => item.detectorId === 'caller-dependent-storage')!
    expect(caller.severity).toBe('low')
    expect(caller.claim).toContain('verified-source dependency')
    expect(caller.claim).toContain('Opcode co-presence alone was not treated as evidence')
    // Nothing was executed, so it must not claim to have been.
    expect(caller.evidenceClass).toBe('static-reachability')
    expect(caller.reproducibility).toBe('not-applicable')
    expect(caller.confidence).toBe('supported')
    expect(caller.technical!.evidenceBasis).toBe('verified-source-only')
  })

  it('does not treat a caller-guarded condition as storage dependence on its own', () => {
    // A require(msg.sender == owner) in a function that writes nothing guards
    // nothing, so reporting caller-dependent storage would be false.
    const result = run([finding('verified-source-dependency', {
      dependencies: [{ sink: 'condition', sources: ['msg.sender'], function: 'viewOnly' }],
    })])
    expect(ids(result)).not.toContain('caller-dependent-storage')
  })

  it('does not infer a guard from condition/write co-presence in one function', () => {
    const result = run([finding('verified-source-dependency', {
      dependencies: [
        { sink: 'condition', sources: ['msg.sender'], function: 'setRouter' },
        { sink: 'state-assignment', sources: ['parameter'], function: 'setRouter' },
      ],
    })])
    expect(ids(result)).not.toContain('caller-dependent-storage')
  })

  it('accepts a source assignment with a lexically proven caller guard', () => {
    const result = run([finding('verified-source-dependency', {
      dependencies: [
        { sink: 'guarded-state-assignment', sources: ['msg.sender'], function: 'setRouter' },
      ],
    })])
    expect(ids(result)).toContain('caller-dependent-storage')
  })

  it('fires at medium on a controlled pair that changed storage', () => {
    const result = run([finding('concrete-hook-sender-dependence', {
      behavior: { identical: false, changedStorage },
    })])
    const caller = result.find((item) => item.detectorId === 'caller-dependent-storage')!
    expect(caller.severity).toBe('medium')
    expect(caller.storage).toEqual([{ slot: '0x07', before: '0x01', after: '0x99' }])
  })

  it('ignores a controlled pair that changed nothing', () => {
    const result = run([finding('concrete-transaction-caller-dependence', {
      behavior: { identical: true, changedStorage: [] },
    })])
    expect(ids(result)).not.toContain('caller-dependent-storage')
  })
})

describe('controllable delegatecall', () => {
  const reachable = finding('cfg-reachable-delegatecall')
  const changedDelegatecalls = [{
    caller: '0x00000000000000000000000000000000000000c1',
    storageAddress: SUBJECT,
    beforeTarget: '0x00000000000000000000000000000000000000a1',
    afterTarget: '0x00000000000000000000000000000000000000a2',
    beforeFrameId: 2,
    afterFrameId: 8,
    ordinal: 0,
    storageEffects: changedStorage,
  }]
  // Standalone execution evidence cannot be joined to a different pair.
  const executed = finding('protocol-native-scenario', {
    calls: [
      { scheme: 'Call', target: '0xaaa', caller: '0xbbb' },
      { scheme: 'DelegateCall', target: '0xdddd', caller: SUBJECT },
    ],
  })
  const executedWithoutDelegate = finding('protocol-native-scenario', {
    calls: [{ scheme: 'Call', target: '0xaaa', caller: '0xbbb' }],
  })
  const targetVaries = finding('concrete-hook-sender-dependence', {
    behavior: {
      identical: false,
      changedCallTargets: ['0xabc'],
      changedDelegatecalls,
      changedStorage,
    },
  })

  it('requires every condition, not just reachability', () => {
    expect(ids(run([reachable]))).not.toContain('controllable-delegatecall')
    // Reachable and executed elsewhere, but no controlled pair correlates it.
    expect(ids(run([reachable, executed]))).not.toContain('controllable-delegatecall')
    // Target varies, but nothing proved reachability.
    expect(ids(run([targetVaries, executed]))).not.toContain('controllable-delegatecall')
    // A generic changed call target is not a changed delegated frame.
    const unrelatedTarget = finding('concrete-hook-sender-dependence', {
      behavior: { identical: false, changedCallTargets: ['0xabc'], changedStorage },
    })
    expect(ids(run([reachable, unrelatedTarget, executed]))).not.toContain('controllable-delegatecall')
  })

  it('requires a delegated call to have actually executed', () => {
    // Everything else holds, but the trace only ever made a plain CALL. The
    // opcode may sit behind a branch no scenario took.
    const genericTarget = finding('concrete-hook-sender-dependence', {
      behavior: { identical: false, changedCallTargets: ['0xabc'], changedStorage },
    })
    expect(ids(run([reachable, genericTarget, executedWithoutDelegate])))
      .not.toContain('controllable-delegatecall')
  })

  it('requires a recorded effect from the delegated execution', () => {
    const noEffect = finding('concrete-hook-sender-dependence', {
      behavior: {
        identical: false,
        changedDelegatecalls: changedDelegatecalls.map((call) => ({ ...call, storageEffects: [] })),
        changedStorage,
      },
    })
    expect(ids(run([reachable, noEffect, executed]))).not.toContain('controllable-delegatecall')
  })

  it('does not join a delegated target change to storage written in another context', () => {
    const otherContext = '0x00000000000000000000000000000000000000ff'
    const unrelatedEffect = finding('concrete-hook-sender-dependence', {
      behavior: {
        identical: false,
        changedDelegatecalls: [{
          ...changedDelegatecalls[0],
          storageAddress: otherContext,
          storageEffects: [{ ...changedStorage[0], address: otherContext }],
        }],
        changedStorage: [{ ...changedStorage[0], address: otherContext }],
      },
    })
    expect(ids(run([reachable, unrelatedEffect]))).not.toContain('controllable-delegatecall')
  })

  it('fires when every requirement is met', () => {
    const result = run([reachable, targetVaries])
    const delegate = result.find((item) => item.detectorId === 'controllable-delegatecall')!
    expect(delegate.severity).toBe('high')
    expect(delegate.claim).toContain('were each insufficient for this claim')
    expect(delegate.technical!.requirements).toMatchObject({
      cfgReachable: true, targetInfluenceable: true, delegatecallsExecuted: 1, storageChangesRecorded: 1, correlatedPairs: 1,
    })
    expect(delegate.claim).toContain('matching delegated frames changed implementation')
  })

  it('does not fire when the opcode was present but unreachable', () => {
    // The graded finding, not the reachable one.
    const result = run([finding('delegatecall-opcode-present'), targetVaries, executed])
    expect(ids(result)).not.toContain('controllable-delegatecall')
  })

  it('does not let a source call-target dependency substitute for correlated execution', () => {
    const result = run([
      reachable, executed,
      finding('concrete-hook-sender-dependence', { behavior: { identical: false, changedStorage } }),
      finding('verified-source-dependency', {
        dependencies: [{ sink: 'call-target', sources: ['parameter'], function: 'execute' }],
      }),
    ])
    expect(ids(result)).not.toContain('controllable-delegatecall')
  })

  it('does not treat a target read from a state slot as influenceable', () => {
    // A hardcoded or immutable configuration slot is not something an attacker
    // steers, so a state-derived target alone must not qualify.
    const result = run([
      reachable, executed,
      finding('concrete-hook-sender-dependence', { behavior: { identical: false, changedStorage } }),
      finding('verified-source-dependency', {
        dependencies: [{ sink: 'call-target', sources: ['state'], function: 'execute' }],
      }),
    ])
    expect(ids(result)).not.toContain('controllable-delegatecall')
  })
})

describe('origin-based authorization', () => {
  it('stays silent on a raw ORIGIN read', () => {
    expect(ids(run([finding('origin-opcode-present')]))).not.toContain('origin-based-authorization')
  })

  it('fires once the origin reaches a decision', () => {
    const result = run([
      finding('origin-opcode-present'),
      finding('verified-source-dependency', {
        dependencies: [{ sink: 'condition', sources: ['tx.origin'], function: 'guard' }],
      }),
    ])
    const origin = result.find((item) => item.detectorId === 'origin-based-authorization')!
    expect(origin.severity).toBe('medium')
    expect(origin.claim).toContain('condition')
    expect(origin.claim).toContain('remains informational')
  })

  it('does not fire when only msg.sender reaches a condition', () => {
    const result = run([
      finding('origin-opcode-present'),
      finding('verified-source-dependency', {
        dependencies: [{ sink: 'condition', sources: ['msg.sender'] }],
      }),
    ])
    expect(ids(result)).not.toContain('origin-based-authorization')
  })
})

describe('rule set as a whole', () => {
  it('returns nothing when no requirement set is satisfied', () => {
    expect(run([
      finding('caller-and-storage-present'),
      finding('origin-opcode-present'),
      finding('delegatecall-opcode-present'),
      finding('selfdestruct-opcode-present'),
    ])).toEqual([])
  })

  it('marks an execution-backed finding as a concrete replayed observation', () => {
    const result = run([finding('concrete-hook-sender-dependence', { behavior: { identical: false, changedStorage } })])
    expect(result[0]!.evidenceClass).toBe('concrete-observation')
    expect(result[0]!.reproducibility).toBe('replayed')
    expect(result[0]!.technical!.evidenceBasis).toBe('executed-and-static')
    expect(result[0]!.technical!.rule).toBe('combined-static-and-concrete')
  })
})
