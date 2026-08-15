import { describe, expect, it } from 'vitest'
import { keccak256, toEventSelector, type Hex } from 'viem'
import {
  CUSTOM_ROUTER_POOL_MANAGER,
  CUSTOM_ROUTER_SAMPLES,
  CUSTOM_ROUTER_TEMPLATE_HASH,
  customRouterPoolKey,
  customRouterRuntime,
} from './customRouter9409'
import { computePoolId } from '../adapters/uniswapV4Pool'
import {
  CUSTOM_V4_UNLOCK_CALLDATA_BYTES,
  CUSTOM_V4_UNLOCK_SELECTOR,
  decodeCustomV4UnlockCalldata,
  encodeCustomV4UnlockCalldata,
} from '../adapters/customV4UnlockRouterCodec'
import {
  CUSTOM_ROUTER_ADDRESS_RANGES,
  CUSTOM_ROUTER_RUNTIME_BYTES,
  normalizeCustomRouterRuntime,
  recognizeCustomRouterRuntime,
} from '../adapters/customV4UnlockRouterRuntime'
import { attestCustomRouterExecution, V4_SELECTORS } from '../analysis/customRouterAttestation'

const bytes = (hex: Hex) => Buffer.from(hex.slice(2), 'hex')

describe('frozen mainnet fixtures', () => {
  it('carries three samples across two deployments of one template', () => {
    expect(CUSTOM_ROUTER_SAMPLES).toHaveLength(3)
    expect(new Set(CUSTOM_ROUTER_SAMPLES.map((sample) => sample.router)).size).toBe(2)
    expect(new Set(CUSTOM_ROUTER_SAMPLES.map((sample) => sample.expected.poolId)).size).toBe(2)
  })

  it.each(CUSTOM_ROUTER_SAMPLES)('$id is a zero-value 228-byte payload that succeeded', (sample) => {
    expect(sample.calldata.slice(0, 10)).toBe(CUSTOM_V4_UNLOCK_SELECTOR)
    expect((sample.calldata.length - 2) / 2).toBe(CUSTOM_V4_UNLOCK_CALLDATA_BYTES)
    expect(sample.value).toBe(0n)
    expect(sample.receipt.status).toBe('success')
    // The parent block is what a replay pins to.
    expect(sample.stateBlockNumber).toBe(sample.blockNumber - 1n)
  })
})

