import type { SourcifyCompilationBundle } from '../data/source'
import { buildAstCompilerInput, type VerifiedSourceSummary } from './verifiedSource'

type WorkerEvent =
  | { type: 'progress'; id: string; phase: 'compiling' }
  | { type: 'complete'; id: string; summary: VerifiedSourceSummary; warnings: string[] }
  | { type: 'failure'; id: string; message: string }

type PendingCompile = {
  id: string
  resolve(value: { summary: VerifiedSourceSummary; warnings: string[] }): void
  reject(error: Error): void
  timeout: ReturnType<typeof setTimeout>
  signal: AbortSignal
  cancel(): void
  onProgress?: (detail: string) => void
}

export class SolcWorkerSession {
  readonly compilerVersion: string
  private readonly worker: Worker
  private pending?: PendingCompile
  private closed = false

  constructor(compilerVersion: string) {
    this.compilerVersion = compilerVersion
    this.worker = new Worker(`${import.meta.env.BASE_URL}solc.worker.js`, { name: `hookscope-solc-${compilerVersion}` })
    this.worker.onerror = (event) => this.fail(new Error(event.message || 'Verified-source compiler worker failed.'))
    this.worker.onmessage = (event: MessageEvent<WorkerEvent>) => {
      const message = event.data
      const pending = this.pending
      if (!pending || message.id !== pending.id) return
      if (message.type === 'progress') pending.onProgress?.(`Compiling verified source with ${this.compilerVersion}`)
      if (message.type === 'failure') this.fail(new Error(message.message))
      if (message.type === 'complete') {
        this.pending = undefined
        clearTimeout(pending.timeout)
        pending.signal.removeEventListener('abort', pending.cancel)
        pending.resolve({ summary: message.summary, warnings: message.warnings })
      }
    }
  }

  compile(input: {
    bundle: SourcifyCompilationBundle
    expectedRuntimeCodeHash: string
    signal: AbortSignal
    timeoutMs?: number
    onProgress?: (detail: string) => void
  }): Promise<{ summary: VerifiedSourceSummary; warnings: string[] }> {
    if (this.closed) return Promise.reject(new Error('Compiler worker session is closed.'))
    if (this.pending) return Promise.reject(new Error('Compiler worker session is already compiling.'))
    if (input.bundle.compilerVersion !== this.compilerVersion) {
      return Promise.reject(new Error(`Compiler session ${this.compilerVersion} cannot compile ${input.bundle.compilerVersion}.`))
    }
    if (input.bundle.runtimeCodeHash.toLowerCase() !== input.expectedRuntimeCodeHash.toLowerCase()) {
      return Promise.reject(new Error('Verified source bundle does not match the pinned runtime codehash.'))
    }
    const compilerInput = buildAstCompilerInput(input.bundle)
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID()
      const cancel = () => {
        this.fail(new DOMException('Verified-source compilation cancelled', 'AbortError'))
        this.close()
      }
      const timeout = setTimeout(() => {
        this.fail(new Error('Verified-source compiler worker exceeded its time budget.'))
        this.close()
      }, input.timeoutMs ?? 45_000)
      this.pending = { id, resolve, reject, timeout, signal: input.signal, cancel, onProgress: input.onProgress }
      input.signal.addEventListener('abort', cancel, { once: true })
      this.worker.postMessage({
        type: 'compile',
        id,
        compilerVersion: this.compilerVersion,
        fullyQualifiedName: input.bundle.fullyQualifiedName,
        input: compilerInput,
      })
    })
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.worker.terminate()
  }

  private fail(error: Error) {
    const pending = this.pending
    if (!pending) return
    this.pending = undefined
    clearTimeout(pending.timeout)
    pending.signal.removeEventListener('abort', pending.cancel)
    pending.reject(error)
  }
}
