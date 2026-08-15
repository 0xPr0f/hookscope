import { describe, expect, it } from 'vitest'
import {
  bytesToHex,
  encodeAbiParameters,
  encodeFunctionData,
  hexToBytes,
  parseAbi,
  type Address,
  type Hex,
} from 'viem'
import { V4_ACTIONS, decodeUniswapV4Calldata } from './uniswapV4RouterCodec'
import { computePoolId } from './uniswapV4Pool'
import {
  UNIVERSAL_ROUTER_SIGNED_COMMANDS,
  collectSignedPayloads,
  signedPayloadDigest,
  signedPayloadLimitation,
  signedPayloadsPreserved,
} from './uniswapV4SignedPayloads'
import { deriveUniswapV4MutationMask, isUniswapV4MaskedDerivative } from '../analysis/uniswapV4MutationMask'

const CURRENCY0 = '0x0000000000000000000000000000000000000000' as Address
const CURRENCY1 = '0x1111111111111111111111111111111111111111' as Address
const HOOK = '0x2222222222222222222222222222222222222222' as Address
const OWNER = '0x3333333333333333333333333333333333333333' as Address
const SPENDER = '0x4444444444444444444444444444444444444444' as Address
const TOKEN = '0x5555555555555555555555555555555555555555' as Address

const SIGNATURE = `0x${'a5'.repeat(65)}` as Hex

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
const MULTICALL_ABI = parseAbi(['function multicall(bytes[] data) payable returns (bytes[])'])
const MODIFY_LIQUIDITIES_ABI = parseAbi(['function modifyLiquidities(bytes unlockData, uint256 deadline) payable'])
const ERC721_PERMIT_ABI = parseAbi([
  'function permit(address spender, uint256 tokenId, uint256 deadline, uint256 nonce, bytes signature) payable',
])
const PERMIT2_FORWARDER_ABI = parseAbi([
  'function permit(address owner, ((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline) permitSingle, bytes signature) payable returns (bytes)',
])

const poolKey = { currency0: CURRENCY0, currency1: CURRENCY1, fee: 3_000, tickSpacing: 60, hooks: HOOK }
const poolId = computePoolId({ ...poolKey, hook: HOOK })

function swapPlan(amountIn: bigint): Hex {
  const swap = encodeAbiParameters(SINGLE_IN_PARAMETERS, [{
    poolKey,
    zeroForOne: true,
    amountIn,
    amountOutMinimum: 5n,
    hookData: '0xdeadbeef',
  }])
  return encodeAbiParameters(ACTION_PLAN_PARAMETERS, [
    bytesToHex(new Uint8Array([V4_ACTIONS.SWAP_EXACT_IN_SINGLE, 0x0f])),
    [swap, '0xfeed'],
  ])
}

function erc721Permit(): Hex {
  return encodeFunctionData({
    abi: ERC721_PERMIT_ABI,
    functionName: 'permit',
    args: [SPENDER, 42n, 4_000_000_000n, 7n, SIGNATURE],
  })
}

function permit2ForwarderPermit(): Hex {
  return encodeFunctionData({
    abi: PERMIT2_FORWARDER_ABI,
    functionName: 'permit',
    args: [
      OWNER,
      { details: { token: TOKEN, amount: 10n ** 18n, expiration: 1_900_000_000, nonce: 3 }, spender: SPENDER, sigDeadline: 4_000_000_000n },
      SIGNATURE,
    ],
  })
}

/** The production pattern: a signed permit bundled with the liquidity call it authorizes. */
function multicallWithPermits(): Hex {
  const modify = encodeFunctionData({
    abi: MODIFY_LIQUIDITIES_ABI,
    functionName: 'modifyLiquidities',
    args: [swapPlan(100n), 4_000_000_000n],
  })
  return encodeFunctionData({
    abi: MULTICALL_ABI,
    functionName: 'multicall',
    args: [[erc721Permit(), permit2ForwarderPermit(), modify]],
  })
}

function routerWithPermitCommand(): Hex {
  return encodeFunctionData({
    abi: EXECUTE_ABI,
    functionName: 'execute',
    args: [
      bytesToHex(new Uint8Array([UNIVERSAL_ROUTER_SIGNED_COMMANDS.PERMIT2_PERMIT, 0x10])),
      [permit2ForwarderPermit(), swapPlan(100n)],
      4_000_000_000n,
    ],
  })
}

