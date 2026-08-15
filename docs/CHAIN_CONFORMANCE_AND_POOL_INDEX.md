# Chain conformance and pool-index tooling

These commands exercise only read paths. They do not hold a wallet, sign data,
call state-changing contract methods, or send transactions. Configured endpoint
URLs are never included in command output.

## Capability canary

Run one chain or the full registry:

```bash
pnpm canary:chains -- --chain ethereum
pnpm canary:chains -- --chain all --allow-degraded
```

The JSON result gives every check one of three explicit outcomes:

- `passed`: the requested read completed and its identity/invariant matched;
- `degraded`: the capability was attempted but its read or invariant did not pass;
- `unsupported`: the registry or command configuration does not enable it.

The per-chain checks cover registry identity, RPC chain identity and confirmed
head, deployed bytecode at the confirmed block, historical bytecode at the
configured deployment block, optional pool discovery, and a bounded onchain
state sample for as many as 16 indexed candidates. An unsupported
optional pool-discovery source does not erase passed RPC/deployment checks.

Use `--require` when a CI lane needs a particular capability to pass:

```bash
pnpm canary:chains -- \
  --chain ethereum \
  --token ethereum=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 \
  --require registry \
  --require rpcRead \
  --require deploymentState \
  --require historicalState \
  --require poolDiscovery
```

The command exits non-zero for a degraded result or an unmet required
capability. `--allow-degraded` is intended for observational scheduled runs; it
does not override `--require`.

Server-side overrides use these environment variables:

```text
HOOKSCOPE_RPC_<chainId>
HOOKSCOPE_CANARY_TOKEN_<chainId>
HOOKSCOPE_POOL_INDEX_<chainId>
HOOKSCOPE_SUBGRAPH_<chainId>
```

Do not put credential-bearing endpoint values in tracked files. The `VITE_*`
index variables are also recognized for parity with deployment configuration,
but `HOOKSCOPE_RPC_*` is deliberately separate from browser-exposed RPC values.

## Generate a versioned pool index

Generation reads confirmed `Initialize` logs from the configured deployment
block through the chain's confirmation-depth head. It validates every decoded
PoolId, adapts its log range down when a provider rejects a large range, and
writes token-sharded schema-v1 documents plus a checksummed manifest:

```bash
HOOKSCOPE_RPC_1='<server-side endpoint>' pnpm pool-index:generate -- \
  --chain ethereum \
  --output ./generated-pool-index
```

The layout is stable and directly matches the browser URL template:

```text
generated-pool-index/
  v1/
    1/
      manifest.json
      0x<lowercase-token>.json
```

Configure the published documents with a URL such as:

```text
VITE_V4_POOL_INDEX_1=https://YOUR_CDN_HOST/pool-index/v1/{chainId}/{token}.json
```

`YOUR_CDN_HOST` is illustrative. This repository provides the generator and
validator but does not publish a production index. Do not configure the browser
with an index URL until the generated directory is hosted and its canary passes.

Documents omit wall-clock metadata so identical chain data produces identical
bytes and manifest checksums. `indexedThroughBlock` plus the pinned block hash
identify the versioned snapshot boundary. Re-running the same range is
deterministic; advancing the confirmed head produces the next snapshot.

Useful bounds are `--chunk-size`, `--minimum-chunk`, `--max-requests`, and
`--to-block`. `--dry-run` decodes, builds, and validates without writing files.
The command refuses a `to-block` above the current confirmed head. If
`--from-block` is supplied, it must equal the registry deployment block: a
partial historical range cannot safely claim to be a complete static index.

## Validate generated or supplied indexes

Validation is offline and makes no network requests:

```bash
pnpm pool-index:validate -- \
  --input ./generated-pool-index/v1/1 \
  --chain ethereum
```

It validates registry identity, schema version, token identity, PoolId
reconstruction, initialization bounds, replay-reference bounds, duplicate
records, manifest references, and SHA-256 document checksums. A document using
an unknown schema or unregistered chain reports `unsupported`; malformed or
inconsistent data reports `degraded`.

## Measured canary results — 2026-08-14

Executed with `pnpm canary:chains -- --chain all --allow-degraded` against the
registry's public RPC candidates. No credentials, no transactions.

| Outcome | Chains |
|---|---|
| `passed` (16) | Ethereum, Unichain, Base, Optimism, Blast, World Chain, Avalanche, Celo, Zora, Ink, Soneium, Linea, MegaETH, Tempo, X Layer, zkSync `rpcRead` only |
| `degraded` — public RPC serves no archive state at the deployment block (5) | Arbitrum (`missing trie node`), Polygon (`historical state is not available`), BNB Chain (`HTTP 403`), Monad (`Block requested not found`), Robinhood Chain (no RPC candidate passed chain identity) |
| `unsupported` (1) | zkSync — no verified PoolManager deployment is published |

Every chain passed `registry`, and every chain with a reachable endpoint passed
`deploymentState`. `poolDiscovery` and `indexedPoolState` report `unsupported`
throughout because no canary token or index URL is configured; both are operator
configuration rather than chain capability.

