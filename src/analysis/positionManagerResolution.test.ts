import { describe, expect, it } from 'vitest'
import { bytesToHex, encodeAbiParameters, encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'
import { V4_ACTIONS, decodeUniswapV4Calldata } from '../adapters/uniswapV4RouterCodec'
import {
  forwardedPositionManagerCalls,
  observedPositionManagerTargets,
} from './positionManagerResolution'
import type { RevmCallEvidence } from './revmProof'

const ROUTER = '0x4444444444444444444444444444444444444444' as Address
const POSITION_MANAGER = '0x7777777777777777777777777777777777777777' as Address
const DECOY = '0x8888888888888888888888888888888888888888' as Address

const ACTION_PLAN_PARAMETERS = [{ type: 'bytes' }, { type: 'bytes[]' }] as const
const EXECUTE_ABI = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable'])
const MODIFY_LIQUIDITIES_ABI = parseAbi(['function modifyLiquidities(bytes unlockData, uint256 deadline) payable'])
const MODIFY_LIQUIDITY_PARAMETERS = [
  { name: 'tokenId', type: 'uint256' },
  { name: 'liquidity', type: 'uint128' },
  { name: 'amount0Limit', type: 'uint128' },
  { name: 'amount1Limit', type: 'uint128' },
  { name: 'hookData', type: 'bytes' },
] as const

function positionManagerCalldata(tokenId: bigint): Hex {
  const modify = encodeAbiParameters(MODIFY_LIQUIDITY_PARAMETERS, [tokenId, 100n, 5n, 6n, '0x1234'])
  const plan = encodeAbiParameters(ACTION_PLAN_PARAMETERS, [
    bytesToHex(new Uint8Array([V4_ACTIONS.INCREASE_LIQUIDITY])),
    [modify],
  ])
  return encodeFunctionData({ abi: MODIFY_LIQUIDITIES_ABI, functionName: 'modifyLiquidities', args: [plan, 1_000n] })
}

function routerWithNestedPositionCall(tokenId = 42n): Hex {
  return encodeFunctionData({
    abi: EXECUTE_ABI,
    functionName: 'execute',
    args: ['0x14', [positionManagerCalldata(tokenId)], 1_000n],
  })
}

function call(overrides: Partial<RevmCallEvidence>): RevmCallEvidence {
  return {
    caller: ROUTER,
    target: POSITION_MANAGER,
    bytecodeAddress: POSITION_MANAGER,
    scheme: 'Call',
    value: '0x0',
    inputLength: 0,
    ...overrides,
  }
}

describe('nested PositionManager attribution', () => {
  it('finds the forwarded payload and its token IDs', () => {
    const decoded = decodeUniswapV4Calldata(routerWithNestedPositionCall())!
    const forwarded = forwardedPositionManagerCalls(decoded)
    expect(forwarded).toHaveLength(1)
    expect(forwarded[0]?.tokenIds).toEqual([42n])
    expect(forwarded[0]?.commandPath).toEqual([0])
    expect(forwarded[0]?.calldata).toBe(positionManagerCalldata(42n))
    expect(forwarded[0]?.calldataBytes).toBe((positionManagerCalldata(42n).length - 2) / 2)
  })

  it('recovers the address the router actually called', () => {
    const forwarded = forwardedPositionManagerCalls(decodeUniswapV4Calldata(routerWithNestedPositionCall())!)[0]!
    const targets = observedPositionManagerTargets({
      router: ROUTER,
      forwardedBytes: forwarded.calldataBytes,
      calls: [
        call({ target: DECOY, inputLength: 4 }),
        call({ target: POSITION_MANAGER, inputLength: forwarded.calldataBytes }),
        call({ caller: POSITION_MANAGER, target: DECOY, inputLength: forwarded.calldataBytes }),
      ],
    })
    expect(targets).toEqual([POSITION_MANAGER])
  })

  it('reports every candidate when the trace is ambiguous', () => {
    const targets = observedPositionManagerTargets({
      router: ROUTER,
      forwardedBytes: 100,
      calls: [
        call({ target: POSITION_MANAGER, inputLength: 100 }),
        call({ target: DECOY, inputLength: 100 }),
      ],
    })
    expect(targets).toHaveLength(2)
  })

  it('ignores self-calls and calls made by other contracts', () => {
    const targets = observedPositionManagerTargets({
      router: ROUTER,
      forwardedBytes: 100,
      calls: [
        call({ target: ROUTER, inputLength: 100 }),
        call({ caller: DECOY, target: POSITION_MANAGER, inputLength: 100 }),
      ],
    })
    expect(targets).toEqual([])
  })

  it('returns nothing when no observed call matches the forwarded length', () => {
    expect(observedPositionManagerTargets({
      router: ROUTER,
      forwardedBytes: 512,
      calls: [call({ inputLength: 100 })],
    })).toEqual([])
  })

  it('ignores a direct PositionManager call that has no router envelope', () => {
    const decoded = decodeUniswapV4Calldata(positionManagerCalldata(42n))!
    expect(decoded.kind).toBe('position-manager')
    expect(forwardedPositionManagerCalls(decoded)).toEqual([])
  })
})
