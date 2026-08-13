import {
  getAddress,
  parseAbi,
  parseAbiItem,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from 'viem'
import type { ChainConfig } from '../config/chains'
import type { PoolDescriptor } from '../domain/report'
import { fetchPoolIndex, type PoolIndexFetch } from '../data/poolIndex'
import { computePoolId, computePoolStateSlot } from './uniswapV4Pool'

export { computePoolId, computePoolStateSlot } from './uniswapV4Pool'

export const INITIALIZE_EVENT = parseAbiItem(
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
)

const TOKEN_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
])

const EXTSLOAD_ABI = parseAbi([
  'function extsload(bytes32[] slots) external view returns (bytes32[])',
])

export type TokenMetadata = { symbol?: string; name?: string; decimals?: number }
export type DiscoveryResult = {
  pools: PoolDescriptor[]
  requests: number
  completeHistory: boolean
  source: 'index+tail' | 'logs'
  indexedThroughBlock?: string
  limitation?: string
}

export function poolFromLog(log: Log<bigint, number, false, typeof INITIALIZE_EVENT>): PoolDescriptor | null {
  const args = log.args
  if (!args.id || !args.currency0 || !args.currency1 || args.fee === undefined || args.tickSpacing === undefined || !args.hooks || log.blockNumber === null) return null
  const pool = {
    poolId: args.id,
    currency0: getAddress(args.currency0),
    currency1: getAddress(args.currency1),
    fee: args.fee,
    tickSpacing: args.tickSpacing,
    hook: getAddress(args.hooks),
    initializedAtBlock: log.blockNumber.toString(),
    transactionHash: log.transactionHash ?? undefined,
    activity: 0,
  } satisfies PoolDescriptor
  return computePoolId(pool) === pool.poolId ? pool : null
}

