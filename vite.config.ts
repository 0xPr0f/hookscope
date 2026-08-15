import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'

const methodologyPath = fileURLToPath(new URL('./docs/V4_HOOK_ANALYZER_ARCHITECTURE.md', import.meta.url))
const methodologyUrl = '/docs/V4_HOOK_ANALYZER_ARCHITECTURE.md'

function methodologyAsset(): Plugin {
  const serveMethodology = (request: { url?: string }, response: { setHeader(name: string, value: string): void; end(body: Buffer): void }, next: () => void) => {
    if (request.url?.split('?', 1)[0] !== methodologyUrl) return next()
    response.setHeader('Content-Type', 'text/markdown; charset=utf-8')
    response.end(readFileSync(methodologyPath))
  }
  return {
    name: 'hookscope-methodology-asset',
    configureServer(server: { middlewares: { use(handler: typeof serveMethodology): void } }) {
      server.middlewares.use(serveMethodology)
    },
    configurePreviewServer(server: { middlewares: { use(handler: typeof serveMethodology): void } }) {
      server.middlewares.use(serveMethodology)
    },
    buildStart() {
      this.emitFile({ type: 'asset', fileName: methodologyUrl.slice(1), source: readFileSync(methodologyPath) })
    },
  }
}

/**
 * Serves the pool-index proxy in dev with the same contract as the deployed
 * function, so a local run never needs a browser-visible API key. The key is
 * read from `SUBGRAPH_API_KEY` in the node process and is never exposed to the
 * client: Vite only inlines `VITE_`-prefixed variables.
 */
function subgraphProxy(apiKey: string | undefined): Plugin {
  const handler = async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const path = request.url?.split('?', 1)[0] ?? ''
    const match = /^\/api\/subgraph\/(\d+)$/.exec(path)
    if (!match || request.method !== 'POST') return next()

    const { UNISWAP_V4_SUBGRAPHS, GRAPH_GATEWAY_ORIGIN, subgraphQuery } = await import('./src/config/subgraphs')
    const published = UNISWAP_V4_SUBGRAPHS[Number(match[1])]
    const send = (status: number, body: unknown) => {
      response.statusCode = status
      response.setHeader('content-type', 'application/json')
      response.end(typeof body === 'string' ? body : JSON.stringify(body))
    }
    if (!published) return send(404, { error: 'No Uniswap v4 subgraph is published for this chain.' })
    if (!apiKey) return send(503, { error: 'Pool discovery is not configured. Set SUBGRAPH_API_KEY.' })

    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { query?: string; variables?: unknown }
    const expected = subgraphQuery(published.schema)
    if (body.query !== expected) return send(400, { error: 'Only the pool-discovery query is accepted.' })

    const upstream = await fetch(`${GRAPH_GATEWAY_ORIGIN}/api/subgraphs/id/${published.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query: expected, variables: body.variables }),
    })
    send(upstream.ok ? 200 : 502, await upstream.text())
  }
  return {
    name: 'hookscope-subgraph-proxy',
    configureServer(server) { server.middlewares.use(handler) },
    configurePreviewServer(server) { server.middlewares.use(handler) },
  }
}

export default defineConfig(({ mode }) => {
  // Vite exposes prefixed values through import.meta.env, but it deliberately
  // does not merge server-only values from .env into process.env. Load the
  // complete environment here so the local proxy sees the same server-side key
  // that Vercel injects into the production function.
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [methodologyAsset(), subgraphProxy(env.SUBGRAPH_API_KEY), react()],
    // EVMole's wasm-bindgen entrypoint resolves its binary relative to
    // import.meta.url. Prebundling relocates that module without its .wasm file.
    optimizeDeps: { exclude: ['evmole'] },
    worker: { format: 'es' },
    build: {
      target: 'es2022',
      sourcemap: true,
      rollupOptions: {
        output: {
          manualChunks: {
            'evm-static': ['@shazow/whatsabi'],
            'web3-core': ['viem'],
          },
        },
      },
    },
  }
})
