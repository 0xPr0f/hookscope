import type { EvmoleBlock, EvmoleContractInfo } from 'evmole'

/**
 * Structural reachability over EVMole's control-flow graph.
 *
 * The point is to stop reporting an opcode as a finding merely because it
 * appears in the disassembly. Solidity routinely emits bytes that no execution
 * path reaches — data regions, dead branches, constructor remnants — and a scan
 * of the flat instruction list cannot tell those apart from live code.
 *
 * What this proves is narrow and worth stating exactly: an opcode is reachable
 * when a path of resolved edges leads to its block from an entry point. It does
 * not prove the path is satisfiable, only that the graph admits it. Concrete
 * execution remains the authority on whether anything actually happens.
 *
 * The converse is the stronger half. When no resolved path reaches a block, and
 * no unresolved dynamic jump could have led there, the opcode is genuinely dead
 * and reporting it would be a false positive.
 */

/** EVMole's Wasm build materializes blocks as `Map`s despite its own typings. */
function field<T>(source: unknown, key: string): T | undefined {
  if (source instanceof Map) return source.get(key) as T | undefined
  if (source && typeof source === 'object') return (source as Record<string, unknown>)[key] as T | undefined
  return undefined
}

export type NormalizedBlock = {
  id: number
  start: number
  end: number
  type: string
  /** Targets this block provably transfers control to. */
  successors: number[]
  /**
   * True when the block ends in a computed jump whose destination EVMole could
   * not resolve. Anything downstream of it is unknown rather than unreachable.
   */
  unresolvedDynamicJump: boolean
}

export type CfgReachability = {
  blocks: NormalizedBlock[]
  byId: Map<number, NormalizedBlock>
  /** Block ids reached from the entry points. */
  reachable: Set<number>
  entryPoints: number[]
  /** Blocks ending in a jump EVMole could not resolve. */
  unresolvedBlocks: number[]
  /** True when any unresolved jump exists, making non-reachability inconclusive. */
  hasUnresolvedJumps: boolean
  limitations: string[]
}

/**
 * Reads the resolved destinations of a dynamic jump.
 *
 * EVMole's declaration types `data.to` as a single object, but its Wasm build
 * returns an array of `{ path, to }` resolutions — one per stack path that
 * reaches the jump. Both shapes are accepted, and a resolution whose `to` is
 * absent counts as unresolved rather than being silently dropped.
 */
function dynamicTargets(data: unknown, key: string): { targets: number[]; unresolved: boolean } {
  const raw = field<unknown>(data, key)
  const entries = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
  const targets: number[] = []
  let unresolved = entries.length === 0
  for (const entry of entries) {
    const to = field<number>(entry, 'to')
    if (typeof to === 'number') targets.push(to)
    else unresolved = true
  }
  return { targets, unresolved }
}

/** Normalizes one EVMole block into explicit successor edges. */
export function normalizeBlock(block: EvmoleBlock | unknown): NormalizedBlock {
  const id = field<number>(block, 'id') ?? 0
  const start = field<number>(block, 'start') ?? id
  const end = field<number>(block, 'end') ?? start
  const type = field<string>(block, 'type') ?? 'Unknown'
  const data = field<unknown>(block, 'data')

  if (type === 'Terminate') {
    return { id, start, end, type, successors: [], unresolvedDynamicJump: false }
  }
  if (type === 'Jump') {
    const to = field<number>(data, 'to')
    return { id, start, end, type, successors: typeof to === 'number' ? [to] : [], unresolvedDynamicJump: false }
  }
  if (type === 'Jumpi') {
    const trueTo = field<number>(data, 'true_to')
    const falseTo = field<number>(data, 'false_to')
    const successors = [trueTo, falseTo].filter((value): value is number => typeof value === 'number')
    return { id, start, end, type, successors, unresolvedDynamicJump: false }
  }
  if (type === 'DynamicJump') {
    const { targets, unresolved } = dynamicTargets(data, 'to')
    return { id, start, end, type, successors: targets, unresolvedDynamicJump: unresolved }
  }
  if (type === 'DynamicJumpi') {
    const { targets, unresolved } = dynamicTargets(data, 'true_to')
    const falseTo = field<number>(data, 'false_to')
    // The fall-through of a computed conditional jump is always a plain offset,
    // so it stays known even when the taken branch does not.
    const successors = typeof falseTo === 'number' ? [...targets, falseTo] : targets
    return { id, start, end, type, successors, unresolvedDynamicJump: unresolved }
  }
  return { id, start, end, type, successors: [], unresolvedDynamicJump: false }
}

