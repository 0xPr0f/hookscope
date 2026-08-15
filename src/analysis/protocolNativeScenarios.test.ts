import { describe, expect, it } from 'vitest'
import { decodeFunctionData, type Address } from 'viem'
import {
  MAX_SQRT_PRICE_MINUS_ONE,
  MIN_SQRT_PRICE_PLUS_ONE,
  SCENARIO_ABI,
  alignTick,
  alignedRange,
  buildProtocolScenarioMatrix,
  type ScenarioPoolKey,
} from './protocolNativeScenarios'

const ACTOR = '0x1111111111111111111111111111111111111111' as Address
const key: ScenarioPoolKey = {
  currency0: '0x0000000000000000000000000000000000000000',
  currency1: '0x2222222222222222222222222222222222222222',
  fee: 3_000,
  tickSpacing: 60,
  hooks: '0x3333333333333333333333333333333333333333',
}

describe('generated scenario matrix', () => {
  it('covers both directions and both exactness modes at bounded amounts', () => {
    const { scenarios } = buildProtocolScenarioMatrix({ key, currentTick: 0, actor: ACTOR })
    const swaps = scenarios.filter((s) => s.operation === 'swap' && s.id.startsWith('swap:exact'))
    // 2 directions x 2 modes x 3 amounts.
    expect(swaps).toHaveLength(12)
    // Negative amountSpecified is exact input, positive is exact output.
    const exactIn = scenarios.find((s) => s.id === 'swap:exact-input:0-for-1:small')!
    expect(exactIn.steps[0]!.amountSpecified).toBe(-1_000n)
    const exactOut = scenarios.find((s) => s.id === 'swap:exact-output:0-for-1:small')!
    expect(exactOut.steps[0]!.amountSpecified).toBe(1_000n)
  })

  it('points each swap at the canonical price bound for its direction', () => {
    const { scenarios } = buildProtocolScenarioMatrix({ key, currentTick: 0, actor: ACTOR })
    for (const scenario of scenarios.filter((s) => s.operation === 'swap')) {
      const step = scenario.steps[0]!
      expect(step.sqrtPriceLimitX96).toBe(
        step.zeroForOne ? MIN_SQRT_PRICE_PLUS_ONE : MAX_SQRT_PRICE_MINUS_ONE,
      )
    }
  })

  it('keeps every liquidity range aligned to the pool tick spacing', () => {
    const { scenarios } = buildProtocolScenarioMatrix({ key, currentTick: 137, actor: ACTOR })
    const ranged = scenarios.filter((s) => s.steps.some((step) => step.liquidityDelta !== 0n))
    expect(ranged.length).toBeGreaterThan(0)
    for (const scenario of ranged) {
      for (const step of scenario.steps) {
        if (step.liquidityDelta === 0n) continue
        // Math.abs because a negative aligned tick yields -0, and Object.is(-0, 0) is false.
        expect(Math.abs(step.tickLower % key.tickSpacing)).toBe(0)
        expect(Math.abs(step.tickUpper % key.tickSpacing)).toBe(0)
        expect(step.tickLower).toBeLessThan(step.tickUpper)
      }
    }
  })

  it('only ever removes liquidity it added in the same sequence', () => {
    const { scenarios } = buildProtocolScenarioMatrix({ key, currentTick: 0, actor: ACTOR })
    for (const scenario of scenarios) {
      let net = 0n
      for (const step of scenario.steps) {
        net += step.liquidityDelta
        // A removal may never exceed what this scenario has already added.
        expect(net).toBeGreaterThanOrEqual(0n)
      }
    }
  })

  it('reports liquidity as unavailable with a reason when the tick is unknown', () => {
    const { scenarios, unavailable } = buildProtocolScenarioMatrix({ key, actor: ACTOR })
    expect(scenarios.some((s) => s.steps.some((step) => step.liquidityDelta !== 0n))).toBe(false)
    expect(unavailable).toHaveLength(1)
    expect(unavailable[0]!.reason).toContain('tick was not readable')
    // Swaps and donations must still be generated.
    expect(scenarios.some((s) => s.operation === 'swap')).toBe(true)
    expect(scenarios.some((s) => s.operation === 'donate')).toBe(true)
  })

  it('rounds ticks toward negative infinity so negative ranges stay aligned', () => {
    expect(alignTick(137, 60)).toBe(120)
    expect(alignTick(-137, 60)).toBe(-180)
    const range = alignedRange(-137, 60, 1)!
    expect(Math.abs(range.tickLower % 60)).toBe(0)
    expect(Math.abs(range.tickUpper % 60)).toBe(0)
    expect(range.tickLower).toBeLessThan(range.tickUpper)
  })

  it('encodes calldata the harness ABI decodes back to the same steps', () => {
    const { scenarios } = buildProtocolScenarioMatrix({ key, currentTick: 0, actor: ACTOR })
    const scenario = scenarios.find((s) => s.id === 'sequence:repeated-swap')!
    const decoded = decodeFunctionData({ abi: SCENARIO_ABI, data: scenario.calldata })
    expect(decoded.functionName).toBe('run')
    const steps = decoded.args[0] as readonly { amountSpecified: bigint }[]
    expect(steps).toHaveLength(2)
    expect(steps[0]!.amountSpecified).toBe(-1_000n)
    expect(scenario.commits).toBe(true)
  })

  it('exercises hook data shapes and an alternate sender', () => {
    const { scenarios } = buildProtocolScenarioMatrix({ key, currentTick: 0, actor: ACTOR })
    expect(scenarios.find((s) => s.id === 'swap:hook-data:empty')!.steps[0]!.hookData).toBe('0x')
    expect(scenarios.find((s) => s.id === 'swap:hook-data:marker')!.steps[0]!.hookData).toBe('0x686f6f6b73636f7065')
    expect(scenarios.find((s) => s.id === 'swap:hook-data:abi-actor')!.steps[0]!.hookData)
      .toContain(ACTOR.slice(2).toLowerCase())
    // The alternate-sender scenario must change the contract that calls the
    // PoolManager, not merely the transaction caller: a hook's `sender` is
    // whoever called the PoolManager, which is always a harness instance.
    const alternate = scenarios.find((s) => s.id === 'swap:alternate-sender')!
    expect(alternate.caller).toBe('alternateActor')
    expect(alternate.via).toBe('alternateRouter')
    expect(scenarios.filter((s) => s.via === 'router').length).toBe(scenarios.length - 1)
  })

  it('generates donations for each currency shape', () => {
    const { scenarios } = buildProtocolScenarioMatrix({ key, currentTick: 0, actor: ACTOR })
    const donations = scenarios.filter((s) => s.operation === 'donate')
    expect(donations.map((s) => s.id).sort()).toEqual([
      'donate:both', 'donate:currency0', 'donate:currency1', 'donate:minimal',
    ])
  })
})
