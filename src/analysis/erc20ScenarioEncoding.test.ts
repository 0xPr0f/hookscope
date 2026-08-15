import { describe, expect, it } from 'vitest'
import { decodeFunctionData, getAddress, type Address } from 'viem'
import erc20Manifest from '../fixtures/generated/protocol-erc20-scenario-router.json'
import claimsManifest from '../fixtures/generated/protocol-scenario-router.json'
import {
  ERC20_SCENARIO_ABI,
  buildProtocolScenarioMatrix,
  encodeErc20Scenario,
  encodeScenario,
} from './protocolNativeScenarios'

const PAYER = getAddress('0xbbd64a6de020a1e2caf3eabe3781b8958d03c728')
const RECIPIENT = getAddress('0x000000000000000000000000000000000000beef')
const HOOK = getAddress('0x239732813d5f9b531abc736b1c9478f7088e0040')
const TOKEN = getAddress('0x3c4952ccf02d4dbb4c48077bbfe8296b3dfdb4bc')

const scenarios = buildProtocolScenarioMatrix({
  key: { currency0: '0x0000000000000000000000000000000000000000' as Address, currency1: TOKEN, fee: 0x800000, tickSpacing: 200, hooks: HOOK },
  currentTick: 0,
  actor: PAYER,
}).scenarios

describe('ERC-20 scenario encoding', () => {
  it('produces the selector the deployed harness actually exposes', () => {
    const expected = Object.entries(erc20Manifest.selectors)
      .find(([signature]) => signature.startsWith('run('))![1]
    const calldata = encodeErc20Scenario(scenarios[0]!.steps, PAYER, RECIPIENT)
    expect(calldata.slice(2, 10)).toBe(expected)
  })

  it('is a different selector from the claims lane, so the lanes cannot be confused', () => {
    const claimsSelector = Object.entries(claimsManifest.selectors)
      .find(([signature]) => signature.startsWith('run('))![1]
    const erc20Selector = Object.entries(erc20Manifest.selectors)
      .find(([signature]) => signature.startsWith('run('))![1]
    expect(erc20Selector).not.toBe(claimsSelector)

    const steps = scenarios[0]!.steps
    expect(encodeScenario(steps).slice(2, 10)).toBe(claimsSelector)
    expect(encodeErc20Scenario(steps, PAYER, RECIPIENT).slice(2, 10)).toBe(erc20Selector)
  })

  it('round-trips every generated scenario with its payer and recipient intact', () => {
    for (const scenario of scenarios) {
      const calldata = encodeErc20Scenario(scenario.steps, PAYER, RECIPIENT)
      const decoded = decodeFunctionData({ abi: ERC20_SCENARIO_ABI, data: calldata })
      expect(decoded.functionName).toBe('run')
      const [steps, payer, recipient] = decoded.args as [unknown[], Address, Address]
      expect(steps).toHaveLength(scenario.steps.length)
      expect(payer).toBe(PAYER)
      expect(recipient).toBe(RECIPIENT)
      // Re-encoding is byte-identical, so nothing is lost through the lane.
      expect(encodeErc20Scenario(scenario.steps, payer, recipient)).toBe(calldata)
    }
  })

  it('carries the same pool key as the claims lane for the same scenario', () => {
    const scenario = scenarios.find((item) => item.id === 'swap:exact-input:0-for-1:medium')!
    const erc20 = decodeFunctionData({ abi: ERC20_SCENARIO_ABI, data: encodeErc20Scenario(scenario.steps, PAYER, RECIPIENT) })
    const steps = erc20.args[0] as readonly { key: { hooks: Address; fee: number; tickSpacing: number } }[]
    expect(steps[0]!.key.hooks).toBe(HOOK)
    expect(steps[0]!.key.fee).toBe(0x800000)
    expect(steps[0]!.key.tickSpacing).toBe(200)
  })
})
