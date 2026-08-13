import { describe, expect, it } from 'vitest'
import { decodeHookPermissions } from './hooks'

describe('decodeHookPermissions', () => {
  it('decodes the afterSwap bit from a hook address suffix', () => {
    expect(decodeHookPermissions('0x0000000000000000000000000000000000000040')).toEqual(['afterSwap'])
  })
})
