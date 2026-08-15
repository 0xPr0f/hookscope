'use strict'

// Intraprocedural dependency analysis over a verified-source Solidity AST.
//
// This answers a question bytecode pattern matching cannot: does a value that
// originates at `msg.sender` (or a parameter, or `msg.value`) actually reach
// something that matters — a branch condition, a state assignment, a call
// target? Seeing both a `CALLER` opcode and an `SSTORE` proves only that the
// contract contains both.
//
// Scope is stated plainly because it bounds every claim built on top: the
// analysis is intraprocedural and source-order-sensitive within a function body.
// It follows assignments through local variables using solc's
// `referencedDeclaration` ids, which are exact, but it does not cross function boundaries, expand
// modifiers, or reason about aliasing through storage pointers. A dependency it
// reports is real; a dependency it misses is not evidence of absence.
//
// Written as plain JS with a UMD tail so the classic `importScripts` worker and
// the Node test runner can both load it. The worker cannot use ES modules
// because it needs `importScripts` for the official soljson build.

;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.HookscopeAstDependencies = api
})(typeof self !== 'undefined' ? self : globalThis, function () {
  /** Value origins worth tracking to a sink. */
  const SOURCE_KINDS = ['msg.sender', 'tx.origin', 'msg.value', 'parameter', 'state', 'block']

  /** Places a tracked value arriving is worth reporting. */
  const SINK_KINDS = [
    'condition',
    'state-assignment',
    'guarded-state-assignment',
    'call-target',
    'call-value',
    'transfer-recipient',
    'transfer-amount',
    'return-value',
  ]

  const TRANSFER_NAMES = new Set(['transfer', 'transferFrom', 'safeTransfer', 'safeTransferFrom', 'send'])
  const LOW_LEVEL = new Set(['call', 'delegatecall', 'staticcall'])

  function children(node) {
    const out = []
    if (!node || typeof node !== 'object') return out
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) if (item && typeof item === 'object') out.push(item)
      } else if (value && typeof value === 'object') {
        out.push(value)
      }
    }
    return out
  }

  function walk(node, visit) {
    const stack = [node]
    while (stack.length) {
      const current = stack.pop()
      if (!current || typeof current !== 'object') continue
      visit(current)
      stack.push(...children(current))
    }
  }

  function parentMap(root) {
    const parents = new Map()
    walk(root, (node) => {
      for (const child of children(node)) if (!parents.has(child)) parents.set(child, node)
    })
    return parents
  }

  function addSources(target, source) {
    for (const kind of source) target.add(kind)
    return target
  }

  function memberOf(node, base, member) {
    return (
      node
      && node.nodeType === 'MemberAccess'
      && node.memberName === member
      && node.expression
      && node.expression.nodeType === 'Identifier'
      && node.expression.name === base
    )
  }

  /**
   * Collects the origins an expression depends on.
   *
   * Every identifier is resolved through `referencedDeclaration`, so a local
   * that was assigned from `msg.sender` earlier carries that origin forward
   * rather than being treated as an opaque name.
   */
  function sourcesOf(expression, tainted, parameters, stateVariables) {
    const found = new Set()
    walk(expression, (node) => {
      if (memberOf(node, 'msg', 'sender')) found.add('msg.sender')
      else if (memberOf(node, 'tx', 'origin')) found.add('tx.origin')
      else if (memberOf(node, 'msg', 'value')) found.add('msg.value')
      else if (memberOf(node, 'block', 'timestamp') || memberOf(node, 'block', 'number')) found.add('block')
      else if (node.nodeType === 'Identifier' && typeof node.referencedDeclaration === 'number') {
        const id = node.referencedDeclaration
        if (parameters.has(id)) found.add('parameter')
        if (stateVariables.has(id)) found.add('state')
        const carried = tainted.get(id)
        if (carried) for (const kind of carried) found.add(kind)
      }
    })
    return found
  }

  function position(node) {
    return typeof node?.src === 'string' ? node.src : undefined
  }

  function declarationTarget(expression, stateVariables) {
    // `a = x`, `s.field = x` and `m[k] = x` all resolve to their base identifier.
    let current = expression
    while (current && (current.nodeType === 'MemberAccess' || current.nodeType === 'IndexAccess')) {
      current = current.expression || current.baseExpression
    }
    if (current && current.nodeType === 'Identifier' && typeof current.referencedDeclaration === 'number') {
      return {
        id: current.referencedDeclaration,
        stateVariable: stateVariables.get(current.referencedDeclaration),
      }
    }
    return undefined
  }

  /** Origins used to choose a mapping/array storage location. */
  function storageLocationSources(expression, tainted, parameters, stateVariables) {
    const found = new Set()
    let current = expression
    while (current && (current.nodeType === 'IndexAccess' || current.nodeType === 'IndexRangeAccess' || current.nodeType === 'MemberAccess')) {
      if (current.nodeType === 'IndexAccess') {
        addSources(found, sourcesOf(current.indexExpression, tainted, parameters, stateVariables))
      }
      if (current.nodeType === 'IndexRangeAccess') {
        addSources(found, sourcesOf(current.startExpression, tainted, parameters, stateVariables))
        addSources(found, sourcesOf(current.endExpression, tainted, parameters, stateVariables))
      }
      current = current.expression || current.baseExpression
    }
    return found
  }

  function callCondition(statement) {
    const call = statement?.nodeType === 'ExpressionStatement' ? statement.expression : statement
    if (call?.nodeType !== 'FunctionCall') return undefined
    if (call.expression?.name !== 'require' && call.expression?.name !== 'assert') return undefined
    return call.arguments?.[0]
  }

  /**
   * Conditions that provably control this node inside the current function.
   *
   * An enclosing `if` controls its branch. A preceding top-level require/assert
   * in the same block dominates later sibling statements. Merely appearing
   * somewhere else in the function is deliberately insufficient.
   */
  function guardingSources(node, parents, tainted, parameters, stateVariables) {
    const found = new Set()
    let current = node
    while (parents.has(current)) {
      const parent = parents.get(current)
      if (parent.nodeType === 'IfStatement' && current !== parent.condition) {
        addSources(found, sourcesOf(parent.condition, tainted, parameters, stateVariables))
      }
      if (parent.nodeType === 'Block' && Array.isArray(parent.statements)) {
        const index = parent.statements.indexOf(current)
        if (index >= 0) {
          for (const previous of parent.statements.slice(0, index)) {
            const condition = callCondition(previous)
            if (condition) addSources(found, sourcesOf(condition, tainted, parameters, stateVariables))
          }
        }
      }
      current = parent
    }
    return found
  }

  /**
   * Analyzes one function body.
   *
   * Statements are visited in source order so an assignment observed earlier
   * informs the ones after it. That ordering is why a value can be followed
   * through a local rather than only when it is used inline.
   */
  function analyzeFunction(fn, stateVariables, sourcePath) {
    const parameters = new Map()
    for (const parameter of fn.parameters?.parameters || []) {
      if (typeof parameter.id === 'number') parameters.set(parameter.id, parameter.name || `param-${parameter.id}`)
    }

    const tainted = new Map()
    const parents = parentMap(fn.body)
    const dependencies = []
    const record = (sinkKind, sources, node, detail) => {
      if (!sources.size) return
      dependencies.push({
        sink: sinkKind,
        sources: [...sources].sort(),
        function: fn.name || fn.kind || '<fallback>',
        detail,
        sourcePath,
        src: position(node),
      })
    }

    // Source order matters, and the generic walker pops depth-first in reverse,
    // so statements are gathered and then visited in order.
    const statements = []
    walk(fn.body, (node) => statements.push(node))
    statements.sort((left, right) => {
      const a = Number(String(left.src || '0').split(':')[0])
      const b = Number(String(right.src || '0').split(':')[0])
      return a - b
    })

    for (const node of statements) {
      if (node.nodeType === 'VariableDeclarationStatement' && node.initialValue) {
        const sources = sourcesOf(node.initialValue, tainted, parameters, stateVariables)
        for (const declaration of node.declarations || []) {
          if (declaration && typeof declaration.id === 'number') {
            if (sources.size) tainted.set(declaration.id, new Set(sources))
            else tainted.delete(declaration.id)
          }
        }
        continue
      }

      if (node.nodeType === 'Assignment') {
        const sources = sourcesOf(node.rightHandSide, tainted, parameters, stateVariables)
        const target = declarationTarget(node.leftHandSide, stateVariables)
        if (target?.stateVariable) {
          const assignmentSources = addSources(
            new Set(sources),
            storageLocationSources(node.leftHandSide, tainted, parameters, stateVariables),
          )
          record('state-assignment', assignmentSources, node, target.stateVariable)
          record(
            'guarded-state-assignment',
            guardingSources(node, parents, tainted, parameters, stateVariables),
            node,
            target.stateVariable,
          )
        } else if (target) {
          // Compound assignments depend on the previous local value; a plain
          // assignment replaces it and must clear stale taint when the RHS is a
          // constant or otherwise untainted.
          const next = new Set(sources)
          if (node.operator !== '=') addSources(next, tainted.get(target.id) || [])
          if (next.size) tainted.set(target.id, next)
          else tainted.delete(target.id)
        }
        continue
      }

      if (node.nodeType === 'IfStatement') {
        record('condition', sourcesOf(node.condition, tainted, parameters, stateVariables), node.condition, 'if')
        continue
      }

      if (node.nodeType === 'Return' && node.expression) {
        record('return-value', sourcesOf(node.expression, tainted, parameters, stateVariables), node.expression)
        continue
      }

      if (node.nodeType === 'FunctionCall') {
        // `target.call{value: v}("")` wraps the callee in a FunctionCallOptions
        // node, so the member access and the forwarded value live one level in.
        let callee = node.expression
        let callOptions
        if (callee && callee.nodeType === 'FunctionCallOptions') {
          callOptions = callee
          callee = callee.expression
        }
        const name = callee?.name
        if (name === 'require' || name === 'assert') {
          const condition = node.arguments?.[0]
          record('condition', sourcesOf(condition, tainted, parameters, stateVariables), condition, name)
          continue
        }

        const member = callee?.memberName
        if (LOW_LEVEL.has(member)) {
          // The receiver of `.call` is the target being invoked.
          record('call-target', sourcesOf(callee.expression, tainted, parameters, stateVariables), node, member)
          const optionNames = callOptions?.names || []
          const optionValues = callOptions?.options || []
          optionNames.forEach((optionName, index) => {
            if (optionName !== 'value') return
            record('call-value', sourcesOf(optionValues[index], tainted, parameters, stateVariables), node, member)
          })
          continue
        }

        if (TRANSFER_NAMES.has(member)) {
          const args = node.arguments || []
          const isFrom = member === 'transferFrom' || member === 'safeTransferFrom'
          const nativeTransfer = (member === 'transfer' || member === 'send') && args.length === 1
          const recipient = isFrom ? args[1] : nativeTransfer ? callee.expression : args[0]
          const amount = isFrom ? args[2] : nativeTransfer ? args[0] : args[1]
          record('transfer-recipient', sourcesOf(recipient, tainted, parameters, stateVariables), node, member)
          record('transfer-amount', sourcesOf(amount, tainted, parameters, stateVariables), node, member)
        }
      }
    }

    return dependencies
  }

  /**
   * Collects `{ source → sink }` dependencies for every function in the AST.
   *
   * `value` options on a low-level call are read from both shapes solc has
   * emitted across versions, so a forwarded `msg.value` is not missed because
   * of a compiler-version difference.
   */
  function analyzeAstDependencies(roots) {
    const stateVariables = new Map()
    for (const root of roots) {
      walk(root.node, (node) => {
        if (node.nodeType === 'VariableDeclaration' && node.stateVariable === true && typeof node.id === 'number') {
          stateVariables.set(node.id, node.name || `state-variable-${node.id}`)
        }
      })
    }

    const dependencies = []
    for (const root of roots) {
      walk(root.node, (node) => {
        if (node.nodeType !== 'FunctionDefinition' || !node.body) return
        dependencies.push(...analyzeFunction(node, stateVariables, root.path))
      })
    }

    const seen = new Set()
    return dependencies.filter((item) => {
      const key = `${item.function}:${item.sink}:${item.sources.join(',')}:${item.sourcePath}:${item.src}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  return { analyzeAstDependencies, SOURCE_KINDS, SINK_KINDS }
})
