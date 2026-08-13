import { isHex, keccak256, type Address, type Hex } from 'viem'

type SourcifySignature = {
  signature?: string
  signatureHash4?: Hex
}

export type SourcifyStatus = {
  verified: boolean
  match?: 'exact_match' | 'match' | string
  creationBytecode?: Hex
  runtimeBytecode?: Hex
  runtimeCodeHash?: Hex
  verifiedAt?: string
  language?: string
  compilerVersion?: string
  contractName?: string
  fullyQualifiedName?: string
  proxyType?: string
  functionSignatures: string[]
  eventSignatures: string[]
  selectors: Hex[]
}

export type SourcifyCompilationBundle = {
  match: string
  verifiedAt?: string
  language: string
  compilerVersion: string
  fullyQualifiedName: string
  compilerSettings: Record<string, unknown>
  sources: Record<string, { content: string }>
  totalSourceBytes: number
  runtimeCodeHash: Hex
}

const MAX_SOURCE_FILES = 256
const MAX_SOURCE_BYTES = 2_000_000

type SourcifyBytecodeField = string | { onchainBytecode?: unknown }

function onchainBytecode(field: SourcifyBytecodeField | undefined): Hex | undefined {
  const candidate = typeof field === 'string' ? field : field?.onchainBytecode
  return typeof candidate === 'string' && isHex(candidate) ? candidate : undefined
}

export function sourcifyMatchesCodeHash(status: SourcifyStatus, codeHash: Hex): boolean {
  return status.verified && status.runtimeCodeHash?.toLowerCase() === codeHash.toLowerCase()
}

export async function fetchSourcifyStatus(
  chainId: number,
  address: Address,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<SourcifyStatus> {
  // Match identity and verification time are returned by default; listing them
  // in `fields` is rejected by the v2 lookup API.
  const fields = 'creationBytecode,runtimeBytecode,compilation,signatures,proxyResolution'
  const url = `https://sourcify.dev/server/v2/contract/${chainId}/${address}?fields=${fields}`
  try {
    const response = await fetcher(url, { signal, headers: { accept: 'application/json' } })
    if (response.status === 404) return { verified: false, functionSignatures: [], eventSignatures: [], selectors: [] }
    if (!response.ok) throw new Error(`Sourcify returned HTTP ${response.status}`)
    const body = (await response.json()) as {
      match?: string
      verifiedAt?: string
      creationBytecode?: SourcifyBytecodeField
      runtimeBytecode?: SourcifyBytecodeField
      compilation?: {
        language?: string
        compilerVersion?: string
        name?: string
        fullyQualifiedName?: string
      }
      signatures?: {
        function?: SourcifySignature[]
        event?: SourcifySignature[]
      }
      proxyResolution?: { proxyType?: string | null }
    }
    const functions = body.signatures?.function ?? []
    const events = body.signatures?.event ?? []
    const creationBytecode = onchainBytecode(body.creationBytecode)
    const runtimeBytecode = onchainBytecode(body.runtimeBytecode)
    return {
      verified: Boolean(body.match),
      match: body.match,
      creationBytecode,
      runtimeBytecode,
      runtimeCodeHash: runtimeBytecode ? keccak256(runtimeBytecode) : undefined,
      verifiedAt: body.verifiedAt,
      language: body.compilation?.language,
      compilerVersion: body.compilation?.compilerVersion,
      contractName: body.compilation?.name,
      fullyQualifiedName: body.compilation?.fullyQualifiedName,
      proxyType: body.proxyResolution?.proxyType ?? undefined,
      functionSignatures: functions.flatMap((item) => item.signature ? [item.signature] : []),
      eventSignatures: events.flatMap((item) => item.signature ? [item.signature] : []),
      selectors: functions.flatMap((item) => item.signatureHash4 ? [item.signatureHash4] : []),
    }
  } catch (error) {
    if (signal?.aborted) throw error
    return { verified: false, functionSignatures: [], eventSignatures: [], selectors: [] }
  }
}

export async function fetchSourcifyCompilationBundle(
  chainId: number,
  address: Address,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<SourcifyCompilationBundle | undefined> {
  const url = `https://sourcify.dev/server/v2/contract/${chainId}/${address}?fields=sources,compilation,runtimeBytecode`
  const response = await fetcher(url, { signal, headers: { accept: 'application/json' } })
  if (response.status === 404) return
  if (!response.ok) throw new Error(`Sourcify returned HTTP ${response.status}`)
  const body = await response.json() as {
    match?: string
    verifiedAt?: string
    sources?: Record<string, { content?: unknown }>
    runtimeBytecode?: SourcifyBytecodeField
    compilation?: {
      language?: unknown
      compilerVersion?: unknown
      fullyQualifiedName?: unknown
      compilerSettings?: unknown
    }
  }
  if (!body.match || !body.compilation || !body.sources) return
  const runtimeBytecode = onchainBytecode(body.runtimeBytecode)
  if (!runtimeBytecode) throw new Error('Sourcify did not return the verified on-chain runtime bytecode.')
  const sourceEntries = Object.entries(body.sources)
  if (sourceEntries.length > MAX_SOURCE_FILES) throw new Error(`Verified source bundle exceeds the ${MAX_SOURCE_FILES}-file browser ceiling.`)
  const sources: SourcifyCompilationBundle['sources'] = {}
  let totalSourceBytes = 0
  for (const [path, source] of sourceEntries) {
    if (typeof source.content !== 'string') throw new Error(`Verified source ${path} has no text content.`)
    totalSourceBytes += new TextEncoder().encode(source.content).byteLength
    if (totalSourceBytes > MAX_SOURCE_BYTES) throw new Error(`Verified source bundle exceeds the ${MAX_SOURCE_BYTES.toLocaleString()}-byte browser ceiling.`)
    sources[path] = { content: source.content }
  }
  if (typeof body.compilation.language !== 'string'
    || typeof body.compilation.compilerVersion !== 'string'
    || typeof body.compilation.fullyQualifiedName !== 'string'
    || !body.compilation.compilerSettings
    || typeof body.compilation.compilerSettings !== 'object') {
    throw new Error('Sourcify compilation metadata is incomplete.')
  }
  return {
    match: body.match,
    verifiedAt: body.verifiedAt,
    language: body.compilation.language,
    compilerVersion: body.compilation.compilerVersion,
    fullyQualifiedName: body.compilation.fullyQualifiedName,
    compilerSettings: body.compilation.compilerSettings as Record<string, unknown>,
    sources,
    totalSourceBytes,
    runtimeCodeHash: keccak256(runtimeBytecode),
  }
}
