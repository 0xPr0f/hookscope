import { describe, expect, it } from 'vitest'
import { usesStaticOnlyMobileTier } from './executionClient'

describe('browser execution tier selection', () => {
  it('keeps a narrow desktop window eligible for deep execution', () => {
    expect(usesStaticOnlyMobileTier({ narrowViewport: true, coarsePointer: false, touchPoints: 0 })).toBe(false)
  })

  it('uses the static-only tier for a narrow touch-first mobile client', () => {
    expect(usesStaticOnlyMobileTier({ narrowViewport: true, coarsePointer: true, touchPoints: 5 })).toBe(true)
  })

  it('honors an explicit browser mobile hint independently of layout width', () => {
    expect(usesStaticOnlyMobileTier({
      narrowViewport: false,
      coarsePointer: false,
      touchPoints: 0,
      userAgentMobile: true,
    })).toBe(true)
  })
})