describe('codec against real calldata', () => {
  it.each(CUSTOM_ROUTER_SAMPLES)('decodes $id to its expected fields', (sample) => {
    const result = decodeCustomV4UnlockCalldata(sample.calldata, {
      poolKey: customRouterPoolKey(sample),
      poolId: sample.expected.poolId,
      transactionValue: sample.value,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.decoded).toMatchObject({
      zeroForOne: sample.expected.zeroForOne,
      amountIn: sample.expected.amountIn,
      settlementCurrency: sample.expected.settlementCurrency,
      poolId: sample.expected.poolId,
    })
    expect(result.decoded.poolKey.fee).toBe(sample.expected.fee)
    expect(result.decoded.poolKey.tickSpacing).toBe(sample.expected.tickSpacing)
    expect(result.decoded.poolKey.hooks).toBe(sample.expected.hook)
  })

  it.each(CUSTOM_ROUTER_SAMPLES)('re-encodes $id byte-identically', (sample) => {
    const result = decodeCustomV4UnlockCalldata(sample.calldata, {
      poolKey: customRouterPoolKey(sample),
      poolId: sample.expected.poolId,
      transactionValue: sample.value,
    })
    if (!result.ok) throw new Error(`${sample.id} did not decode`)
    expect(encodeCustomV4UnlockCalldata(result.decoded).toLowerCase()).toBe(sample.calldata.toLowerCase())
  })

  it.each(CUSTOM_ROUTER_SAMPLES)('reconstructs the PoolId $id actually traded', (sample) => {
    const key = customRouterPoolKey(sample)
    expect(computePoolId({ ...key, hook: key.hooks })).toBe(sample.expected.poolId)
  })

  it('refuses a real payload presented against the wrong pool', () => {
    const [owl, , hfa] = CUSTOM_ROUTER_SAMPLES
    // OWL's calldata offered as if it were HFA's pool must not decode.
    const result = decodeCustomV4UnlockCalldata(owl!.calldata, {
      poolKey: customRouterPoolKey(hfa!),
      poolId: hfa!.expected.poolId,
      transactionValue: 0n,
    })
    expect(result.ok).toBe(false)
  })
})

describe('runtime template against real deployments', () => {
  it.each(['owl', 'hfa'] as const)('%s runtime is 8,449 bytes with the recorded code hash', (key) => {
    const runtime = customRouterRuntime(key)
    expect((runtime.length - 2) / 2).toBe(CUSTOM_ROUTER_RUNTIME_BYTES)
    const sample = CUSTOM_ROUTER_SAMPLES.find((item) => item.runtimeKey === key)!
    expect(keccak256(runtime)).toBe(sample.runtimeCodeHash)
  })

  it('normalizes two different deployments to one template hash', () => {
    const owl = normalizeCustomRouterRuntime(customRouterRuntime('owl'))
    const hfa = normalizeCustomRouterRuntime(customRouterRuntime('hfa'))
    expect(owl.ok && hfa.ok).toBe(true)
    if (!owl.ok || !hfa.ok) return
    expect(owl.runtime.normalizedTemplateHash).toBe(CUSTOM_ROUTER_TEMPLATE_HASH)
    expect(hfa.runtime.normalizedTemplateHash).toBe(CUSTOM_ROUTER_TEMPLATE_HASH)
    // Raw identities stay distinct: recognition is not deduplication.
    expect(owl.runtime.codeHash).not.toBe(hfa.runtime.codeHash)
  })

  it('differs at exactly the five declared ranges and nowhere else', () => {
    const owl = bytes(customRouterRuntime('owl'))
    const hfa = bytes(customRouterRuntime('hfa'))
    const differing = [...owl.keys()].filter((index) => owl[index] !== hfa[index])
    const declared = new Set(CUSTOM_ROUTER_ADDRESS_RANGES.flatMap((start) =>
      Array.from({ length: 20 }, (_, offset) => start + offset)))
    expect(differing).toHaveLength(declared.size)
    expect(differing.every((index) => declared.has(index))).toBe(true)
  })

  it.each(CUSTOM_ROUTER_SAMPLES)('recovers the configuration address embedded in $id', (sample) => {
    const result = normalizeCustomRouterRuntime(customRouterRuntime(sample.runtimeKey))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.runtime.configurationAddress).toBe(sample.configurationAddress)
  })

  it('rejects a real deployment with one non-masked byte changed', () => {
    const tampered = bytes(customRouterRuntime('hfa'))
    tampered[5_000] = tampered[5_000]! ^ 0xff
    expect(recognizeCustomRouterRuntime(`0x${tampered.toString('hex')}` as Hex, CUSTOM_ROUTER_TEMPLATE_HASH))
      .toMatchObject({ ok: false, reason: 'template-mismatch' })
  })

  it('rejects a deployment whose embedded configuration is inconsistent', () => {
    const mixed = bytes(customRouterRuntime('owl'))
    const other = bytes(customRouterRuntime('hfa'))
    const range = CUSTOM_ROUTER_ADDRESS_RANGES[3]
    other.copy(mixed, range, range, range + 20)
    expect(normalizeCustomRouterRuntime(`0x${mixed.toString('hex')}` as Hex))
      .toMatchObject({ ok: false, reason: 'inconsistent-configuration' })
  })
})

describe('attestation against the captured trace', () => {
  const traced = CUSTOM_ROUTER_SAMPLES.filter((sample) => sample.tracedCalls?.length)

  it('captured at least one real trace', () => {
    expect(traced.length).toBeGreaterThan(0)
  })

  it.each(traced)('attests the reproduced call path of $id', (sample) => {
    const proof = {
      engine: 'revm/36.0.0', success: true, gasUsed: sample.receipt.gasUsed, output: '0x' as Hex,
      steps: [], storageOperations: [], storageDiffs: [], balanceChanges: [], selfdestructs: [], truncated: false,
      calls: sample.tracedCalls!.map((call) => ({
        caller: call.from, target: call.to, bytecodeAddress: call.to,
        scheme: 'Call', value: '0', inputLength: 68, selector: call.selector,
      })),
      logs: [{
        address: CUSTOM_ROUTER_POOL_MANAGER,
        topics: [
          toEventSelector('event Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)'),
          sample.expected.poolId,
        ] as Hex[],
        data: '0x' as Hex,
      }],
      logCount: sample.receipt.logCount,
    }
    const result = attestCustomRouterExecution({
      proof,
      poolManager: CUSTOM_ROUTER_POOL_MANAGER,
      router: sample.router,
      hook: sample.expected.hook,
      poolId: sample.expected.poolId,
    })
    expect(result.ok, result.ok ? '' : result.detail).toBe(true)
  })

  it('the real trace contains the ordered v4 unlock spine', () => {
    const selectors = traced[0]!.tracedCalls!.map((call) => call.selector)
    const spine = [V4_SELECTORS.unlock, V4_SELECTORS.unlockCallback, V4_SELECTORS.swap]
    let cursor = 0
    for (const selector of selectors) if (selector === spine[cursor]) cursor++
    expect(cursor).toBe(spine.length)
    for (const required of [V4_SELECTORS.transferFrom, V4_SELECTORS.sync, V4_SELECTORS.transfer, V4_SELECTORS.settle, V4_SELECTORS.take]) {
      expect(selectors, `missing ${required}`).toContain(required)
    }
  })
})
