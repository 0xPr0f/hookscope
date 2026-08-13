import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const productCopy = [
  readFileSync(new URL('../../README.md', import.meta.url), 'utf8'),
  readFileSync(new URL('../analysis/staticEngine.ts', import.meta.url), 'utf8'),
].join('\n')

describe('product purpose', () => {
  it('states the DeFi execution-transparency purpose', () => {
    expect(productCopy).toContain('DeFi execution transparency')
    expect(productCopy).toContain('pool callbacks')
    expect(productCopy).toContain('tested execution outcomes')
  })
})
