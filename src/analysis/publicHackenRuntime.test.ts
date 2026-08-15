import { describe, expect, it } from 'vitest'
import {
  encodeAbiParameters,
  encodeEventTopics,
  toFunctionSelector,
  type Address,
  type Hex,
} from 'viem'
import type { PoolDescriptor } from '../domain/report'
import type { ProtocolScenarioContext } from './protocolScenarioContext'
import { runPublicHackenRuntimeProbes } from './publicHackenRuntime'
import type { ForkExecutionInput, ForkReplayResult, RevmExecutionProof } from './revmProof'

const POOL_MANAGER = '0x000000000004444c5dc75cB358380D2e3dE08A90' as Address
const HOOK = '0x3333333333333333333333333333333333330080' as Address
const ROUTER = '0x0000000000000000000000000000000000005ce4' as Address
const ACTOR = '0x00000000000000000000000000000000000ac7a1' as Address
const PRIMARY_POOL_ID = `0x${'11'.repeat(32)}` as Hex
const SECONDARY_POOL_ID = `0x${'22'.repeat(32)}` as Hex

const PERMISSION_OUTPUTS = Array.from({ length: 14 }, () => ({ type: 'bool' as const }))
const GET_PERMISSIONS = toFunctionSelector('getHookPermissions()')
const GET_POOL_MANAGER = toFunctionSelector('poolManager()')
const SUPPORTS_INTERFACE = toFunctionSelector('supportsInterface(bytes4)')
const BEFORE_SWAP = toFunctionSelector('beforeSwap(address,(address,address,uint24,int24,address),(bool,int256,uint160),bytes)')
const UNLOCK = '0x48c89491' as Hex

const primary: PoolDescriptor = {
  poolId: PRIMARY_POOL_ID,
  currency0: '0x0000000000000000000000000000000000000000',
  currency1: '0x2222222222222222222222222222222222222222',
  fee: 3_000,
  tickSpacing: 60,
  hook: HOOK,
  initializedAtBlock: '100',
  activity: 2,
}
const secondary: PoolDescriptor = {
  ...primary,
  poolId: SECONDARY_POOL_ID,
  fee: 500,
  tickSpacing: 10,
  initializedAtBlock: '120',
  activity: 1,
}

const context = {
  chainId: 1,
  stateBlockNumber: 100n,
  executionBlock: {
    number: 101n,
    beneficiary: '0x0000000000000000000000000000000000000000',
    timestamp: 1n,
    gasLimit: 30_000_000n,
    baseFee: 1n,
    difficulty: 0n,
  },
  poolManager: POOL_MANAGER,
  pool: primary,
  router: ROUTER,
  alternateRouter: '0x0000000000000000000000000000000000005ce5',
  erc20Router: '0x0000000000000000000000000000000000005ce6',
  actor: ACTOR,
  alternateActor: '0x00000000000000000000000000000000000ac7a2',
  relocatedAddresses: [],
  overlay: { snapshot: { accounts: [], blockHashes: [] }, declaredOverrides: [], patched: {} },
  slot0: { sqrtPriceX96: 1n << 96n, tick: 0, protocolFee: 0, lpFee: 3_000 },
} as unknown as ProtocolScenarioContext

function call(target: Address, selector: Hex) {
  return {
    frameId: 1,
    depth: 0,
    caller: ACTOR,
    target,
    bytecodeAddress: target,
    scheme: 'CALL',
    value: '0x0',
    inputLength: 4,
    selector,
  }
}

function proof(input: Partial<RevmExecutionProof> = {}): ForkReplayResult {
  const base: RevmExecutionProof = {
    engine: 'test',
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
  }
  const value = { ...base, ...input }
  return { proof: value, hydrationRequests: 0, hydratedAccounts: 0, hydratedStorageSlots: 0 }
}

