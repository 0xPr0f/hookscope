import {
  createPublicClient,
  fallback,
  http,
  type Chain,
  type PublicClient,
} from 'viem'
import type { ChainConfig } from '../config/chains'

const clients = new Map<number, PublicClient>()

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
    transport: fallback(config.rpcUrls.map((url) => http(url, { timeout: 15_000, retryCount: 1 }))),
    batch: { multicall: true },
  })
  clients.set(config.id, client)
  return client
}
