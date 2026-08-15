import { describe, expect, it } from 'vitest'
import { InvalidTokenAddressError, parseTokenAddress } from './address'

const malformedAddress = `0x${'a'.repeat(41)}`

describe('parseTokenAddress', () => {
  it('normalizes a valid address', () => {
    expect(parseTokenAddress('0x000000000000000000000000000000000000dead')).toBe(
      '0x000000000000000000000000000000000000dEaD',
    )
  })

  it('rejects a 41-hex-digit address before any RPC work', () => {
    expect(() => parseTokenAddress(malformedAddress)).toThrow(InvalidTokenAddressError)
  })
})
