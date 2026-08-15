import type { ChainConfig } from '../config/chains'

const STORAGE_KEY = 'hookscope:rpc-overrides:v1'
const RPC_URL = /^https?:\/\/[^\s]+$/i

export type RpcOverrides = Readonly<Record<string, string>>

function browserStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

export function isValidRpcUrl(value: string) {
  return RPC_URL.test(value.trim())
}

export function loadRpcOverrides(storage: Storage | undefined = browserStorage()): RpcOverrides {
  if (!storage) return {}
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}') as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const result: Record<string, string> = {}
    for (const [chainId, value] of Object.entries(parsed)) {
      if (/^\d+$/.test(chainId) && typeof value === 'string' && isValidRpcUrl(value)) {
        result[chainId] = value.trim()
      }
    }
    return result
  } catch {
    return {}
  }
}

function persist(overrides: RpcOverrides, storage: Storage | undefined = browserStorage()) {
  if (!storage) return
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(overrides))
  } catch {
    // Private browsing and storage policies may reject writes. The caller can
    // still use the configured defaults without making settings a hard failure.
  }
}

export function saveRpcOverride(chainId: number, url: string, storage?: Storage): RpcOverrides {
  const normalized = url.trim()
  if (!isValidRpcUrl(normalized)) throw new Error('Enter a valid HTTP or HTTPS RPC endpoint.')
  const next = { ...loadRpcOverrides(storage), [String(chainId)]: normalized }
  persist(next, storage)
  return next
}

export function removeRpcOverride(chainId: number, storage?: Storage): RpcOverrides {
  const next = { ...loadRpcOverrides(storage) }
  delete next[String(chainId)]
  persist(next, storage)
  return next
}

export function clearRpcOverrides(storage?: Storage): RpcOverrides {
  persist({}, storage)
  return {}
}

/** A browser override replaces public fallbacks so a private key-bearing URL is never leaked to another provider. */
export function runtimeRpcUrls(chain: ChainConfig, overrides: RpcOverrides = loadRpcOverrides()) {
  const override = overrides[String(chain.id)]
  return override ? [override] : chain.rpcUrls
}

