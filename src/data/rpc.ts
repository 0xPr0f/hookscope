import {
  createPublicClient,
  fallback,
  http,
  type Chain,
  type PublicClient,
} from 'viem'
import type { ChainConfig } from '../config/chains'

const clients = new Map<number, PublicClient>()

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
 * Any HTTP status at or above 400 is the endpoint refusing the request rather
 * than the chain answering it, so it always warrants rotation; a chain that
 * genuinely rejects a call answers 200 with a JSON-RPC error. The message list
 * then covers providers that return 200 with a capability complaint.
 *
 * Capability is per method, not per endpoint: a provider can serve historical
 * `eth_getCode` and still refuse historical `eth_getLogs`, so no static ordering
 * removes the need to rotate.
 */
export function isEndpointCapabilityError(error: Error): boolean {
  const parts: string[] = []
  for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
    const node = current as { message?: string; details?: string; status?: number; cause?: unknown }
    if (typeof node.status === 'number' && node.status >= 400) return true
    if (node.message) parts.push(node.message)
    if (node.details) parts.push(node.details)
    current = node.cause
  }
  const message = parts.join(' ').toLowerCase()
  return RETRY_ON_NEXT_ENDPOINT.some((needle) => message.includes(needle))
}

function toViemChain(config: ChainConfig): Chain {
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
  const existing = clients.get(config.id)
  if (existing) return existing
  if (config.rpcUrls.length === 0) throw new Error(`No browser RPC is configured for ${config.name}.`)
  const client = createPublicClient({
    chain: toViemChain(config),
    transport: fallback(
      config.rpcUrls.map((url) => http(url, {
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
  clients.set(config.id, client)
  return client
}
