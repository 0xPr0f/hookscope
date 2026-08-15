import { getAddress, type Address, type Hex } from 'viem'
import type { ChainConfig } from '../config/chains'
import { subgraphInitialCursor, subgraphQuery } from '../config/subgraphs'
import type { PoolDescriptor, PoolReplayKind, PoolReplayReference } from '../domain/report'
import { computePoolId } from '../adapters/uniswapV4Pool'

const POOL_ID = /^0x[0-9a-fA-F]{64}$/
const TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/
const REPLAY_KINDS = new Set<PoolReplayKind>(['initialize', 'swap', 'modify-liquidity', 'donate'])

type PoolIndexDocument = {
  schemaVersion: '1'
  chainId: number
  poolManager: string
  token: string
  indexedThroughBlock: string
  generatedAt?: string
  pools: unknown[]
}

type SubgraphPool = {
  id: string
  token0: { id: string }
  token1: { id: string }
  feeTier: string
  tickSpacing: string
  hooks: string
  liquidity?: string
  txCount?: string
  createdAtBlockNumber: string
  swaps?: SubgraphEventReference[]
  modifyLiquiditys?: SubgraphEventReference[]
}

type SubgraphEventReference = {
  transaction?: { id?: string; blockNumber?: string }
}

type SubgraphPage = {
  data?: {
    token0Pools?: SubgraphPool[]
    token1Pools?: SubgraphPool[]
    _meta?: { block?: { number?: number }; hasIndexingErrors?: boolean }
  }
  errors?: { message?: string }[]
}

export type PoolIndexResult = {
  pools: PoolDescriptor[]
  indexedThroughBlock: bigint
  requests: number
  source: 'static-index' | 'subgraph'
  limitations: string[]
}

export type PoolIndexFetch = typeof fetch

function parseInteger(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error(`Pool index contains an invalid ${label}.`)
  return parsed
}

function parseReplayTransactions(value: unknown): PoolReplayReference[] | undefined {
  if (value === undefined) return
  if (!Array.isArray(value)) throw new Error('Pool index replayTransactions must be an array.')
  if (value.length > 16) throw new Error('Pool index exceeds the 16-transaction per-pool replay ceiling.')
  const unique = new Map<string, PoolReplayReference>()
  for (const item of value) {
    if (!item || typeof item !== 'object') throw new Error('Pool index contains an invalid replay transaction.')
    const candidate = item as Record<string, unknown>
    const kind = String(candidate.kind) as PoolReplayKind
    const transactionHash = String(candidate.transactionHash) as Hex
    const blockNumber = String(candidate.blockNumber)
    if (!REPLAY_KINDS.has(kind)) throw new Error(`Pool index contains an unsupported replay kind: ${kind}.`)
    if (!TRANSACTION_HASH.test(transactionHash)) throw new Error('Pool index contains an invalid replay transaction hash.')
    BigInt(blockNumber)
    unique.set(`${kind}:${transactionHash.toLowerCase()}`, { kind, transactionHash, blockNumber })
  }
  return [...unique.values()]
}

function subgraphReplayTransactions(pool: SubgraphPool): PoolReplayReference[] | undefined {
  const candidates: PoolReplayReference[] = []
  const add = (kind: PoolReplayKind, entries: SubgraphEventReference[] | undefined) => {
    for (const entry of entries ?? []) {
      const transactionHash = entry.transaction?.id as Hex | undefined
      const blockNumber = entry.transaction?.blockNumber
      if (!transactionHash || !blockNumber || !TRANSACTION_HASH.test(transactionHash)) continue
      try {
        BigInt(blockNumber)
        candidates.push({ kind, transactionHash, blockNumber })
      } catch {
        // A malformed optional replay reference does not invalidate pool discovery.
      }
    }
  }
  add('swap', pool.swaps)
  add('modify-liquidity', pool.modifyLiquiditys)
  return parseReplayTransactions(candidates.length ? candidates : undefined)
}

