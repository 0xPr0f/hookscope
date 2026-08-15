import { describe, expect, it } from 'vitest'
import { DYNAMIC_FEE_FLAG, formatPoolFee } from './poolFee'

describe('formatPoolFee', () => {
  it('formats fixed pool fees as percentages', () => {
    expect(formatPoolFee(500)).toBe('0.05%')
    expect(formatPoolFee(3_000)).toBe('0.3%')
    expect(formatPoolFee(10_000)).toBe('1%')
  })

  it('labels the Uniswap v4 dynamic-fee marker without treating it as a fee', () => {
    expect(formatPoolFee(DYNAMIC_FEE_FLAG)).toBe('Dynamic')
  })
})