describe('Uniswap v4 signed payloads', () => {
  it('identifies signed PositionManager entrypoints bundled in a multicall', () => {
    const decoded = decodeUniswapV4Calldata(multicallWithPermits())
    expect(decoded).not.toBeNull()
    const payloads = collectSignedPayloads(decoded!)
    expect(payloads.map((item) => item.standard)).toEqual(['erc721-permit', 'permit2-forwarder-permit'])
    expect(payloads[0]?.bytes).toBe(erc721Permit())
    expect(payloads[0]?.location).toMatchObject({ root: 'position-manager', multicallPath: [0] })
    expect(payloads[1]?.location).toMatchObject({ root: 'position-manager', multicallPath: [1] })
    expect(payloads[0]?.covers).toContain('token ID')
  })

  it('identifies signature-bearing Universal Router commands', () => {
    const decoded = decodeUniswapV4Calldata(routerWithPermitCommand())
    expect(decoded).not.toBeNull()
    const payloads = collectSignedPayloads(decoded!)
    expect(payloads).toHaveLength(1)
    expect(payloads[0]?.standard).toBe('permit2-permit')
    expect(payloads[0]?.location).toMatchObject({ root: 'universal-router', commandPath: [0] })
  })

  it('reports no signed payload for a call that carries none', () => {
    const plain = encodeFunctionData({
      abi: EXECUTE_ABI,
      functionName: 'execute',
      args: ['0x10', [swapPlan(100n)], 4_000_000_000n],
    })
    const decoded = decodeUniswapV4Calldata(plain)!
    expect(collectSignedPayloads(decoded)).toEqual([])
    expect(signedPayloadDigest(decoded)).toBe('')
    expect(signedPayloadLimitation([])).toBeUndefined()
  })

  it('keeps every signature byte-identical under the strongest masked mutation', () => {
    const calldata = routerWithPermitCommand()
    const mask = deriveUniswapV4MutationMask(calldata)
    expect(mask).not.toBeNull()
    expect(mask!.byteIndices.length).toBeGreaterThan(0)

    const seed = decodeUniswapV4Calldata(calldata)!
    const bytes = hexToBytes(calldata)
    for (const index of mask!.byteIndices) bytes[index] = bytes[index]! ^ 0xff
    const mutated = bytesToHex(bytes)

    const variant = decodeUniswapV4Calldata(mutated)!
    expect(signedPayloadsPreserved(seed, variant)).toBe(true)
    expect(collectSignedPayloads(variant)[0]?.bytes).toBe(permit2ForwarderPermit())
    expect(isUniswapV4MaskedDerivative(mask!, mutated)).toBe(true)
  })

  it('rejects a candidate whose signature bytes were altered', () => {
    const calldata = routerWithPermitCommand()
    const mask = deriveUniswapV4MutationMask(calldata)!
    const seed = decodeUniswapV4Calldata(calldata)!

    // Flip a byte inside the signature itself rather than inside the mask.
    const signatureStart = calldata.toLowerCase().indexOf(SIGNATURE.slice(2).toLowerCase())
    expect(signatureStart).toBeGreaterThan(0)
    const bytes = hexToBytes(calldata)
    bytes[(signatureStart - 2) / 2] = bytes[(signatureStart - 2) / 2]! ^ 0x01
    const forged = bytesToHex(bytes)

    const variant = decodeUniswapV4Calldata(forged)
    expect(variant).not.toBeNull()
    expect(signedPayloadsPreserved(seed, variant!)).toBe(false)
    expect(isUniswapV4MaskedDerivative(mask, forged)).toBe(false)
  })

  it('states what the signed messages commit to', () => {
    const decoded = decodeUniswapV4Calldata(multicallWithPermits())!
    const limitation = signedPayloadLimitation(collectSignedPayloads(decoded))
    expect(limitation).toContain('replayed byte-identically')
    expect(limitation).toContain('erc721-permit')
    expect(limitation).toContain('original signature stayed valid')
  })

  it('finds the pool operation alongside the signed payloads', () => {
    const decoded = decodeUniswapV4Calldata(multicallWithPermits())!
    expect(decoded.kind).toBe('position-manager')
    expect(collectSignedPayloads(decoded)).toHaveLength(2)
    expect(poolId).toMatch(/^0x[0-9a-f]{64}$/)
  })
})
