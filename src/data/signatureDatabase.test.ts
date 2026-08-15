import { describe, expect, it, vi } from 'vitest'
import type { Hex } from 'viem'
import { fetchSourcify4ByteSignatures } from './signatureDatabase'

describe('Sourcify 4byte signature lookup', () => {
  it('batches selectors, filters junk, and prefers candidates found in verified ABIs', async () => {
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input))
      expect(url.origin).toBe('https://api.4byte.sourcify.dev')
      expect(url.searchParams.get('function')).toBe('0x007074c3,0xdeadbeef')
      expect(url.searchParams.get('filter')).toBe('true')
      return new Response(JSON.stringify({
        ok: true,
        result: {
          function: {
            '0x007074c3': [
              { name: 'noise()', filtered: true, hasVerifiedContract: false },
              { name: 'LiquidityFrozen()', filtered: false, hasVerifiedContract: true },
            ],
            '0xdeadbeef': null,
          },
          event: {},
        },
      }))
    }) as typeof fetch

    const result = await fetchSourcify4ByteSignatures(
      ['0x007074c3', '0xdeadbeef'] as Hex[],
      undefined,
      fetcher,
    )

    expect(result['0x007074c3']).toEqual([{
      name: 'LiquidityFrozen()',
      source: 'sourcify-4byte',
      hasVerifiedContract: true,
    }])
    expect(result['0xdeadbeef']).toEqual([])
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('reuses cached selector results without another request', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch
    const result = await fetchSourcify4ByteSignatures(['0x007074c3'] as Hex[], undefined, fetcher)
    expect(result['0x007074c3']?.[0]?.name).toBe('LiquidityFrozen()')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
