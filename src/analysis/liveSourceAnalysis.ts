import type { Address, Hex } from 'viem'
import { fetchSourcifyCompilationBundle } from '../data/source'
import type { ContractNode, Evidence, StaticSubject } from '../domain/report'
import { SolcWorkerSession } from './solcWorkerClient'
import { sourceSummaryEvidence } from './verifiedSource'

export type SourceAnalysisCoverage = {
  attempted: number
  compiled: number
  findings: Evidence[]
  limitations: string[]
  compilerVersions: string[]
}

type SourceTarget = {
  address: Address
  codeHash: Hex
  affectedPools: Hex[]
  compilerVersion: string
}

function targets(nodes: ContractNode[], subjects: StaticSubject[]): SourceTarget[] {
  const affectedByCodeHash = new Map(subjects.map((subject) => [subject.codeHash.toLowerCase(), subject.affectedPools]))
  const unique = new Map<string, SourceTarget>()
  for (const node of nodes) {
    const version = node.sourceMetadata?.compilerVersion
    if (!node.verifiedSource || !version || !node.sourceMetadata?.fullyQualifiedName) continue
    const key = node.codeHash.toLowerCase()
    if (!unique.has(key)) unique.set(key, {
      address: node.address,
      codeHash: node.codeHash,
      affectedPools: affectedByCodeHash.get(key) ?? [],
      compilerVersion: version,
    })
  }
  return [...unique.values()]
}

export async function runVerifiedSourceAnalysis(input: {
  chainId: number
  nodes: ContractNode[]
  subjects: StaticSubject[]
  signal: AbortSignal
  onProgress?: (completed: number, total: number, detail: string) => void
}): Promise<SourceAnalysisCoverage> {
  const selected = targets(input.nodes, input.subjects)
  const findings: Evidence[] = []
  const limitations: string[] = []
  let completed = 0
  let compiled = 0
  const groups = new Map<string, SourceTarget[]>()
  for (const target of selected) groups.set(target.compilerVersion, [...(groups.get(target.compilerVersion) ?? []), target])

  const entries = [...groups.entries()]
  let nextGroup = 0
  const runGroup = async () => {
    while (nextGroup < entries.length) {
      const entry = entries[nextGroup++]
      if (!entry) return
      const [compilerVersion, group] = entry
      const session = new SolcWorkerSession(compilerVersion)
      try {
        for (const target of group) {
          if (input.signal.aborted) throw new DOMException('Verified-source analysis cancelled', 'AbortError')
          try {
            input.onProgress?.(completed, selected.length, `Loading verified source for ${target.address}`)
            const bundle = await fetchSourcifyCompilationBundle(input.chainId, target.address, input.signal)
            if (!bundle) throw new Error('Sourcify did not return a complete compilation bundle.')
            const result = await session.compile({
              bundle,
              expectedRuntimeCodeHash: target.codeHash,
              signal: input.signal,
              onProgress: (detail) => input.onProgress?.(completed, selected.length, detail),
            })
            findings.push(...sourceSummaryEvidence({ subject: target.address, affectedPools: target.affectedPools, summary: result.summary }))
            compiled += 1
          } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') throw error
            limitations.push(`Verified-source AST passes were unavailable for ${target.address}: ${error instanceof Error ? error.message : String(error)}`)
          } finally {
            completed += 1
            input.onProgress?.(completed, selected.length, `Verified-source pass ${completed} of ${selected.length}`)
          }
        }
      } finally {
        session.close()
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(2, entries.length) }, () => runGroup()))
  return { attempted: selected.length, compiled, findings, limitations, compilerVersions: [...groups.keys()] }
}
