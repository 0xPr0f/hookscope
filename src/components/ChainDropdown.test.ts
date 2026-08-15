import { describe, expect, it } from 'vitest'
import { CHAINS } from '../config/chains'
import { selectableChains } from './chainSelection'

describe('chain dropdown availability', () => {
  it('omits every chain whose execution capability is disabled', () => {
    const visible = selectableChains(CHAINS)
    expect(visible.length).toBeGreaterThan(0)
    expect(visible.every((chain) => chain.deepExecution)).toBe(true)
    expect(visible.map((chain) => chain.name)).toEqual(['Ethereum', 'Unichain', 'Base', 'Optimism', 'X Layer'])
    expect(visible.some((chain) => chain.name === 'Arbitrum')).toBe(false)
  })
})