function parsePool(value: unknown, token: Address): PoolDescriptor {
  if (!value || typeof value !== 'object') throw new Error('Pool index contains a non-object pool.')
  const pool = value as Record<string, unknown>
  const currency0 = getAddress(String(pool.currency0 ?? (pool.token0 as { id?: string } | undefined)?.id))
  const currency1 = getAddress(String(pool.currency1 ?? (pool.token1 as { id?: string } | undefined)?.id))
  const hook = getAddress(String(pool.hook ?? pool.hooks))
  const poolId = String(pool.poolId ?? pool.id) as Hex
  if (!POOL_ID.test(poolId)) throw new Error('Pool index contains an invalid PoolId.')
  if (currency0.toLowerCase() !== token.toLowerCase() && currency1.toLowerCase() !== token.toLowerCase()) {
    throw new Error('Pool index returned a pool that does not contain the requested token.')
  }
  const descriptor = {
    poolId,
    currency0,
    currency1,
    fee: parseInteger(pool.fee ?? pool.feeTier, 'fee'),
    tickSpacing: parseInteger(pool.tickSpacing, 'tick spacing'),
    hook,
    initializedAtBlock: String(pool.initializedAtBlock ?? pool.createdAtBlockNumber),
    transactionHash: typeof pool.transactionHash === 'string' ? pool.transactionHash as Hex : undefined,
    replayTransactions: pool.replayTransactions === undefined
      ? subgraphReplayTransactions(pool as unknown as SubgraphPool)
      : parseReplayTransactions(pool.replayTransactions),
    liquidity: pool.liquidity === undefined ? undefined : String(pool.liquidity),
    activity: Math.max(0, Number(pool.activity ?? pool.txCount ?? 0) || 0),
  } satisfies PoolDescriptor
  if (computePoolId(descriptor).toLowerCase() !== descriptor.poolId.toLowerCase()) {
    throw new Error(`Pool index returned a PoolId that does not match its PoolKey: ${descriptor.poolId}.`)
  }
  BigInt(descriptor.initializedAtBlock)
  for (const reference of descriptor.replayTransactions ?? []) {
    if (BigInt(reference.blockNumber) < BigInt(descriptor.initializedAtBlock)) {
      throw new Error('Pool index replay transaction predates pool initialization.')
    }
  }
  return descriptor
}

function resolveTemplate(template: string, chain: ChainConfig, token: Address) {
  return template
    .replaceAll('{chainId}', String(chain.id))
    .replaceAll('{chainSlug}', chain.slug)
    .replaceAll('{token}', token.toLowerCase())
}

async function fetchStaticIndex(input: {
  chain: ChainConfig
  token: Address
  signal?: AbortSignal
  fetcher: PoolIndexFetch
}): Promise<PoolIndexResult | undefined> {
  const { chain, token, signal, fetcher } = input
  if (!chain.poolIndexUrl || !chain.poolManager) return
  const response = await fetcher(resolveTemplate(chain.poolIndexUrl, chain, token), {
    signal,
    headers: { accept: 'application/json' },
  })
  if (response.status === 404) return
  if (!response.ok) throw new Error(`Pool index returned HTTP ${response.status}.`)
  const body = await response.text()
  const document = JSON.parse(body) as PoolIndexDocument
  if (document.schemaVersion !== '1') throw new Error('Pool index schema version is unsupported.')
  if (document.chainId !== chain.id) throw new Error('Pool index chain identity does not match the selected chain.')
  if (getAddress(document.poolManager) !== chain.poolManager) throw new Error('Pool index PoolManager identity does not match the chain registry.')
  if (getAddress(document.token) !== token) throw new Error('Pool index token identity does not match the scan request.')
  const indexedThroughBlock = BigInt(document.indexedThroughBlock)
  const pools = document.pools.map((pool) => parsePool(pool, token))
  const manifest = await verifyAgainstManifest({ chain, token, body, signal, fetcher })
  return {
    pools,
    indexedThroughBlock,
    requests: 1 + manifest.requests,
    source: 'static-index',
    limitations: manifest.limitations,
  }
}

/** `sha256:<hex>` over the exact document bytes, matching the generator's checksum. */
async function documentChecksum(body: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `sha256:${hex}`
}

/**
 * Confirms the served token shard is the one the published manifest committed to.
 *
 * The manifest pins each document's checksum, so verifying it here means a
 * substituted or truncated shard is rejected before its PoolIds are trusted.
 * A manifest that is absent or unreadable is a visible limitation, never a
 * silent pass: the document's own identity checks have already run.
 */
