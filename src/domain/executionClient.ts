export type ExecutionClientSignals = {
  narrowViewport: boolean
  coarsePointer: boolean
  touchPoints: number
  userAgentMobile?: boolean
}

/**
 * Mobile v1 intentionally uses the static-only tier, but a narrow desktop
 * window is not a mobile device. Requiring a mobile UA hint or touch/coarse
 * input keeps browser sidebars and split-screen desktop windows eligible for
 * deep execution.
 */
export function usesStaticOnlyMobileTier(signals: ExecutionClientSignals) {
  if (signals.userAgentMobile === true) return true
  return signals.narrowViewport && signals.coarsePointer && signals.touchPoints > 0
}

export function currentClientUsesStaticOnlyMobileTier() {
  const navigatorWithHints = window.navigator as Navigator & {
    userAgentData?: { mobile?: boolean }
  }
  return usesStaticOnlyMobileTier({
    narrowViewport: window.matchMedia('(max-width: 720px)').matches,
    coarsePointer: window.matchMedia('(pointer: coarse)').matches,
    touchPoints: navigatorWithHints.maxTouchPoints ?? 0,
    userAgentMobile: navigatorWithHints.userAgentData?.mobile,
  })
}