async function readChunk(
  client: PublicClient,
  poolManager: Address,
  token: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<PoolDescriptor[]> {
  const [asCurrency0, asCurrency1] = await Promise.all([
    client.getLogs({ address: poolManager, event: INITIALIZE_EVENT, args: { currency0: token }, fromBlock, toBlock }),
    client.getLogs({ address: poolManager, event: INITIALIZE_EVENT, args: { currency1: token }, fromBlock, toBlock }),
  ])
  return [...asCurrency0, ...asCurrency1].flatMap((log) => {
    const pool = poolFromLog(log)
    return pool ? [pool] : []
  })
}

async function scanLogRange(input: {
  client: PublicClient
  poolManager: Address
  token: Address
  fromBlock: bigint
  toBlock: bigint
  signal?: AbortSignal
  maxRequests: number
}): Promise<{ pools: PoolDescriptor[]; requests: number; complete: boolean }> {
  const { client, poolManager, token, toBlock, signal, maxRequests } = input
  const unique = new Map<Hex, PoolDescriptor>()
  let cursor = input.fromBlock
  let chunk = 250_000n
  let requests = 0
  let learnedCeiling = false

  while (cursor <= toBlock && requests + 2 <= maxRequests) {
    if (signal?.aborted) throw new DOMException('Scan cancelled', 'AbortError')
    const end = cursor + chunk - 1n < toBlock ? cursor + chunk - 1n : toBlock
    requests += 2
    try {
      const pools = await readChunk(client, poolManager, token, cursor, end)
      for (const pool of pools) unique.set(pool.poolId, pool)
      cursor = end + 1n
      if (!learnedCeiling && chunk < 1_000_000n) chunk *= 2n
    } catch (error) {
      if (signal?.aborted) throw error
      if (chunk <= 2_000n) throw error
      chunk /= 2n
      learnedCeiling = true
    }
  }
  return { pools: [...unique.values()], requests, complete: cursor > toBlock }
}

async function validateIndexedPools(
  client: PublicClient,
  poolManager: Address,
  pools: PoolDescriptor[],
  blockNumber: bigint,
  signal?: AbortSignal,
): Promise<{ pools: PoolDescriptor[]; requests: number }> {
  const candidates = pools.filter((pool) => BigInt(pool.initializedAtBlock) <= blockNumber)
  const verified: PoolDescriptor[] = []
  let requests = 0
  const batchSize = 256
  for (let offset = 0; offset < candidates.length; offset += batchSize) {
    if (signal?.aborted) throw new DOMException('Scan cancelled', 'AbortError')
    const batch = candidates.slice(offset, offset + batchSize)
    const state = await client.readContract({
      address: poolManager,
      abi: EXTSLOAD_ABI,
      functionName: 'extsload',
      args: [batch.map((pool) => computePoolStateSlot(pool.poolId))],
      blockNumber,
    })
    requests += 1
    for (let index = 0; index < batch.length; index += 1) {
      const candidate = batch[index]
      if (candidate && BigInt(state[index] ?? '0x0') !== 0n) {
        verified.push({
          ...candidate,
          replayTransactions: candidate.replayTransactions?.filter((reference) => BigInt(reference.blockNumber) <= blockNumber),
        })
      }
    }
  }
  return { pools: verified, requests }
}

function rankPools(pools: PoolDescriptor[]) {
  return pools.sort((a, b) => {
    const liquidityA = BigInt(a.liquidity ?? '0')
    const liquidityB = BigInt(b.liquidity ?? '0')
    if (liquidityA !== liquidityB) return liquidityB > liquidityA ? 1 : -1
    if (a.activity !== b.activity) return b.activity - a.activity
    const blockOrder = BigInt(b.initializedAtBlock) - BigInt(a.initializedAtBlock)
    if (blockOrder !== 0n) return blockOrder > 0n ? 1 : -1
    return a.poolId.localeCompare(b.poolId)
  })
}

export async function discoverPools(
  client: PublicClient,
  chain: ChainConfig,
  token: Address,
  blockNumber: bigint,
  signal?: AbortSignal,
  indexFetch?: PoolIndexFetch,
): Promise<DiscoveryResult> {
  if (!chain.poolManager || chain.deploymentBlock === undefined) {
    return {
      pools: [],
      requests: 0,
      completeHistory: false,
      source: 'logs',
      limitation: chain.limitation ?? 'PoolManager deployment is not verified for this chain.',
    }
  }

  const indexed = await fetchPoolIndex({ chain, token, signal, fetcher: indexFetch })
  if (indexed && indexed.indexedThroughBlock >= chain.deploymentBlock) {
    const verified = await validateIndexedPools(client, chain.poolManager, indexed.pools, blockNumber, signal)
    const tailStart = indexed.indexedThroughBlock + 1n
    const tail = tailStart <= blockNumber
      ? await scanLogRange({ client, poolManager: chain.poolManager, token, fromBlock: tailStart, toBlock: blockNumber, signal, maxRequests: 100 })
      : { pools: [], requests: 0, complete: true }
    const unique = new Map<string, PoolDescriptor>()
    for (const pool of [...verified.pools, ...tail.pools]) unique.set(pool.poolId.toLowerCase(), pool)
    const limitation = [
      ...indexed.limitations,
      tail.complete ? undefined : 'Recent PoolManager log tail exceeded its 100-request resource ceiling.',
      verified.pools.length < indexed.pools.filter((pool) => BigInt(pool.initializedAtBlock) <= blockNumber).length
        ? 'One or more indexed candidates had no initialized PoolManager state at the pinned block and were excluded.'
        : undefined,
    ].filter((item): item is string => Boolean(item)).join(' ')
    return {
      pools: rankPools([...unique.values()]),
      requests: indexed.requests + verified.requests + tail.requests,
      completeHistory: tail.complete,
      source: 'index+tail',
      indexedThroughBlock: indexed.indexedThroughBlock.toString(),
      limitation: limitation || undefined,
    }
  }

  const scan = await scanLogRange({
    client,
    poolManager: chain.poolManager,
    token,
    fromBlock: chain.deploymentBlock,
    toBlock: blockNumber,
    signal,
    maxRequests: 600,
  })
  const indexLimitation = indexed?.limitations.join(' ')
  const limitation = [
    indexLimitation,
    scan.complete ? undefined : 'Discovery stopped at the 600-request resource ceiling.',
  ].filter((item): item is string => Boolean(item)).join(' ')
  return {
    pools: rankPools(scan.pools),
    requests: (indexed?.requests ?? 0) + scan.requests,
    completeHistory: scan.complete,
    source: 'logs',
    limitation: limitation || undefined,
  }
}

export async function attachInitializationTransactions(
  client: PublicClient,
  poolManager: Address,
  pools: PoolDescriptor[],
  signal?: AbortSignal,
): Promise<{ pools: PoolDescriptor[]; requests: number; unresolved: number }> {
  const result = [...pools]
  const pending = pools
    .map((pool, index) => ({ pool, index }))
    .filter(({ pool }) => !pool.transactionHash)
  let requests = 0
  let unresolved = 0
  let cursor = 0

  const run = async () => {
    while (cursor < pending.length) {
      if (signal?.aborted) throw new DOMException('Scan cancelled', 'AbortError')
      const item = pending[cursor]
      cursor += 1
      if (!item) continue
      const blockNumber = BigInt(item.pool.initializedAtBlock)
      try {
        const logs = await client.getLogs({
          address: poolManager,
          event: INITIALIZE_EVENT,
          args: { id: item.pool.poolId },
          fromBlock: blockNumber,
          toBlock: blockNumber,
        })
        requests += 1
        const observed = logs.map(poolFromLog).find((pool) => pool?.poolId.toLowerCase() === item.pool.poolId.toLowerCase())
        if (!observed) {
          unresolved += 1
          continue
        }
        result[item.index] = {
          ...item.pool,
          transactionHash: observed.transactionHash,
          replayTransactions: observed.transactionHash
            ? [
                ...(item.pool.replayTransactions ?? []).filter((reference) => reference.kind !== 'initialize'),
                { kind: 'initialize', transactionHash: observed.transactionHash, blockNumber: blockNumber.toString() },
              ]
            : item.pool.replayTransactions,
        }
      } catch (error) {
        if (signal?.aborted) throw error
        requests += 1
        unresolved += 1
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, () => run()))
  return { pools: result, requests, unresolved }
}

async function readOptional<T>(promise: Promise<T>): Promise<T | undefined> {
  try {
    return await promise
  } catch {
    return undefined
  }
}

export async function fetchTokenMetadata(
  client: PublicClient,
  token: Address,
  blockNumber: bigint,
): Promise<TokenMetadata> {
  const [symbol, name, decimals] = await Promise.all([
    readOptional(client.readContract({ address: token, abi: TOKEN_ABI, functionName: 'symbol', blockNumber })),
    readOptional(client.readContract({ address: token, abi: TOKEN_ABI, functionName: 'name', blockNumber })),
    readOptional(client.readContract({ address: token, abi: TOKEN_ABI, functionName: 'decimals', blockNumber })),
  ])
  return { symbol, name, decimals }
}
