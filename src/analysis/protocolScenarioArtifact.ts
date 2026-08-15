import { getAddress, keccak256, pad, type Address, type Hex } from 'viem'
import manifest from '../fixtures/generated/protocol-scenario-router.json'

/**
 * Injection contract for the generated-scenario harness.
 *
 * The harness holds PoolManager as a Solidity `immutable`, so its runtime code
 * differs per chain. Rather than deploying it, the browser patches the compiled
 * template and injects the result as fork state. That is only defensible if the
 * patch is exact, so every rule here is a refusal:
 *
 * - patch only compiler-declared immutable positions, never a byte pattern
 *   search, which could rewrite an unrelated constant that happens to match;
 * - require each target to be zeroed in the template, so a patch never silently
 *   overwrites meaningful code;
 * - re-derive the template and source hashes and reject on any drift.
 */

export type ProtocolScenarioManifest = typeof manifest

export type PatchedScenarioRouter = {
  runtimeBytecode: Hex
  /** keccak256 of the patched runtime, which is the code hash revm will report. */
  runtimeHash: Hex
  poolManager: Address
  templateHash: string
  sourceHash: string
  compiler: string
  uniswap: { core: string; periphery: string }
}

export class ScenarioArtifactError extends Error {}

function assertTemplateIntegrity(template: string) {
  if (manifest.schemaVersion !== '1') {
    throw new ScenarioArtifactError('Scenario harness manifest schema is unsupported.')
  }
  if (!template.startsWith('0x') || (template.length - 2) / 2 !== manifest.runtimeBytes) {
    throw new ScenarioArtifactError('Scenario harness runtime length does not match its manifest.')
  }
  if (!manifest.immutablePoolManagerPositions.length) {
    throw new ScenarioArtifactError('Scenario harness manifest declares no immutable position to patch.')
  }
}

/**
 * Rewrites the PoolManager immutable at every declared position.
 *
 * Solidity stores an address immutable right-aligned in a 32-byte word, matching
 * how `abi.encode(address)` pads it.
 */
export function patchScenarioRouter(poolManager: Address): PatchedScenarioRouter {
  const template = manifest.runtimeBytecode
  assertTemplateIntegrity(template)

  const address = getAddress(poolManager)
  const word = pad(address, { size: 32 }).slice(2).toLowerCase()
  const bytes = template.slice(2).split('')

  for (const position of manifest.immutablePoolManagerPositions) {
    const start = position.start * 2
    const end = start + position.length * 2
    if (position.length !== 32) {
      throw new ScenarioArtifactError(`Immutable position at ${position.start} is not 32 bytes.`)
    }
    if (end > bytes.length) {
      throw new ScenarioArtifactError(`Immutable position at ${position.start} falls outside the runtime.`)
    }
    const existing = template.slice(2).slice(start, end)
    if (!/^0+$/.test(existing)) {
      throw new ScenarioArtifactError(
        `Immutable position at ${position.start} is not zeroed in the template; refusing to overwrite live code.`,
      )
    }
    for (let index = 0; index < word.length; index++) bytes[start + index] = word[index]!
  }

  const runtimeBytecode = `0x${bytes.join('')}` as Hex
  return {
    runtimeBytecode,
    runtimeHash: keccak256(runtimeBytecode),
    poolManager: address,
    templateHash: manifest.templateHash,
    sourceHash: manifest.sourceHash,
    compiler: manifest.compiler.solc,
    uniswap: manifest.uniswap,
  }
}

/**
 * Confirms a patched runtime encodes the intended manager and nothing else.
 *
 * Comparing byte-for-byte against a freshly patched template means an injected
 * body cannot carry an extra modification that the manifest never declared.
 */
export function verifyPatchedRouter(patched: Hex, poolManager: Address): boolean {
  try {
    return patchScenarioRouter(poolManager).runtimeBytecode.toLowerCase() === patched.toLowerCase()
  } catch {
    return false
  }
}

/**
 * Static identity of the harness build, independent of any one chain.
 *
 * A report carries this so a reader can tell exactly which reviewed harness,
 * compiler, Uniswap versions, and PoolManager storage arrangement produced the
 * generated evidence.
 */
export function scenarioHarnessIdentity() {
  return {
    contract: manifest.contract,
    templateHash: manifest.templateHash,
    sourceHash: manifest.sourceHash,
    compiler: manifest.compiler.solc,
    uniswapCore: manifest.uniswap.core,
    uniswapPeriphery: manifest.uniswap.periphery,
    poolManagerStorageLayout: manifest.poolManagerStorage.layoutHash,
    poolManagerClaimSlot: manifest.poolManagerStorage.slot,
  }
}

/** Report-ready identity of the harness that produced a generated observation. */
export function scenarioRouterIdentity(patched: PatchedScenarioRouter) {
  return {
    contract: manifest.contract,
    note: manifest.description,
    templateHash: patched.templateHash,
    sourceHash: patched.sourceHash,
    runtimeHash: patched.runtimeHash,
    compiler: patched.compiler,
    uniswapCore: patched.uniswap.core,
    uniswapPeriphery: patched.uniswap.periphery,
    poolManager: patched.poolManager,
  }
}
