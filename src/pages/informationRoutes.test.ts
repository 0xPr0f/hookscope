import { describe, expect, it } from 'vitest'
import { informationPageForPath } from './informationRoutes'

describe('informationPageForPath', () => {
  it('recognizes the two public information pages with optional trailing slashes', () => {
    expect(informationPageForPath('/how')).toBe('how')
    expect(informationPageForPath('/how/')).toBe('how')
    expect(informationPageForPath('/methodology')).toBe('methodology')
    expect(informationPageForPath('/methodology///')).toBe('methodology')
  })

  it('leaves the analyzer and unknown paths to the main application', () => {
    expect(informationPageForPath('/')).toBeUndefined()
    expect(informationPageForPath('/reports/example')).toBeUndefined()
  })
})
