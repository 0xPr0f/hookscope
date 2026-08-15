import { autoload, providers } from '@shazow/whatsabi'
import { getAddress, keccak256, zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import {
  attachInitializationTransactions,
  discoverPools,
  fetchTokenMetadata,
  type DiscoveryResult,
  type TokenMetadata,
} from '../adapters/uniswapV4'
import type { ChainConfig } from '../config/chains'
import type { ContractNode, PoolDescriptor, StaticSubject } from '../domain/report'
import { fetchSourcifyStatus, sourcifyMatchesCodeHash } from './source'
import { mapWithConcurrency } from './scanRpcClient'

export type PinnedBlock = { number: bigint; hash: Hex; policy: string }
export type PoolDiscoverySnapshot = {
  chainId: number
  token: Address
  block: PinnedBlock
  tokenMetadata: TokenMetadata
  pools: PoolDescriptor[]
  discovery: Pick<DiscoveryResult, 'source' | 'requests' | 'completeHistory' | 'indexedThroughBlock' | 'limitation'>
}
export type ScanSources = {
  block: PinnedBlock
  tokenMetadata: TokenMetadata
  pools: PoolDescriptor[]
  poolCount: number
  hasMore: boolean
  nextCursor?: string
  subjects: StaticSubject[]
  preResolvedNodes: ContractNode[]
  limitations: string[]
  discovery: {
    source: 'index+tail' | 'logs'
    requests: number
    indexedThroughBlock?: string
  }
}

export async function loadPoolDiscovery(input: {
  client: PublicClient
  chain: ChainConfig
  token: Address
  block?: bigint
  signal?: AbortSignal
  onProgress?: (detail: string) => void
}): Promise<PoolDiscoverySnapshot> {
  const { client, chain, token, signal, onProgress } = input
  onProgress?.('Pinning a reproducible block')
  const block = await pinBlock(client, chain, input.block)
  if (signal?.aborted) throw new DOMException('Scan cancelled', 'AbortError')

  onProgress?.('Loading and verifying Uniswap v4 pools')
  const [discovery, tokenMetadata] = await Promise.all([
    discoverPools(client, chain, token, block.number, signal),
    fetchTokenMetadata(client, token, block.number),
  ])
  if (signal?.aborted) throw new DOMException('Scan cancelled', 'AbortError')

  return {
    chainId: chain.id,
    token,
    block,
    tokenMetadata,
    pools: discovery.pools,
    discovery: {
      source: discovery.source,
      requests: discovery.requests,
      completeHistory: discovery.completeHistory,
      indexedThroughBlock: discovery.indexedThroughBlock,
      limitation: discovery.limitation,
    },
  }
}

export function selectDiscoveredPools(
  discovery: PoolDiscoverySnapshot,
  selectedPoolIds: readonly Hex[],
  limit = 20,
): PoolDescriptor[] {
  const normalized = new Set(selectedPoolIds.map((poolId) => poolId.toLowerCase()))
  if (normalized.size === 0) throw new Error('Select at least one pool to analyze.')
  if (normalized.size > limit) throw new Error(`Select no more than ${limit} pools for one report.`)

  const selected = discovery.pools.filter((pool) => normalized.has(pool.poolId.toLowerCase()))
  if (selected.length !== normalized.size) {
    throw new Error('One or more selected pools do not belong to this pinned token discovery.')
  }
  return selected
}

export async function pinBlock(
  client: PublicClient,
  chain: ChainConfig,
  requested?: bigint,
): Promise<PinnedBlock> {
  if (requested !== undefined) {
    const block = await client.getBlock({ blockNumber: requested })
    if (!block.hash) throw new Error('RPC returned a block without a hash.')
    return { number: block.number, hash: block.hash, policy: 'explicit' }
  }
  try {
    const block = await client.getBlock({ blockTag: 'finalized' })
    if (block.hash) return { number: block.number, hash: block.hash, policy: 'finalized' }
  } catch {
    // Fall through to a confirmation-depth pin for chains without finalized tags.
  }
  const latest = await client.getBlockNumber()
  const number = latest > BigInt(chain.confirmations) ? latest - BigInt(chain.confirmations) : 0n
  const block = await client.getBlock({ blockNumber: number })
  if (!block.hash) throw new Error('RPC returned a block without a hash.')
  return { number, hash: block.hash, policy: `${chain.confirmations}-block confirmation depth` }
}

function whatsabiProvider(client: PublicClient, blockNumber: bigint) {
  return providers.CompatibleProvider({
    getCode: (address: string) => client.getCode({ address: getAddress(address), blockNumber }),
    getStorageAt: (address: string, slot: string | number) =>
      client.getStorageAt({
        address: getAddress(address),
        slot: (typeof slot === 'number' ? `0x${slot.toString(16)}` : slot) as Hex,
        blockNumber,
      }),
    call: async ({ to, data }: { to: string; data: string }) =>
      (await client.call({ to: getAddress(to), data: data as Hex, blockNumber })).data ?? '0x',
    getAddress: async () => {
      throw new Error('ENS resolution is disabled during deterministic scans.')
    },
  })
}

async function resolveContract(
  client: PublicClient,
  chainId: number,
  address: Address,
  role: StaticSubject['role'],
  affectedPools: Hex[],
  blockNumber: bigint,
  signal?: AbortSignal,
): Promise<{ subjects: StaticSubject[]; nodes: ContractNode[]; limitations: string[] }> {
  const bytecode = (await client.getCode({ address, blockNumber })) ?? '0x'
  const codeHash = keccak256(bytecode)
  const sourcify = await fetchSourcifyStatus(chainId, address, signal)
  const sourceMatchesCode = sourcifyMatchesCodeHash(sourcify, codeHash)
  const limitations: string[] = []
  if (sourcify.verified && !sourceMatchesCode) {
    limitations.push(`Sourcify metadata for ${role} ${address} was not attached because its repository runtime bytecode does not match the code at the pinned block.`)
  }
  let implementation: Address | undefined
  try {
    const result = await autoload(address, {
      provider: whatsabiProvider(client, blockNumber),
      abiLoader: false,
      signatureLookup: false,
      followProxies: true,
      onError: () => false,
    })
    if (result.address.toLowerCase() !== address.toLowerCase()) implementation = getAddress(result.address)
  } catch {
    // Proxy inference is additive. Bytecode analysis remains valid if a resolver fails.
  }

  const subjects: StaticSubject[] = [{ address, role, bytecode, codeHash, affectedPools }]
  const nodes: ContractNode[] = [{
    address,
    role,
    codeHash,
    bytecodeSize: Math.max(0, (bytecode.length - 2) / 2),
    verifiedSource: sourceMatchesCode,
    implementation,
    selectors: sourceMatchesCode ? sourcify.selectors : [],
    sourceMetadata: sourceMatchesCode && sourcify.match && sourcify.runtimeCodeHash ? {
      provider: 'sourcify',
      match: sourcify.match,
      runtimeCodeHash: sourcify.runtimeCodeHash,
      verifiedAt: sourcify.verifiedAt,
      language: sourcify.language,
      compilerVersion: sourcify.compilerVersion,
      contractName: sourcify.contractName,
      fullyQualifiedName: sourcify.fullyQualifiedName,
      proxyType: sourcify.proxyType,
      functionSignatures: sourcify.functionSignatures,
      eventSignatures: sourcify.eventSignatures,
    } : undefined,
  }]

  if (implementation) {
    const implementationCode = (await client.getCode({ address: implementation, blockNumber })) ?? '0x'
    const implementationHash = keccak256(implementationCode)
    const implementationSource = await fetchSourcifyStatus(chainId, implementation, signal)
    const implementationSourceMatchesCode = sourcifyMatchesCodeHash(implementationSource, implementationHash)
    if (implementationSource.verified && !implementationSourceMatchesCode) {
      limitations.push(`Sourcify metadata for implementation ${implementation} was not attached because its repository runtime bytecode does not match the code at the pinned block.`)
    }
    subjects.push({ address: implementation, role: 'implementation', bytecode: implementationCode, codeHash: implementationHash, affectedPools })
    nodes.push({
      address: implementation,
      role: 'implementation',
      codeHash: implementationHash,
      bytecodeSize: Math.max(0, (implementationCode.length - 2) / 2),
      verifiedSource: implementationSourceMatchesCode,
      selectors: implementationSourceMatchesCode ? implementationSource.selectors : [],
      sourceMetadata: implementationSourceMatchesCode && implementationSource.match && implementationSource.runtimeCodeHash ? {
        provider: 'sourcify',
        match: implementationSource.match,
        runtimeCodeHash: implementationSource.runtimeCodeHash,
        verifiedAt: implementationSource.verifiedAt,
        language: implementationSource.language,
        compilerVersion: implementationSource.compilerVersion,
        contractName: implementationSource.contractName,
        fullyQualifiedName: implementationSource.fullyQualifiedName,
        proxyType: implementationSource.proxyType,
        functionSignatures: implementationSource.functionSignatures,
        eventSignatures: implementationSource.eventSignatures,
      } : undefined,
    })
  }
  return { subjects, nodes, limitations }
}

export async function loadScanSources(input: {
  client: PublicClient
  chain: ChainConfig
  token: Address
  block?: bigint
  poolCursor?: string
  discoverySnapshot?: PoolDiscoverySnapshot
  selectedPoolIds?: readonly Hex[]
  poolLimit: 20
  signal?: AbortSignal
  onProgress?: (detail: string) => void
}): Promise<ScanSources> {
  const { client, chain, token, signal, onProgress } = input
  const snapshot = input.discoverySnapshot ?? await loadPoolDiscovery({
    client,
    chain,
    token,
    block: input.block,
    signal,
    onProgress,
  })
  if (snapshot.chainId !== chain.id || snapshot.token.toLowerCase() !== token.toLowerCase()) {
    throw new Error('The selected pools were discovered for a different chain or token.')
  }
  const { block, tokenMetadata } = snapshot
  const discovery = { pools: snapshot.pools, ...snapshot.discovery }
  const offset = Math.max(0, Number(input.poolCursor ?? '0') || 0)
  const selectedPools = input.selectedPoolIds
    ? selectDiscoveredPools(snapshot, input.selectedPoolIds, input.poolLimit)
    : discovery.pools.slice(offset, offset + input.poolLimit)
  onProgress?.(`Verifying ${selectedPools.length} selected pool initialization${selectedPools.length === 1 ? '' : 's'}`)
  const initialized = chain.poolManager
    ? await attachInitializationTransactions(client, chain.poolManager, selectedPools, signal)
    : { pools: selectedPools, requests: 0, unresolved: selectedPools.length }
  const pools = initialized.pools
  const hasMore = selectedPools.length < discovery.pools.length
  const affectedByHook = new Map<Address, Hex[]>()
  for (const pool of pools) {
    if (pool.hook.toLowerCase() === zeroAddress) continue
    const existing = affectedByHook.get(pool.hook) ?? []
    existing.push(pool.poolId)
    affectedByHook.set(pool.hook, existing)
  }

  onProgress?.(`Resolving ${affectedByHook.size} unique hook codehash${affectedByHook.size === 1 ? '' : 'es'}`)
  const targets = [
    { address: token, role: 'token' as const, affectedPools: pools.map((pool) => pool.poolId) },
    ...[...affectedByHook.entries()].map(([address, affectedPools]) => ({ address, role: 'hook' as const, affectedPools })),
  ]
  const resolved = await mapWithConcurrency({
    items: targets,
    concurrency: 4,
    signal,
    map: ({ address, role, affectedPools }, index) => {
      onProgress?.(`Resolving contract ${index + 1} of ${targets.length}`)
      return resolveContract(client, chain.id, address, role, affectedPools, block.number, signal)
    },
  })

  const subjectByHash = new Map<Hex, StaticSubject>()
  const nodeByIdentity = new Map<string, ContractNode>()
  for (const group of resolved) {
    for (const subject of group.subjects) {
      const existing = subjectByHash.get(subject.codeHash)
      subjectByHash.set(subject.codeHash, existing
        ? { ...existing, affectedPools: [...new Set([...existing.affectedPools, ...subject.affectedPools])] }
        : subject)
    }
    for (const node of group.nodes) nodeByIdentity.set(`${node.address}:${node.codeHash}`, node)
  }

  const limitations = [
    discovery.limitation,
    ...resolved.flatMap((group) => group.limitations),
    discovery.pools.length === 0 ? 'No verified Uniswap v4 pools containing this token were found at the pinned block.' : undefined,
    hasMore
      ? input.selectedPoolIds
        ? `This report covers ${pools.length} user-selected pool${pools.length === 1 ? '' : 's'} out of ${discovery.pools.length} discovered pools.`
        : `This report covers ${pools.length} of ${discovery.pools.length} discovered pools.`
      : undefined,
    initialized.unresolved > 0
      ? `${initialized.unresolved} selected pool initialization transaction${initialized.unresolved === 1 ? ' was' : 's were'} unavailable; pinned-state analysis remains available but historical replay is not.`
      : undefined,
  ].filter((item): item is string => Boolean(item))

  return {
    block,
    tokenMetadata,
    pools,
    poolCount: discovery.pools.length,
    hasMore,
    nextCursor: hasMore && !input.selectedPoolIds ? String(offset + input.poolLimit) : undefined,
    subjects: [...subjectByHash.values()],
    preResolvedNodes: [...nodeByIdentity.values()],
    limitations,
    discovery: {
      source: discovery.source,
      requests: discovery.requests + initialized.requests,
      indexedThroughBlock: discovery.indexedThroughBlock,
    },
  }
}
