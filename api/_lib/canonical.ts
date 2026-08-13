import { createHash } from 'node:crypto'

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    )
  }
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

export function canonicalReportHash(report: Record<string, unknown>): `0x${string}` {
  const identity = { ...report }
  delete identity.reportHash
  return `0x${createHash('sha256').update(canonicalJson(identity)).digest('hex')}`
}
