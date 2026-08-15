import type { SourcifyCompilationBundle } from '../../data/source'

export type SourceOutlineItem = { kind: string; name: string; line: number }

export function selectPrimarySourcePath(bundle: SourcifyCompilationBundle, fullyQualifiedName?: string) {
  const paths = Object.keys(bundle.sources).sort()
  const compilationTarget = fullyQualifiedName?.split(':')[0]
  return compilationTarget && bundle.sources[compilationTarget] ? compilationTarget : paths[0]
}

export function sourceOutline(source: string): SourceOutlineItem[] {
  const items: SourceOutlineItem[] = []
  const expression = /\b(contract|interface|library|abstract\s+contract|function|modifier|event|error)\s+([A-Za-z_$][\w$]*)/g
  for (const match of source.matchAll(expression)) {
    const offset = match.index ?? 0
    items.push({
      kind: match[1]!.replace(/\s+/g, ' '),
      name: match[2]!,
      line: source.slice(0, offset).split('\n').length,
    })
    if (items.length >= 256) break
  }
  return items
}
