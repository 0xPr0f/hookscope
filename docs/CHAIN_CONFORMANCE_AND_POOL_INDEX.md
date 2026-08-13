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
VITE_V4_POOL_INDEX_1=https://cdn.example.com/pool-index/v1/{chainId}/{token}.json
```

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
