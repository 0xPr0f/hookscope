import type { Address, Hex } from 'viem'

export type SelectorSignatureSource =
  | 'verified-contract-abi'
  | 'canonical-interface'
  | 'sourcify-4byte'

export type SelectorSignatureCandidate = {
  /** Canonical ABI signature, for example `transfer(address,uint256)`. */
  name: string
  source?: SelectorSignatureSource
  /** True when Sourcify has observed this signature in a verified contract. */
  hasVerifiedContract: boolean
  /** Contracts whose exact verified ABI contains this signature. */
  subjects?: Address[]
}

export type SelectorSignatureLookup = Readonly<
  Record<string, readonly SelectorSignatureCandidate[]>
>

export type ResolvedSelector = {
  selector: Hex
  candidate?: SelectorSignatureCandidate
  candidates: readonly SelectorSignatureCandidate[]
  ambiguous: boolean
}

const SELECTOR_PATTERN = /^0x[0-9a-fA-F]{8}$/

export function normalizeFunctionSelector(value: string): Hex | undefined {
  const normalized = value.toLowerCase()
  return SELECTOR_PATTERN.test(normalized) ? normalized as Hex : undefined
}

function sameAddress(left: Address, right: Address) {
  return left.toLowerCase() === right.toLowerCase()
}

/**
 * Selects the strongest available label without pretending a four-byte match
 * proves an ABI. An exact ABI scoped to the call target wins, followed by a
 * canonical protocol interface, then Sourcify's global candidate ordering.
 */
export function resolveSelectorSignature(
  lookup: SelectorSignatureLookup | undefined,
  selectorInput: string,
  subject?: Address,
): ResolvedSelector | undefined {
  const selector = normalizeFunctionSelector(selectorInput)
  if (!selector) return undefined
  const candidates = lookup?.[selector] ?? []
  const subjectCandidate = subject
    ? candidates.find((candidate) => candidate.source === 'verified-contract-abi'
      && candidate.subjects?.some((address) => sameAddress(address, subject)))
    : undefined
  const candidate = subjectCandidate
    ?? candidates.find((item) => item.source === 'canonical-interface')
    ?? candidates.find((item) => item.source === 'verified-contract-abi')
    ?? candidates[0]
  return {
    selector,
    candidate,
    candidates,
    ambiguous: candidates.some((item) => item.name !== candidate?.name),
  }
}

export function selectorDisplayText(
  lookup: SelectorSignatureLookup | undefined,
  selector: string,
  subject?: Address,
) {
  const resolved = resolveSelectorSignature(lookup, selector, subject)
  if (!resolved?.candidate) return selector
  return `${resolved.candidate.name} (${resolved.selector})`
}