/**
 * Chooses the roots reachability is measured from.
 *
 * Offset 0 is always a root: it is where the runtime dispatcher begins, so every
 * externally callable path descends from it. Decoded function entries are added
 * because a dispatcher built on a computed jump table may not have resolvable
 * edges into its own handlers, and dropping those would mark live functions
 * dead.
 */
export function entryPointsFor(info: Pick<EvmoleContractInfo, 'functions'>, byId: Map<number, NormalizedBlock>): number[] {
  const entries = new Set<number>()
  if (byId.has(0)) entries.add(0)
  for (const fn of info.functions ?? []) {
    const offset = field<number>(fn, 'bytecodeOffset')
    if (typeof offset !== 'number') continue
    const block = blockContaining(byId, offset)
    if (block) entries.add(block.id)
  }
  return [...entries]
}

/** Finds the block whose byte range covers an offset. */
export function blockContaining(byId: Map<number, NormalizedBlock>, offset: number): NormalizedBlock | undefined {
  const exact = byId.get(offset)
  if (exact) return exact
  let best: NormalizedBlock | undefined
  for (const block of byId.values()) {
    if (offset < block.start || offset > block.end) continue
    if (!best || block.start > best.start) best = block
  }
  return best
}

/**
 * Builds the graph and walks it from every entry point.
 *
 * Iterative rather than recursive: a large contract's graph is deep enough that
 * recursion risks a stack overflow inside a browser worker, and a dead scan is
 * indistinguishable to a user from a hung one.
 */
export function buildCfgReachability(info: EvmoleContractInfo): CfgReachability {
  const rawBlocks = info.controlFlowGraph?.blocks ?? []
  const blocks = rawBlocks.map((block) => normalizeBlock(block))
  const byId = new Map(blocks.map((block) => [block.id, block]))
  const entryPoints = entryPointsFor(info, byId)

  const reachable = new Set<number>()
  const queue = [...entryPoints]
  while (queue.length) {
    const id = queue.pop()!
    if (reachable.has(id)) continue
    const block = byId.get(id)
    if (!block) continue
    reachable.add(id)
    for (const successor of block.successors) {
      if (!reachable.has(successor)) queue.push(successor)
    }
  }

  const unresolvedBlocks = blocks.filter((block) => block.unresolvedDynamicJump).map((block) => block.id)
  // Only unresolved jumps that are themselves reachable can hide live code.
  const reachableUnresolved = unresolvedBlocks.filter((id) => reachable.has(id))
  const limitations: string[] = []
  if (reachableUnresolved.length) {
    limitations.push(
      `Reachability beyond ${reachableUnresolved.length} computed jump${reachableUnresolved.length === 1 ? '' : 's'} is unknown, so code this traversal did not reach is not proven unreachable.`,
    )
  }

  return {
    blocks,
    byId,
    reachable,
    entryPoints,
    unresolvedBlocks: reachableUnresolved,
    hasUnresolvedJumps: reachableUnresolved.length > 0,
    limitations,
  }
}

export type OpcodeReachability =
  | { status: 'reachable'; blockId: number; offset: number }
  | { status: 'unreachable'; blockId: number; offset: number }
  | { status: 'unknown'; offset: number; reason: string }

/**
 * Classifies one instruction offset.
 *
 * Three outcomes, never two. `unknown` exists because an unresolved computed
 * jump makes non-reachability unprovable, and collapsing it into `unreachable`
 * would let the analyzer claim dead code it cannot demonstrate is dead.
 */
export function classifyOffset(graph: CfgReachability, offset: number): OpcodeReachability {
  const block = blockContaining(graph.byId, offset)
  if (!block) {
    // EVMole only emits blocks for code its own traversal reached, so an offset
    // inside no block was never on any path. That is the strongest form of dead
    // code — bytes after an unconditional terminator with nothing jumping in —
    // and calling it merely unknown would forfeit the false positive this whole
    // module exists to prevent. It only holds when every jump was resolved.
    return graph.hasUnresolvedJumps
      ? {
          status: 'unknown',
          offset,
          reason: 'The offset falls outside every control-flow block, but unresolved computed jumps mean it cannot be proven dead.',
        }
      : { status: 'unreachable', blockId: -1, offset }
  }
  if (graph.reachable.has(block.id)) {
    return { status: 'reachable', blockId: block.id, offset }
  }
  if (graph.hasUnresolvedJumps) {
    return {
      status: 'unknown',
      offset,
      reason: 'No resolved path reaches this block, but the contract contains computed jumps whose destinations are unknown.',
    }
  }
  return { status: 'unreachable', blockId: block.id, offset }
}
