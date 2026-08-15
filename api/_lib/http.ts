import type { VercelRequest, VercelResponse } from '@vercel/node'

const MAX_REQUESTS = 12
const WINDOW_MS = 60_000
const submissionWindows = new Map<string, { startedAt: number; count: number }>()

/**
 * Discovery pages through a subgraph, so it needs a looser ceiling than report
 * submission. Like the submission brake this is instance-local and resets on a
 * cold start; it bounds one instance, not the deployment.
 */
const MAX_DISCOVERY_REQUESTS = 120
const discoveryWindows = new Map<string, { startedAt: number; count: number }>()

function withinWindow(
  windows: Map<string, { startedAt: number; count: number }>,
  ip: string,
  max: number,
): boolean {
  const now = Date.now()
  const current = windows.get(ip)
  if (!current || now - current.startedAt > WINDOW_MS) {
    windows.set(ip, { startedAt: now, count: 1 })
    return true
  }
  current.count += 1
  return current.count <= max
}

export function discoveryAllowed(ip: string): boolean {
  return withinWindow(discoveryWindows, ip, MAX_DISCOVERY_REQUESTS)
}

export function allowMethods(response: VercelResponse, methods: string[]) {
  response.setHeader('Allow', methods.join(', '))
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
}

export function requestIp(request: VercelRequest): string {
  const forwarded = request.headers['x-forwarded-for']
  return (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0])?.trim() || request.socket.remoteAddress || 'unknown'
}

export function submissionAllowed(ip: string): boolean {
  const now = Date.now()
  const current = submissionWindows.get(ip)
  if (!current || now - current.startedAt > WINDOW_MS) {
    submissionWindows.set(ip, { startedAt: now, count: 1 })
    return true
  }
  current.count += 1
  return current.count <= MAX_REQUESTS
}

export function bodyBytes(request: VercelRequest): number {
  const declared = Number(request.headers['content-length'] ?? 0)
  if (Number.isFinite(declared) && declared > 0) return declared
  return Buffer.byteLength(typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? null))
}
