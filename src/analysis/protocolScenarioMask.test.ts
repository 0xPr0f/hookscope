import { describe, expect, it } from 'vitest'
import { decodeFunctionData, hexToBytes, bytesToHex, type Address, type Hex } from 'viem'
import {
  SCENARIO_ABI,
  buildProtocolScenarioMatrix,
  encodeScenario,
  type ScenarioPoolKey,
  type ScenarioStep,
} from './protocolNativeScenarios'
import {
  deriveScenarioMutationMask,
  isScenarioDerivative,
  splitExplorationBudget,
} from './protocolScenarioMask'

const ACTOR = '0x1111111111111111111111111111111111111111' as Address
const key: ScenarioPoolKey = {
  currency0: '0x0000000000000000000000000000000000000000',
  currency1: '0x2222222222222222222222222222222222222222',
  fee: 3_000,
  tickSpacing: 60,
  hooks: '0x3333333333333333333333333333333333333333',
}

const matrix = buildProtocolScenarioMatrix({ key, currentTick: 0, actor: ACTOR })
const find = (id: string) => matrix.scenarios.find((s) => s.id === id)!

function flip(calldata: Hex, indices: readonly number[]): Hex {
  const bytes = hexToBytes(calldata)
  for (const index of indices) bytes[index] = bytes[index]! ^ 0x01
  return bytesToHex(bytes)
}

function steps(calldata: Hex): ScenarioStep[] {
  return decodeFunctionData({ abi: SCENARIO_ABI, data: calldata }).args[0] as ScenarioStep[]
}

describe('generated scenario mutation mask', () => {
  it('masks the swap amount and hook data but nothing structural', () => {
    const scenario = find('swap:hook-data:marker')
    const mask = deriveScenarioMutationMask(scenario)
    expect(mask.regions.map((r) => r.field).sort()).toEqual(['amountSpecified', 'hookData'])
    // Selector is never mutable.
    expect(mask.byteIndices.every((index) => index >= 4)).toBe(true)
  })

  it('leaves the direction bool outside the mask', () => {
    const scenario = find('swap:exact-input:0-for-1:medium')
    const mask = deriveScenarioMutationMask(scenario)
    // Only 0x00 and 0x01 decode as an ABI bool, so a mutated direction byte
    // dies in the harness's own decoder instead of reaching the PoolManager.
    // The matrix covers both directions structurally instead.
    const flipped = encodeScenario(scenario.steps.map((step) => ({ ...step, zeroForOne: !step.zeroForOne })))
    const seedBytes = hexToBytes(mask.calldata)
    const flippedBytes = hexToBytes(flipped)
    const directionIndex = seedBytes.findIndex((byte, index) => byte !== flippedBytes[index])
    expect(directionIndex).toBeGreaterThan(0)
    expect(mask.byteIndices).not.toContain(directionIndex)
  })

  it('keeps the PoolKey byte-identical under the strongest masked mutation', () => {
    const scenario = find('swap:exact-input:0-for-1:medium')
    const mask = deriveScenarioMutationMask(scenario)
    const mutated = flip(mask.calldata, mask.byteIndices)
    const [seed] = steps(mask.calldata)
    const [candidate] = steps(mutated)
    expect(candidate!.key).toEqual(seed!.key)
    expect(candidate!.tickLower).toBe(seed!.tickLower)
    expect(isScenarioDerivative(mask, mutated)).toBe(true)
  })

  it('rejects a candidate that reaches a different pool', () => {
    const scenario = find('swap:exact-input:0-for-1:medium')
    const mask = deriveScenarioMutationMask(scenario)
    const otherPool = encodeScenario(scenario.steps.map((s) => ({ ...s, key: { ...s.key, fee: 500 } })))
    expect(isScenarioDerivative(mask, otherPool)).toBe(false)
  })

  it('refuses a seed whose calldata disagrees with its steps', () => {
    const scenario = find('swap:exact-input:0-for-1:medium')
    const inconsistent = { ...scenario, steps: scenario.steps.map((s) => ({ ...s, key: { ...s.key, fee: 500 } })) }
    expect(() => deriveScenarioMutationMask(inconsistent)).toThrow(/does not match its steps/)
  })

  it('rejects a mutation outside the mask', () => {
    const mask = deriveScenarioMutationMask(find('swap:exact-input:0-for-1:medium'))
    const outside = [...Array(mask.calldataBytes).keys()].find((i) => !mask.byteIndices.includes(i) && i >= 4)!
    expect(isScenarioDerivative(mask, flip(mask.calldata, [outside]))).toBe(false)
  })

  it('excludes tick bounds so alignment cannot be broken by a byte flip', () => {
    const mask = deriveScenarioMutationMask(find('liquidity:add:narrow'))
    expect(mask.regions.map((r) => r.field)).toContain('liquidityDelta')
    expect(mask.regions.map((r) => r.field)).not.toContain('tickLower')
    const mutated = flip(mask.calldata, mask.byteIndices)
    const [seed] = steps(mask.calldata)
    const [candidate] = steps(mutated)
    expect(candidate!.tickLower).toBe(seed!.tickLower)
    expect(candidate!.tickUpper).toBe(seed!.tickUpper)
  })

  it('masks donation amounts only for the currencies the scenario donates', () => {
    const only0 = deriveScenarioMutationMask(find('donate:currency0'))
    expect(only0.regions.map((r) => r.field)).toEqual(['donateAmount0'])
    const both = deriveScenarioMutationMask(find('donate:both'))
    expect(both.regions.map((r) => r.field).sort()).toEqual(['donateAmount0', 'donateAmount1'])
  })

  it('does not mask a liquidity removal', () => {
    const mask = deriveScenarioMutationMask(find('sequence:add-then-remove'))
    // Step 0 adds and is maskable; step 1 removes and must not be.
    expect(mask.regions.filter((r) => r.field === 'liquidityDelta').map((r) => r.stepIndex)).toEqual([0])
  })

  it('masks every step of a multi-step sequence', () => {
    const mask = deriveScenarioMutationMask(find('sequence:repeated-swap'))
    expect(new Set(mask.regions.map((r) => r.stepIndex))).toEqual(new Set([0, 1]))
    expect(isScenarioDerivative(mask, flip(mask.calldata, mask.byteIndices))).toBe(true)
  })

  it('splits one pool budget across shapes instead of granting each a full run', () => {
    const split = splitExplorationBudget(['swap', 'liquidity', 'donate'], 30_000)
    expect(split.reduce((sum, item) => sum + item.executions, 0)).toBe(30_000)
    expect(split.every((item) => item.executions < 30_000)).toBe(true)
  })
})
