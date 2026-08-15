import type { PublicClient } from 'viem'

type QueueEntry<T> = {
  task: () => Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

type Scheduler = {
  run: <T>(task: () => Promise<T>) => Promise<T>
  metrics: () => { active: number; queued: number; peak: number }
}

function createScheduler(concurrency: number, signal?: AbortSignal): Scheduler {
  const ceiling = Math.max(1, Math.floor(concurrency))
  const queue: QueueEntry<unknown>[] = []
  let active = 0
  let peak = 0

  const drain = () => {
    while (active < ceiling && queue.length > 0) {
      const entry = queue.shift()
      if (!entry) return
      if (signal?.aborted) {
        entry.reject(new DOMException('Scan cancelled', 'AbortError'))
        continue
      }
      active += 1
      peak = Math.max(peak, active)
      void entry.task().then(entry.resolve, entry.reject).finally(() => {
        active -= 1
        drain()
      })
    }
  }

  signal?.addEventListener('abort', () => {
    const error = new DOMException('Scan cancelled', 'AbortError')
    for (const entry of queue.splice(0)) entry.reject(error)
  }, { once: true })

  return {
    run: <T>(task: () => Promise<T>) => new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('Scan cancelled', 'AbortError'))
        return
      }
      queue.push({ task, resolve, reject } as QueueEntry<unknown>)
      drain()
    }),
    metrics: () => ({ active, queued: queue.length, peak }),
  }
}

function cacheIdentity(method: string, args: unknown[]) {
  return `${method}:${JSON.stringify(args, (_key, value) => (
    typeof value === 'bigint' ? `bigint:${value}` : value
  ))}`
}

function isPinnedRead(method: string, args: unknown[]) {
  const parameters = args[0]
  if (!parameters || typeof parameters !== 'object') return false
  if (method === 'getTransaction' || method === 'getTransactionReceipt') return 'hash' in parameters
  return 'blockNumber' in parameters
}

const SCHEDULED_METHODS = new Set([
  'call',
  'getBalance',
  'getBlock',
  'getBlockNumber',
  'getCode',
  'getLogs',
  'getStorageAt',
  'getTransaction',
  'getTransactionCount',
  'getTransactionReceipt',
  'readContract',
])

const CACHEABLE_METHODS = new Set([
  'call',
  'getBalance',
  'getBlock',
  'getCode',
  'getStorageAt',
  'getTransaction',
  'getTransactionCount',
  'getTransactionReceipt',
  'readContract',
])

export type ScanRpcMetrics = {
  reads: { active: number; queued: number; peak: number }
  logs: { active: number; queued: number; peak: number }
  cacheEntries: number
  cacheHits: number
  cacheMisses: number
}

/**
 * Scan-owned wrapper around viem. It bounds logical RPC work while leaving
 * viem's HTTP batching and Multicall aggregation intact underneath it.
 */
export function createScanRpcClient(input: {
  client: PublicClient
  signal?: AbortSignal
  readConcurrency?: number
  logConcurrency?: number
  maxCacheEntries?: number
}): { client: PublicClient; metrics: () => ScanRpcMetrics } {
  const reads = createScheduler(input.readConcurrency ?? 4, input.signal)
  const logs = createScheduler(input.logConcurrency ?? 2, input.signal)
  const cache = new Map<string, Promise<unknown>>()
  const wrappers = new Map<PropertyKey, unknown>()
  const maxCacheEntries = Math.max(32, input.maxCacheEntries ?? 4_096)
  let cacheHits = 0
  let cacheMisses = 0

  const client = new Proxy(input.client as PublicClient & Record<PropertyKey, unknown>, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof property !== 'string' || typeof value !== 'function' || !SCHEDULED_METHODS.has(property)) return value
      const existing = wrappers.get(property)
      if (existing) return existing
      const scheduler = property === 'getLogs' ? logs : reads
      const wrapped = (...args: unknown[]) => {
        const cacheable = CACHEABLE_METHODS.has(property) && isPinnedRead(property, args)
        const key = cacheable ? cacheIdentity(property, args) : undefined
        if (key) {
          const cached = cache.get(key)
          if (cached) {
            cacheHits += 1
            return cached
          }
          cacheMisses += 1
        }
        const pending = scheduler.run(() => Promise.resolve(value.apply(target, args)))
        if (key) {
          if (cache.size >= maxCacheEntries) cache.delete(cache.keys().next().value as string)
          cache.set(key, pending)
          void pending.catch(() => cache.delete(key))
        }
        return pending
      }
      wrappers.set(property, wrapped)
      return wrapped
    },
  }) as PublicClient

  return {
    client,
    metrics: () => ({
      reads: reads.metrics(),
      logs: logs.metrics(),
      cacheEntries: cache.size,
      cacheHits,
      cacheMisses,
    }),
  }
}

export async function mapWithConcurrency<Input, Output>(input: {
  items: readonly Input[]
  concurrency: number
  signal?: AbortSignal
  map: (item: Input, index: number) => Promise<Output>
}): Promise<Output[]> {
  const result = new Array<Output>(input.items.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < input.items.length) {
      if (input.signal?.aborted) throw new DOMException('Scan cancelled', 'AbortError')
      const index = cursor
      cursor += 1
      const item = input.items[index]
      if (item !== undefined) result[index] = await input.map(item, index)
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, Math.floor(input.concurrency)), input.items.length) },
    () => worker(),
  ))
  return result
}

