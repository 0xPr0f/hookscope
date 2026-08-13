'use strict'

// This worker deliberately contains only the small loading surface needed for
// an official soljson build. It is not Remix code and does not bundle Remix.
const SOLC_ORIGIN = 'https://binaries.soliditylang.org/bin/'
const VERSION_PATTERN = /^0\.\d+\.\d+\+commit\.[0-9a-f]{8}$/i
const MAX_AST_NODES = 500_000
let loadedVersion
let compileStandard
let compilerVersion

function compilerUrl(version) {
  if (!VERSION_PATTERN.test(version)) throw new Error(`Unsupported Solidity compiler version: ${version}`)
  return `${SOLC_ORIGIN}soljson-v${version}.js`
}

async function loadCompiler(version) {
  if (loadedVersion && loadedVersion !== version) {
    throw new Error(`This compiler worker already loaded ${loadedVersion}; create a new worker for ${version}.`)
  }
  if (compileStandard) return

  await new Promise((resolve, reject) => {
    let initialized = false
    self.Module = {
      onRuntimeInitialized() {
        initialized = true
        resolve()
      },
    }
    try {
      importScripts(compilerUrl(version))
      if (self.Module.calledRun && !initialized) resolve()
    } catch (error) {
      reject(error)
    }
  })

  compileStandard = self.Module.cwrap('solidity_compile', 'string', ['string', 'number', 'number'])
  compilerVersion = self.Module.cwrap('solidity_version', 'string', [])
  const actual = compilerVersion()
  if (!actual.startsWith(version)) throw new Error(`Loaded soljson ${actual}, expected ${version}.`)
  loadedVersion = version
}

function memberName(expression) {
  return expression && expression.nodeType === 'MemberAccess' ? expression.memberName : undefined
}

function sourcePosition(node) {
  return typeof node.src === 'string' ? node.src : undefined
}

function modifierNames(node) {
  return Array.isArray(node.modifiers)
    ? node.modifiers.map((modifier) => modifier.modifierName?.name || modifier.modifierName?.namePath).filter(Boolean)
    : []
}

function referencesStateVariable(node, stateVariables) {
  const stack = [node]
  while (stack.length) {
    const current = stack.pop()
    if (!current || typeof current !== 'object') continue
    if (typeof current.referencedDeclaration === 'number' && stateVariables.has(current.referencedDeclaration)) {
      return stateVariables.get(current.referencedDeclaration)
    }
    for (const value of Object.values(current)) {
      if (Array.isArray(value)) stack.push(...value)
      else if (value && typeof value === 'object') stack.push(value)
    }
  }
}

function readsMessageSender(node) {
  const stack = [node]
  while (stack.length) {
    const current = stack.pop()
    if (!current || typeof current !== 'object') continue
    if (current.nodeType === 'MemberAccess'
      && current.memberName === 'sender'
      && current.expression?.nodeType === 'Identifier'
      && current.expression.name === 'msg') return true
    for (const value of Object.values(current)) {
      if (Array.isArray(value)) stack.push(...value)
      else if (value && typeof value === 'object') stack.push(value)
    }
  }
  return false
}

