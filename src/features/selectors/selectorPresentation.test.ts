import { describe, expect, it } from 'vitest'
import type { SelectorSignatureLookup } from '../../domain/selectors'
import { selectorAwareJson, selectorsForDisplay } from './selectorPresentation'

const lookup: SelectorSignatureLookup = {
  '0x007074c3': [{
    name: 'LiquidityFrozen()',
    source: 'sourcify-4byte',
    hasVerifiedContract: true,
  }],
}

describe('selector presentation mapping', () => {
  it('labels exact selector values without mutating calldata or unrelated hashes', () => {
    const value = {
      selector: '0x007074c3',
      calldata: '0x007074c300000000',
      hash: `0x${'00'.repeat(32)}`,
    }
    expect(selectorAwareJson(value, lookup)).toContain('LiquidityFrozen() (0x007074c3)')
    expect(selectorAwareJson(value, lookup)).toContain('0x007074c300000000')
    expect(selectorsForDisplay(value, lookup).map((item) => item.selector)).toContain('0x007074c3')
  })
})
