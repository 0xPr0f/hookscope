import type { Address } from 'viem'
import type { SubgraphSchema } from './subgraphs'
import { GRAPH_GATEWAY_ORIGIN, UNISWAP_V4_SUBGRAPHS, subgraphProxyPath } from './subgraphs'

export type EvmVariant = 'ethereum' | 'op-stack' | 'arbitrum' | 'zksync' | 'other'

export type ChainConfig = {
  id: number
  slug: string
  name: string
  shortName: string
  explorerUrl: string
  rpcUrls: string[]
  poolIndexUrl?: string
  subgraphUrl?: string
  /**
   * Public Graph Network subgraph ID. These are not secrets, so they live in the
   * registry rather than in environment configuration; one API key serves all of
   * them through the same gateway.
   */
  subgraphId?: string
  /** Sent with subgraph requests; carries the bearer token on the direct-gateway path. */
  subgraphHeaders?: Record<string, string>
  subgraphSchema?: SubgraphSchema
  poolManager?: Address
  deploymentBlock?: bigint
  evmVariant: EvmVariant
  confirmations: number
  deepExecution: boolean
  limitation?: string
}

const envRpc = (id: number, fallback: string[]) => {
  const configured = import.meta.env[`VITE_RPC_${id}`] as string | undefined
  return configured ? [configured, ...fallback] : fallback
}

const envSource = (name: string, id: number) => import.meta.env[`${name}_${id}`] as string | undefined

/**
 * Resolves how this build reaches a chain's pool index.
 *
 * The browser never holds the Graph API key. Discovery goes through the
 * same-origin `/api/subgraph/<chainId>` proxy, which reads `SUBGRAPH_API_KEY`
 * server-side; the dev server serves that same route so local runs behave like
 * production. An explicit `VITE_V4_SUBGRAPH_<chainId>` still wins for a private
 * or self-hosted indexer that needs no credential.
 *
 * `VITE_GRAPH_API_KEY` remains a last-resort fallback for a static deployment
 * with no server at all. It is not the default and should stay unset: a key
 * compiled into the bundle is readable by anyone who loads the page, and domain
 * restriction only raises the effort needed to reuse it. When it is used, the
 * key travels as a bearer header rather than in the URL, keeping it out of
 * referrer headers, proxy logs, and browser history.
 */
export function resolveSubgraphSource(input: {
  chainId: number
  subgraphId?: string
  explicitUrl?: string
  browserApiKey?: string
}): { url?: string; headers?: Record<string, string> } {
  if (input.explicitUrl) return { url: input.explicitUrl }
  if (!input.subgraphId) return {}
  if (input.browserApiKey) {
    return {
      url: `${GRAPH_GATEWAY_ORIGIN}/api/subgraphs/id/${input.subgraphId}`,
      headers: { authorization: `Bearer ${input.browserApiKey}` },
    }
  }
  return { url: subgraphProxyPath(input.chainId) }
}

const config = (
  input: Omit<ChainConfig, 'rpcUrls'> & { publicRpcs: string[] },
): ChainConfig => {
  const published = UNISWAP_V4_SUBGRAPHS[input.id]
  const subgraphId = input.subgraphId ?? published?.id
  const source = resolveSubgraphSource({
    chainId: input.id,
    subgraphId,
    explicitUrl: envSource('VITE_V4_SUBGRAPH', input.id),
    browserApiKey: import.meta.env.VITE_GRAPH_API_KEY as string | undefined,
  })
  return {
    ...input,
    subgraphId,
    subgraphSchema: published?.schema,
    rpcUrls: envRpc(input.id, input.publicRpcs),
    subgraphUrl: source.url ?? input.subgraphUrl,
    subgraphHeaders: source.headers,
  }
}

