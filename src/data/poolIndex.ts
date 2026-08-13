import { getAddress, type Address, type Hex } from 'viem'
import type { ChainConfig } from '../config/chains'
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
    replayTransactions: parseReplayTransactions(pool.replayTransactions),
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
  const document = await response.json() as PoolIndexDocument
  if (document.schemaVersion !== '1') throw new Error('Pool index schema version is unsupported.')
  if (document.chainId !== chain.id) throw new Error('Pool index chain identity does not match the selected chain.')
  if (getAddress(document.poolManager) !== chain.poolManager) throw new Error('Pool index PoolManager identity does not match the chain registry.')
  if (getAddress(document.token) !== token) throw new Error('Pool index token identity does not match the scan request.')
  const indexedThroughBlock = BigInt(document.indexedThroughBlock)
  const pools = document.pools.map((pool) => parsePool(pool, token))
  return { pools, indexedThroughBlock, requests: 1, source: 'static-index', limitations: [] }
}

const SUBGRAPH_QUERY = `
  query HookscopePools($token: String!, $first: Int!, $cursor0: ID!, $cursor1: ID!) {
    token0Pools: pools(first: $first, orderBy: id, orderDirection: asc, where: { token0: $token, id_gt: $cursor0 }) {
      id token0 { id } token1 { id } feeTier tickSpacing hooks liquidity txCount createdAtBlockNumber
    }
    token1Pools: pools(first: $first, orderBy: id, orderDirection: asc, where: { token1: $token, id_gt: $cursor1 }) {
      id token0 { id } token1 { id } feeTier tickSpacing hooks liquidity txCount createdAtBlockNumber
    }
    _meta { block { number } hasIndexingErrors }
  }
`

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
  let cursor0 = ''
  let cursor1 = ''
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
        query: SUBGRAPH_QUERY,
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
