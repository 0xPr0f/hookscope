#!/usr/bin/env node
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readChainRegistry, selectChains } from './lib/chain-registry.mjs'
import { validateManifest, validatePoolIndexDocument } from './lib/pool-index-tools.mjs'
import {
  assertKnownOptions,
  capability,
  commandArguments,
  hasFlag,
  json,
  optionValue,
  safeError,
} from './lib/tooling-outcomes.mjs'

const HELP = `Usage: pnpm pool-index:validate -- --input <file-or-directory> [options]

Validate schema-v1 pool-index documents, registry identity, PoolIds, replay
references, versioned manifests, and document checksums without network access.

Options:
  --input <path>       Document, manifest, or directory to validate
  --chain <id|slug>    Require documents to belong to this configured chain
  --help               Show this help
`

async function collectJsonFiles(input) {
  const result = []
  const pending = [resolve(input)]
  while (pending.length > 0) {
    const current = pending.pop()
    const metadata = await stat(current)
    if (metadata.isDirectory()) {
      const entries = await readdir(current, { withFileTypes: true })
      for (const entry of entries.sort((left, right) => right.name.localeCompare(left.name))) {
        if (entry.isDirectory() || (entry.isFile() && entry.name.endsWith('.json'))) {
          pending.push(resolve(current, entry.name))
        }
      }
      continue
    }
    if (!metadata.isFile() || !current.endsWith('.json')) throw new Error(`Input is not a JSON file: ${current}.`)
    if (metadata.size > 32 * 1024 * 1024) throw new Error(`Pool-index file exceeds 32 MiB: ${current}.`)
    result.push(current)
    if (result.length > 10_000) throw new Error('Pool-index validation exceeds the 10,000-file ceiling.')
  }
  return result.sort()
}

async function main() {
  const argv = commandArguments()
  assertKnownOptions(argv, ['--input', '--chain'], ['--help'])
  if (hasFlag(argv, '--help')) {
    process.stdout.write(HELP)
    return
  }
  const input = optionValue(argv, '--input')
  if (!input) throw new Error('--input is required.')
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const registry = await readChainRegistry(resolve(root, 'src/config/chains.ts'))
  const requiredSelector = optionValue(argv, '--chain')
  const requiredChain = requiredSelector ? selectChains(registry, [requiredSelector])[0] : undefined
  const files = await collectJsonFiles(input)
  if (files.length === 0) throw new Error('No JSON documents were found.')
  const parsed = new Map()
  const raw = new Map()
  for (const path of files) {
    const contents = await readFile(path, 'utf8')
    raw.set(path, contents)
    try {
      parsed.set(path, JSON.parse(contents))
    } catch {
      parsed.set(path, undefined)
    }
  }
  const results = []
  for (const [path, document] of parsed) {
    const label = relative(process.cwd(), path) || basename(path)
    if (document === undefined) {
      results.push({ file: label, capability: capability('degraded', 'File is not valid JSON.'), errors: ['Invalid JSON.'], warnings: [] })
      continue
    }
    const chain = registry.find((candidate) => candidate.id === document.chainId)
    if (!chain) {
      results.push({ file: label, capability: capability('unsupported', `Chain ${String(document.chainId)} is not in the registry.`), errors: [], warnings: [] })
      continue
    }
    if (requiredChain && requiredChain.id !== chain.id) {
      results.push({ file: label, capability: capability('degraded', `Document does not belong to required chain ${requiredChain.slug}.`), errors: ['Required chain mismatch.'], warnings: [] })
      continue
    }
    if (basename(path) === 'manifest.json') {
      const manifestFiles = new Map()
      for (const [candidate, contents] of raw) {
        if (candidate === path || dirname(candidate) !== dirname(path)) continue
        manifestFiles.set(basename(candidate), contents)
      }
      const validation = validateManifest(document, manifestFiles, chain)
      results.push({ file: label, ...validation })
      continue
    }
    const tokenFromName = /^0x[0-9a-fA-F]{40}\.json$/u.test(basename(path))
      ? basename(path).slice(0, -'.json'.length)
      : undefined
    const validation = validatePoolIndexDocument(document, { chain, expectedToken: tokenFromName })
    results.push({ file: label, ...validation, pools: validation.pools?.length ?? 0 })
  }
  const status = results.some((result) => result.capability.status === 'degraded')
    ? 'degraded'
    : results.some((result) => result.capability.status === 'unsupported')
      ? 'unsupported'
      : 'passed'
  process.stdout.write(json({
    schemaVersion: '1',
    command: 'pool-index-validate',
    offline: true,
    status,
    capability: capability(status, status === 'passed' ? `Validated ${results.length} file${results.length === 1 ? '' : 's'}.` : 'Pool-index validation found limitations.'),
    files: results,
  }))
  if (status !== 'passed') process.exitCode = 1
}

main().catch((error) => {
  process.stdout.write(json({
    schemaVersion: '1',
    command: 'pool-index-validate',
    offline: true,
    status: 'degraded',
    capability: capability('degraded', safeError(error)),
  }))
  process.exitCode = 1
})