The run found and fixed one registry defect: Celo's `deploymentBlock` was
`43985160`, three blocks before the PoolManager actually had code. A binary
search over `eth_getCode` established `43985163` as the first block with code,
and Celo now passes `historicalState`.

The five archive degradations are a property of the free public endpoints, not
of the chains. Deep execution on them needs a credentialed archive endpoint
supplied through `HOOKSCOPE_RPC_<chainId>`; the canary reports the limitation
rather than silently scanning from an unreadable block.

## Pool-index coverage — verified 2026-08-14

Published v4 subgraphs were enumerated from The Graph's network subgraph and each
candidate was then queried live with the exact discovery query, using a token
taken from the subgraph itself. Eight chains answered with a synced head and no
indexing errors:

| Chain | Subgraph | Schema |
|---|---|---|
| Ethereum (1) | `uniswap-v4-ethereum` | pool-entities |
| Optimism (10) | `Uniswap V4 Optimism` | pool-entities |
| BNB Chain (56) | `uniswap-v4-bnb` | pool-entities |
| Unichain (130) | `Uniswap V4 Unichain` | pool-entities |
| Polygon (137) | `uniswap-v4-polygon` | pool-entities |
| X Layer (196) | `uniswap-v4-xlayer-mainnet-2` | pool-entities |
| Base (8453) | `uniswap-v4-base-3` | pool-entities |
| Avalanche (43114) | `uniswap-v4-avalanche` | pool-entities |

Candidates were rejected for two reasons, both observed rather than assumed:
`subgraph not found: no allocations` (published but unserved by any indexer), and
a schema exposing no `poolId`. Monad and Arbitrum have no usable published
subgraph and stay on the log-scan fallback.

None of these is published by Uniswap Labs, and Uniswap's own `v4-subgraph`
repository publishes no deployment IDs. That is acceptable because discovery
treats index output as candidates only: every PoolId is recomputed and verified
against pinned PoolManager state, so a wrong index can withhold pools but cannot
introduce one.

Why the index matters: public RPCs cap `eth_getLogs` at 10,000 blocks
(`range 4071432 exceeds limit of 10000`) and several refuse archive reads
outright, so full-history discovery on Ethereum costs roughly 400 sequential
requests. Uniswap's own interface avoids this by querying its private backend at
`interface.gateway.uniswap.org`; that endpoint is undocumented, carries no
stability guarantee, and is not used here.

## Execution conformance — measured 2026-08-14

`src/analysis/chainDifferential.live.test.ts` replays a real v4 transaction from
pinned parent state and compares outcome, gas, and log count against the chain's
own receipt. The receipt is the oracle. Only transactions whose pre-state equals
the parent block's state are used: index 0 normally, index 1 on OP-stack, where
index 0 is always the L1-attributes deposit and no user transaction can occupy it.

Candidate transactions come from the chain's own indexer rather than from
`eth_getLogs`. Log scanning has to satisfy three unrelated provider limits at
once — block range, result count, and response size — and an active chain
breaches the result cap long before the range cap, so window sizing became a
guess. The indexer already knows which transactions touched a pool. Log scanning
remains the fallback for chains with no usable subgraph.

In-block predecessors are replayed with commit enabled to rebuild the target's
exact pre-state, so any transaction within 64 predecessors qualifies rather than
only index 0.

| Chain | Result |
|---|---|
| Ethereum (1) | exact — 1,455,344 gas, 16 logs |
| Base (8453) | exact — 176,027 gas, 1 predecessor |
| Optimism (10) | exact — 166,333 gas, 1 predecessor |
| Unichain (130) | exact — 269,583 gas, 3 predecessors |
| X Layer (196) | exact — 377,012 gas, 3 predecessors |
| Polygon (137) | **diverged** — revm 252,977 gas / 13 logs vs chain 311,881 gas / 20 logs |
| Avalanche (43114) | **diverged** — revm 466,752 gas vs chain 492,252 gas, twice on independent samples |

Ethereum, Base, Optimism, Unichain, and X Layer are `deepExecution: true` on this
evidence. Polygon and Avalanche both reproduce fewer logs and less gas than the
chain, which is a different execution path rather than a rounding difference, so
they stay disabled with the measurement recorded in their registry limitation.
The UI now disables any chain whose execution is unverified instead of offering
it and degrading later.

Enabling the flag does not risk a false claim: every runtime replay still asserts
its own receipt match, so a chain that regresses reports degraded coverage rather
than passing silently.

Run it per chain with:

```bash
DIFFERENTIAL=1 CHAIN_ID=8453 pnpm exec vitest run src/analysis/chainDifferential.live.test.ts
```

## Current limitations

- Public RPCs can reject broad log ranges, lack historical state, rate-limit, or
  time out. Use a server-side read endpoint and explicit request bounds for
  scheduled generation.
- Generation records initialization transactions. Representative swap,
  liquidity-change, and donation transaction references require a separate
  activity-index enrichment source and are not invented by this command.
- A chain without a verified manager identity and deployment block is reported
  as `unsupported`; the tooling does not infer deployment metadata.
- Registry manager addresses are stored in checksum form and compared after
  normalization so formatting differences cannot become identity differences.
