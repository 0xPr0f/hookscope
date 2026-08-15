import { collectSelectorsFromValue } from '../../analysis/selectorCatalog'
import {
  resolveSelectorSignature,
  selectorDisplayText,
  type SelectorSignatureLookup,
} from '../../domain/selectors'

export function selectorsForDisplay(value: unknown, lookup?: SelectorSignatureLookup) {
  return collectSelectorsFromValue(value).map((selector) => ({
    selector,
    resolved: resolveSelectorSignature(lookup, selector),
  }))
}

export function selectorAwareJson(value: unknown, lookup?: SelectorSignatureLookup) {
  const mapped = (item: unknown): unknown => {
    if (typeof item === 'string' && /^0x[0-9a-fA-F]{8}$/.test(item)) {
      return selectorDisplayText(lookup, item)
    }
    if (Array.isArray(item)) return item.map(mapped)
    if (!item || typeof item !== 'object') return item
    return Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([key, child]) => [key, mapped(child)]))
  }
  return JSON.stringify(mapped(value), null, 2)
}
