import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
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

export default defineConfig({
  plugins: [methodologyAsset(), react()],
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
          'evm-static': ['@shazow/whatsabi', 'sevm'],
          'web3-core': ['viem'],
        },
      },
    },
  },
})
