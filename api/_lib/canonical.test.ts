import { describe, expect, it } from 'vitest'
import { canonicalJson, canonicalReportHash } from './canonical'

describe('canonical report identity', () => {
  it('is independent of object insertion order and claimed hashes', () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}')
    expect(canonicalReportHash({ a: 1, b: 2 })).toBe(canonicalReportHash({ b: 2, reportHash: 'invented', a: 1 }))
  })
})
