const resolvedImages = new Map<string, string>()
const pendingImages = new Map<string, Promise<string>>()

type ImageCache = Pick<Cache, 'match' | 'put'>

export type BrowserImageCacheRuntime = {
  openCache?: (name: string) => Promise<ImageCache>
  fetcher?: typeof fetch
  createObjectUrl?: (blob: Blob) => string
}

/**
 * Resolves an immutable remote image through browser Cache Storage.
 *
 * Vite cannot extend a third-party server's short HTTP cache lifetime. Keeping
 * the response in Cache Storage means a later render or visit can create a new
 * local object URL without requesting the asset again. The cache namespace is
 * supplied by the caller and should include the upstream asset version.
 */
export function browserCachedImageUrl(
  source: string,
  cacheName: string,
  runtime: BrowserImageCacheRuntime = {},
): Promise<string> {
  const identity = `${cacheName}:${source}`
  const resolved = resolvedImages.get(identity)
  if (resolved) return Promise.resolve(resolved)
  const pending = pendingImages.get(identity)
  if (pending) return pending

  const openCache = runtime.openCache
    ?? ('caches' in globalThis ? (name: string) => globalThis.caches.open(name) : undefined)
  const fetcher = runtime.fetcher ?? globalThis.fetch
  const createObjectUrl = runtime.createObjectUrl ?? URL.createObjectURL
  if (!openCache || !fetcher || !createObjectUrl) return Promise.resolve(source)

  const request = (async () => {
    try {
      const cache = await openCache(cacheName)
      let response = await cache.match(source)
      if (!response) {
        response = await fetcher(source, { cache: 'force-cache', mode: 'cors' })
        if (!response.ok) return source
        await cache.put(source, response.clone())
      }
      const objectUrl = createObjectUrl(await response.blob())
      resolvedImages.set(identity, objectUrl)
      return objectUrl
    } catch {
      // Cache Storage can be disabled in private browsing. The immutable remote
      // URL remains a functional fallback and keeps this enhancement optional.
      return source
    } finally {
      pendingImages.delete(identity)
    }
  })()
  pendingImages.set(identity, request)
  return request
}

