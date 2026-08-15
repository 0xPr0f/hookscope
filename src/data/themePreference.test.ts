import { describe, expect, it, vi } from 'vitest'
import {
  loadThemePreference,
  saveThemePreference,
  THEME_STORAGE_KEY,
} from './themePreference'

describe('theme preference persistence', () => {
  it('loads only supported saved values', () => {
    expect(loadThemePreference({ getItem: () => 'dark', setItem: vi.fn() })).toBe('dark')
    expect(loadThemePreference({ getItem: () => 'light', setItem: vi.fn() })).toBe('light')
    expect(loadThemePreference({ getItem: () => 'system', setItem: vi.fn() })).toBeUndefined()
  })

  it('writes the versioned preference key', () => {
    const setItem = vi.fn()
    expect(saveThemePreference('dark', { getItem: vi.fn(), setItem })).toBe(true)
    expect(setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, 'dark')
  })

  it('degrades when browser storage is unavailable', () => {
    const unavailable = {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
    }
    expect(loadThemePreference(unavailable)).toBeUndefined()
    expect(saveThemePreference('light', unavailable)).toBe(false)
  })
})