// PoolManager addresses and start blocks are pinned from Uniswap/v4-subgraph networks.json.
// `deepExecution` is enabled only where a real v4 transaction was reproduced
// exactly from pinned parent state — outcome, gas, and log count — by
// src/analysis/chainDifferential.live.test.ts. Runtime replay still asserts a
// receipt match per transaction, so a regression degrades coverage rather than
// producing a false claim.
// RPC candidates are ordered archive-first: each leading endpoint was verified on
// 2026-08-14 to serve `eth_getCode` at that chain's PoolManager deployment block.
// Ordering matters because an endpoint without archive state answers ordinary
// calls perfectly and only fails historical reads, so a non-archive endpoint at
// the head silently degrades every replay. The client rotates on that failure
// (see `isEndpointCapabilityError`), and the trailing entries are its targets.
// Chains absent from that source remain visible but explicitly unavailable until canaried.
export const CHAINS: ChainConfig[] = [
  config({ id: 1, slug: 'ethereum', name: 'Ethereum', shortName: 'ETH', explorerUrl: 'https://etherscan.io', publicRpcs: ['https://rpc.mevblocker.io', 'https://ethereum.drpc.org', 'https://1rpc.io/eth', 'https://ethereum-rpc.publicnode.com'], poolManager: '0x000000000004444c5dc75cB358380D2e3dE08A90', deploymentBlock: 21688329n, evmVariant: 'ethereum', confirmations: 12, deepExecution: true }),
  config({ id: 130, slug: 'unichain', name: 'Unichain', shortName: 'UNI', explorerUrl: 'https://uniscan.xyz', publicRpcs: ['https://unichain.drpc.org', 'https://mainnet.unichain.org', 'https://unichain-rpc.publicnode.com'], poolManager: '0x1F98400000000000000000000000000000000004', deploymentBlock: 25500n, evmVariant: 'op-stack', confirmations: 20, deepExecution: true }),
  config({ id: 8453, slug: 'base', name: 'Base', shortName: 'BASE', explorerUrl: 'https://basescan.org', publicRpcs: ['https://base.drpc.org', 'https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.llamarpc.com'], poolManager: '0x498581fF718922c3f8e6A244956aF099B2652b2b', deploymentBlock: 25350988n, evmVariant: 'op-stack', confirmations: 20, deepExecution: true }),
  config({ id: 42161, slug: 'arbitrum', name: 'Arbitrum', shortName: 'ARB', explorerUrl: 'https://arbiscan.io', publicRpcs: ['https://arbitrum.drpc.org', 'https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com', 'https://arbitrum.llamarpc.com'], poolManager: '0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32', deploymentBlock: 297842872n, evmVariant: 'arbitrum', confirmations: 20, deepExecution: false, limitation: 'Arbitrum execution conformance is not yet certified.' }),
  config({ id: 10, slug: 'optimism', name: 'Optimism', shortName: 'OP', explorerUrl: 'https://optimistic.etherscan.io', publicRpcs: ['https://optimism.drpc.org', 'https://mainnet.optimism.io', 'https://optimism-rpc.publicnode.com'], poolManager: '0x9a13F98Cb987694C9F086b1F5eB990EeA8264Ec3', deploymentBlock: 130947675n, evmVariant: 'op-stack', confirmations: 20, deepExecution: true }),
  config({ id: 137, slug: 'polygon', name: 'Polygon', shortName: 'POL', explorerUrl: 'https://polygonscan.com', publicRpcs: ['https://polygon.drpc.org', 'https://1rpc.io/matic', 'https://polygon-rpc.com', 'https://polygon-bor-rpc.publicnode.com'], poolManager: '0x67366782805870060151383F4BbFF9daB53e5cD6', deploymentBlock: 66980384n, evmVariant: 'other', confirmations: 128, deepExecution: false, limitation: 'Polygon execution conformance failed a receipt differential on 2026-08-14: revm reproduced 13 logs and 252,977 gas against the chain\'s 20 logs and 311,881 gas.' }),
  config({ id: 81457, slug: 'blast', name: 'Blast', shortName: 'BLAST', explorerUrl: 'https://blastscan.io', publicRpcs: ['https://blast.drpc.org', 'https://rpc.blast.io', 'https://blast-rpc.publicnode.com'], poolManager: '0x1631559198A9e474033433b2958daBC135ab6446', deploymentBlock: 14377311n, evmVariant: 'op-stack', confirmations: 20, deepExecution: false, limitation: 'OP execution conformance is not yet certified.' }),
  config({ id: 480, slug: 'worldchain', name: 'World Chain', shortName: 'WORLD', explorerUrl: 'https://worldscan.org', publicRpcs: ['https://worldchain-mainnet.g.alchemy.com/public', 'https://worldchain.drpc.org'], poolManager: '0xb1860D529182ac3BC1F51Fa2ABd56662b7D13f33', deploymentBlock: 9111872n, evmVariant: 'op-stack', confirmations: 20, deepExecution: false, limitation: 'OP execution conformance is not yet certified.' }),
  config({ id: 43114, slug: 'avalanche', name: 'Avalanche', shortName: 'AVAX', explorerUrl: 'https://snowtrace.io', publicRpcs: ['https://avalanche.drpc.org', 'https://api.avax.network/ext/bc/C/rpc', 'https://avalanche-c-chain-rpc.publicnode.com'], poolManager: '0x06380C0e0912312B5150364B9DC4542BA0DbBc85', deploymentBlock: 56195376n, evmVariant: 'other', confirmations: 5, deepExecution: false, limitation: 'Avalanche execution conformance failed a receipt differential on 2026-08-14: revm reproduced 55 logs and 1,230,799 gas against the chain\'s 51 logs and 1,272,399 gas.' }),
  config({ id: 56, slug: 'bnb', name: 'BNB Chain', shortName: 'BNB', explorerUrl: 'https://bscscan.com', publicRpcs: ['https://bsc.drpc.org', 'https://bsc-dataseed.binance.org', 'https://bsc-rpc.publicnode.com'], poolManager: '0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF', deploymentBlock: 45970610n, evmVariant: 'other', confirmations: 15, deepExecution: false, limitation: 'BNB execution conformance is not yet certified.' }),
  config({ id: 42220, slug: 'celo', name: 'Celo', shortName: 'CELO', explorerUrl: 'https://celoscan.io', publicRpcs: ['https://celo.drpc.org', 'https://forno.celo.org', 'https://celo-rpc.publicnode.com'], poolManager: '0x288dc841A52FCA2707c6947B3A777c5E56cd87BC', deploymentBlock: 43985163n, evmVariant: 'other', confirmations: 5, deepExecution: false, limitation: 'Celo execution conformance is not yet certified.' }),
  config({ id: 7777777, slug: 'zora', name: 'Zora', shortName: 'ZORA', explorerUrl: 'https://explorer.zora.energy', publicRpcs: ['https://zora.drpc.org', 'https://rpc.zora.energy'], poolManager: '0x0575338e4C17006aE181B47900A84404247CA30f', deploymentBlock: 25434534n, evmVariant: 'op-stack', confirmations: 20, deepExecution: false, limitation: 'OP execution conformance is not yet certified.' }),
  config({ id: 57073, slug: 'ink', name: 'Ink', shortName: 'INK', explorerUrl: 'https://explorer.inkonchain.com', publicRpcs: ['https://ink.drpc.org', 'https://rpc-gel.inkonchain.com', 'https://ink-rpc.publicnode.com'], poolManager: '0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32', deploymentBlock: 4580556n, evmVariant: 'op-stack', confirmations: 20, deepExecution: false, limitation: 'OP execution conformance is not yet certified.' }),
  config({ id: 1868, slug: 'soneium', name: 'Soneium', shortName: 'SONE', explorerUrl: 'https://soneium.blockscout.com', publicRpcs: ['https://soneium.drpc.org', 'https://rpc.soneium.org'], poolManager: '0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32', deploymentBlock: 2473300n, evmVariant: 'op-stack', confirmations: 20, deepExecution: false, limitation: 'OP execution conformance is not yet certified.' }),
  config({ id: 59144, slug: 'linea', name: 'Linea', shortName: 'LINEA', explorerUrl: 'https://lineascan.build', publicRpcs: ['https://rpc.linea.build', 'https://1rpc.io/linea', 'https://linea.drpc.org'], poolManager: '0x248083Fb965359d82b06C1F5322480Dcfc1AD857', deploymentBlock: 28974969n, evmVariant: 'other', confirmations: 20, deepExecution: false, limitation: 'Linea execution conformance is not yet certified.' }),
  config({ id: 143, slug: 'monad', name: 'Monad', shortName: 'MON', explorerUrl: 'https://monadscan.com', publicRpcs: ['https://rpc.monad.xyz', 'https://monad.drpc.org'], poolManager: '0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e', deploymentBlock: 29255895n, evmVariant: 'other', confirmations: 20, deepExecution: false, limitation: 'Monad execution conformance is not yet certified.' }),
  config({ id: 4663, slug: 'robinhood', name: 'Robinhood Chain', shortName: 'RHC', explorerUrl: 'https://robinhoodchain.blockscout.com', publicRpcs: ['https://rpc.robinhoodchain.com'], poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951', deploymentBlock: 9070n, evmVariant: 'other', confirmations: 20, deepExecution: false, limitation: 'Public RPC and execution conformance require verification.' }),
  config({ id: 4326, slug: 'megaeth', name: 'MegaETH', shortName: 'MEGA', explorerUrl: 'https://megaeth.blockscout.com', publicRpcs: ['https://mainnet.megaeth.com/rpc'], poolManager: '0xaCB7e78fa05D562e0A5D3089ec896D57D057d38E', deploymentBlock: 7009653n, evmVariant: 'other', confirmations: 20, deepExecution: false, limitation: 'MegaETH execution conformance is not yet certified.' }),
  config({ id: 4217, slug: 'tempo', name: 'Tempo', shortName: 'TEMPO', explorerUrl: 'https://explore.tempo.xyz', publicRpcs: ['https://rpc.tempo.xyz'], poolManager: '0x33620f62C5b9B2086dD6b62F4A297A9f30347029', deploymentBlock: 6606180n, evmVariant: 'other', confirmations: 20, deepExecution: false, limitation: 'Tempo execution conformance is not yet certified.' }),
  config({ id: 196, slug: 'xlayer', name: 'X Layer', shortName: 'XL', explorerUrl: 'https://www.oklink.com/x-layer', publicRpcs: ['https://xlayerrpc.okx.com', 'https://rpc.xlayer.tech', 'https://xlayer.drpc.org'], poolManager: '0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32', deploymentBlock: 46460144n, evmVariant: 'other', confirmations: 20, deepExecution: true }),
  config({ id: 324, slug: 'zksync', name: 'zkSync', shortName: 'ZK', explorerUrl: 'https://explorer.zksync.io', publicRpcs: ['https://mainnet.era.zksync.io'], evmVariant: 'zksync', confirmations: 20, deepExecution: false, limitation: 'Uniswap v4-subgraph does not yet publish a verified PoolManager deployment for zkSync.' }),
]

export const CHAIN_BY_ID = new Map(CHAINS.map((chain) => [chain.id, chain]))

export function getChainConfig(chainId: number): ChainConfig {
  const chain = CHAIN_BY_ID.get(chainId)
  if (!chain) throw new Error(`Unsupported chain ${chainId}`)
  return chain
}
