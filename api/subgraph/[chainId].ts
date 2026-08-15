import type { VercelRequest, VercelResponse } from '@vercel/node'
import { isAddress } from 'viem'
import {
  GRAPH_GATEWAY_ORIGIN,
  UNISWAP_V4_SUBGRAPHS,
  subgraphQuery,
} from '../../src/config/subgraphs.js'
import { allowMethods, discoveryAllowed, requestIp } from '../_lib/http.js'

/**
 * Pool-discovery proxy that keeps the Graph Network key server-side.
 *
 * This is deliberately not a GraphQL relay. Only the single discovery query is
 * accepted, and its variables are validated, so a caller cannot use the hidden
 * key to run arbitrary queries or reach a different subgraph. The key is read
 * from `SUBGRAPH_API_KEY`, which has no `VITE_` prefix and therefore never enters
 * the browser bundle.
 */

const MAX_PAGE_SIZE = 1_000
const MAX_CURSOR_LENGTH = 80
// Finish before Vercel's 10-second function ceiling so callers receive a
// structured 504 instead of a platform-level FUNCTION_INVOCATION_FAILED page.
const UPSTREAM_TIMEOUT_MS = 8_500

function validOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const parsed = new URL(value)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value) return undefined
    return parsed.origin
  } catch {
    return undefined
  }
}

export function graphRequestOrigin(request: VercelRequest) {
  const header = request.headers.origin
  const requestOrigin = Array.isArray(header) ? header[0] : header
  return validOrigin(process.env.SUBGRAPH_REQUEST_ORIGIN) ?? validOrigin(requestOrigin)
}

function badRequest(response: VercelResponse, message: string) {
  return response.status(400).json({ error: message })
}

function validVariables(value: unknown): value is {
  token: string
  first: number
  cursor0: string
  cursor1: string
} {
  if (!value || typeof value !== 'object') return false
  const { token, first, cursor0, cursor1 } = value as Record<string, unknown>
  if (typeof token !== 'string' || !isAddress(token, { strict: false })) return false
  if (typeof first !== 'number' || !Number.isSafeInteger(first) || first < 1 || first > MAX_PAGE_SIZE) return false
  for (const cursor of [cursor0, cursor1]) {
    if (typeof cursor !== 'string' || cursor.length > MAX_CURSOR_LENGTH) return false
  }
  return true
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  allowMethods(response, ['POST'])
  if (request.method !== 'POST') return response.status(405).json({ error: 'Only POST is supported.' })

  const chainId = Number(Array.isArray(request.query.chainId) ? request.query.chainId[0] : request.query.chainId)
  const published = Number.isSafeInteger(chainId) ? UNISWAP_V4_SUBGRAPHS[chainId] : undefined
  if (!published) return response.status(404).json({ error: 'No Uniswap v4 subgraph is published for this chain.' })
  // The server picks the query for this chain's schema; the client may only echo it.
  const expectedQuery = subgraphQuery(published.schema)

  const apiKey = process.env.SUBGRAPH_API_KEY
  if (!apiKey) return response.status(503).json({ error: 'Pool discovery is not configured.' })

  if (!discoveryAllowed(requestIp(request))) {
    return response.status(429).json({ error: 'Too many discovery requests.' })
  }

  const body = typeof request.body === 'string' ? safeParse(request.body) : request.body
  if (!body || typeof body !== 'object') return badRequest(response, 'A JSON body is required.')
  const { query, variables } = body as Record<string, unknown>

  // Exact-match allowlist: this endpoint serves one query, not arbitrary GraphQL.
  if (query !== expectedQuery) return badRequest(response, 'Only the pool-discovery query is accepted.')
  if (!validVariables(variables)) return badRequest(response, 'Pool-discovery variables are invalid.')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
  try {
    const origin = graphRequestOrigin(request)
    const upstream = await fetch(`${GRAPH_GATEWAY_ORIGIN}/api/subgraphs/id/${published.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        ...(origin ? { origin } : {}),
      },
      body: JSON.stringify({ query: expectedQuery, variables }),
      signal: controller.signal,
    })
    const text = await upstream.text()
    response.setHeader('Content-Type', 'application/json')
    // Upstream status is surfaced, but its body is passed through unaltered so a
    // GraphQL error still reaches the client's existing error handling.
    return response.status(upstream.ok ? 200 : 502).send(text)
  } catch {
    return response.status(504).json({ error: 'The pool index did not respond in time.' })
  } finally {
    clearTimeout(timeout)
  }
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}
