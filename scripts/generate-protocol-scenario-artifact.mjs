#!/usr/bin/env node
// Emits the pinned browser manifest for the generated-scenario harness.
//
// The browser must inject this harness into a fork for a chain the compiler
// never saw, so the manifest records the compiler-declared immutable positions
// alongside hashes of the template and its source. Injection patches only those
// positions and re-checks both hashes, which is what keeps "we ran your pool
// through a known harness" a verifiable claim rather than an assertion.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const read = (relative) => readFileSync(fileURLToPath(new URL(relative, root)), 'utf8')
const keccakLike = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`
/**
 * keccak256 of the raw runtime, so the browser can re-derive and compare it
 * synchronously. The sha256 hashes above identify the manifest and its source
 * for humans and CI; this one is the value injection actually enforces.
 */
const runtimeKeccak = (hex) =>
  `0x${Buffer.from(keccak_256(Buffer.from(hex.replace(/^0x/, ''), 'hex'))).toString('hex')}`

/**
 * Pins the upstream Uniswap packages by npm tarball integrity.
 *
 * The published packages carry no gitHead, so a commit hash cannot be recorded
 * honestly. The lockfile integrity is what actually determined these bytes.
 */
function upstreamIntegrity() {
  const lock = read('pnpm-lock.yaml')
  const pin = (name, version) => {
    const pattern = new RegExp(`'${name}@${version.replace(/\./g, '\\.')}':\\s*\\n\\s*resolution: \\{integrity: (sha512-[^}]+)\\}`)
    const match = pattern.exec(lock)
    if (!match) throw new Error(`No lockfile integrity pin for ${name}@${version}.`)
    return match[1]
  }
  return { pin }
}

/**
 * Both settlement lanes are emitted from one place.
 *
 * The claims lane is the pool/hook mechanics baseline; the ERC-20 lane executes
 * the token's own transfer code. They share a compiler build, an immutable
 * layout and a PoolManager storage manifest, so publishing them together keeps
 * a browser from ever injecting one lane built against a different pin.
 */
const HARNESSES = [
  {
    contract: 'ProtocolScenarioRouter',
    artifact: 'out/ProtocolScenarioRouter.sol/ProtocolScenarioRouter.json',
    source: 'contracts/fixtures/ProtocolScenarioRouter.sol',
    output: 'src/fixtures/generated/protocol-scenario-router.json',
    settlement: 'erc6909-claims',
    description: 'Pinned, reviewed Uniswap-derived scenario harness. Not audited and not a production router.',
  },
  {
    contract: 'ProtocolERC20ScenarioRouter',
    artifact: 'out/ProtocolERC20ScenarioRouter.sol/ProtocolERC20ScenarioRouter.json',
    source: 'contracts/fixtures/ProtocolERC20ScenarioRouter.sol',
    output: 'src/fixtures/generated/protocol-erc20-scenario-router.json',
    settlement: 'erc20-transfers',
    description: 'Pinned, reviewed Uniswap-derived ERC-20 settlement harness. Not audited and not a production router.',
  },
]

/** The harness stores PoolManager as a single immutable; more than one id means the layout changed. */
function immutablePositions(deployedBytecode) {
  const references = deployedBytecode.immutableReferences ?? {}
  const ids = Object.keys(references)
  if (ids.length !== 1) {
    throw new Error(`Expected exactly one immutable, found ${ids.length}. Re-review the harness before regenerating.`)
  }
  const positions = references[ids[0]]
  for (const position of positions) {
    if (position.length !== 32) throw new Error(`Immutable at ${position.start} is ${position.length} bytes, expected 32.`)
  }
  return positions.map((position) => ({ start: position.start, length: position.length }))
}

/**
 * Reads the ERC-6909 balance slot from the pinned PoolManager build.
 *
 * Hardcoding a slot number would silently break the overlay if upstream
 * reordered storage, and the failure would look like an empty claim balance
 * rather than a wrong slot. Deriving it here ties the overlay to the same
 * compiler output the differential oracle runs against.
 */
function poolManagerClaimSlot() {
  const raw = execFileSync('forge', ['inspect', 'PoolManager', 'storageLayout', '--json', '--root', '.'], {
    cwd: fileURLToPath(root),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  const layout = JSON.parse(raw)
  const entry = layout.storage.find((item) => item.label === 'balanceOf')
  if (!entry) throw new Error('PoolManager storage layout has no balanceOf mapping.')
  const type = layout.types?.[entry.type]?.label ?? ''
  if (!type.startsWith('mapping(address => mapping(uint256 =>')) {
    throw new Error(`PoolManager balanceOf has unexpected type ${type}; the overlay key derivation would be wrong.`)
  }
  if (Number(entry.offset) !== 0) throw new Error('PoolManager balanceOf is not slot-aligned.')
  // Hashing the whole layout, not just the one slot, means a report can prove
  // which storage arrangement the overlay was derived against.
  return { slot: Number(entry.slot), type, layoutHash: keccakLike(JSON.stringify(layout)) }
}

function emit(harness, storage) {
  const artifact = JSON.parse(read(harness.artifact))
  const source = read(harness.source)
  const runtime = artifact.deployedBytecode.object
  if (!runtime?.startsWith('0x')) throw new Error('Artifact has no deployed bytecode.')

  const positions = immutablePositions(artifact.deployedBytecode)
  const body = runtime.slice(2)
  for (const position of positions) {
    const slice = body.slice(position.start * 2, (position.start + position.length) * 2)
    if (!/^0+$/.test(slice)) {
      throw new Error(`Immutable slot at ${position.start} is not zeroed in the template; refusing to publish an ambiguous patch target.`)
    }
  }

  const core = JSON.parse(read('node_modules/@uniswap/v4-core/package.json'))
  const periphery = JSON.parse(read('node_modules/@uniswap/v4-periphery/package.json'))

  const manifest = {
    schemaVersion: '1',
    contract: harness.contract,
    settlement: harness.settlement,
    description: harness.description,
    runtimeBytecode: runtime,
    runtimeBytes: body.length / 2,
    // Hash of the unpatched template. The per-chain hash is derived after
    // patching, so this pins what was patched rather than the result.
    templateHash: keccakLike(runtime),
    templateKeccak: runtimeKeccak(runtime),
    sourceHash: keccakLike(source),
    immutablePoolManagerPositions: positions,
    compiler: {
      solc: artifact.metadata.compiler.version,
      evmVersion: artifact.metadata.settings.evmVersion,
      viaIR: Boolean(artifact.metadata.settings.viaIR),
      optimizer: artifact.metadata.settings.optimizer,
      bytecodeHash: artifact.metadata.settings.metadata?.bytecodeHash ?? 'unknown',
    },
    uniswap: {
      core: core.version,
      periphery: periphery.version,
      coreIntegrity: upstreamIntegrity().pin('@uniswap/v4-core', core.version),
      peripheryIntegrity: upstreamIntegrity().pin('@uniswap/v4-periphery', periphery.version),
    },
    poolManagerStorage: storage,
    selectors: artifact.methodIdentifiers,
    generatedAt: new Date().toISOString().slice(0, 10),
  }

  // Regenerating an unchanged harness must produce a byte-identical file, so CI
  // can assert the checked-in manifest against a fresh build with a plain diff.
  const outputPath = fileURLToPath(new URL(harness.output, root))
  if (existsSync(outputPath)) {
    const previous = JSON.parse(readFileSync(outputPath, 'utf8'))
    if (JSON.stringify({ ...previous, generatedAt: null }) === JSON.stringify({ ...manifest, generatedAt: null })) {
      manifest.generatedAt = previous.generatedAt
    }
  }

  mkdirSync(fileURLToPath(new URL('src/fixtures/generated/', root)), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(
    `Wrote ${harness.output}: ${manifest.runtimeBytes} runtime bytes, `
    + `${positions.length} immutable position(s), solc ${manifest.compiler.solc}, `
    + `v4-core ${manifest.uniswap.core}, v4-periphery ${manifest.uniswap.periphery}, `
    + `balanceOf slot ${manifest.poolManagerStorage.slot}, `
    + `layout ${manifest.poolManagerStorage.layoutHash}.`,
  )
}

function main() {
  // Derived once and shared: both lanes must agree on the PoolManager layout
  // they were built against, and re-deriving it per harness invites drift.
  const storage = poolManagerClaimSlot()
  for (const harness of HARNESSES) emit(harness, storage)
}

main()
