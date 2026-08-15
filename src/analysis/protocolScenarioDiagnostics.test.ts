import { encodeErrorResult, encodeEventTopics, encodeAbiParameters, parseAbi, type Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import type { RevmExecutionProof } from './revmProof'
import { decodeProtocolRevert, summarizeProtocolSwapMovement, unresolvedProtocolRevertSelectors } from './protocolScenarioDiagnostics'

const MANAGER = '0x0000000000000000000000000000000000000001'
const POOL_ID = `0x${'ab'.repeat(32)}` as Hex

function proof(data: Hex): RevmExecutionProof {
  return {
    engine: 'test',
    success: true,
    gasUsed: 1,
    output: '0x',
    calls: [],
    logs: [{
      address: MANAGER,
      topics: encodeEventTopics({
        abi: parseAbi(['event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)']),
        eventName: 'Swap',
        args: { id: POOL_ID, sender: MANAGER },
      }) as Hex[],
      data,
    }],
    steps: [],
    storageOperations: [],
    storageDiffs: [],
    balanceChanges: [],
    logCount: 1,
    selfdestructs: [],
    truncated: false,
  }
}

describe('protocol scenario diagnostics', () => {
  it('names the official zero-liquidity donation precondition', () => {
    const data = encodeErrorResult({
      abi: parseAbi(['error NoLiquidityToReceiveFees()']),
      errorName: 'NoLiquidityToReceiveFees',
    })
    expect(decodeProtocolRevert(data)).toMatchObject({
      name: 'NoLiquidityToReceiveFees',
      summary: expect.stringContaining('zero active liquidity'),
    })
  })

  it('keeps unknown selectors explicit instead of guessing', () => {
    expect(decodeProtocolRevert('0xdeadbeef')).toMatchObject({
      name: 'UnknownRevert',
      selector: '0xdeadbeef',
    })
  })

  it('labels a matching Sourcify 4byte candidate without presenting it as ABI proof', () => {
    expect(decodeProtocolRevert('0x007074c3', {
      '0x007074c3': [{ name: 'LiquidityFrozen()', hasVerifiedContract: true }],
    })).toMatchObject({
      name: 'LiquidityFrozen',
      signature: 'LiquidityFrozen()',
      signatureSource: 'sourcify-4byte',
      signatureFoundInVerifiedContract: true,
      summary: expect.stringContaining('LiquidityFrozen()'),
    })
  })

  it('collects only selectors that the authoritative decoder did not recognize', () => {
    expect(unresolvedProtocolRevertSelectors('0x007074c3')).toEqual(['0x007074c3'])
    const known = encodeErrorResult({
      abi: parseAbi(['error PoolAlreadyInitialized()']),
      errorName: 'PoolAlreadyInitialized',
    })
    expect(unresolvedProtocolRevertSelectors(known)).toEqual([])
  })

  it('distinguishes a zero-movement Swap event from a real exchange', () => {
    const zero = encodeAbiParameters(
      [{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }],
      [0n, 0n, 1n << 96n, 0n, 0, 3_000],
    )
    const moved = encodeAbiParameters(
      [{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }],
      [-1n, 1n, 1n << 96n, 10n, 0, 3_000],
    )
    expect(summarizeProtocolSwapMovement({ proof: proof(zero), poolManager: MANAGER, poolId: POOL_ID })).toMatchObject({
      events: 1, movedEvents: 0, zeroMovement: true,
    })
    expect(summarizeProtocolSwapMovement({ proof: proof(moved), poolManager: MANAGER, poolId: POOL_ID })).toMatchObject({
      events: 1, movedEvents: 1, zeroMovement: false,
    })
  })
})
