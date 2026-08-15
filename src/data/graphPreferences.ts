import type { ChainConfig } from '../config/chains'
import { GRAPH_GATEWAY_ORIGIN } from '../config/subgraphs'

const STORAGE_KEY = 'hookscope:graph-api-key:v1'

function browserStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

export function isValidGraphApiKey(value: string) {
  const normalized = value.trim()
  const containsWhitespaceOrControl = [...normalized].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 32 || code === 127
  })
  return normalized.length > 0 && normalized.length <= 512 && !containsWhitespaceOrControl
}

export function loadGraphApiKey(storage: Storage | undefined = browserStorage()) {
  if (!storage) return undefined
  try {
    const value = storage.getItem(STORAGE_KEY)?.trim()
    return value && isValidGraphApiKey(value) ? value : undefined
  } catch {
    return undefined
  }
}

export function saveGraphApiKey(value: string, storage: Storage | undefined = browserStorage()) {
  const normalized = value.trim()
  if (!isValidGraphApiKey(normalized)) throw new Error('Enter a valid The Graph API key without spaces.')
  try {
    storage?.setItem(STORAGE_KEY, normalized)
  } catch {
    throw new Error('This browser did not allow the API key to be saved.')
  }
  return normalized
}

export function clearGraphApiKey(storage: Storage | undefined = browserStorage()) {
  try {
    storage?.removeItem(STORAGE_KEY)
  } catch {
    // Storage can be unavailable in private browsing. The configured server
    // proxy remains the default source in that case.
  }
}

export type RuntimeSubgraphRequest = {
  url: string
  headers: Readonly<Record<string, string>>
  source: 'self-hosted' | 'browser-graph-key' | 'server-proxy'
}

/**
 * Resolve credentials at request time so saving a key never requires a reload.
 * Explicit credential-free/self-hosted URLs remain build-owned. A browser key
 * overrides only Hookscope's same-origin Graph proxy.
 */
export function runtimeSubgraphRequest(
  chain: ChainConfig,
  graphApiKey: string | undefined = loadGraphApiKey(),
): RuntimeSubgraphRequest | undefined {
  const configured = chain.subgraphUrl
  const sameOriginProxy = configured?.startsWith('/api/subgraph/') ?? false
  if (configured && !sameOriginProxy) {
    return { url: configured, headers: {}, source: 'self-hosted' }
  }
  if (graphApiKey && chain.subgraphId && isValidGraphApiKey(graphApiKey)) {
    return {
      url: `${GRAPH_GATEWAY_ORIGIN}/api/subgraphs/id/${chain.subgraphId}`,
      headers: { authorization: `Bearer ${graphApiKey.trim()}` },
      source: 'browser-graph-key',
    }
  }
  if (configured) return { url: configured, headers: {}, source: 'server-proxy' }
  return undefined
}