async function verifyAgainstManifest(input: {
  chain: ChainConfig
  token: Address
  body: string
  signal?: AbortSignal
  fetcher: PoolIndexFetch
}): Promise<{ requests: number; limitations: string[] }> {
  const template = input.chain.poolIndexUrl
  if (!template || !template.includes('{token}')) {
    return { requests: 0, limitations: ['The pool index URL has no token placeholder, so its manifest checksum was not verified.'] }
  }
  const manifestUrl = resolveTemplate(template, input.chain, input.token).replace(/[^/]+$/, 'manifest.json')
  try {
    const response = await input.fetcher(manifestUrl, { signal: input.signal, headers: { accept: 'application/json' } })
    if (!response.ok) {
      return { requests: 1, limitations: [`The pool-index manifest returned HTTP ${response.status}, so the served shard checksum was not verified.`] }
    }
    const manifest = await response.json() as {
      schemaVersion?: string
      chainId?: number
      documents?: { token?: string; checksum?: string }[]
    }
    if (manifest.schemaVersion !== '1' || manifest.chainId !== input.chain.id) {
      return { requests: 1, limitations: ['No matching pool-index manifest was published for this chain, so the served shard checksum was not verified.'] }
    }
    const entry = manifest.documents?.find((item) => item.token?.toLowerCase() === input.token.toLowerCase())
    if (!entry?.checksum) {
      return { requests: 1, limitations: ['The pool-index manifest does not list this token document, so its checksum was not verified.'] }
    }
    // Only a published-and-disagreeing checksum is fatal: it means the served
    // document is not the one the index publisher committed to.
    const actual = await documentChecksum(input.body)
    if (actual !== entry.checksum.toLowerCase()) {
      throw new Error('The served pool-index document does not match its published manifest checksum.')
    }
    return { requests: 1, limitations: [] }
  } catch (error) {
    if (input.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
    if (error instanceof Error && error.message.includes('published manifest checksum')) throw error
    return { requests: 1, limitations: ['The pool-index manifest was unreachable, so the served shard checksum was not verified.'] }
  }
}


async function fetchSubgraphIndex(input: {
  chain: ChainConfig
  token: Address
  signal?: AbortSignal
  fetcher: PoolIndexFetch
}): Promise<PoolIndexResult | undefined> {
  const { chain, token, signal, fetcher } = input
  if (!chain.subgraphUrl) return
  const unique = new Map<string, PoolDescriptor>()
  const pageSize = 1_000
  const pageCeiling = 50
  // `id` is `ID` in one published schema and `Bytes` in the other.
  const schema = chain.subgraphSchema ?? 'pool-entities'
  let cursor0 = subgraphInitialCursor(schema)
  let cursor1 = subgraphInitialCursor(schema)
  let indexedThroughBlock = 0n
  let requests = 0
  let hasIndexingErrors = false

  for (let page = 0; page < pageCeiling; page += 1) {
    if (signal?.aborted) throw new DOMException('Scan cancelled', 'AbortError')
    const response = await fetcher(chain.subgraphUrl, {
      method: 'POST',
      signal,
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        query: subgraphQuery(schema),
        variables: { token: token.toLowerCase(), first: pageSize, cursor0, cursor1 },
      }),
    })
    requests += 1
    if (!response.ok) throw new Error(`Uniswap v4 subgraph returned HTTP ${response.status}.`)
    const body = await response.json() as SubgraphPage
    if (body.errors?.length) throw new Error(body.errors.map((error) => error.message ?? 'Subgraph query failed.').join(' '))
    const token0Pools = body.data?.token0Pools ?? []
    const token1Pools = body.data?.token1Pools ?? []
    const indexedBlock = body.data?._meta?.block?.number
    if (indexedBlock !== undefined) indexedThroughBlock = BigInt(indexedBlock)
    hasIndexingErrors ||= Boolean(body.data?._meta?.hasIndexingErrors)
    for (const pool of [...token0Pools, ...token1Pools]) {
      const parsed = parsePool(pool, token)
      unique.set(parsed.poolId.toLowerCase(), parsed)
    }
    const lastToken0Pool = token0Pools.at(-1)
    const lastToken1Pool = token1Pools.at(-1)
    if (lastToken0Pool) cursor0 = lastToken0Pool.id
    if (lastToken1Pool) cursor1 = lastToken1Pool.id
    if (token0Pools.length < pageSize && token1Pools.length < pageSize) {
      if (indexedThroughBlock === 0n) throw new Error('Uniswap v4 subgraph did not report its indexed block.')
      return {
        pools: [...unique.values()],
        indexedThroughBlock,
        requests,
        source: 'subgraph',
        limitations: hasIndexingErrors ? ['The configured pool index reports indexing errors; candidates were still verified onchain.'] : [],
      }
    }
  }
  throw new Error(`Uniswap v4 subgraph exceeded the ${pageCeiling}-page candidate ceiling.`)
}

export async function fetchPoolIndex(input: {
  chain: ChainConfig
  token: Address
  signal?: AbortSignal
  fetcher?: PoolIndexFetch
}): Promise<PoolIndexResult | undefined> {
  const fetcher = input.fetcher ?? fetch
  const limitations: string[] = []
  try {
    const result = await fetchStaticIndex({ ...input, fetcher })
    if (result) return result
  } catch (error) {
    if (input.signal?.aborted) throw error
    limitations.push(`Static pool index unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    const result = await fetchSubgraphIndex({ ...input, fetcher })
    if (result) return { ...result, limitations: [...limitations, ...result.limitations] }
  } catch (error) {
    if (input.signal?.aborted) throw error
    limitations.push(`Subgraph pool index unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  return limitations.length
    ? { pools: [], indexedThroughBlock: 0n, requests: 0, source: 'subgraph', limitations }
    : undefined
}
