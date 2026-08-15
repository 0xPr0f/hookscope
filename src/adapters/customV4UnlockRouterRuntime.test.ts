import { describe, expect, it } from 'vitest'
import { getAddress, keccak256, type Hex } from 'viem'
import {
  CUSTOM_ROUTER_ADDRESS_RANGES,
  CUSTOM_ROUTER_RUNTIME_BYTES,
  normalizeCustomRouterRuntime,
  recognizeCustomRouterRuntime,
} from './customV4UnlockRouterRuntime'

const CONFIG_A = '0xAAaAaA00000000000000000000000000000000Aa'
const CONFIG_B = '0xbBbBbB11111111111111111111111111111111bB'

/**
 * A synthetic deployment of the family: deterministic body with the declared
 * ranges carrying one repeated configuration address.
 *
 * Once the real fixtures land these tests run against them too; the synthetic
 * pair proves the masking logic independently of any one deployment.
 */
function deployment(config: string, mutate?: (bytes: Uint8Array) => void): Hex {
  const bytes = new Uint8Array(CUSTOM_ROUTER_RUNTIME_BYTES)
  for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 7 + 13) & 0xff
  const address = Buffer.from(config.slice(2), 'hex')
  for (const start of CUSTOM_ROUTER_ADDRESS_RANGES) bytes.set(address, start)
  mutate?.(bytes)
  return `0x${Buffer.from(bytes).toString('hex')}` as Hex
}

describe('custom router runtime template', () => {
  it('normalizes two deployments that differ only in configuration to one hash', () => {
    const owl = normalizeCustomRouterRuntime(deployment(CONFIG_A))
    const hfa = normalizeCustomRouterRuntime(deployment(CONFIG_B))
    expect(owl.ok && hfa.ok).toBe(true)
    if (!owl.ok || !hfa.ok) return
    expect(owl.runtime.normalizedTemplateHash).toBe(hfa.runtime.normalizedTemplateHash)
    // Raw identities must stay distinct: recognition is not deduplication.
    expect(owl.runtime.codeHash).not.toBe(hfa.runtime.codeHash)
    // Returned checksummed, so a report can name the configuration contract.
    expect(owl.runtime.configurationAddress).toBe(getAddress(CONFIG_A))
    expect(hfa.runtime.configurationAddress).toBe(getAddress(CONFIG_B))
  })

  it('differs from its counterpart at exactly the declared ranges', () => {
    const owl = Buffer.from(deployment(CONFIG_A).slice(2), 'hex')
    const hfa = Buffer.from(deployment(CONFIG_B).slice(2), 'hex')
    const differing = [...owl.keys()].filter((index) => owl[index] !== hfa[index])
    const declared = new Set(CUSTOM_ROUTER_ADDRESS_RANGES.flatMap((start) =>
      Array.from({ length: 20 }, (_, offset) => start + offset)))
    expect(differing.every((index) => declared.has(index))).toBe(true)
  })

  it('rejects a runtime of the wrong length', () => {
    expect(normalizeCustomRouterRuntime('0x6080')).toMatchObject({ ok: false, reason: 'length' })
  })

  it('rejects inconsistent embedded configuration addresses', () => {
    const inconsistent = deployment(CONFIG_A, (bytes) => {
      bytes.set(Buffer.from(CONFIG_B.slice(2), 'hex'), CUSTOM_ROUTER_ADDRESS_RANGES[2])
    })
    expect(normalizeCustomRouterRuntime(inconsistent)).toMatchObject({ ok: false, reason: 'inconsistent-configuration' })
  })

  it('rejects a deployment whose non-masked bytes differ', () => {
    const template = normalizeCustomRouterRuntime(deployment(CONFIG_A))
    if (!template.ok) throw new Error('template did not normalize')
    const tampered = deployment(CONFIG_B, (bytes) => { bytes[4_000] = bytes[4_000]! ^ 0xff })
    expect(recognizeCustomRouterRuntime(tampered, template.runtime.normalizedTemplateHash))
      .toMatchObject({ ok: false, reason: 'template-mismatch' })
    // The untampered counterpart is still recognized, so the rejection is the byte, not the mask.
    expect(recognizeCustomRouterRuntime(deployment(CONFIG_B), template.runtime.normalizedTemplateHash))
      .toMatchObject({ ok: true })
  })

  it('rejects unrelated bytecode of the same length that merely contains the selector', () => {
    const impostor = deployment(CONFIG_A, (bytes) => {
      bytes.set([0x94, 0x09, 0xa7, 0x8f], 100)
      // A different program: change a byte outside every masked range.
      bytes[7_000] = 0x01
    })
    const template = normalizeCustomRouterRuntime(deployment(CONFIG_A))
    if (!template.ok) throw new Error('template did not normalize')
    expect(recognizeCustomRouterRuntime(impostor, template.runtime.normalizedTemplateHash))
      .toMatchObject({ ok: false, reason: 'template-mismatch' })
  })

  it('reports the code hash revm will see for the raw deployment', () => {
    const raw = deployment(CONFIG_A)
    const result = normalizeCustomRouterRuntime(raw)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.runtime.codeHash).toBe(keccak256(raw))
  })
})
