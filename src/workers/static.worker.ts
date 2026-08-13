/// <reference lib="webworker" />

import type { WorkerCommand, WorkerEvent } from '../domain/report'
import { analyzeStaticSubjects, registerEvmoleContractInfo } from '../analysis/staticEngine'
import initEvmole, { contractInfo } from 'evmole/no_tla'
import evmoleWasmUrl from 'evmole/evmole_bg.wasm?url'

const cancelled = new Set<string>()
let evmoleReady: Promise<WebAssembly.Exports> | undefined

function emit(event: WorkerEvent) {
  self.postMessage(event)
}

self.onmessage = async (message: MessageEvent<WorkerCommand>) => {
  const command = message.data
  if (command.type === 'cancel') {
    cancelled.add(command.scanId)
    return
  }

  const { scanId, subjects } = command
  try {
    emit({
      type: 'phase',
      scanId,
      phase: { id: 'static', label: 'Static bytecode evidence', status: 'running', completed: 0, total: subjects.length },
    })

    evmoleReady ??= initEvmole({ module_or_path: evmoleWasmUrl })
    await evmoleReady
    registerEvmoleContractInfo(contractInfo)

    if (cancelled.has(scanId)) return
    const result: ReturnType<typeof analyzeStaticSubjects> = {
      findings: [],
      nodes: [],
      paths: 0,
      branches: 0,
      engineAvailability: {},
    }
    for (let index = 0; index < subjects.length; index += 1) {
      if (cancelled.has(scanId)) return
      const subject = subjects[index]
      if (!subject) continue
      const next = analyzeStaticSubjects([subject])
      result.findings.push(...next.findings)
      result.nodes.push(...next.nodes)
      result.paths += next.paths
      result.branches += next.branches
      Object.assign(result.engineAvailability, next.engineAvailability)
      emit({
        type: 'progress',
        scanId,
        completed: index + 1,
        total: subjects.length,
        detail: `Mapped ${index + 1} of ${subjects.length} code identities`,
      })
    }
    if (cancelled.has(scanId)) return
    for (const finding of result.findings) emit({ type: 'finding', scanId, finding })
    emit({ type: 'complete-static', scanId, result })
  } catch (error) {
    emit({ type: 'failure', scanId, message: error instanceof Error ? error.message : String(error) })
  } finally {
    cancelled.delete(scanId)
  }
}

export {}
