/// <reference lib="webworker" />

import init, {
  create_fork_session,
  dispose_fork_session,
  fuzz_fork_session,
  fuzz_runtime,
  fuzz_runtime_with_seeds,
  hydrate_fork_session,
  inspect_fork_session,
} from '../wasm/fuzz/hookscope_revm_wasm.js'
import fuzzWasmUrl from '../wasm/fuzz/hookscope_revm_wasm_bg.wasm?url'

type ForkHydrationUpdate =
  | { kind: 'account'; account: unknown }
  | { kind: 'storage'; address: string; slot: string; value: string }
  | { kind: 'block-hash'; blockNumber: number; hash: string }

type Command =
  | { type: 'fuzz'; scanId: string; bytecode: string; maxExecutions: number; seed: string; seedCorpus?: string[] }
  | { type: 'create-fork-session'; scanId: string; snapshot: unknown }
  | { type: 'prime-fork-session'; scanId: string; updates: ForkHydrationUpdate[] }
  | { type: 'warm-fork'; scanId: string; runId: string; transaction: unknown; block: unknown }
  | { type: 'hydrate-warm-fork'; scanId: string; runId: string; update: ForkHydrationUpdate }
  | { type: 'fuzz-fork'; scanId: string; runId: string; transaction: unknown; block: unknown; maxExecutions: number; seed: string; mutableIndices: number[]; seedCorpus?: string[] }
  | { type: 'dispose-fork-session'; scanId: string }

type WarmRun = { runId: string; transaction: unknown; block: unknown }
const warmRuns = new Map<string, WarmRun>()
let wasmReady: Promise<unknown> | undefined

function warmFork(scanId: string, run: WarmRun) {
  const step = inspect_fork_session(scanId, run.transaction, run.block, false)
  if (step.status !== 'missing') warmRuns.delete(scanId)
  self.postMessage({ type: 'fork-step', scanId, runId: run.runId, step })
}

self.onmessage = async (event: MessageEvent<Command>) => {
  const command = event.data
  try {
    wasmReady ??= init({ module_or_path: fuzzWasmUrl })
    await wasmReady
    if (command.type === 'fuzz') {
      const startedAt = performance.now()
      const exploration = command.seedCorpus?.length
        ? fuzz_runtime_with_seeds(command.bytecode, command.maxExecutions, BigInt(command.seed), command.seedCorpus)
        : fuzz_runtime(command.bytecode, command.maxExecutions, BigInt(command.seed))
      self.postMessage({
        type: 'complete-exploration',
        scanId: command.scanId,
        exploration: { ...exploration, elapsedMs: Math.round(performance.now() - startedAt) },
      })
    } else if (command.type === 'create-fork-session') {
      create_fork_session(command.scanId, command.snapshot)
      self.postMessage({ type: 'fork-session-ready', scanId: command.scanId })
    } else if (command.type === 'prime-fork-session') {
      for (const update of command.updates) hydrate_fork_session(command.scanId, update)
    } else if (command.type === 'warm-fork') {
      if (warmRuns.has(command.scanId)) throw new Error(`Fork session ${command.scanId} is already warming.`)
      const run = { runId: command.runId, transaction: command.transaction, block: command.block }
      warmRuns.set(command.scanId, run)
      warmFork(command.scanId, run)
    } else if (command.type === 'hydrate-warm-fork') {
      const run = warmRuns.get(command.scanId)
      if (!run || run.runId !== command.runId) throw new Error(`Fork warmup ${command.runId} is no longer active.`)
      hydrate_fork_session(command.scanId, command.update)
      warmFork(command.scanId, run)
    } else if (command.type === 'fuzz-fork') {
      const startedAt = performance.now()
      const exploration = fuzz_fork_session(
        command.scanId,
        command.transaction,
        command.block,
        command.maxExecutions,
        BigInt(command.seed),
        command.mutableIndices,
        command.seedCorpus ?? [],
      )
      self.postMessage({
        type: 'complete-fork-exploration',
        scanId: command.scanId,
        runId: command.runId,
        exploration: { ...exploration, elapsedMs: Math.round(performance.now() - startedAt) },
      })
    } else {
      warmRuns.delete(command.scanId)
      dispose_fork_session(command.scanId)
    }
  } catch (error) {
    self.postMessage({ type: 'failure', scanId: command.scanId, message: error instanceof Error ? error.message : String(error) })
  }
}

export {}
