import { readFile } from 'node:fs/promises'
import ts from 'typescript'

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text
  }
  throw new Error(`Unsupported computed property in chain registry at ${node.pos}.`)
}

function literalValue(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isNumericLiteral(node)) return Number(node.text.replaceAll('_', ''))
  if (ts.isBigIntLiteral(node)) return BigInt(node.text.slice(0, -1).replaceAll('_', ''))
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false
  if (node.kind === ts.SyntaxKind.NullKeyword) return null
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    const value = literalValue(node.operand)
    if (typeof value !== 'number' && typeof value !== 'bigint') {
      throw new Error(`Unsupported negative value in chain registry at ${node.pos}.`)
    }
    return -value
  }
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literalValue)
  if (ts.isObjectLiteralExpression(node)) {
    const value = {}
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) {
        throw new Error(`Unsupported chain registry property at ${property.pos}.`)
      }
      value[propertyName(property.name)] = literalValue(property.initializer)
    }
    return value
  }
  throw new Error(`Unsupported chain registry expression at ${node.pos}.`)
}

function findChainArray(sourceFile) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'CHAINS') continue
      if (!declaration.initializer || !ts.isArrayLiteralExpression(declaration.initializer)) {
        throw new Error('CHAINS must be initialized with an array literal.')
      }
      return declaration.initializer
    }
  }
  throw new Error('Could not find the CHAINS registry declaration.')
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Chain registry has an invalid ${label}.`)
  return value
}

function assertInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Chain registry has an invalid ${label}.`)
  return value
}

function normalizeChain(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('Chain registry entry must be an object.')
  }
  const publicRpcs = candidate.publicRpcs
  if (!Array.isArray(publicRpcs) || publicRpcs.some((url) => typeof url !== 'string')) {
    throw new Error(`Chain ${String(candidate.id)} has invalid public RPC candidates.`)
  }
  for (const url of publicRpcs) {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`Chain ${String(candidate.id)} has a non-HTTP public RPC candidate.`)
    }
  }
  if (candidate.deploymentBlock !== undefined && (typeof candidate.deploymentBlock !== 'bigint' || candidate.deploymentBlock < 0n)) {
    throw new Error(`Chain ${String(candidate.id)} has an invalid deployment block.`)
  }
  if (candidate.poolManager !== undefined && (typeof candidate.poolManager !== 'string' || !/^0x[0-9a-fA-F]{40}$/u.test(candidate.poolManager))) {
    throw new Error(`Chain ${String(candidate.id)} has an invalid PoolManager address.`)
  }
  return {
    id: assertInteger(candidate.id, 'chain ID'),
    slug: assertString(candidate.slug, 'chain slug'),
    name: assertString(candidate.name, 'chain name'),
    shortName: assertString(candidate.shortName, 'short chain name'),
    explorerUrl: assertString(candidate.explorerUrl, 'explorer URL'),
    rpcUrls: [...publicRpcs],
    poolIndexUrl: candidate.poolIndexUrl,
    subgraphUrl: candidate.subgraphUrl,
    poolManager: candidate.poolManager,
    deploymentBlock: candidate.deploymentBlock,
    evmVariant: assertString(candidate.evmVariant, 'EVM variant'),
    confirmations: assertInteger(candidate.confirmations, 'confirmation policy'),
    deepExecution: candidate.deepExecution === true,
    limitation: candidate.limitation,
  }
}

/** Parse the literal data entries in src/config/chains.ts without executing Vite code. */
export function parseChainRegistry(source, fileName = 'chains.ts') {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const diagnostics = sourceFile.parseDiagnostics ?? []
  if (diagnostics.length > 0) throw new Error(`Unable to parse ${fileName}.`)
  const chainArray = findChainArray(sourceFile)
  const chains = chainArray.elements.map((element) => {
    if (!ts.isCallExpression(element) || !ts.isIdentifier(element.expression) || element.expression.text !== 'config') {
      throw new Error(`CHAINS contains an unsupported entry at ${element.pos}.`)
    }
    const argument = element.arguments[0]
    if (!argument) throw new Error(`Chain entry at ${element.pos} has no configuration object.`)
    return normalizeChain(literalValue(argument))
  })
  const ids = new Set()
  const slugs = new Set()
  for (const chain of chains) {
    if (ids.has(chain.id)) throw new Error(`Chain ID ${chain.id} appears more than once.`)
    if (slugs.has(chain.slug)) throw new Error(`Chain slug ${chain.slug} appears more than once.`)
    ids.add(chain.id)
    slugs.add(chain.slug)
  }
  return chains
}

export async function readChainRegistry(path) {
  return parseChainRegistry(await readFile(path, 'utf8'), path)
}

export function selectChains(chains, selectors) {
  if (selectors.length === 0 || selectors.includes('all')) return [...chains]
  const selected = []
  const seen = new Set()
  for (const selector of selectors) {
    const chain = chains.find((candidate) => String(candidate.id) === selector || candidate.slug === selector)
    if (!chain) throw new Error(`Unknown chain selector: ${selector}.`)
    if (!seen.has(chain.id)) selected.push(chain)
    seen.add(chain.id)
  }
  return selected
}
