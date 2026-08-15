import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Serves the pool-index proxy in dev with the same contract as the deployed
 * function, so a local run never needs a browser-visible API key. The key is
 * read from `SUBGRAPH_API_KEY` in the node process and is never exposed to the
 * client: Vite only inlines `VITE_`-prefixed variables.
 */
function subgraphProxy(apiKey: string | undefined, requestOrigin: string | undefined): Plugin {
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
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        ...(requestOrigin ? { origin: requestOrigin } : {}),
      },
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
    plugins: [subgraphProxy(
      env.SUBGRAPH_API_KEY,
      env.SUBGRAPH_REQUEST_ORIGIN || 'https://hook.centaurion.xyz',
    ), react()],
    // Keep every eagerly and lazily loaded feature on the same React module
    // instance. This matters for the source workspace because CodeMirror is
    // loaded in a separate chunk and declares React as a peer dependency.
    resolve: {
      dedupe: ['react', 'react-dom'],
    },
    // Use one explicit development endpoint for HTTP and HMR. Without a fixed
    // port Vite can move the HTTP server while the browser keeps reconnecting
    // its WebSocket to 5173, leaving lazy chunks attached to a stale optimizer
    // graph.
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      hmr: {
        host: 'localhost',
        clientPort: 5173,
        protocol: 'ws',
      },
    },
    // The source workspace is lazy-loaded, so its editor dependencies are not
    // guaranteed to be discovered during Vite's initial static crawl. Bundle
    // them up front to avoid a mid-session optimizer reload when Contracts is
    // opened for the first time. EVMole must stay outside the optimizer because
    // its wasm-bindgen entrypoint resolves the binary relative to import.meta.url.
    optimizeDeps: {
      include: ['@uiw/react-codemirror', '@replit/codemirror-lang-solidity'],
      exclude: ['evmole'],
    },
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
