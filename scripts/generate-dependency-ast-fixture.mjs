#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const sourcePath = 'contracts/fixtures/DependencyFixtures.sol'
const artifactPath = 'out/DependencyFixtures.sol/DependencyFixtures.json'
const outputPath = 'src/fixtures/generated/dependency-fixtures-ast.json'

function read(relative) {
  return readFileSync(fileURLToPath(new URL(relative, root)), 'utf8')
}

function main() {
  const artifact = JSON.parse(read(artifactPath))
  const source = read(sourcePath)
  const compiler = artifact.metadata?.compiler?.version

  if (compiler !== '0.8.26+commit.8a97fa7a') {
    throw new Error(`Dependency fixture used unexpected compiler ${compiler ?? 'unknown'}.`)
  }
  if (!artifact.ast || artifact.ast.nodeType !== 'SourceUnit' || artifact.ast.absolutePath !== sourcePath) {
    throw new Error('Dependency fixture artifact does not contain the expected real solc SourceUnit AST.')
  }

  const fixture = {
    schemaVersion: '1',
    compiler,
    sourcePath,
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    ast: artifact.ast,
  }
  const destination = fileURLToPath(new URL(outputPath, root))
  mkdirSync(fileURLToPath(new URL('src/fixtures/generated/', root)), { recursive: true })
  writeFileSync(destination, `${JSON.stringify(fixture, null, 2)}\n`)
  console.log(`Wrote ${outputPath} from ${artifactPath} (${compiler}).`)
}

main()
