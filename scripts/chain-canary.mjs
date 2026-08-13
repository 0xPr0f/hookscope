#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { getAddress, isAddress } from 'viem'
import { readChainRegistry, selectChains } from './lib/chain-registry.mjs'
import { runChainCanary } from './lib/chain-canary-tools.mjs'
import {
  assertKnownOptions,
  capability,
  commandArguments,
  hasFlag,
  json,
  optionValue,
  optionValues,
  positiveInteger,
  safeError,
} from './lib/tooling-outcomes.mjs'

const HELP = `Usage: pnpm canary:chains -- [options]

Read-only per-chain capability canary.

Options:
  --chain <id|slug|all>       Chain selector; repeatable (default: all)
  --token <selector=address>  Canary token for a selected chain; repeatable
  --require <capability>      Require a capability to pass; repeatable
  --timeout-ms <milliseconds> Per-request timeout (default: 15000)
  --allow-degraded            Return zero when attempted checks degrade
  --help                      Show this help

Server-side environment overrides:
  HOOKSCOPE_RPC_<chainId>
  HOOKSCOPE_CANARY_TOKEN_<chainId>
  HOOKSCOPE_POOL_INDEX_<chainId>
  HOOKSCOPE_SUBGRAPH_<chainId>

The command sends no transactions and never prints configured endpoint URLs.
`

function tokenMap(specifications, chains, environment) {
  const result = new Map()
  for (const chain of chains) {
    const configured = environment[`HOOKSCOPE_CANARY_TOKEN_${chain.id}`]
    if (configured) result.set(chain.id, configured)
  }
  for (const specification of specifications) {
    const separator = specification.indexOf('=')
    let selector
    let value
    if (separator === -1 && chains.length === 1) {
      selector = String(chains[0].id)
      value = specification
    } else if (separator === -1) {
      throw new Error('--token requires <chain-id-or-slug>=<address> when more than one chain is selected.')
    } else {
      selector = specification.slice(0, separator)
      value = specification.slice(separator + 1)
    }
    const chain = chains.find((candidate) => String(candidate.id) === selector || candidate.slug === selector)
    if (!chain) throw new Error(`Canary token uses an unselected chain: ${selector}.`)
    if (!isAddress(value)) throw new Error(`Canary token for ${chain.slug} is not an EVM address.`)
    result.set(chain.id, getAddress(value))
  }
  return result
}

async function main() {
  const argv = commandArguments()
  assertKnownOptions(argv, ['--chain', '--token', '--require', '--timeout-ms'], ['--allow-degraded', '--help'])
  if (hasFlag(argv, '--help')) {
    process.stdout.write(HELP)
    return
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const registry = await readChainRegistry(resolve(root, 'src/config/chains.ts'))
  const chains = selectChains(registry, optionValues(argv, '--chain'))
  const tokens = tokenMap(optionValues(argv, '--token'), chains, process.env)
  const timeoutMs = positiveInteger(optionValue(argv, '--timeout-ms'), 15_000, 'timeout-ms')
  const required = optionValues(argv, '--require').flatMap((value) => value.split(',')).filter(Boolean)
  const results = []
  for (const chain of chains) {
    results.push(await runChainCanary(chain, { token: tokens.get(chain.id), timeoutMs }))
  }
  const knownCapabilities = new Set(results.flatMap((result) => Object.keys(result.capabilities)))
  for (const name of required) {
    if (!knownCapabilities.has(name)) throw new Error(`Unknown required capability: ${name}.`)
  }
  const degraded = results.some((result) => result.status === 'degraded')
  const unmet = results.flatMap((result) => required
    .filter((name) => result.capabilities[name]?.status !== 'passed')
    .map((name) => `${result.chainSlug}:${name}`))
  process.stdout.write(json({
    schemaVersion: '1',
    command: 'chain-canary',
    generatedAt: new Date().toISOString(),
    readOnly: true,
    requestedCapabilities: required,
    status: degraded || unmet.length > 0 ? 'degraded' : results.some((result) => result.status === 'passed') ? 'passed' : 'unsupported',
    chains: results,
    unmetCapabilities: unmet,
  }))
  if (unmet.length > 0 || (degraded && !hasFlag(argv, '--allow-degraded'))) process.exitCode = 1
}

main().catch((error) => {
  process.stdout.write(json({
    schemaVersion: '1',
    command: 'chain-canary',
    readOnly: true,
    status: 'degraded',
    capabilities: { command: capability('degraded', safeError(error)) },
  }))
  process.exitCode = 1
})
