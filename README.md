# Hookscope

Browser-native Uniswap v4 hook behavior and DeFi execution transparency. Hookscope explains pool callbacks, control mechanics, value movement, and tested execution outcomes with explicit evidence and coverage. See [the living architecture and implementation ledger](./docs/V4_HOOK_ANALYZER_ARCHITECTURE.md).

## Local development

```bash
pnpm install
pnpm dev
```

Use **Load deterministic example** to exercise the real WhatsABI/sevm/EVMole static worker, the 40-scenario/80-transaction Hacken browser port through an official PoolManager fixture, revm Wasm execution, and a bounded 30,000-input state-outcome fixture without making an RPC request. The added paired fixtures cover alternate hookData, non-zero return-delta settlement, primary/secondary PoolIds, and open/restricted caller and router policies.

The analyzer works without a database. `DATABASE_URL` belongs only to the optional Vercel report-storage functions; it must never use a `VITE_` prefix or appear in the browser bundle. Railway runs PostgreSQL only—there is no analysis server.

Public pool discovery is index-first. Configure either a token-sharded static index or a v4 subgraph per chain; Hookscope recomputes every PoolId, validates initialized PoolManager state at the pinned block, and scans only the recent log tail:

```bash
VITE_V4_POOL_INDEX_1='https://cdn.example.com/uniswap-v4/v1/{chainId}/{token}.json'
# or
VITE_V4_SUBGRAPH_1='https://your-domain-restricted-v4-subgraph-endpoint'
```

See [`.env.example`](./.env.example) for the environment boundary and [the Vercel/Railway deployment runbook](./docs/DEPLOYMENT.md) for migrations, least-privilege roles, preview/production releases, health checks, limits, and rollback. Unrestricted API credentials must not be placed in `VITE_` variables.

## Verification

```bash
pnpm test
pnpm wasm:build
pnpm build
pnpm test:e2e
node scripts/validate-deployment.mjs
```

The Playwright suite is configured for Chromium, Firefox, and WebKit in CI. Local interactive acceptance was also completed through the in-app browser at desktop and 390 px responsive widths.

The optional read-only live canary is explicit because it depends on configured public archive/index availability:

```bash
LIVE_CANARY=1 pnpm exec playwright test tests/e2e/live-canary.spec.ts --project=chromium
```

It never persists a failed or timed-out run. Verified index-first discovery is implemented; the Ethereum canary remains gated until `VITE_V4_POOL_INDEX_1` or `VITE_V4_SUBGRAPH_1` is configured and canaried in the deployment.

The literal address `0xD0a606aDf58b69a28D479aAA510CE6FE96E0a1eb2` is intentionally covered by validation tests and must fail before RPC access.
