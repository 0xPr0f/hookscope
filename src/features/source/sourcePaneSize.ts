export const SOURCE_SIDEBAR_MIN_WIDTH = 180
export const SOURCE_SIDEBAR_DEFAULT_WIDTH = 250
export const SOURCE_SIDEBAR_MAX_WIDTH = 480
export const SOURCE_EDITOR_MIN_WIDTH = 320

export function sourceSidebarMaxWidth(containerWidth?: number) {
  if (!containerWidth || !Number.isFinite(containerWidth)) return SOURCE_SIDEBAR_MAX_WIDTH
  return Math.max(
    SOURCE_SIDEBAR_MIN_WIDTH,
    Math.min(SOURCE_SIDEBAR_MAX_WIDTH, Math.floor(containerWidth) - SOURCE_EDITOR_MIN_WIDTH),
  )
}

export function clampSourceSidebarWidth(width: number, containerWidth?: number) {
  return Math.min(
    sourceSidebarMaxWidth(containerWidth),
    Math.max(SOURCE_SIDEBAR_MIN_WIDTH, Math.round(width)),
  )
}
