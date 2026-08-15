import type { PublicClient } from 'viem'
import {
  loadForkHydration,
  type ForkHydrationRequest,
  type ForkHydrationUpdate,
} from '../analysis/revmProof'

function requestIdentity(blockNumber: bigint, request: ForkHydrationRequest) {
  if (request.kind === 'account') return `${blockNumber}:account:${request.address.toLowerCase()}`
  if (request.kind === 'storage') return `${blockNumber}:storage:${request.address.toLowerCase()}:${request.slot.toLowerCase()}`
  if (request.kind === 'block-hash') return `${blockNumber}:block-hash:${request.blockNumber}`
  return `${blockNumber}:code:${request.codeHash.toLowerCase()}`
}

/**
 * One scan-wide pinned-state cache shared by replay, router scenarios, and the
 * bounded explorer. A rejected read is evicted so endpoint rotation/retry can
 * recover; successful immutable block reads are reused across worker sessions.
 */
export function createForkHydrationCache(client: PublicClient) {
  const values = new Map<string, Promise<ForkHydrationUpdate>>()
  let hits = 0
  let misses = 0

  const load = (stateBlockNumber: bigint, request: ForkHydrationRequest) => {
    const key = requestIdentity(stateBlockNumber, request)
    const cached = values.get(key)
    if (cached) {
      hits++
      return cached
    }
    misses++
    const pending = loadForkHydration({ client, stateBlockNumber, request })
      .catch((error: unknown) => {
        values.delete(key)
        throw error
      })
    values.set(key, pending)
    return pending
  }

  return {
    load,
    metrics: () => ({ entries: values.size, hits, misses }),
  }
}
