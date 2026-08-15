import type { Hex } from 'viem'
import {
  normalizeFunctionSelector,
  type SelectorSignatureCandidate,
  type SelectorSignatureLookup,
} from '../domain/selectors'

export type { SelectorSignatureCandidate, SelectorSignatureLookup } from '../domain/selectors'

type ApiCandidate = {
  name?: unknown
  filtered?: unknown
  hasVerifiedContract?: unknown
}

const LOOKUP_ENDPOINT = 'https://api.4byte.sourcify.dev/signature-database/v1/lookup'
const MAX_SELECTORS = 1_024
const BATCH_SIZE = 64
const MAX_CONCURRENT_BATCHES = 3
const candidateCache = new Map<string, readonly SelectorSignatureCandidate[]>()

function normalizedCandidates(value: unknown): SelectorSignatureCandidate[] {
  if (!Array.isArray(value)) return []
  const candidates = value.flatMap((candidate): SelectorSignatureCandidate[] => {
    const item = candidate as ApiCandidate
    if (typeof item.name !== 'string' || !item.name.includes('(') || item.name.length > 256 || item.filtered === true) return []
    return [{
      name: item.name,
      source: 'sourcify-4byte',
      hasVerifiedContract: item.hasVerifiedContract === true,
    }]
  })
  return [...new Map(candidates.map((candidate) => [candidate.name, candidate])).values()]
    .sort((left, right) => Number(right.hasVerifiedContract) - Number(left.hasVerifiedContract) || left.name.localeCompare(right.name))
    .slice(0, 8)
}

function chunks<T>(values: T[], size: number) {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}

async function mapWithConcurrency<T>(
  values: T[],
  concurrency: number,
  run: (value: T) => Promise<void>,
) {
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const value = values[cursor++]
      if (value !== undefined) await run(value)
    }
  }))
}

/**
 * Resolves four-byte function/error selectors through Sourcify's global
 * signature database. Results are hints, not ABI proof: distinct signatures
 * can share the same four-byte selector.
 */
export async function fetchSourcify4ByteSignatures(
  selectors: Iterable<Hex>,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<SelectorSignatureLookup> {
  const requested = [...new Set(
    [...selectors]
      .flatMap((selector) => normalizeFunctionSelector(selector) ?? [])
      .slice(0, MAX_SELECTORS),
  )]
  const missing = requested.filter((selector) => !candidateCache.has(selector))

  await mapWithConcurrency(chunks(missing, BATCH_SIZE), MAX_CONCURRENT_BATCHES, async (batch) => {
    const url = new URL(LOOKUP_ENDPOINT)
    url.searchParams.set('function', batch.join(','))
    url.searchParams.set('filter', 'true')
    const response = await fetcher(url, { signal, headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`Sourcify 4byte returned HTTP ${response.status}`)
    const body = await response.json() as {
      ok?: unknown
      result?: { function?: Record<string, ApiCandidate[] | null> }
    }
    if (body.ok !== true || !body.result?.function) throw new Error('Sourcify 4byte returned an invalid response.')
    for (const selector of batch) {
      candidateCache.set(selector, normalizedCandidates(body.result.function[selector]))
    }
  })

  return Object.fromEntries(requested.map((selector) => [selector, candidateCache.get(selector) ?? []]))
}
