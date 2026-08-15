# Hookscope

Browser-native Uniswap v4 hook behavior and DeFi execution transparency. Hookscope explains pool callbacks, control mechanics, value movement, and tested execution outcomes with explicit evidence and coverage. See [the living architecture and implementation ledger](./docs/V4_HOOK_ANALYZER_ARCHITECTURE.md).

## Local development

```bash
pnpm install
pnpm dev
```

Use **Load deterministic example** to exercise the real WhatsABI/sevm/EVMole static worker, the 40-scenario/80-transaction Hacken browser port through an official PoolManager fixture, revm Wasm execution, and a bounded 30,000-input state-outcome fixture without making an RPC request. The added paired fixtures cover alternate hookData, non-zero return-delta settlement, primary/secondary PoolIds, and open/restricted caller and router policies.

The analyzer works without a database. `DATABASE_URL` belongs only to the optional Vercel report-storage functions; it must never use a `VITE_` prefix or appear in the browser bundle. Railway runs PostgreSQL only—there is no analysis server.

Public pool discovery is index-first. Published Uniswap v4 subgraph IDs are not
secrets, so they live in [`src/config/chains.ts`](./src/config/chains.ts); one
server-side Graph Network key serves every chain through the same-origin proxy:

```bash
SUBGRAPH_API_KEY='your-graph-key'
```

The key is read only by `/api/subgraph/<chainId>` and is never compiled into the
browser bundle. Set `VITE_V4_SUBGRAPH_<chainId>` only to point a chain at a
credential-free private or self-hosted indexer.

Discovery treats index results as candidates only: Hookscope recomputes every
PoolId, validates initialized PoolManager state at the pinned block, and scans
only the recent log tail. A stale index can therefore withhold pools, but cannot
introduce one. Without a configured index, discovery falls back to bounded log
scanning — public endpoints cap `eth_getLogs` at 10,000 blocks, so covering v4
history from its deployment block needs roughly 400 sequential requests, which
is why the index path exists.

See [`.env.example`](./.env.example) for the environment boundary and [the Vercel/Railway deployment runbook](./docs/DEPLOYMENT.md) for migrations, least-privilege roles, preview/production releases, health checks, limits, and rollback. Unrestricted API credentials must not be placed in `VITE_` variables.

## Verification

```bash
pnpm test
pnpm test:rust
pnpm wasm:build
pnpm build
pnpm test:e2e
node scripts/validate-deployment.mjs
```

`pnpm verify` runs lint, the browser and tooling suites, both Rust feature configurations, the Foundry oracle, and the production build. The Wasm artifacts under `src/wasm/` are generated and untracked, so a fresh clone needs Rust 1.88 and `wasm-pack` before `pnpm build`.

The Playwright suite is configured for Chromium, Firefox, and WebKit in CI. Local interactive acceptance was also completed through the in-app browser at desktop and 390 px responsive widths.

The optional read-only live canary is explicit because it depends on configured public archive/index availability:

```bash
LIVE_CANARY=1 pnpm exec playwright test tests/e2e/live-canary.spec.ts --project=chromium
```

It never persists a failed or timed-out run. Verified index-first discovery is implemented; the Ethereum canary remains gated until `SUBGRAPH_API_KEY` or a credential-free `VITE_V4_SUBGRAPH_1` is configured and canaried in the deployment.

The literal address `0xD0a606aDf58b69a28D479aAA510CE6FE96E0a1eb2` is intentionally covered by validation tests and must fail before RPC access.