function secondarySwapProof() {
  const topics = encodeEventTopics({
    abi: [{
      type: 'event',
      name: 'Swap',
      inputs: [
        { name: 'id', type: 'bytes32', indexed: true },
        { name: 'sender', type: 'address', indexed: true },
        { name: 'amount0', type: 'int128', indexed: false },
        { name: 'amount1', type: 'int128', indexed: false },
        { name: 'sqrtPriceX96', type: 'uint160', indexed: false },
        { name: 'liquidity', type: 'uint128', indexed: false },
        { name: 'tick', type: 'int24', indexed: false },
        { name: 'fee', type: 'uint24', indexed: false },
      ],
    }],
    eventName: 'Swap',
    args: { id: SECONDARY_POOL_ID, sender: ROUTER },
  }) as Hex[]
  return proof({
    calls: [call(POOL_MANAGER, UNLOCK)],
    logs: [{
      address: POOL_MANAGER,
      topics,
      data: encodeAbiParameters(
        [
          { type: 'int128' }, { type: 'int128' }, { type: 'uint160' },
          { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' },
        ],
        [-1n, 1n, 1n << 96n, 100n, 0, 500],
      ),
    }],
    logCount: 1,
  })
}

function session(options: { permissions?: boolean[]; directSucceeds?: boolean } = {}) {
  const calls: Hex[] = []
  const permissions = options.permissions ?? [false, false, false, false, false, false, true, false, false, false, false, false, false, false]
  return {
    calls,
    execute: async (input: ForkExecutionInput) => {
      const selector = input.transaction.calldata.slice(0, 10) as Hex
      calls.push(selector)
      if (input.transaction.to.toLowerCase() === ROUTER.toLowerCase()) return secondarySwapProof()
      if (selector === GET_PERMISSIONS) {
        return proof({ output: encodeAbiParameters(PERMISSION_OUTPUTS, permissions) })
      }
      if (selector === GET_POOL_MANAGER) {
        return proof({ output: encodeAbiParameters([{ type: 'address' }], [POOL_MANAGER]) })
      }
      if (selector === SUPPORTS_INTERFACE) {
        return proof({ output: encodeAbiParameters([{ type: 'bool' }], [true]) })
      }
      return proof({
        success: Boolean(options.directSucceeds),
        calls: [call(HOOK, selector)],
        output: options.directSucceeds ? '0x' : '0xdeadbeef',
      })
    },
  }
}

describe('public Hacken runtime adaptations', () => {
  it('proves canonical getters, every enabled direct callback, and a compatible secondary PoolId', async () => {
    const fake = session()
    const probes = await runPublicHackenRuntimeProbes({
      session: fake,
      context,
      pools: [primary, secondary],
      signal: new AbortController().signal,
    })
    const byId = new Map(probes.map((item) => [item.caseId, item]))

    expect(byId.get('permissions-match-address')).toMatchObject({ status: 'passed' })
    expect(byId.get('base-hook-pool-manager')).toMatchObject({ status: 'passed' })
    expect(byId.get('introspect-public-getters')).toMatchObject({ status: 'passed' })
    expect(byId.get('introspect-optional-interface')).toMatchObject({ status: 'observed' })
    expect(byId.get('only-pool-manager')).toMatchObject({ status: 'passed', observedOutcome: 'reverted' })
    expect(byId.get('secondary-pool-open-policy')).toMatchObject({ status: 'passed', observedOutcome: 'completed' })
    expect(fake.calls.filter((selector) => selector === BEFORE_SWAP)).toHaveLength(1)
  })

  it('rejects a canonical permissions result that disagrees with the hook address bits', async () => {
    const probes = await runPublicHackenRuntimeProbes({
      session: session({ permissions: Array.from({ length: 14 }, () => false) }),
      context,
      pools: [primary],
      signal: new AbortController().signal,
    })
    expect(probes.find((item) => item.caseId === 'permissions-match-address')).toMatchObject({
      status: 'failed',
    })
    expect(probes.find((item) => item.caseId === 'secondary-pool-open-policy')).toMatchObject({
      status: 'unavailable',
    })
  })

  it('contradicts direct-callback authorization when an enabled callback completes', async () => {
    const probes = await runPublicHackenRuntimeProbes({
      session: session({ directSucceeds: true }),
      context,
      pools: [primary],
      signal: new AbortController().signal,
    })
    expect(probes.find((item) => item.caseId === 'only-pool-manager')).toMatchObject({
      status: 'failed',
      observedOutcome: 'completed',
    })
  })
})
