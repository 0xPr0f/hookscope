#!/usr/bin/env node
// Supply-chain gate: every runtime dependency must be pinned to an exact
// version, and no CI-only or copyleft-restricted analyzer may reach the browser
// bundle. Run offline; it reads the manifest rather than the registry.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url))
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

/**
 * Tools the architecture keeps out of the shipped bundle. Slither is AGPL-3.0
 * and Mythril/Echidna are native oracles; none may become a browser dependency.
 */
const CI_ONLY = ['slither', 'slither-analyzer', 'mythril', 'echidna', 'echidna-test']

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

const errors = []
const warnings = []

const dependencies = Object.entries(manifest.dependencies ?? {})
const devDependencies = Object.entries(manifest.devDependencies ?? {})

for (const [name, range] of [...dependencies, ...devDependencies]) {
  if (!EXACT_VERSION.test(range)) {
    errors.push(`${name} is not pinned to an exact version (found "${range}").`)
  }
}

for (const [name] of dependencies) {
  if (CI_ONLY.some((tool) => name === tool || name.endsWith(`/${tool}`))) {
    errors.push(`${name} is a CI-only analyzer and must never be a runtime dependency.`)
  }
}

if (!manifest.packageManager || !manifest.packageManager.includes('@')) {
  errors.push('packageManager must pin an exact pnpm version.')
}

// The storage credential must never be reachable from the browser bundle.
const envExample = readFileSync(fileURLToPath(new URL('../.env.example', import.meta.url)), 'utf8')
for (const line of envExample.split('\n')) {
  const name = line.split('=')[0]?.trim()
  if (!name || name.startsWith('#')) continue
  if (name.startsWith('VITE_') && /DATABASE|SECRET|PRIVATE_KEY/i.test(name)) {
    errors.push(`${name} exposes a credential to the browser bundle.`)
  }
}

if (warnings.length) console.warn(warnings.map((item) => `warning: ${item}`).join('\n'))

if (errors.length) {
  console.error(errors.map((item) => `error: ${item}`).join('\n'))
  process.exit(1)
}

console.log(
  `Supply chain is consistent: ${dependencies.length} runtime and ${devDependencies.length} development dependencies pinned exactly.`,
)
