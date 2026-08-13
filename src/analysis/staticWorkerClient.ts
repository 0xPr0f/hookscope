import type { StaticAnalysisResult, StaticSubject, WorkerCommand, WorkerEvent } from '../domain/report'

export function runStaticWorker(input: {
  scanId: string
  subjects: StaticSubject[]
  signal: AbortSignal
  onProgress?: (completed: number, total: number, detail: string) => void
}): Promise<StaticAnalysisResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/static.worker.ts', import.meta.url), { type: 'module', name: 'hookscope-static' })
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      worker.terminate()
      input.signal.removeEventListener('abort', cancel)
      callback()
    }
    const cancel = () => {
      worker.postMessage({ type: 'cancel', scanId: input.scanId } satisfies WorkerCommand)
      finish(() => reject(new DOMException('Analysis cancelled', 'AbortError')))
    }
    input.signal.addEventListener('abort', cancel, { once: true })
    worker.onerror = (event) => finish(() => reject(new Error(event.message || 'Static worker failed.')))
    worker.onmessage = (event: MessageEvent<WorkerEvent>) => {
      const message = event.data
      if (message.scanId !== input.scanId) return
      if (message.type === 'phase') input.onProgress?.(0, message.phase.total, 'Static worker ready')
      if (message.type === 'progress') input.onProgress?.(message.completed, message.total, message.detail)
      if (message.type === 'failure') finish(() => reject(new Error(message.message)))
      if (message.type === 'complete-static') finish(() => resolve(message.result))
    }
    worker.postMessage({ type: 'start-static', scanId: input.scanId, subjects: input.subjects } satisfies WorkerCommand)
  })
}
