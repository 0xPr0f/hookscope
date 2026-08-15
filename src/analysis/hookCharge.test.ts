import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, pad, toFunctionSelector, type Address, type Hex } from 'viem'
import { currencyDeltaSlot } from './currencyDeltas'
import { formatRatePpm, observeHookCharge } from './hookCharge'
import { POOL_MANAGER_EVENT_TOPICS } from './poolEvents'
import type { RevmExecutionProof, RevmLogEvidence, RevmStorageAccess } from './revmProof'

const MANAGER = '0x5555555555555555555555555555555555555555' as Address
const HOOK = '0x2222222222222222222222222222222222222222' as Address
const SENDER = '0x3333333333333333333333333333333333333333' as Address
const CURRENCY0 = '0x1111111111111111111111111111111111111111' as Address
const CURRENCY1 = '0x4444444444444444444444444444444444444444' as Address
const POOL_ID = `0x${'ab'.repeat(32)}` as Hex
const OTHER_POOL_ID = `0x${'cd'.repeat(32)}` as Hex
const SWAP_SELECTOR = toFunctionSelector(
  'function swap((address,address,uint24,int24,address),(bool,int256,uint160),bytes)',
)

function word(value: bigint): Hex {
  const raw = value < 0n ? (1n << 256n) + value : value
  return `0x${raw.toString(16).padStart(64, '0')}` as Hex
}

function tstore(currency: Address, value: bigint, frameId: number): RevmStorageAccess {
  return {
    frameId,
    address: MANAGER,
    storageAddress: MANAGER,
    pc: 1,
    opcode: 'TSTORE',
    slot: currencyDeltaSlot(HOOK, currency),
    value: word(value),
  }
}

function swapLog(amount0 = -1_000n, amount1 = 800n, poolId = POOL_ID): RevmLogEvidence {
  return {
    address: MANAGER,
    topics: [POOL_MANAGER_EVENT_TOPICS.swap as Hex, poolId, pad(SENDER, { size: 32 })],
    data: encodeAbiParameters(
      [{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }],
      [amount0, amount1, 79_228_162_514_264_337_593_543_950_336n, 5_000n, -120, 0],
    ),
  }
}

function proof(input: Partial<RevmExecutionProof> = {}): RevmExecutionProof {
  const logs = input.logs ?? [swapLog()]
  return {
    engine: 'revm/36.0.0',
    success: true,
    gasUsed: 21_000,
    output: '0x',
    steps: [],
    storageOperations: [],
    calls: [
      {
        frameId: 2,
        parentFrameId: 1,
        depth: 1,
        caller: SENDER,
        target: MANAGER,
        bytecodeAddress: MANAGER,
        scheme: 'Call',
        value: '0',
        inputLength: 356,
        selector: SWAP_SELECTOR,
      },
      {
        frameId: 3,
        parentFrameId: 2,
        depth: 2,
        caller: MANAGER,
        target: HOOK,
        bytecodeAddress: HOOK,
        scheme: 'Call',
        value: '0',
        inputLength: 356,
      },
      {
        frameId: 4,
        parentFrameId: 3,
        depth: 3,
        caller: HOOK,
        target: MANAGER,
        bytecodeAddress: MANAGER,
        scheme: 'Call',
        value: '0',
        inputLength: 100,
        selector: toFunctionSelector('function take(address,address,uint256)'),
      },
    ],
    storageDiffs: [],
    balanceChanges: [],
    logs,
    logCount: logs.length,
    selfdestructs: [],
    truncated: false,
    ...input,
  }
}

const observe = (execution: RevmExecutionProof) => observeHookCharge({
  proof: execution,
  poolManager: MANAGER,
  poolId: POOL_ID,
  hook: HOOK,
  currency0: CURRENCY0,
  currency1: CURRENCY1,
  poolFee: 0,
})

