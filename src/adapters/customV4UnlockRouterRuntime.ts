import { bytesToHex, getAddress, hexToBytes, keccak256, type Address, type Hex } from 'viem'

/**
 * Runtime-template recognition for the custom v4 unlock router family.
 *
 * Two deployments of this family were observed with different code hashes that
 * differ only in five embedded 20-byte address ranges. Masking exactly those
 * ranges and hashing the remainder gives a template identity: a claim that this
 * deployment is the same compiled program as one already reproduced end to end,
 * differing only in configuration.
 *
 * This is template recognition, not source verification. It says the bytes match
 * a known program; it does not say the program was audited, published, or that
 * its ABI is documented anywhere. Every non-masked byte must match exactly.
 */

/** Observed runtime length for the family; anything else is a different program. */
export const CUSTOM_ROUTER_RUNTIME_BYTES = 8_449

/**
 * Zero-based runtime offsets of the embedded 20-byte address ranges.
 *
 * These are the only positions two observed deployments differed at. They are
 * re-derived from the checked-in fixtures by the fixture tests rather than taken
 * on trust, so a wrong offset fails there instead of silently widening the mask.
 */
export const CUSTOM_ROUTER_ADDRESS_RANGES = [603, 887, 2_533, 2_797, 3_026] as const
const ADDRESS_BYTES = 20

export type CustomRouterRuntimeNormalization = {
  normalizedBytecode: Hex
  normalizedTemplateHash: Hex
  codeHash: Hex
  /** The repeated embedded address, once every masked range agrees on it. */
  configurationAddress: Address
}

export type CustomRouterRuntimeRejection =
  | 'length'
  | 'inconsistent-configuration'
  | 'template-mismatch'

export type CustomRouterRuntimeResult =
  | { ok: true; runtime: CustomRouterRuntimeNormalization }
  | { ok: false; reason: CustomRouterRuntimeRejection; detail: string }

function embeddedAddress(bytes: Uint8Array, start: number): string {
  return bytesToHex(bytes.subarray(start, start + ADDRESS_BYTES)).slice(2)
}

/**
 * Zeroes the declared address ranges and hashes what is left.
 *
 * The extracted addresses are returned rather than discarded: the router calls
 * that configuration contract, so a caller needs it to prefetch its state, and a
 * report needs it to name what the recognized deployment points at.
 */
export function normalizeCustomRouterRuntime(bytecode: Hex): CustomRouterRuntimeResult {
  const bytes = hexToBytes(bytecode)
  if (bytes.length !== CUSTOM_ROUTER_RUNTIME_BYTES) {
    return {
      ok: false,
      reason: 'length',
      detail: `Recognized template runtime is ${CUSTOM_ROUTER_RUNTIME_BYTES} bytes; this deployment is ${bytes.length}.`,
    }
  }

  const embedded = CUSTOM_ROUTER_ADDRESS_RANGES.map((start) => embeddedAddress(bytes, start))
  const distinct = new Set(embedded)
  if (distinct.size !== 1) {
    // The five ranges are one configuration value repeated. Disagreement means
    // either the offsets are wrong or this is not the same program.
    return {
      ok: false,
      reason: 'inconsistent-configuration',
      detail: `Embedded configuration addresses disagree across the masked ranges: ${[...distinct].join(', ')}.`,
    }
  }

  const masked = new Uint8Array(bytes)
  for (const start of CUSTOM_ROUTER_ADDRESS_RANGES) masked.fill(0, start, start + ADDRESS_BYTES)
  const normalizedBytecode = bytesToHex(masked)

  return {
    ok: true,
    runtime: {
      normalizedBytecode,
      normalizedTemplateHash: keccak256(normalizedBytecode),
      codeHash: keccak256(bytecode),
      configurationAddress: getAddress(`0x${embedded[0]!}`),
    },
  }
}

/**
 * Accepts a deployment only when its normalized template hash is the known one.
 *
 * The expected hash is supplied by the caller from a checked-in fixture rather
 * than hardcoded here, so the value a report cites is the one the fixture tests
 * derive from real runtime bytecode.
 */
export function recognizeCustomRouterRuntime(
  bytecode: Hex,
  expectedTemplateHash: Hex,
): CustomRouterRuntimeResult {
  const normalized = normalizeCustomRouterRuntime(bytecode)
  if (!normalized.ok) return normalized
  if (normalized.runtime.normalizedTemplateHash.toLowerCase() !== expectedTemplateHash.toLowerCase()) {
    return {
      ok: false,
      reason: 'template-mismatch',
      detail: 'Normalized runtime does not match the recognized template hash; a non-masked byte differs.',
    }
  }
  return normalized
}
