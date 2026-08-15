import {
  createPublicClient,
  fallback,
  http,
  type Chain,
  type PublicClient,
} from 'viem'
import type { ChainConfig } from '../config/chains'
import { runtimeRpcUrls } from './rpcPreferences'

const clients = new Map<number, { endpoints: string; client: PublicClient }>()

/**
 * Errors that mean "this endpoint cannot serve the request", not "the request is
 * wrong".
 *
 * viem's default fallback treats a JSON-RPC error as a real answer and stops
 * rotating, which is right for a malformed call but wrong here: an endpoint
 * without archive state answers `eth_blockNumber` perfectly and then refuses
 * every historical read. Without this, discovery succeeds on the first endpoint
 * and every replay afterwards fails against the same one, degrading the whole
 * execution tier while a working archive endpoint sits next in the list.
 *
 * Providers signal the same condition with different codes: -32000 for a pruned
 * node, -32602 for a gated archive tier, HTTP 400 for a router with no suitable
 * backend.
 */
const RETRY_ON_NEXT_ENDPOINT = [
  'suitable provider',
  'route your request',
  'missing trie node',
  'historical state',
  'archive',
  'state is not available',
  'block requested not found',
  'header not found',
  'unknown state',
  'not available on this endpoint',
  'exceeds limit',
  'range',
  'too large',
  'rate limit',
  'too many requests',
  'capacity',
  'unauthorized',
  'personal token',
]

/**
 * True when another endpoint deserves a try rather than surfacing this error.
 *
 * Two signals, because providers disagree on how to report the same condition.
 * Transient HTTP statuses rotate immediately. Generic 400/403 responses rotate
 * only when their message identifies an archive, routing, capacity, or access
 * limitation; otherwise duplicating a malformed request across every endpoint
 * merely increases load and hides the actual error.
 *
 * Capability is per method, not per endpoint: a provider can serve historical
 * `eth_getCode` and still refuse historical `eth_getLogs`, so no static ordering
 * removes the need to rotate.
 */
export function isEndpointCapabilityError(error: Error): boolean {
  const parts: string[] = []
  for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
    const node = current as { message?: string; details?: string; status?: number; cause?: unknown }
    if (node.status === 408 || node.status === 425 || node.status === 429 || (typeof node.status === 'number' && node.status >= 500)) return true
    if (node.message) parts.push(node.message)
    if (node.details) parts.push(node.details)
    current = node.cause
  }
  const message = parts.join(' ').toLowerCase()
  return RETRY_ON_NEXT_ENDPOINT.some((needle) => message.includes(needle))
}

export function toViemChain(config: ChainConfig): Chain {
  return {
    id: config.id,
    name: config.name,
    nativeCurrency: { name: config.shortName, symbol: config.shortName, decimals: 18 },
    rpcUrls: {
      default: { http: config.rpcUrls },
    },
    blockExplorers: {
      default: { name: `${config.name} explorer`, url: config.explorerUrl },
    },
  }
}

export function getPublicClient(config: ChainConfig): PublicClient {
  const rpcUrls = runtimeRpcUrls(config)
  const endpointIdentity = rpcUrls.join('\n')
  const existing = clients.get(config.id)
  if (existing?.endpoints === endpointIdentity) return existing.client
  if (rpcUrls.length === 0) throw new Error(`No browser RPC is configured for ${config.name}.`)
  const client = createPublicClient({
    chain: toViemChain(config),
    transport: fallback(
      rpcUrls.map((url) => http(url, {
        timeout: 15_000,
        retryCount: 1,
        // Account hydration asks for balance, nonce, and code together. JSON-RPC
        // batching turns those concurrent reads into one HTTP request, reducing
        // browser connection pressure without changing the pinned read model.
        batch: { batchSize: 20, wait: 8 },
      })),
      { shouldThrow: (error) => !isEndpointCapabilityError(error) },
    ),
    batch: { multicall: true },
  })
  clients.set(config.id, { endpoints: endpointIdentity, client })
  return client
}

export function resetPublicClient(chainId?: number) {
  if (chainId === undefined) clients.clear()
  else clients.delete(chainId)
}
