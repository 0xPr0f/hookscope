import { decodeFunctionData, hexToBytes, type Hex } from 'viem'
import {
  SCENARIO_ABI,
  encodeScenario,
  type ProtocolScenario,
  type ScenarioStep,
} from './protocolNativeScenarios'

/**
 * Mutation mask for generated harness calldata.
 *
 * Seeds come from scenarios this analyzer generated, so the encoding is known
 * exactly and does not pass through the historical router codec. Mutable regions
 * are discovered by probing — encode the scenario twice with distinctive values
 * in one field and diff the bytes — rather than by hand-computed offsets, which
 * would silently drift if the struct changed.
 *
 * Immutable by construction: the selector, every PoolKey field (currencies, fee,
 * spacing, hook), ABI offsets and lengths, and the step count.
 *
 * Tick bounds and swap direction are deliberately excluded. Tick bounds must be
 * spacing-aligned and a byte-level mutator cannot preserve that. Direction is an
 * ABI bool: only 0x00 and 0x01 decode, and a mutated byte was measured against
 * the browser engine reverting inside the harness's own ABI decode without ever
 * reaching the PoolManager. The scenario matrix varies both structurally
 * instead, so masking them here would only spend budget on rejected inputs.
 */

export type ScenarioMutableField =
  | 'amountSpecified'
  | 'liquidityDelta'
  | 'donateAmount0'
  | 'donateAmount1'
  | 'hookData'

export type ScenarioMutableRegion = {
  stepIndex: number
  field: ScenarioMutableField
  byteIndices: number[]
}

export type ScenarioMutationMask = {
  calldata: Hex
  calldataBytes: number
  byteIndices: number[]
  regions: ScenarioMutableRegion[]
}

/** Low-order bytes carry magnitude; the mask keeps mutations inside a plausible range. */
const SCALAR_BYTES = 8
const PATTERN_A = 0x11n
const PATTERN_B = 0xeen

function repeatByte(byte: bigint, count: number): bigint {
  let value = 0n
  for (let index = 0; index < count; index++) value = (value << 8n) | byte
  return value
}

function changedIndices(original: Hex, variants: readonly Hex[]): number[] {
  const base = hexToBytes(original)
  // Not point-free: .map would pass the index as viem's opts argument.
  const others = variants.map((variant) => hexToBytes(variant))
  if (others.some((variant) => variant.length !== base.length)) {
    throw new Error('A scenario probe changed the calldata length.')
  }
  const changed: number[] = []
  for (let index = 0; index < base.length; index++) {
    if (others.some((variant) => variant[index] !== base[index])) changed.push(index)
  }
  return changed
}

function cloneSteps(steps: readonly ScenarioStep[]): ScenarioStep[] {
  return steps.map((step) => ({ ...step, key: { ...step.key } }))
}

function probe(
  steps: readonly ScenarioStep[],
  stepIndex: number,
  mutate: (step: ScenarioStep, pattern: bigint) => void,
): Hex[] {
  return [PATTERN_A, PATTERN_B].map((pattern) => {
    const copy = cloneSteps(steps)
    mutate(copy[stepIndex]!, pattern)
    return encodeScenario(copy)
  })
}

/**
 * Derives the mask for one generated scenario.
 *
 * Only fields the step actually uses are probed: a donation has no swap amount,
 * and a swap has no liquidity delta, so masking them would hand the mutator
 * bytes that cannot change behavior.
 */
