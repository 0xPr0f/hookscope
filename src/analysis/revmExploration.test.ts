import { describe, expect, it, vi } from 'vitest'
import type { Hex } from 'viem'
import {
  minimizeExplorationWitnesses,
  runParallelRevmExploration,
  type RevmExploration,
  type RevmExplorationWitness,
} from './revmProof'

function witness(input: Hex, output: Hex, newEdges = 1): RevmExplorationWitness {
  return { calldata: input, success: true, gasUsed: 21_000 + input.length, newEdges, output, storageDiffs: [] }
}

describe('parallel revm exploration', () => {
  it('retains the shortest representative for each distinct outcome', () => {
    const minimized = minimizeExplorationWitnesses([
      witness('0x00000000', '0x01'),
      witness('0x00', '0x01'),
      witness('0xff', '0x02'),
    ], 2)
    expect(minimized).toHaveLength(2)
    expect(minimized.find((item) => item.output === '0x01')?.calldata).toBe('0x00')
  })

  it('splits one execution ceiling across two rounds and exchanges compact seeds', async () => {
    const calls: { executions: number; corpus: Hex[] }[] = []
    const runWorker = vi.fn(async (input: {
      maxExecutions: number
      seed?: bigint
      seedCorpus?: Hex[]
    }): Promise<RevmExploration> => {
      calls.push({ executions: input.maxExecutions, corpus: input.seedCorpus ?? [] })
      const suffix = Number((input.seed ?? 0n) & 0xffn).toString(16).padStart(2, '0')
      return {
        engine: 'revm/36.0.0 + libafl/0.15.4',
        strategy: 'worker-test',
        executions: input.maxExecutions,
        coverageEdges: input.maxExecutions,
        uniqueOutcomes: 1,
        witnesses: [witness(`0x${suffix}` as Hex, `0x${suffix}` as Hex)],
        elapsedMs: 1,
      }
    })

    const result = await runParallelRevmExploration({
      scanId: 'parallel-test',
      bytecode: '0x00',
      maxExecutions: 100,
      timeoutMs: 10_000,
      maxWorkers: 2,
      signal: new AbortController().signal,
      runWorker: runWorker as never,
    })

    expect(result.executions).toBe(100)
    expect(result.workers).toBe(2)
    expect(result.rounds).toBe(2)
    expect(result.exchangedSeeds).toBeGreaterThan(0)
    expect(result.strategy).toBe('libafl-worker-fanout-corpus-exchange/0.2.0')
    expect(calls.map((call) => call.executions)).toEqual([30, 30, 20, 20])
    expect(calls.slice(0, 2).every((call) => call.corpus.length === 0)).toBe(true)
    expect(calls.slice(2).every((call) => call.corpus.length > 0)).toBe(true)
  })
})
