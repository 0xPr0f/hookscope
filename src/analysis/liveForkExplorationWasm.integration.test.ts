import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  bytesToHex,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
} from 'viem'
import {
  create_fork_session,
  dispose_fork_session,
  fuzz_fork_session,
  initSync,
} from '../wasm/fuzz/hookscope_revm_wasm.js'
import { V4_ACTIONS, decodeUniswapV4Calldata, locateUniswapV4Operations } from '../adapters/uniswapV4RouterCodec'
import { computePoolId } from '../adapters/uniswapV4Pool'
import { poolScopedMutationMask } from './liveForkExploration'
import { isUniswapV4MaskedDerivative } from './uniswapV4MutationMask'

const CURRENCY0 = '0x0000000000000000000000000000000000000000' as Address
const CURRENCY1 = '0x1111111111111111111111111111111111111111' as Address
const HOOK = '0x2222222222222222222222222222222222222222' as Address
const ACTOR = '0x3333333333333333333333333333333333333333' as Address
const ROUTER = '0x4444444444444444444444444444444444444444' as Address
const BENEFICIARY = '0x5555555555555555555555555555555555555555' as Address

const POOL_KEY_COMPONENTS = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
] as const
const SINGLE_IN_PARAMETERS = [{
  type: 'tuple',
  components: [
    { name: 'poolKey', type: 'tuple', components: POOL_KEY_COMPONENTS },
    { name: 'zeroForOne', type: 'bool' },
    { name: 'amountIn', type: 'uint128' },
    { name: 'amountOutMinimum', type: 'uint128' },
    { name: 'hookData', type: 'bytes' },
  ],
}] as const
const ACTION_PLAN_PARAMETERS = [{ type: 'bytes' }, { type: 'bytes[]' }] as const
const EXECUTE_ABI = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable'])

const poolKey = { currency0: CURRENCY0, currency1: CURRENCY1, fee: 3_000, tickSpacing: 60, hooks: HOOK }
const poolId = computePoolId({ ...poolKey, hook: HOOK })

function routerCalldata(): Hex {
  const swap = encodeAbiParameters(SINGLE_IN_PARAMETERS, [{
    poolKey,
    zeroForOne: true,
    amountIn: 1_000n,
    amountOutMinimum: 5n,
    hookData: '0x1234',
  }])
  const plan = encodeAbiParameters(ACTION_PLAN_PARAMETERS, [
    bytesToHex(new Uint8Array([V4_ACTIONS.SWAP_EXACT_IN_SINGLE, 0x0f])),
    [swap, '0xfeed'],
  ])
  return encodeFunctionData({
    abi: EXECUTE_ABI,
    functionName: 'execute',
    args: ['0x1002', [plan, '0xcafebabe'], 1_000n],
  })
}

/**
 * Returns success or revert depending on the lowest bit of the calldata word
 * ending at `byteIndex`, so a masked mutation of that byte is the only way to
 * reach a second outcome.
 */
function branchOnCalldataByte(byteIndex: number): Hex {
  const offset = byteIndex - 31
  if (offset < 0) throw new Error('The selected byte is inside the first calldata word.')
  const word = offset.toString(16).padStart(4, '0')
  return `0x61${word}35600116600f5760006000f35b60006000fd` as Hex
}

function account(address: Address, code: Hex) {
  return {
    address,
    exists: true,
    balance: '0x56bc75e2d63100000',
    nonce: 0,
    code,
    storage: {},
    storageComplete: true,
  }
}

describe('masked router exploration through the revm/LibAFL Wasm bridge', () => {
  it('mutates only masked bytes and keeps the canonical router envelope', () => {
    const wasm = readFileSync(new URL('../wasm/fuzz/hookscope_revm_wasm_bg.wasm', import.meta.url))
    initSync({ module: wasm })

    const calldata = routerCalldata()
    const mask = poolScopedMutationMask(poolId, calldata)
    expect(mask).not.toBeNull()
    if (!mask) throw new Error('Expected a pool-scoped mutation mask.')

    // The least significant amountIn byte: the mask orders its indices ascending.
    const amountInRegion = mask.regions.find((region) => region.field === 'amountIn')!
    const decisionByte = amountInRegion.byteIndices[amountInRegion.byteIndices.length - 1]!
    const sessionId = 'vitest-masked-router-fork'
    create_fork_session(sessionId, {
      accounts: [
        account(ACTOR, '0x'),
        account(ROUTER, branchOnCalldataByte(decisionByte)),
        account(BENEFICIARY, '0x'),
      ],
      blockHashes: [],
    })

    try {
      const summary = fuzz_fork_session(
        sessionId,
        {
          caller: ACTOR,
          to: ROUTER,
          calldata,
          value: '0x0',
          gasLimit: 1_000_000,
          gasPrice: '0x0',
          nonce: 0,
          chainId: 1,
          traceLimit: 1_024,
        },
        {
          number: 10,
          beneficiary: BENEFICIARY,
          timestamp: '0x6553f100',
          gasLimit: 30_000_000,
          baseFee: 0,
          difficulty: '0x0',
          prevrandao: `0x${'0'.repeat(64)}`,
        },
        256,
        0x484f_4f4b_5343_4f50n,
        mask.byteIndices,
        [],
      ) as {
        strategy: string
        executions: number
        coverageEdges: number
        uniqueOutcomes: number
        skippedExecutions: number
        missingRequests: unknown[]
        witnesses: { calldata: Hex; success: boolean }[]
      }

      expect(summary.strategy).toBe('libafl-masked-router-fork/0.1.0')
      expect(summary.executions).toBe(256)
      expect(summary.skippedExecutions).toBe(0)
      expect(summary.missingRequests).toHaveLength(0)
      expect(summary.coverageEdges).toBeGreaterThan(0)
      // The seed reverts or succeeds; mutating the masked byte reaches the other branch.
      expect(summary.uniqueOutcomes).toBeGreaterThanOrEqual(2)
      expect(summary.witnesses.some((witness) => witness.success)).toBe(true)
      expect(summary.witnesses.some((witness) => !witness.success)).toBe(true)

      for (const witness of summary.witnesses) {
        expect(isUniswapV4MaskedDerivative(mask, witness.calldata)).toBe(true)
        const decoded = decodeUniswapV4Calldata(witness.calldata)
        expect(decoded?.kind).toBe('universal-router')
        if (decoded?.kind !== 'universal-router') throw new Error('Expected Universal Router calldata.')
        expect(decoded.commands).toBe('0x1002')
        expect(decoded.deadline).toBe(1_000n)
        expect(decoded.inputs[1]?.rawInput).toBe('0xcafebabe')
        const operation = locateUniswapV4Operations(decoded)[0]!.operation
        expect(operation).toMatchObject({ kind: 'swap-exact-in-single', amountOutMinimum: 5n })
      }
    } finally {
      dispose_fork_session(sessionId)
    }
  })
})