describe('hook charge reconstruction', () => {
  it('keeps an input surcharge nominal rate distinct from its all-in share', () => {
    const observation = observe(proof({
      // The hook takes first in its nested callback, then PoolManager applies the
      // positive returned delta in the swap frame and settles the balance.
      storageOperations: [tstore(CURRENCY0, -100n, 4), tstore(CURRENCY0, 0n, 2)],
    }))

    expect(observation.status).toBe('observed')
    expect(observation.inputCurrency).toBe(CURRENCY0)
    expect(observation.components).toEqual([{
      currency: CURRENCY0,
      side: 'input',
      amount: '100',
      denominator: '1000',
      ratePpm: 100_000,
      allInDenominator: '1100',
      allInRatePpm: 90_909,
    }])
    expect(observation.primaryRatePpm).toBe(100_000)
    expect(observation.observedLpFee).toBe(0)
    expect(formatRatePpm(observation.primaryRatePpm!)).toBe('10%')
    expect(observation.hookDeltaTimelines[0]?.values).toEqual(['-100', '0'])
  })

  it('preserves the exact PNKSTR nominal and all-in arithmetic', () => {
    const observation = observe(proof({
      logs: [swapLog(-3_694n, 1_000_000_000n)],
      storageOperations: [tstore(CURRENCY0, -369n, 4), tstore(CURRENCY0, 0n, 2)],
    }))

    expect(observation.components[0]).toMatchObject({
      amount: '369',
      denominator: '3694',
      ratePpm: 99_891,
      allInDenominator: '4063',
      allInRatePpm: 90_819,
    })
  })

  it('measures the swap transition from a non-zero transaction-scoped entry delta', () => {
    const observation = observe(proof({
      storageOperations: [
        // An earlier operation entered swap() with an existing -50 balance.
        tstore(CURRENCY0, -50n, 1),
        // The hook takes another 100, then swap() applies exactly +100.
        tstore(CURRENCY0, -150n, 4),
        tstore(CURRENCY0, -50n, 2),
        // The earlier balance is settled after the selected swap returns.
        tstore(CURRENCY0, 0n, 1),
      ],
    }))

    expect(observation.status).toBe('observed')
    expect(observation.components[0]).toMatchObject({
      currency: CURRENCY0,
      amount: '100',
      denominator: '1000',
      ratePpm: 100_000,
    })
    expect(observation.hookDeltaTimelines[0]?.values).toEqual(['-50', '-150', '-50', '0'])
  })

  it('quantifies an output-side charge against gross pool output', () => {
    const observation = observe(proof({
      storageOperations: [tstore(CURRENCY1, -80n, 4), tstore(CURRENCY1, 0n, 2)],
    }))
    expect(observation.components[0]).toMatchObject({ side: 'output', amount: '80', denominator: '800', ratePpm: 100_000 })
  })

  it('records a completed single swap with no hook delta without inventing a charge', () => {
    expect(observe(proof()).status).toBe('none-observed')
  })

  it('quantifies complete hook accounting when only the bounded instruction list was truncated', () => {
    const observation = observe(proof({
      truncated: true,
      storageOperations: [tstore(CURRENCY0, -100n, 4), tstore(CURRENCY0, 0n, 2)],
    }))

    expect(observation.status).toBe('observed')
    expect(observation.primaryRatePpm).toBe(100_000)
  })

  it('isolates one swap when the transaction also contains another PoolManager operation', () => {
    const baseProof = proof()
    const observation = observe(proof({
      calls: [
        ...baseProof.calls,
        {
          frameId: 8,
          parentFrameId: 1,
          depth: 1,
          caller: SENDER,
          target: MANAGER,
          bytecodeAddress: MANAGER,
          scheme: 'Call',
          value: '0',
          inputLength: 356,
          selector: toFunctionSelector('function donate((address,address,uint24,int24,address),uint256,uint256,bytes)'),
        },
      ],
      storageOperations: [tstore(CURRENCY0, -100n, 4), tstore(CURRENCY0, 0n, 2)],
    }))

    expect(observation.status).toBe('observed')
    expect(observation.primaryRatePpm).toBe(100_000)
  })

  it('ignores a rolled-back PoolManager operation when attributing committed accounting', () => {
    const baseProof = proof()
    const observation = observe(proof({
      calls: [
        ...baseProof.calls,
        {
          ...baseProof.calls[0]!,
          frameId: 8,
          parentFrameId: 1,
          outcome: 'revert',
          committed: false,
        },
      ],
      storageOperations: [tstore(CURRENCY0, -100n, 4), tstore(CURRENCY0, 0n, 2)],
    }))

    expect(observation.status).toBe('observed')
    expect(observation.primaryRatePpm).toBe(100_000)
  })

  it('refuses to quantify an actually incomplete event stream', () => {
    const observation = observe(proof({
      truncated: true,
      logCount: 2,
      storageOperations: [tstore(CURRENCY0, -100n, 4), tstore(CURRENCY0, 0n, 2)],
    }))

    expect(observation.status).toBe('not-quantified')
    expect(observation.reason).toContain('log stream was truncated')
  })

  it('does not apportion one delta timeline across multiple swaps', () => {
    const observation = observe(proof({
      logs: [swapLog(), swapLog(-1_800n, 1_500n)],
      storageOperations: [tstore(CURRENCY0, -100n, 4), tstore(CURRENCY0, 0n, 2)],
    }))
    expect(observation.status).toBe('not-quantified')
    expect(observation.reason).toContain('exactly one')
  })

  it('does not attribute another pool swap to the selected pool timeline', () => {
    const observation = observe(proof({
      logs: [swapLog(), swapLog(-500n, 450n, OTHER_POOL_ID)],
      calls: [
        ...proof().calls,
        { ...proof().calls[0]!, frameId: 8, parentFrameId: 1 },
      ],
      storageOperations: [tstore(CURRENCY0, -100n, 4), tstore(CURRENCY0, 0n, 2)],
    }))
    expect(observation.status).toBe('not-quantified')
  })

  it('keeps a hook-funded rebate distinct from a charge', () => {
    const observation = observe(proof({
      // A hook paying the PoolManager first receives a negative return-delta
      // debit in the outer swap frame. This is value added to the swap, not a fee.
      storageOperations: [tstore(CURRENCY1, 80n, 4), tstore(CURRENCY1, 0n, 2)],
    }))
    expect(observation.status).toBe('none-observed')
    expect(observation.components).toEqual([])
    expect(observation.rebateComponents[0]).toMatchObject({
      currency: CURRENCY1,
      side: 'output',
      amount: '80',
      ratePpm: 100_000,
    })
    expect(observation.reason).toContain('rebate')
  })

  it('does not present a reverted intermediate delta as an executed charge', () => {
    const observation = observe(proof({
      success: false,
      storageOperations: [tstore(CURRENCY0, -100n, 4)],
    }))
    expect(observation.status).toBe('not-quantified')
    expect(observation.reason).toContain('reverted')
  })

})
