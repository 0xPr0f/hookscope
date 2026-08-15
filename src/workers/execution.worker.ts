/// <reference lib="webworker" />
import init, {
  create_fork_session,
  dispose_fork_session,
  explore_runtime,
  hydrate_fork_session,
  inspect_fork_session,
  inspect_runtime,
} from '../wasm/revm/hookscope_revm_wasm.js'
import revmWasmUrl from '../wasm/revm/hookscope_revm_wasm_bg.wasm?url'

type Command =
  | { type: 'inspect'; scanId: string; bytecode: string; calldata: string }
  | { type: 'explore'; scanId: string; bytecode: string; maxExecutions: number; scheduler: 'libafl' | 'baseline'; seed: string }
  | { type: 'create-fork-session'; scanId: string; snapshot: ForkSnapshot }
  | { type: 'prime-fork-session'; scanId: string; updates: ForkHydrationUpdate[] }
  | { type: 'execute-fork'; scanId: string; runId: string; transaction: unknown; block: unknown; commit: boolean }
  | { type: 'hydrate-fork'; scanId: string; runId: string; update: ForkHydrationUpdate }
  | { type: 'cancel-fork'; scanId: string; runId: string }
  | { type: 'dispose-fork-session'; scanId: string }

type ForkSnapshotAccount = {
  address: string
  exists: boolean
  balance: string
  nonce: number
  code: string
  storage: Record<string, string>
}

type ForkSnapshot = {
  accounts: ForkSnapshotAccount[]
  blockHashes: { number: number; hash: string }[]
}

type ForkHydrationUpdate =
  | { kind: 'account'; account: ForkSnapshotAccount }
  | { kind: 'storage'; address: string; slot: string; value: string }
  | { kind: 'block-hash'; blockNumber: number; hash: string }

type ForkRun = { runId: string; transaction: unknown; block: unknown; commit: boolean }
type ForkSession = { run?: ForkRun }

const forkSessions = new Map<string, ForkSession>()
let wasmReady: Promise<unknown> | undefined

function ensureWasm() {
  wasmReady ??= init({ module_or_path: revmWasmUrl })
  return wasmReady
}

function executeFork(scanId: string, session: ForkSession) {
  if (!session.run) return
  const step = inspect_fork_session(scanId, session.run.transaction, session.run.block, session.run.commit)
  const runId = session.run.runId
  if (step.status !== 'missing') session.run = undefined
  self.postMessage({ type: 'fork-step', scanId, runId, step })
}

self.onmessage = async (event: MessageEvent<Command>) => {
  const command = event.data
  try {
    if (command.type === 'create-fork-session') {
      self.postMessage({ type: 'fork-session-phase', scanId: command.scanId, phase: 'loading-wasm' })
    }
    await ensureWasm()
    if (command.type === 'inspect') {
      const proof = inspect_runtime(command.bytecode, command.calldata)
      self.postMessage({ type: 'complete', scanId: command.scanId, proof })
    } else if (command.type === 'explore') {
      const startedAt = performance.now()
      if (command.scheduler === 'libafl') throw new Error('LibAFL exploration must run in the dedicated fuzz worker.')
      const exploration = explore_runtime(command.bytecode, command.maxExecutions)
      self.postMessage({
        type: 'complete-exploration',
        scanId: command.scanId,
        exploration: { ...exploration, elapsedMs: Math.round(performance.now() - startedAt) },
      })
    } else if (command.type === 'create-fork-session') {
      self.postMessage({ type: 'fork-session-phase', scanId: command.scanId, phase: 'loading-snapshot' })
      create_fork_session(command.scanId, command.snapshot)
      forkSessions.set(command.scanId, {})
      self.postMessage({ type: 'fork-session-ready', scanId: command.scanId })
    } else if (command.type === 'prime-fork-session') {
      const session = forkSessions.get(command.scanId)
      if (!session) throw new Error(`Fork session ${command.scanId} does not exist.`)
      for (const update of command.updates) hydrate_fork_session(command.scanId, update)
    } else if (command.type === 'execute-fork') {
      const session = forkSessions.get(command.scanId)
      if (!session) throw new Error(`Fork session ${command.scanId} does not exist.`)
      if (session.run) throw new Error(`Fork session ${command.scanId} is already executing.`)
      session.run = { runId: command.runId, transaction: command.transaction, block: command.block, commit: command.commit }
      executeFork(command.scanId, session)
    } else if (command.type === 'hydrate-fork') {
      const session = forkSessions.get(command.scanId)
      if (!session?.run || session.run.runId !== command.runId) throw new Error(`Fork run ${command.runId} is no longer active.`)
      hydrate_fork_session(command.scanId, command.update)
      executeFork(command.scanId, session)
    } else if (command.type === 'cancel-fork') {
      const session = forkSessions.get(command.scanId)
      if (session?.run?.runId === command.runId) session.run = undefined
    } else {
      dispose_fork_session(command.scanId)
      forkSessions.delete(command.scanId)
    }
  } catch (error) {
    self.postMessage({ type: 'failure', scanId: command.scanId, message: error instanceof Error ? error.message : String(error) })
  }
}
