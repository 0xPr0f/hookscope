import { Fragment, type ReactNode } from 'react'
import type { Address, Hex } from 'viem'
import {
  resolveSelectorSignature,
  type SelectorSignatureLookup,
} from '../../domain/selectors'

const EMBEDDED_SELECTOR = /0x[0-9a-fA-F]{8}(?![0-9a-fA-F])/g

function sourceLabel(source: string | undefined) {
  if (source === 'verified-contract-abi') return 'exact verified ABI'
  if (source === 'canonical-interface') return 'canonical interface'
  return 'Sourcify 4byte candidate'
}

export function SelectorInline({
  selector,
  lookup,
  subject,
  compact = false,
}: {
  selector: string
  lookup?: SelectorSignatureLookup
  subject?: Address
  compact?: boolean
}) {
  const resolved = resolveSelectorSignature(lookup, selector, subject)
  if (!resolved?.candidate) return <code className="selector-raw">{selector}</code>
  const source = sourceLabel(resolved.candidate.source)
  const title = `${source}${resolved.ambiguous ? ` · ${resolved.candidates.length} distinct signature candidates share this selector` : ''}`
  return (
    <span className={`selector-inline${compact ? ' selector-inline-compact' : ''}`} title={title}>
      <strong>{resolved.candidate.name}</strong>
      <code>{resolved.selector}</code>
      {!compact && <small>{source}{resolved.ambiguous ? ` · ${resolved.candidates.length} candidates` : ''}</small>}
    </span>
  )
}

export function SelectorAwareText({
  children,
  lookup,
  subject,
}: {
  children: string
  lookup?: SelectorSignatureLookup
  subject?: Address
}) {
  const matches = [...children.matchAll(EMBEDDED_SELECTOR)]
  if (!matches.length) return <>{children}</>
  const parts: ReactNode[] = []
  let cursor = 0
  matches.forEach((match, index) => {
    const start = match.index ?? 0
    if (start > cursor) parts.push(children.slice(cursor, start))
    const resolved = resolveSelectorSignature(lookup, match[0], subject)
    const nearbyText = children.slice(Math.max(0, start - 96), start)
    parts.push(resolved?.candidate && nearbyText.includes(resolved.candidate.name)
      ? <code className="selector-raw" key={`${match[0]}:${start}:${index}`}>{match[0]}</code>
      : (
          <SelectorInline
            compact
            key={`${match[0]}:${start}:${index}`}
            selector={match[0]}
            lookup={lookup}
            subject={subject}
          />
        ))
    cursor = start + match[0].length
  })
  if (cursor < children.length) parts.push(children.slice(cursor))
  return <>{parts.map((part, index) => <Fragment key={index}>{part}</Fragment>)}</>
}

export function SelectorCatalogList({
  selectors,
  lookup,
  subject,
}: {
  selectors: readonly Hex[]
  lookup?: SelectorSignatureLookup
  subject?: Address
}) {
  if (!selectors.length) return null
  return (
    <div className="selector-catalog-list">
      {selectors.map((selector) => (
        <SelectorInline key={selector} selector={selector} lookup={lookup} subject={subject} />
      ))}
    </div>
  )
}
