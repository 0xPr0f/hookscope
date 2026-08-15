import { describe, expect, it, vi } from 'vitest'
import { browserCachedImageUrl } from './browserImageCache'

describe('browser image cache', () => {
  it('stores a missing immutable asset and reuses its in-flight resolution', async () => {
    const source = 'https://assets.example.test/base.png'
    const response = new Response(new Blob(['base-logo'], { type: 'image/png' }))
    const match = vi.fn(async () => undefined)
    const put = vi.fn(async () => undefined)
    const fetcher = vi.fn(async () => response)
    const openCache = vi.fn(async () => ({ match, put }))
    const createObjectUrl = vi.fn(() => 'blob:base-logo')
    const runtime = { openCache, fetcher: fetcher as typeof fetch, createObjectUrl }

    const first = browserCachedImageUrl(source, 'logos-test-write', runtime)
    const second = browserCachedImageUrl(source, 'logos-test-write', runtime)

    await expect(first).resolves.toBe('blob:base-logo')
    await expect(second).resolves.toBe('blob:base-logo')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(put).toHaveBeenCalledTimes(1)
  })

  it('reads an existing Cache Storage response without a network request', async () => {
    const source = 'https://assets.example.test/ethereum.png'
    const cached = new Response(new Blob(['ethereum-logo'], { type: 'image/png' }))
    const fetcher = vi.fn()

    await expect(browserCachedImageUrl(source, 'logos-test-read', {
      openCache: async () => ({ match: async () => cached, put: vi.fn() }),
      fetcher: fetcher as typeof fetch,
      createObjectUrl: () => 'blob:ethereum-logo',
    })).resolves.toBe('blob:ethereum-logo')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('falls back to the remote URL when Cache Storage is unavailable', async () => {
    const source = 'https://assets.example.test/unichain.png'
    await expect(browserCachedImageUrl(source, 'logos-test-fallback', {
      openCache: async () => { throw new Error('cache disabled') },
    })).resolves.toBe(source)
  })
})

