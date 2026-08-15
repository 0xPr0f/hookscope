import { describe, expect, it } from 'vitest'
import {
  clampSourceSidebarWidth,
  SOURCE_SIDEBAR_DEFAULT_WIDTH,
  SOURCE_SIDEBAR_MAX_WIDTH,
  SOURCE_SIDEBAR_MIN_WIDTH,
  sourceSidebarMaxWidth,
} from './sourcePaneSize'

describe('source explorer pane sizing', () => {
  it('keeps the explorer inside its absolute bounds', () => {
    expect(clampSourceSidebarWidth(20)).toBe(SOURCE_SIDEBAR_MIN_WIDTH)
    expect(clampSourceSidebarWidth(SOURCE_SIDEBAR_DEFAULT_WIDTH)).toBe(SOURCE_SIDEBAR_DEFAULT_WIDTH)
    expect(clampSourceSidebarWidth(900)).toBe(SOURCE_SIDEBAR_MAX_WIDTH)
  })

  it('reserves room for the editor in narrower containers', () => {
    expect(sourceSidebarMaxWidth(700)).toBe(380)
    expect(clampSourceSidebarWidth(480, 700)).toBe(380)
    expect(clampSourceSidebarWidth(480, 480)).toBe(SOURCE_SIDEBAR_MIN_WIDTH)
  })
})
