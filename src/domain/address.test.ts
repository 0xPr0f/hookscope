import { describe, expect, it } from 'vitest'
import { InvalidTokenAddressError, parseTokenAddress } from './address'

describe('parseTokenAddress', () => {
  it('normalizes a valid address', () => {
    expect(parseTokenAddress('0x000000000000000000000000000000000000dead')).toBe(
      '0x000000000000000000000000000000000000dEaD',
    )
  })

  it('rejects the supplied 41-hex-digit address before any RPC work', () => {
    expect(() => parseTokenAddress('0xD0a606aDf58b69a28D479aAA510CE6FE96E0a1eb2')).toThrow(
      InvalidTokenAddressError,
    )
  })
})
