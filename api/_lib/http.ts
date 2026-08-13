import type { VercelRequest, VercelResponse } from '@vercel/node'

const MAX_REQUESTS = 12
const WINDOW_MS = 60_000
const submissionWindows = new Map<string, { startedAt: number; count: number }>()

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
