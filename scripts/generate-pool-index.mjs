#!/usr/bin/env node
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAddress } from 'viem'
import { readChainRegistry, selectChains } from './lib/chain-registry.mjs'
import { selectRpc } from './lib/read-only-rpc.mjs'
import {
  buildPoolIndexBundle,
  scanInitializeLogs,
  serializeDocument,
  validateManifest,
  validatePoolIndexDocument,
} from './lib/pool-index-tools.mjs'
import {
  assertKnownOptions,
  capability,
  commandArguments,
  hasFlag,
  json,
  optionValue,
  positiveInteger,
  safeError,
} from './lib/tooling-outcomes.mjs'

const HELP = `Usage: pnpm pool-index:generate -- --chain <id|slug> --output <directory> [options]

Generate schema-v1, token-sharded pool-index documents from confirmed Initialize logs.

Options:
  --chain <id|slug>         Exactly one configured chain
  --output <directory>      Output root; files are written below v1/<chainId>/
  --from-block <decimal>    First indexed block (default: configured deployment)
  --to-block <decimal>      Last indexed block (default: confirmed head)
  --chunk-size <blocks>     Initial eth_getLogs range (default: 50000)
  --minimum-chunk <blocks>  Smallest retry range (default: 500)
  --max-requests <count>    Read-request ceiling (default: 10000)
  --timeout-ms <ms>         Per-request timeout (default: 20000)
  --dry-run                 Build and validate without writing files
  --help                    Show this help

Use HOOKSCOPE_RPC_<chainId> for a server-side RPC override. The command is
read-only onchain, sends no transactions, and never includes an RPC URL in output.
`

function decimalBlock(value, fallback, label) {
  if (value === undefined) return fallback
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error(`${label} must be a decimal block number.`)
  return BigInt(value)
}

async function atomicWrite(path, contents) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o644 })
  await rename(temporary, path)
}

