export type AppTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'hookscope.theme.v1'

type ThemeStorage = Pick<Storage, 'getItem' | 'setItem'>

export function isAppTheme(value: unknown): value is AppTheme {
  return value === 'light' || value === 'dark'
}

export function loadThemePreference(storage?: ThemeStorage): AppTheme | undefined {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY)
    return isAppTheme(value) ? value : undefined
  } catch {
    return undefined
  }
}

export function saveThemePreference(theme: AppTheme, storage?: ThemeStorage): boolean {
  try {
    storage?.setItem(THEME_STORAGE_KEY, theme)
    return Boolean(storage)
  } catch {
    return false
  }
}

export function initialTheme(): AppTheme {
  if (typeof document !== 'undefined' && isAppTheme(document.documentElement.dataset.theme)) {
    return document.documentElement.dataset.theme
  }
  const stored = typeof window === 'undefined' ? undefined : loadThemePreference(window.localStorage)
  if (stored) return stored
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

export function applyTheme(theme: AppTheme, root: HTMLElement = document.documentElement) {
  root.dataset.theme = theme
  root.style.colorScheme = theme
  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (themeColor) themeColor.content = theme === 'dark' ? '#11120f' : '#ffffff'
}