function summarizeAst(output, fullyQualifiedName) {
  const separator = fullyQualifiedName.lastIndexOf(':')
  if (separator <= 0) throw new Error(`Invalid fully-qualified contract name: ${fullyQualifiedName}`)
  const sourcePath = fullyQualifiedName.slice(0, separator)
  const contractName = fullyQualifiedName.slice(separator + 1)
  const artifact = output.contracts?.[sourcePath]?.[contractName]
  if (!artifact) throw new Error(`Compiler output did not contain ${fullyQualifiedName}.`)

  const roots = Object.entries(output.sources || {}).flatMap(([path, source]) => source?.ast ? [{ path, node: source.ast }] : [])
  if (!roots.length) throw new Error('The exact compiler run did not emit a Solidity AST.')

  const stateVariables = new Map()
  for (const root of roots) {
    const stack = [root.node]
    while (stack.length) {
      const current = stack.pop()
      if (!current || typeof current !== 'object') continue
      if (current.nodeType === 'VariableDeclaration' && current.stateVariable === true && typeof current.id === 'number') {
        stateVariables.set(current.id, current.name || `state-variable-${current.id}`)
      }
      for (const value of Object.values(current)) {
        if (Array.isArray(value)) stack.push(...value)
        else if (value && typeof value === 'object') stack.push(value)
      }
    }
  }

  const functions = []
  const externalCalls = []
  const stateWrites = []
  const senderGates = []
  let nodeCount = 0
  for (const root of roots) {
    const stack = [{ node: root.node, sourcePath: root.path, functionContext: undefined }]
    while (stack.length) {
      const entry = stack.pop()
      const current = entry.node
      if (!current || typeof current !== 'object') continue
      nodeCount += 1
      if (nodeCount > MAX_AST_NODES) throw new Error(`Verified-source AST exceeds the ${MAX_AST_NODES.toLocaleString()}-node browser ceiling.`)

      let functionContext = entry.functionContext
      if (current.nodeType === 'FunctionDefinition') {
        functionContext = {
          name: current.name || current.kind || '<fallback>',
          visibility: current.visibility,
          stateMutability: current.stateMutability,
          modifiers: modifierNames(current),
          sourcePath: entry.sourcePath,
          src: sourcePosition(current),
        }
        functions.push(functionContext)
      }

      if (current.nodeType === 'FunctionCall') {
        const operation = memberName(current.expression)
        if (operation === 'call' || operation === 'delegatecall' || operation === 'staticcall') {
          externalCalls.push({ operation, function: functionContext?.name, modifiers: functionContext?.modifiers || [], sourcePath: entry.sourcePath, src: sourcePosition(current) })
        }
        const calledName = current.expression?.name
        if ((calledName === 'require' || calledName === 'assert') && readsMessageSender(current)) {
          senderGates.push({ kind: calledName, function: functionContext?.name, sourcePath: entry.sourcePath, src: sourcePosition(current) })
        }
      } else if (current.nodeType === 'IfStatement' && readsMessageSender(current.condition)) {
        senderGates.push({ kind: 'if', function: functionContext?.name, sourcePath: entry.sourcePath, src: sourcePosition(current.condition) })
      } else if (current.nodeType === 'Assignment') {
        const variable = referencesStateVariable(current.leftHandSide, stateVariables)
        if (variable) stateWrites.push({ variable, function: functionContext?.name, sourcePath: entry.sourcePath, src: sourcePosition(current) })
      }

      for (const value of Object.values(current)) {
        if (Array.isArray(value)) {
          for (const child of value) if (child && typeof child === 'object') stack.push({ node: child, sourcePath: entry.sourcePath, functionContext })
        } else if (value && typeof value === 'object') {
          stack.push({ node: value, sourcePath: entry.sourcePath, functionContext })
        }
      }
    }
  }

  const unique = (items, key) => [...new Map(items.map((item) => [key(item), item])).values()]
  return {
    fullyQualifiedName,
    compilerVersion: compilerVersion(),
    astNodeCount: nodeCount,
    functions: unique(functions, (item) => `${item.sourcePath}:${item.src}`),
    externalCalls: unique(externalCalls, (item) => `${item.operation}:${item.sourcePath}:${item.src}`),
    stateWrites: unique(stateWrites, (item) => `${item.variable}:${item.sourcePath}:${item.src}`),
    senderGates: unique(senderGates, (item) => `${item.kind}:${item.sourcePath}:${item.src}`),
    abi: artifact.abi || [],
    storageLayout: artifact.storageLayout || { storage: [], types: {} },
    methodIdentifiers: artifact.evm?.methodIdentifiers || {},
  }
}

self.onmessage = async (event) => {
  const request = event.data
  if (!request || request.type !== 'compile') return
  try {
    await loadCompiler(request.compilerVersion)
    self.postMessage({ type: 'progress', id: request.id, phase: 'compiling' })
    const output = JSON.parse(compileStandard(JSON.stringify(request.input), 0, 0))
    const errors = Array.isArray(output.errors) ? output.errors : []
    const failures = errors.filter((error) => error.severity === 'error')
    if (failures.length) throw new Error(failures.slice(0, 4).map((error) => error.formattedMessage || error.message).join('\n'))
    self.postMessage({
      type: 'complete',
      id: request.id,
      summary: summarizeAst(output, request.fullyQualifiedName),
      warnings: errors.filter((error) => error.severity !== 'error').slice(0, 100).map((error) => error.formattedMessage || error.message),
    })
  } catch (error) {
    self.postMessage({ type: 'failure', id: request.id, message: error instanceof Error ? error.message : String(error) })
  }
}