async function main() {
  const argv = commandArguments()
  assertKnownOptions(
    argv,
    ['--chain', '--output', '--from-block', '--to-block', '--chunk-size', '--minimum-chunk', '--max-requests', '--timeout-ms'],
    ['--dry-run', '--help'],
  )
  if (hasFlag(argv, '--help')) {
    process.stdout.write(HELP)
    return
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const registry = await readChainRegistry(resolve(root, 'src/config/chains.ts'))
  const selector = optionValue(argv, '--chain')
  if (!selector) throw new Error('--chain is required.')
  const selected = selectChains(registry, [selector])
  if (selected.length !== 1) throw new Error('Pool-index generation requires exactly one chain.')
  const chain = selected[0]
  if (!chain.poolManager || chain.deploymentBlock === undefined) {
    process.stdout.write(json({
      schemaVersion: '1',
      command: 'pool-index-generate',
      chainId: chain.id,
      readOnlyOnchain: true,
      status: 'unsupported',
      capability: capability('unsupported', chain.limitation ?? 'No verified PoolManager deployment is configured.'),
    }))
    process.exitCode = 2
    return
  }
  const dryRun = hasFlag(argv, '--dry-run')
  const output = optionValue(argv, '--output')
  if (!dryRun && !output) throw new Error('--output is required unless --dry-run is used.')
  const timeoutMs = positiveInteger(optionValue(argv, '--timeout-ms'), 20_000, 'timeout-ms')
  const selectedRpc = await selectRpc(chain, { timeoutMs })
  const head = BigInt(await selectedRpc.rpc('eth_blockNumber'))
  const confirmedHead = head > BigInt(chain.confirmations) ? head - BigInt(chain.confirmations) : 0n
  const fromBlock = decimalBlock(optionValue(argv, '--from-block'), chain.deploymentBlock, 'from-block')
  const toBlock = decimalBlock(optionValue(argv, '--to-block'), confirmedHead, 'to-block')
  if (toBlock > confirmedHead) throw new Error(`to-block exceeds the confirmed head ${confirmedHead}.`)
  if (fromBlock !== chain.deploymentBlock) {
    throw new Error(`from-block must equal the configured deployment block ${chain.deploymentBlock} so the index is complete.`)
  }
  const pinnedBlock = await selectedRpc.rpc('eth_getBlockByNumber', [`0x${toBlock.toString(16)}`, false])
  if (!pinnedBlock || typeof pinnedBlock !== 'object' || typeof pinnedBlock.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/u.test(pinnedBlock.hash)) {
    throw new Error('RPC did not return an identity for to-block.')
  }
  if (BigInt(pinnedBlock.number) !== toBlock) throw new Error('RPC returned a different block than to-block.')
  const code = await selectedRpc.rpc('eth_getCode', [chain.poolManager, `0x${toBlock.toString(16)}`])
  if (typeof code !== 'string' || code === '0x' || /^0x0+$/iu.test(code)) {
    throw new Error('PoolManager code is absent at to-block.')
  }
  const initialChunk = BigInt(positiveInteger(optionValue(argv, '--chunk-size'), 50_000, 'chunk-size'))
  const minimumChunk = BigInt(positiveInteger(optionValue(argv, '--minimum-chunk'), 500, 'minimum-chunk'))
  const maxRequests = positiveInteger(optionValue(argv, '--max-requests'), 10_000, 'max-requests')
  const scan = await scanInitializeLogs({
    rpc: selectedRpc.rpc,
    poolManager: chain.poolManager,
    fromBlock,
    toBlock,
    initialChunk,
    minimumChunk,
    maxRequests,
  })
  const verifiedBlock = await selectedRpc.rpc('eth_getBlockByNumber', [`0x${toBlock.toString(16)}`, false])
  if (!verifiedBlock || typeof verifiedBlock !== 'object' || verifiedBlock.hash?.toLowerCase() !== pinnedBlock.hash.toLowerCase()) {
    throw new Error('The indexed-through block identity changed during generation; discard this run and retry.')
  }
  const bundle = buildPoolIndexBundle(chain, scan.pools, fromBlock, toBlock, pinnedBlock.hash.toLowerCase())
  const warnings = []
  for (const file of bundle.files) {
    const validation = validatePoolIndexDocument(file.document, { chain, expectedToken: file.token })
    if (validation.errors.length > 0) throw new Error(`${file.path}: ${validation.errors.join(' ')}`)
    warnings.push(...validation.warnings.map((warning) => `${file.path}: ${warning}`))
  }
  const manifestValidation = validateManifest(
    bundle.manifest,
    new Map(bundle.files.map((file) => [file.path, file.contents])),
    chain,
  )
  if (manifestValidation.errors.length > 0) throw new Error(`manifest.json: ${manifestValidation.errors.join(' ')}`)
  warnings.push(...manifestValidation.warnings.map((warning) => `manifest.json: ${warning}`))
  const outputDirectory = output ? resolve(output, 'v1', String(chain.id)) : undefined
  if (!dryRun && outputDirectory) {
    for (const file of bundle.files) await atomicWrite(resolve(outputDirectory, file.path), file.contents)
    await atomicWrite(resolve(outputDirectory, 'manifest.json'), serializeDocument(bundle.manifest))
  }
  const status = warnings.length > 0 ? 'degraded' : 'passed'
  process.stdout.write(json({
    schemaVersion: '1',
    command: 'pool-index-generate',
    chainId: chain.id,
    chainSlug: chain.slug,
    readOnlyOnchain: true,
    status,
    capability: capability(status, warnings.length > 0 ? 'Index generated with browser-loader compatibility warnings.' : 'Versioned pool index generated and validated.'),
    indexedFromBlock: fromBlock.toString(),
    indexedThroughBlock: toBlock.toString(),
    indexedThroughBlockHash: pinnedBlock.hash.toLowerCase(),
    pools: bundle.manifest.poolCount,
    tokenDocuments: bundle.manifest.tokenCount,
    rpcRequests: scan.requests + 5,
    rpcSource: selectedRpc.source,
    dryRun,
    outputDirectory,
    warnings,
  }))
  if (warnings.length > 0) process.exitCode = 1
}

main().catch((error) => {
  process.stdout.write(json({
    schemaVersion: '1',
    command: 'pool-index-generate',
    readOnlyOnchain: true,
    status: 'degraded',
    capability: capability('degraded', safeError(error)),
  }))
  process.exitCode = 1
})
