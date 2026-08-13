import { autoload, providers } from '@shazow/whatsabi'
import { getAddress, keccak256, type Address, type Hex, type PublicClient } from 'viem'
import { attachInitializationTransactions, discoverPools, fetchTokenMetadata, type TokenMetadata } from '../adapters/uniswapV4'
import type { ChainConfig } from '../config/chains'
import type { ContractNode, PoolDescriptor, StaticSubject } from '../domain/report'
import { fetchSourcifyStatus, sourcifyMatchesCodeHash } from './source'

export type PinnedBlock = { number: bigint; hash: Hex; policy: string }
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
  poolLimit: 20
  signal?: AbortSignal
  onProgress?: (detail: string) => void
}): Promise<ScanSources> {
  const { client, chain, token, signal, onProgress } = input
  onProgress?.('Pinning a reproducible block')
  const block = await pinBlock(client, chain, input.block)
  if (signal?.aborted) throw new DOMException('Scan cancelled', 'AbortError')

  onProgress?.('Discovering PoolManager Initialize events')
  const [discovery, tokenMetadata] = await Promise.all([
    discoverPools(client, chain, token, block.number, signal),
    fetchTokenMetadata(client, token, block.number),
  ])
  const offset = Math.max(0, Number(input.poolCursor ?? '0') || 0)
  const selectedPools = discovery.pools.slice(offset, offset + input.poolLimit)
  onProgress?.(`Verifying ${selectedPools.length} selected pool initialization${selectedPools.length === 1 ? '' : 's'}`)
  const initialized = chain.poolManager
    ? await attachInitializationTransactions(client, chain.poolManager, selectedPools, signal)
    : { pools: selectedPools, requests: 0, unresolved: selectedPools.length }
  const pools = initialized.pools
  const hasMore = offset + input.poolLimit < discovery.pools.length
  const affectedByHook = new Map<Address, Hex[]>()
  for (const pool of pools) {
    const existing = affectedByHook.get(pool.hook) ?? []
    existing.push(pool.poolId)
    affectedByHook.set(pool.hook, existing)
  }

  onProgress?.(`Resolving ${affectedByHook.size} unique hook codehash${affectedByHook.size === 1 ? '' : 'es'}`)
  const resolved = await Promise.all([
    resolveContract(client, chain.id, token, 'token', pools.map((pool) => pool.poolId), block.number, signal),
    ...[...affectedByHook.entries()].map(([hook, affectedPools]) =>
      resolveContract(client, chain.id, hook, 'hook', affectedPools, block.number, signal),
    ),
  ])

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
    hasMore ? `This report covers ${pools.length} of ${discovery.pools.length} discovered pools.` : undefined,
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
    nextCursor: hasMore ? String(offset + input.poolLimit) : undefined,
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