export function deriveScenarioMutationMask(scenario: ProtocolScenario): ScenarioMutationMask {
  const calldata = scenario.calldata
  const steps = scenario.steps
  // The probe diffs encodings of `steps` against `calldata`, so a scenario whose
  // calldata does not match its steps would yield a mask covering the mismatch.
  if (encodeScenario(steps).toLowerCase() !== calldata.toLowerCase()) {
    throw new Error('Scenario calldata does not match its steps; refusing to derive a mask from an inconsistent seed.')
  }
  const regions: ScenarioMutableRegion[] = []

  const add = (stepIndex: number, field: ScenarioMutableField, variants: Hex[], expected?: number) => {
    const byteIndices = changedIndices(calldata, variants)
    if (!byteIndices.length) return
    if (expected !== undefined && byteIndices.length !== expected) {
      throw new Error(`Expected ${expected} mutable ${field} bytes, found ${byteIndices.length}.`)
    }
    regions.push({ stepIndex, field, byteIndices })
  }

  steps.forEach((step, stepIndex) => {
    if (step.amountSpecified !== 0n) {
      const sign = step.amountSpecified < 0n ? -1n : 1n
      add(stepIndex, 'amountSpecified', probe(steps, stepIndex, (target, pattern) => {
        target.amountSpecified = sign * repeatByte(pattern, SCALAR_BYTES)
      }), SCALAR_BYTES)
    }

    if (step.liquidityDelta > 0n) {
      // Only additions are masked. Mutating a removal could exceed what the
      // scenario added, which the liquidity invariant forbids.
      add(stepIndex, 'liquidityDelta', probe(steps, stepIndex, (target, pattern) => {
        target.liquidityDelta = repeatByte(pattern, SCALAR_BYTES)
      }), SCALAR_BYTES)
    }

    if (step.amount0 !== 0n) {
      add(stepIndex, 'donateAmount0', probe(steps, stepIndex, (target, pattern) => {
        target.amount0 = repeatByte(pattern, SCALAR_BYTES)
      }), SCALAR_BYTES)
    }
    if (step.amount1 !== 0n) {
      add(stepIndex, 'donateAmount1', probe(steps, stepIndex, (target, pattern) => {
        target.amount1 = repeatByte(pattern, SCALAR_BYTES)
      }), SCALAR_BYTES)
    }

    const hookDataBytes = (step.hookData.length - 2) / 2
    if (hookDataBytes > 0) {
      add(stepIndex, 'hookData', probe(steps, stepIndex, (target, pattern) => {
        target.hookData = `0x${pattern.toString(16).padStart(2, '0').repeat(hookDataBytes)}` as Hex
      }), hookDataBytes)
    }
  })

  const byteIndices = [...new Set(regions.flatMap((region) => region.byteIndices))].sort((a, b) => a - b)
  return { calldata, calldataBytes: (calldata.length - 2) / 2, byteIndices, regions }
}

function sameKey(left: ScenarioStep, right: ScenarioStep) {
  return left.key.currency0.toLowerCase() === right.key.currency0.toLowerCase()
    && left.key.currency1.toLowerCase() === right.key.currency1.toLowerCase()
    && left.key.fee === right.key.fee
    && left.key.tickSpacing === right.key.tickSpacing
    && left.key.hooks.toLowerCase() === right.key.hooks.toLowerCase()
}

/**
 * Accepts a candidate only if it is the seed with masked bytes changed.
 *
 * Decoding and re-encoding rejects a malformed envelope, and the per-step checks
 * reject a candidate that reached a different pool, changed the operation, or
 * moved a tick bound out of alignment.
 */
export function isScenarioDerivative(mask: ScenarioMutationMask, candidate: Hex): boolean {
  if ((candidate.length - 2) / 2 !== mask.calldataBytes) return false

  let seedSteps: ScenarioStep[]
  let candidateSteps: ScenarioStep[]
  try {
    seedSteps = decodeFunctionData({ abi: SCENARIO_ABI, data: mask.calldata }).args[0] as ScenarioStep[]
    const decoded = decodeFunctionData({ abi: SCENARIO_ABI, data: candidate })
    if (decoded.functionName !== 'run') return false
    candidateSteps = decoded.args[0] as ScenarioStep[]
    if (encodeScenario(candidateSteps).toLowerCase() !== candidate.toLowerCase()) return false
  } catch {
    return false
  }

  if (candidateSteps.length !== seedSteps.length) return false
  for (let index = 0; index < seedSteps.length; index++) {
    const seed = seedSteps[index]!
    const step = candidateSteps[index]!
    if (step.operation !== seed.operation) return false
    if (!sameKey(seed, step)) return false
    if (step.tickLower !== seed.tickLower || step.tickUpper !== seed.tickUpper) return false
    if (step.salt !== seed.salt) return false
  }

  // Nothing outside the mask may differ.
  const original = hexToBytes(mask.calldata)
  const mutated = hexToBytes(candidate)
  const allowed = new Set(mask.byteIndices)
  for (let index = 0; index < original.length; index++) {
    if (original[index] !== mutated[index] && !allowed.has(index)) return false
  }
  return true
}

/**
 * Splits one pool's budget across operation shapes.
 *
 * Each shape gets a share rather than a fresh allowance, so the pool ceiling
 * holds no matter how many seeds a scenario matrix produced.
 */
export function splitExplorationBudget(shapes: readonly string[], totalExecutions: number) {
  const count = Math.max(1, shapes.length)
  const base = Math.floor(totalExecutions / count)
  let remainder = totalExecutions % count
  return shapes.map((shape) => ({
    shape,
    executions: base + (remainder-- > 0 ? 1 : 0),
  }))
}
