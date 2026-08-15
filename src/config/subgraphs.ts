/**
 * Published v4 subgraphs use two different shapes. Both answer discovery; they
 * differ in which entity carries the pool.
 *
 * - `pool-entities`: the Uniswap v4-subgraph schema, with `token0`/`token1`
 *   relations plus `liquidity` and `txCount` for activity ranking.
 * - `initialize-events`: a raw `Initialize` event index, keyed on v4's native
 *   `currency0`/`currency1`. It carries no activity counters, but it does supply
 *   the initializing `transactionHash`, which is exactly the replay reference
 *   discovery would otherwise have to find by scanning logs.
 */
export type SubgraphSchema = 'pool-entities' | 'initialize-events'

export const UNISWAP_V4_SUBGRAPHS: Readonly<Record<number, { id: string; schema: SubgraphSchema }>> = {
  // Every entry below was enumerated from The Graph's network subgraph and then
  // validated on 2026-08-14 by running the exact discovery query against it with
  // a token taken from the subgraph itself. All were synced with no indexing
  // errors and returned pools. None is published by Uniswap Labs; that is fine,
  // because discovery verifies every PoolId against pinned chain state.
  1: { id: 'DiYPVdygkfjDWhbxGSqAQxwBKmfKnkWQojqeM2rkLb3G', schema: 'pool-entities' },
  10: { id: '3Tn7Y1NJAr4ySKm7KFu1dwvH2WM3mHJnXzXAxQsdBDvW', schema: 'pool-entities' },
  56: { id: 'EAq1nJKgjnuKH6Gj4RFjCW7LcL7E2uipbncdwV7TTWkX', schema: 'pool-entities' },
  130: { id: 'EoCvJ5tyMLMJcTnLQwWpjAtPdn74PcrZgzfcT5bYxNBH', schema: 'pool-entities' },
  137: { id: '2CB2uQxcDKWDenagn2z17KQVCtfwSx5eXYuvqTciRTJu', schema: 'pool-entities' },
  196: { id: '51wWy4szRM6XFVnFsfMjcxYXc4E6CTbqropp86oUQmxQ', schema: 'pool-entities' },
  8453: { id: 'Gqm2b5J85n1bhCyDMpGbtbVn4935EvvdyHdHrx3dibyj', schema: 'pool-entities' },
  43114: { id: '49JxRo9FGxWpSf5Y5GKQPj5NUpX2HhpoZHpGzNEWQZjq', schema: 'pool-entities' },
}

/**
 * Rejected after a live query rather than on suspicion. Several published v4
 * subgraphs return `subgraph not found: no allocations`, meaning no indexer
 * serves them, and several others expose a schema with no `poolId`. Both classes
 * were dropped. Monad has a published subgraph with no allocations, so it stays
 * on the fallback.
 *
 * A chain with no entry falls back to bounded log scanning, which is slow but
 * correct. A wrong entry would burn requests and emit confusing failures, so the
 * absence is intentional.
 */

export const GRAPH_GATEWAY_ORIGIN = 'https://gateway.thegraph.com'

/**
 * Discovery issues exactly one query per schema and nothing else. The
 * server-side proxy accepts only the query matching the requested chain, so it
 * stays a narrow pool-discovery endpoint rather than an open GraphQL relay that
 * would let anyone run arbitrary queries against a hidden key.
 */
export const POOL_ENTITY_QUERY = `
  query HookscopePools($token: String!, $first: Int!, $cursor0: ID!, $cursor1: ID!) {
    token0Pools: pools(first: $first, orderBy: id, orderDirection: asc, where: { token0: $token, id_gt: $cursor0 }) {
      id token0 { id } token1 { id } feeTier tickSpacing hooks liquidity txCount createdAtBlockNumber
      swaps(first: 4, orderBy: timestamp, orderDirection: desc) { transaction { id blockNumber } }
      modifyLiquiditys(first: 4, orderBy: timestamp, orderDirection: desc) { transaction { id blockNumber } }
    }
    token1Pools: pools(first: $first, orderBy: id, orderDirection: asc, where: { token1: $token, id_gt: $cursor1 }) {
      id token0 { id } token1 { id } feeTier tickSpacing hooks liquidity txCount createdAtBlockNumber
      swaps(first: 4, orderBy: timestamp, orderDirection: desc) { transaction { id blockNumber } }
      modifyLiquiditys(first: 4, orderBy: timestamp, orderDirection: desc) { transaction { id blockNumber } }
    }
    _meta { block { number } hasIndexingErrors }
  }
`

/** Discovery over a raw Initialize-event index; aliases normalize it to the shared parser. */
export const INITIALIZE_EVENT_QUERY = `
  query HookscopeInitializedPools($token: Bytes!, $first: Int!, $cursor0: Bytes!, $cursor1: Bytes!) {
    token0Pools: pools(first: $first, orderBy: id, orderDirection: asc, where: { currency0: $token, id_gt: $cursor0 }) {
      id poolId currency0 currency1 fee tickSpacing hooks transactionHash createdAtBlockNumber: blockNumber
    }
    token1Pools: pools(first: $first, orderBy: id, orderDirection: asc, where: { currency1: $token, id_gt: $cursor1 }) {
      id poolId currency0 currency1 fee tickSpacing hooks transactionHash createdAtBlockNumber: blockNumber
    }
    _meta { block { number } hasIndexingErrors }
  }
`

export function subgraphQuery(schema: SubgraphSchema) {
  return schema === 'initialize-events' ? INITIALIZE_EVENT_QUERY : POOL_ENTITY_QUERY
}

/** `id` is `ID` in one schema and `Bytes` in the other, so the empty cursor differs. */
export function subgraphInitialCursor(schema: SubgraphSchema) {
  return schema === 'initialize-events' ? '0x' : ''
}

/** Same-origin path the browser uses when the key is held server-side. */
export function subgraphProxyPath(chainId: number) {
  return `/api/subgraph/${chainId}`
}
