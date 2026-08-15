import { describe, expect, it } from 'vitest'
import { getAddress, keccak256, pad, type Address, type Hex } from 'viem'
import manifest from '../fixtures/generated/protocol-scenario-router.json'
import {
  patchScenarioRouter,
  scenarioRouterIdentity,
  verifyPatchedRouter,
} from './protocolScenarioArtifact'

const MANAGER = '0x000000000004444c5dc75cB358380D2e3dE08A90' as Address
const OTHER = '0x498581fF718922c3f8e6A244956aF099B2652b2b' as Address

describe('scenario harness artifact', () => {
  it('writes the manager into every declared immutable position and nowhere else', () => {
    const patched = patchScenarioRouter(MANAGER)
    const word = pad(getAddress(MANAGER), { size: 32 }).slice(2).toLowerCase()
    const body = patched.runtimeBytecode.slice(2)
    const template = manifest.runtimeBytecode.slice(2)

    expect(body.length).toBe(template.length)
    const patchedRanges = new Set<number>()
    for (const position of manifest.immutablePoolManagerPositions) {
      expect(body.slice(position.start * 2, (position.start + position.length) * 2)).toBe(word)
      for (let i = position.start * 2; i < (position.start + position.length) * 2; i++) patchedRanges.add(i)
    }
    // Every byte outside a declared position is untouched.
    for (let i = 0; i < template.length; i++) {
      if (!patchedRanges.has(i)) expect(body[i], `byte ${i}`).toBe(template[i])
    }
  })

  it('derives a different runtime hash per chain manager', () => {
    const a = patchScenarioRouter(MANAGER)
    const b = patchScenarioRouter(OTHER)
    expect(a.runtimeHash).not.toBe(b.runtimeHash)
    expect(a.runtimeHash).toBe(keccak256(a.runtimeBytecode))
    expect(a.templateHash).toBe(b.templateHash)
  })

  it('accepts only a byte-identical patch of the pinned template', () => {
    const patched = patchScenarioRouter(MANAGER)
    expect(verifyPatchedRouter(patched.runtimeBytecode, MANAGER)).toBe(true)
    // Right bytecode, wrong manager.
    expect(verifyPatchedRouter(patched.runtimeBytecode, OTHER)).toBe(false)
    // One extra byte changed outside the immutable positions.
    const tampered = `${patched.runtimeBytecode.slice(0, -2)}ff` as Hex
    expect(verifyPatchedRouter(tampered, MANAGER)).toBe(false)
  })

  it('carries the pinned provenance a report has to disclose', () => {
    const identity = scenarioRouterIdentity(patchScenarioRouter(MANAGER))
    expect(identity.contract).toBe('ProtocolScenarioRouter')
    expect(identity.note).toContain('Not audited')
    expect(identity.compiler).toBe(manifest.compiler.solc)
    expect(identity.uniswapCore).toBe(manifest.uniswap.core)
    expect(identity.poolManager).toBe(getAddress(MANAGER))
  })

  it('pins exactly one immutable so a layout change cannot pass silently', () => {
    expect(manifest.immutablePoolManagerPositions.length).toBeGreaterThan(0)
    for (const position of manifest.immutablePoolManagerPositions) expect(position.length).toBe(32)
    expect(manifest.compiler.evmVersion).toBe('cancun')
  })
})
