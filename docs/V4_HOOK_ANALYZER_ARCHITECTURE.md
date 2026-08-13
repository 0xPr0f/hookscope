# Hookscope: Browser-Native Uniswap v4 Hook Behavior Analyzer

Status: living specification and implementation ledger for `0.1.0`

Design reference: [`docs/design/hookscope-primary-screen.png`](./design/hookscope-primary-screen.png)

### Implementation ledger — 2026-08-13

Implemented and verified locally:

- Vite/React/TypeScript application, 21-chain selector, address validation before RPC access, responsive report UI, JSON export, cancellation, IndexedDB history, and completed-report-only persistence flow.
- Uniswap v4 registry, pinned-block loader, index-first token pool discovery, batched PoolManager state verification, recent-tail `Initialize` log freshness, bounded full-history fallback, PoolId reconstruction, pool batching, contract/source loading, Sourcify lookup, and WhatsABI proxy resolution. Static index entries can carry bounded `initialize`, `swap`, `modify-liquidity`, and `donate` transaction references. Each reference is checked against its mined block, receipt, configured PoolManager, PoolId, and event topic before revm receives it.
- Sourcify v2 is now an authoritative lightweight interface source only when its repository `onchainBytecode` hash equals the runtime-code hash read at the pinned block: compiler identity, contract identity, function/event signatures, selectors, verification time, and proxy classification are then normalized into the contract graph. A mismatch is a visible limitation. Full source text and compiler settings use a separate lazy fetch with a 256-file/2 MB ceiling.
- Exact-version Solidity source analysis runs lazily in a small classic Dedicated Worker. It loads the official `soljson-v<version>.js` recorded by Sourcify, performs a compiler-version handshake, preserves the verified compiler settings, requests only AST plus the target ABI/storage/method identifiers, and returns compact facts rather than the complete AST. Workers are reused by compiler version and at most two compiler-version groups run concurrently. The initial modules map hook callbacks, direct state writes, explicit `msg.sender` gates, and low-level call sites without presenting that syntactic map as whole-program proof.
- Dedicated static worker using the upstream WhatsABI, sevm, and EVMole packages. EVMole is explicitly initialized from its supported `no_tla` entrypoint and emitted as a separate Wasm asset.
- Rust `revm` 36 Wasm bridge with instruction, call, storage-operation, storage-diff, log, and SELFDESTRUCT observations. It runs in a Dedicated Worker and has native Rust fixtures. Fork sessions inherit the requested chain ID, bound returned instruction samples without truncating execution, surface worker-start and transaction failures, and can commit scenario state between steps.
- Typed fork-state hydration protocol: revm requests missing accounts, code, storage slots, or ancestor block hashes; the browser reads them at the pinned parent block and retries. Hydrated state is retained inside a Wasm fork session. Independent observations discard transaction overlays; multi-step scenarios explicitly commit successful/reverted transaction results so nonce and state sequencing match chain execution. A historical receipt must match outcome, log count, and gas before replay can pass.
- LibAFL 0.15.4 coverage-guided input exploration runs with revm in a separate lazy Wasm artifact. Independent single-threaded instances fan out across at most four Dedicated Workers under one shared 30,000-execution/30-second ceiling. A second round exchanges at most 64 compact interesting inputs; normalization retains the shortest representative of each distinct outcome plus the strongest coverage samples. Worker-local edge counts are combined conservatively as a maximum rather than falsely presented as a set union. The ordinary replay/scenario worker retains the lean revm-only artifact, so 40 scenarios/80 PoolManager transactions do not load LibAFL.
- Schema-valid evidence/report normalization, immutable local history, PostgreSQL migration, and Vercel GET/POST report handlers with canonical hashing and completed-report validation. Cached public-chain reports display immediately, then a background check pins one coherent current block, verifies the saved block identity and token/hook/implementation codehashes, re-resolves proxies, and replays up to three receipt-backed behavior samples. Results remain explicitly `current`, `stale`, or `unavailable`.
- Native Foundry oracle fixtures using the official PoolManager and test routers, plus a generated 146 KB browser snapshot of that real execution context.
- Browser port of 40 Hacken-derived concrete scenarios pinned to upstream commit `965be6006eab54ff65b83285ef40a245c8735149`: swaps, liquidity, donations, bounded amount/tick corpora, reinitialization, empty/raw/ABI-encoded hook data, public getter/interface observation, PoolManager-only callback access, paired open/restricted router, caller and PoolId policies, permission/address flag agreement, callback selector validation, non-zero swap/liquidity return-delta settlement, fee override settlement, and delta settlement. The Wasm integration gate executes all 80 transactions against the generated official PoolManager snapshot. The two upstream introspection routines that classify bytecode size and external selectors run in the static worker against each deployed hook.
- Pool-wide historical replay orchestration with at most two concurrent workers and four indexed contexts per pool. Missing contexts or archive state produce explicit degraded coverage; a receipt mismatch cannot pass. Static work remains available when optional replay context is unavailable.
- Live callback contexts reuse a pinned-state revm session per hooked pool. The historical actor, router, PoolManager, currencies, and hook are prefetched once, then every address-enabled callback is invoked with bounded exact-input, exact-output, direction, and hook-data variants. These are labelled direct callback observations; they are not presented as generated router swaps.
- Receipt-matched Universal Router and PositionManager payloads are decoded with a conservative official codec. It supports installed v1.0.3 and current v2 swap tuple layouts, rejects non-canonical calldata, matches full PoolKeys/paths to the selected PoolId, preserves unrelated commands, settlement actions, deadline, caller, router, value, and parent block, then replays isolated hookData and smaller-amount variants in a reusable pinned fork session. Direct PositionManager token-ID actions use a cached `getPoolAndPositionInfo` read at the pinned parent block and must reconstruct the selected PoolId. Canonical `EXECUTE_SUB_PLAN` branches follow the official [`0x21`/`0xa1` command](https://github.com/Uniswap/universal-router/blob/2.2.0/contracts/libraries/Commands.sol) and [`(bytes commands, bytes[] inputs)` dispatcher layout](https://github.com/Uniswap/universal-router/blob/2.2.0/contracts/base/Dispatcher.sol) through a four-level application recursion ceiling with stable nested locations. Universal Router token-ID attribution and signed router entrypoints remain explicit coverage gaps.
- Read-only chain canary, deterministic pool-index generation, and offline pool-index validation commands are implemented. They expose `passed`, `degraded`, and `unsupported` capability outcomes, pin index boundaries by block hash, validate PoolIds/replay references/checksums, and keep credential-bearing RPC overrides outside browser configuration.
- Production build, 59 Vitest checks across 18 files (including the complete 80-transaction Wasm suite and router-codec/variant coverage), 11 tooling checks, five native revm tests, nine Foundry tests, and nine desktop E2E checks across Chromium, Firefox, and WebKit pass. The current deterministic full flow completes in 3.2 seconds on Chromium, 9.4 seconds on Firefox, and 6.5 seconds on WebKit in the local acceptance run.

Remaining conformance work before public-chain deep execution is enabled:

- Further Hacken semantics require only new upstream cases or additional contract-specific policies; the deterministic v1 matrix now includes non-zero return deltas, alternative hook-data formats, and paired restricted/unrestricted PoolId, router, and mutator policies.
- Canonical Universal Router v4 swaps, nested subplans, and PositionManager PoolKey-bearing operations now receive controlled variants using their historical funded/approved actor and settlement envelope. Direct PositionManager token-ID actions are resolved at the pinned parent block; token-ID actions routed through Universal Router remain unattributed because the outer calldata does not provide the immutable PositionManager address. Donations still need a recognized production-router envelope before generated variants can be claimed.
- Per-chain Foundry/Anvil differential fixtures and actual scheduled canary runs. The read-only canary and index commands are implemented, but production endpoints and schedules remain operator configuration.
- Live fork-state input exploration. Multi-worker fan-out, compact corpus exchange, and witness minimization are implemented and browser-verified for runtime-bytecode targets; pool-specific fork targets still require router-aware seed mutation.
- Additional source modules beyond the implemented callback/state-write/caller-gate/low-level-call maps. Remix's published analyzer package was probed and removed because it added 207 installed packages. Hookscope keeps no Remix runtime dependency.
- Hosted environment provisioning, scheduled index publication, and deployment. Repository-side Railway/Vercel configuration, least-privilege SQL role, validation script, currentness replay, and operator runbooks are complete; no remote resources were created in this implementation run.

Live-canary result: the read-only Ethereum WETH canary correctly rejected one public provider's personal-token archive policy and then exposed that full-history `eth_getLogs` discovery exceeds the 180-second product budget on the fallback endpoint. No report was persisted. The client now implements verified index-first discovery, but public-chain replay remains gated until a production index or subgraph URL is configured and canaried. Full-history browser RPC scanning remains a bounded fallback, not the primary path.

## 1. Product contract

Hookscope is a DeFi execution-transparency product. It accepts a chain and token address, discovers the token's Uniswap v4 pools, resolves each pool's hook and contract graph, and explains how the deployed pool mechanism behaves at a pinned block. The report separates facts from hypotheses and records enough evidence to reproduce concrete outcomes.

A completed report means that every enabled execution-observation stage for the selected chain and pool batch terminated successfully within its recorded limits. Unsupported capabilities remain visible coverage gaps. Its scope is pool and hook discovery, callback and transfer behavior, liquidity and control mechanics, state/balance/fee/delta outcomes, and reproducible swap/liquidity scenarios.

### Locked behavior

- The site uses Vite, React, TypeScript, viem, and Dedicated Web Workers.
- RPC reads, source retrieval, bytecode analysis, replay, and fuzzing run in the browser.
- The only server-side code is a storage proxy that validates and stores completed JSON reports in PostgreSQL.
- No wallet is required. The chain is selected explicitly.
- A token scan covers at most 20 pool/hook combinations per batch. Overflow is disclosed and can be continued.
- A cache hit shows the newest completed report, history, staleness state, and a **Run analysis again** action.
- A cache miss starts the full capability suite for that chain. Fuzzing is bounded and its actual work is reported.
- Cancelling or losing a worker prevents persistence.

## 2. Execution integrity and failure model

### Correctness goals

- Accuracy of deterministic findings and concrete witnesses.
- Immutability and identity of saved reports.
- Railway database credentials.
- Browser responsiveness and user device resources.
- Honest disclosure of untested pools, paths, or chain capabilities.

### State and failure modes

1. A token deployer can submit an invented browser report directly to the public storage endpoint.
2. A hook can hide behavior behind caller, amount, block, storage, transient storage, implementation upgrades, or external calls.
3. Spam pools can cause unbounded log scanning and worker work.
4. Public RPCs can omit archive state, cap log ranges, return inconsistent heads, or block browser CORS.
5. A cached report can become stale after a proxy implementation or dependency changes.
6. Analyzer defects can create false positives and false negatives.

### Controls

- Reports are content-addressed and append-only. The storage proxy recomputes the canonical hash, validates size/schema/completion, deduplicates, and rate-limits.
- Browser-produced reports are labelled as such. The client validates the pinned block and current codehashes before treating a cached report as current.
- Reproduced material-outcome witnesses are replayable. Unobserved behavior is described by scenarios, paths, executions, time, and limitations rather than a broad assurance claim.
- Discovery and analysis have explicit block, pool, bytecode-size, request, execution, memory, and wall-time ceilings.
- The same fixtures run against the browser engine and native Foundry/Anvil oracle in CI.

## 3. System architecture

```text
React UI
  -> feature hook / scan controller
      -> report-cache fetcher --------------------> /api/reports -> Railway PostgreSQL
      -> Uniswap v4 loader
          -> chain registry
          -> viem RPC fetchers
          -> token-sharded static index / v4 subgraph candidate fetcher
          -> PoolManager state verifier + recent log-tail fetcher
          -> bounded full-history log fallback
          -> lightweight Sourcify interface/compiler fetcher
          -> lazy bounded Sourcify source-bundle fetcher
      -> pure contract-graph mapper
      -> analysis worker coordinator
          -> static worker (WhatsABI + sevm + EVMole)
          -> exact-solc source worker (official soljson + compact AST modules)
          -> execution worker (revm Wasm + inspectors)
          -> lean bounded revm explorer (regression baseline)
          -> lazy LibAFL + revm workers (two-round fan-out + corpus exchange)
      -> pure evidence/report mapper
  -> report UI
```

The data layer follows `fetcher -> loader -> pure mapper -> feature hook -> UI`. Components do not fetch RPC data, join contract graphs, calculate severity, or coordinate workers.

### Snapshot consistency

Every scan first pins `{ blockNumber, blockHash, blockTagPolicy }`. All account code, storage, pool state, transaction replay, and source metadata are associated with that snapshot. A report cannot mix latest-state reads with its pinned evidence.

### Chain capability tiers

- `discovery`: PoolManager and source endpoints are configured and browser-accessible.
- `static`: code retrieval and bytecode engines pass chain canaries.
- `replay`: chain EVM semantics and archive hydration match the native oracle.
- `fuzz`: replay is enabled and the worker resource probe passes.

A tier includes a machine-readable `supported`, `verifiedAt`, and `reason`. OP-stack and other EVM variants cannot inherit Ethereum replay status.

## 4. Core TypeScript contracts

```ts
type ScanRequest = {
  chainId: number
  token: `0x${string}`
  block?: bigint
  poolCursor?: string
  poolLimit: 20
}

type EvidenceClass =
  | 'deterministic-fact'
  | 'static-reachability'
  | 'concrete-observation'
  | 'fuzz-discovery'
  | 'solver-derived'

type Evidence = {
  id: string
  detectorId: string
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  evidenceClass: EvidenceClass
  subject: `0x${string}`
  title: string
  claim: string
  confidence: 'confirmed' | 'supported' | 'heuristic'
  programCounter?: number
  callPath?: readonly `0x${string}`[]
  storage?: readonly { slot: `0x${string}`; before?: `0x${string}`; after?: `0x${string}` }[]
  witness?: ReplayWitness
  reproducibility: 'replayed' | 'replayable' | 'not-applicable' | 'failed'
}
```

`AnalysisReport` additionally contains identity, engine/scenario versions, contract graph, pool coverage, capability coverage, findings, execution/path counters, elapsed time, limitations, completion status, and report hash. `WorkerCommand` is `start | cancel`; `WorkerEvent` is `phase | progress | finding | complete | failure` and includes a scan ID so late messages from terminated work are ignored.

## 5. Uniswap v4 adapter

The adapter is protocol-specific; analysis engines are not.

1. Query a configured token-sharded static index first, then a configured v4 subgraph when available.
2. Recompute every candidate PoolId and batch its canonical `Pool.State` slot through PoolManager `extsload` at the pinned block. A candidate with no initialized state is excluded.
3. Scan only `indexedThroughBlock + 1 ... pinnedBlock` for newly initialized pools, separately matching the indexed token as `currency0` and `currency1`.
4. For the selected batch only, query each initialization block by indexed PoolId to recover the exact transaction hash needed by historical replay. A static index may also supply representative swap, liquidity, and donation hashes.
5. If the index is unavailable, scan Initialize logs in bounded adaptive chunks as a visible fallback.
6. Rank verified pools by indexed liquidity/activity, initialization block, then PoolId; execution-critical state is read from the pinned chain snapshot.
7. Validate every replay reference against its transaction, receipt, event kind, configured PoolManager, and PoolId, then replay at the parent block. Run at most two replay workers concurrently and no more than four indexed contexts per pool.
8. Deduplicate static analysis by `{chainId, codehash}` while retaining pool-specific replay and scenario evidence.

`VITE_V4_POOL_INDEX_<chainId>` accepts `{chainId}`, `{chainSlug}`, and `{token}` placeholders. `VITE_V4_SUBGRAPH_<chainId>` accepts a GraphQL endpoint. Public browser configuration must use a domain-restricted credential or a public endpoint; unrestricted index API credentials are not placed in the Vite bundle.

The chain registry is versioned data. Each entry owns chain ID, name, explorer, native currency, PoolManager, deployment block, public RPC candidates, optional subgraph, confirmation policy, EVM variant, and capability states. The supported chain names are seeded from the [Uniswap hooklist registry](https://github.com/Uniswap/hooklist); addresses and blocks must pass canaries before a deep capability is enabled.

## 6. Analysis engines

### Static pass

- [WhatsABI](https://github.com/shazow/whatsabi) supplies ABI inference and common proxy resolution.
- [Sourcify](https://docs.sourcify.dev/docs/api/index.html) supplies verified source, ABI/signatures, proxy classification, and compiler metadata. Lightweight interface facts are fetched during graph resolution; source contents are fetched only by a source-analysis worker.
- [sevm](https://github.com/acuarica/evm) supplies a browser-compatible symbolic AST, reachable control-flow, and readable decompilation.
- [EVMole](https://github.com/cdump/evmole) supplies Wasm selector, argument, mutability, storage, and CFG extraction.
- Declarative Hookscope rules consume normalized facts rather than engine-specific objects.

Initial deterministic/static rules cover hook permission flags, callback selector presence, materially relevant reachable opcodes, proxy/admin control, delegate targets, external calls, caller/origin-dependent branches, consequential storage writes, transient storage, callback re-entry, dynamic fees, return deltas, whitelist gates, and withdrawal authority.

An opcode's presence alone is informational. Severity increases only with reachability, controllability, affected state/value, a concrete observation, or a replayable witness.

### Browser engine feasibility findings — verified 2026-08-13

The production architecture is viable, but the engines are complementary rather than interchangeable:

| Layer | Viability | Production boundary |
|---|---|---|
| Sourcify v2 | Ready | Use its verified compiler identity and signatures as authoritative interface data. Fetch source/settings lazily and cap the bundle before compilation. |
| sevm 0.7.4 | Ready with an explicit fork limit | The upstream package documents direct browser use and is small, but this release's step table ends at Shanghai and does not implement Cancun `TLOAD`, `TSTORE`, `MCOPY`, or blob opcodes. It remains useful for supported bytecode; EVMole owns full linear decoding/CFG facts for Cancun contracts until sevm gains those operations. |
| EVMole | Ready | Primary fast Wasm disassembly, selectors, storage records, basic blocks, and CFG. It supplies the complete opcode substrate that prevents a sevm parse gap from becoming an analysis pass. |
| Modular source pass learned from Remix | Ready, initial modules implemented | Exact solc runs in a Dedicated Worker and passed real compile gates in Chromium, Firefox, and WebKit. Small AST modules map callbacks, direct state writes, caller gates, and low-level calls. The published Remix analyzer package is not retained because its dependency graph is disproportionate for this product. |
| LibAFL Wasm | Ready for bounded runtime-bytecode exploration; live fork targets remain | Pinned 0.15.4 is the newest release compatible with the project's Rust 1.88 toolchain. Each Dedicated Worker owns one upstream queue scheduler, havoc mutator, in-memory corpus, and revm edge map. The coordinator applies one shared budget, exchanges compact seeds for a second round, minimizes retained outcomes, and keeps cancellation/trap isolation at the Worker boundary. |

This is a functional alternative assembled as small passes, not a claim that one browser engine duplicates every native tool:

1. **Verified interface/source pass:** Sourcify compiler identity, ABI/signatures, settings, source contents, storage layouts, and small declarative AST checks over exact solc output.
2. **Bytecode pass:** WhatsABI proxy/interface inference, EVMole decoding/CFG/storage, and sevm symbolic AST where its fork supports every reached opcode.
3. **Concrete pass:** revm fork replay, state diffs, call/log traces, Hacken-derived PoolManager scenarios, and native Foundry differential fixtures.
4. **Coverage pass:** bounded LibAFL mutations use revm inspector edges and mechanic-specific outcome feedback; workers exchange only compact corpus entries and minimized witnesses.

Breaking the work up this way is faster and more honest than sending every contract through a solver. A source module can answer a source-local question, the bytecode pass can answer deployed-code structure, and revm/LibAFL can answer whether a bounded concrete input reaches a state or balance outcome. A solver-only statement remains a separate evidence class.

### Remix patterns adopted

Remix's implementation provides four useful patterns:

- Its compiler worker loads the selected `soljson` version with `importScripts`, reports a version handshake, compiles Standard JSON, and returns unresolved imports instead of blocking the UI.
- Its analyzer walks the compiler AST once and lets independent modules collect/report their own results. Hookscope uses the same shape without depending on Remix's analyzer package.
- Its simulator exposes a provider/RPC boundary separate from the UI. Hookscope already has the analogous boundary in `ForkExecutionSession`; revm remains the execution engine, so the Remix simulator is not duplicated.
- Expensive compiler/analyzer code is loaded only for a verified-source subject. Bytecode-only scans never pay that download or parse cost.

The implemented source-worker gate pins the solc build from Sourcify, verifies Sourcify's on-chain runtime bytecode against the pinned RPC codehash before trusting source metadata, bounds compile time/source bytes/AST nodes, and discloses module-level failures independently. A compiler or codehash mismatch cannot silently become a source-level pass.

### Concrete execution

[revm](https://github.com/bluealloy/revm) is compiled to Wasm and runs inside a Dedicated Worker. Its database remains synchronous. Missing accounts, code, block hashes, and storage slots are surfaced as hydration requests; the coordinator fetches them at the pinned block, adds them to a persistent in-Wasm base database, and retries deterministically. Repeated scenarios reuse the base through a session handle. revm returns transaction state separately, so scenario writes are observed as a disposable overlay and do not contaminate the next execution. Prefetch and lazy hydration use the same typed update protocol and are measured separately from execution count.

Inspectors record instructions, branch edges, calls/creates, logs, SLOAD/SSTORE, TLOAD/TSTORE, balance changes, return/revert data, external targets, and call frames. Shadow taint mirrors concrete stack/memory/storage values without replacing revm's concrete arithmetic.

### Scenarios

The scenario pack preserves the intent of the [Hacken v4 framework](https://github.com/hknio/uni-v4-hooks-checker) while executing through real PoolManager unlock/callback context:

- exact-input and exact-output swaps in both directions;
- multiple callers and amount classes;
- empty, expected, malformed, and fuzzed hook data;
- add/remove liquidity and donation;
- fee and return-delta invariants;
- callback access control and unauthorized administrative paths;
- repeated operations that expose transient-state and sequence gates;
- replay of representative initialized-pool transactions when available.

We do not port the framework's permissive function detection, swallowed failures, synthetic-pool substitution for deployed hooks, or direct PoolManager impersonation.

Current upstream mapping at commit `965be6006eab54ff65b83285ef40a245c8735149`:

| Upstream module | Browser implementation | Current gate |
|---|---|---|
| `SwapSuite` | Exact in/out, both directions, sequential execution, bounded amount corpus | Real PoolManager fixture passes |
| `LiquiditySuite` | Add/remove, repeated adds, aligned ranges, partial removal, bounded amounts/ranges | Real PoolManager fixture passes |
| `DonateSuite` | Dust, dual currency, single currency, sequential, bounded corpus | Real PoolManager fixture passes |
| `InitializeSuite` | Reinitialization of an existing PoolId must revert | Real PoolManager fixture passes |
| `HookDataDetectionSuite` | Empty, raw-byte, UTF-8, and ABI-address hook-data outcomes | Passes through PoolManager |
| `HookIntrospectionSuite` | Getters/interfaces through revm; code-size and external-selector classification in static worker | Passes |
| `HookAuthorization` | Direct callback rejection plus paired open/restricted PoolId, router, and configuration-mutator policies | Passes through PoolManager |
| `HookConfiguration` | PoolManager identity, address/permission agreement, callback selector and return tuple validation | Passes through PoolManager |
| `SwapDeltaEffects` | No type flip, bidirectional settlement, dynamic fee override, and non-zero specified/unspecified return deltas | Passes through PoolManager |
| `LiquidityDeltaEffects` | Add/remove settlement plus zero and non-zero after-add/after-remove return deltas | Passes through PoolManager |
| `FuzzTestEntry` | Deterministic boundary corpus plus separate 30,000-execution LibAFL/revm edge corpus | Two-round worker fan-out, compact seed exchange, and outcome minimization pass; live fork targets remain |

### Fuzzing

The implemented engine runs LibAFL 0.15.4 with upstream `BytesInput`, `InMemoryCorpus`, `QueueScheduler`, `MaxMapFeedback`, `HavocScheduledMutator`, and `InProcessExecutor`. revm inspector PC edges feed a fixed edge map; distinct state/output outcomes and coverage-expanding inputs are retained as witnesses. A pool receives at most 30 seconds or 30,000 executions; the worker reports actual executions, execution edges, distinct outcomes, and retained inputs. Cancellation terminates the worker and prevents persistence.

The fuzz artifact is separate from the replay/scenario artifact and loads only when the fuzz phase starts. The deterministic edge-corpus implementation remains callable as a regression baseline, but reports identify the selected scheduler so its results are never conflated with LibAFL. The implemented coordinator fans independent single-threaded instances across at most `min(4, max(1, hardwareConcurrency - 1))` workers, exchanges compact interesting inputs for a second round, and retains minimized outcome representatives. Trap handling and immediate cancellation remain at the Worker boundary. This is bounded exploration, not proof.

## 7. Evidence and report semantics

Evidence classes are never collapsed into a generic confidence score:

| Class | Meaning |
|---|---|
| Deterministic fact | Directly decoded from address, bytecode, source, storage, logs, or chain state |
| Static reachability | A normalized engine found a reachable code path without executing it |
| Concrete observation | A deterministic scenario produced the behavior at the pinned state |
| Fuzz discovery | Coverage-guided exploration produced a minimized input/sequence |
| Solver-derived | An optional solver established a satisfiable path condition |

The consumer summary derives from the highest-impact confirmed/supported mechanics. The technical view exposes rule version, evidence class, subject, PoolId, PCs, path, storage/balance deltas, inputs, replay status, and limitations. The UI labels the internal `severity` field as **impact**.

## 8. Persistence contract

Endpoints:

- `GET /api/reports?chainId=<n>&token=<address>` returns newest full report plus history summaries.
- `GET /api/reports/:id` returns one immutable report.
- `POST /api/reports` appends one completed report.

PostgreSQL stores `id`, `report_hash`, identity columns, block identity, engine/scenario versions, severity counts, completion metadata, and `report JSONB`. Uniqueness is enforced on `report_hash`. The proxy accepts no database query language or arbitrary patch/delete operation.

The Vercel functions hold the least-privilege Railway `DATABASE_URL`; the Vite bundle never receives it. Railway hosts PostgreSQL only—there is no server-side analysis service. Schema validation, canonical serialization, SHA-256 hashing, a 2,000,000-byte application payload limit, same-origin browser access, parameterized SQL, and database statement timeouts apply at the storage boundary.

The in-memory 12-submissions-per-minute IP check is an instance-local abuse brake, not a distributed rate limiter: it resets on cold starts and is not shared across function instances or regions. Vercel's platform request/response limit also applies before/around application handling. A durable limiter or platform firewall rule is required before anonymous write traffic is operated at meaningful scale. Deployment, migrations, environment separation, health checks, backup recovery, and application rollback are specified in [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md).

Only reports with `status: 'completed'`, all required phases completed/degraded explicitly, and no `partial` marker are accepted.

## 9. Synthetic fixture catalogue

- Benign no-op/accounting hook baseline.
- No-sell or caller-class-dependent token/hook.
- Hidden reachable SELFDESTRUCT/CALL/DELEGATECALL behavior.
- Unprotected configurable delegate target.
- EIP-1967 proxy with mutable administrator.
- Dynamic-fee or return-delta extraction.
- Whitelist/authorization bypass.
- Reentrant external target.
- Transient-state sequence gate.
- Administrator liquidity withdrawal.

Each material-mechanics fixture declares expected rule IDs, evidence class, affected path/state, and reproducible witness. Baseline fixtures may emit informational facts but no high/critical-impact findings.

## 10. Dependency and license policy

| Dependency | Runtime placement | License/use decision |
|---|---|---|
| viem | browser | MIT; transport and ABI primitives |
| WhatsABI | static worker | MIT; direct package integration |
| sevm/Acuarica EVM | static worker | MIT; direct package integration |
| EVMole | static worker | MIT; Wasm package integration after bundle probe |
| Official soljson builds | source worker, lazy network asset | GPL-3.0 compiler toolchain; executed as an analyzer dependency and not copied from Remix |
| revm | execution/fuzz workers | MIT/Apache-2.0; pinned Rust crates |
| LibAFL | fuzz worker | MIT/Apache-2.0; enabled after revm vertical slice |
| Hacken checker | test semantics | MIT; scenario behavior is reimplemented, attributed, and pinned to commit `965be6006eab54ff65b83285ef40a245c8735149` |
| Foundry/Anvil/Cast | CI/native tests | not shipped to browsers |
| Slither | CI only | AGPL-3.0; never bundled into the product |
| Mythril/Echidna | CI only | native oracle; never bundled into the product |
| BlockSec HookScan | research only | no public embeddable implementation found |
| Z3.js/Owi | deferred | not required by v1 |

Versions and upstream commits are pinned. CI emits an SBOM and runs license and dependency checks.

## 11. UI design system

The accepted concept is a 1440×1050 evidence-led desktop surface with a responsive single-column mobile continuation.

- True white `#ffffff` background; cool gray rules; near-black ink.
- Material-impact orange `#db3514`, attention amber, and reproduced-outcome green `#267c2d` are semantic, not decorative.
- Display typography is a sober grotesk at 42–48px; UI chrome is 12–14px with explicit line-height and weight.
- Containers are open ruled bands, rails, lists, and tables. Cards, gradients, glows, glass, and crypto imagery are excluded.
- Signature motif: fine execution-trace lines and square evidence markers.
- The first viewport contains the quiet header, scan form, completed/running rail, summary, evidence table, and coverage rail.
- Motion is limited to the progress rule and sequential evidence insertion, and is disabled under `prefers-reduced-motion`.

## 12. Verification gates

1. Invalid addresses, including `0xD0a606aDf58b69a28D479aAA510CE6FE96E0a1eb2`, fail before any RPC request.
2. The static worker imports its browser dependencies in a Vite production build.
3. revm Wasm produces instruction/call/storage events in Chromium, Firefox, and Safari workers.
4. Exact-version official soljson produces compact AST facts in Chromium, Firefox, and WebKit; source metadata is used only after its runtime codehash matches the pinned chain code.
5. Every material-mechanics fixture emits its expected exact evidence; baseline fixtures emit no high/critical-impact evidence.
6. Pool discovery and PoolId reconstruction pass canaries on every configured chain.
7. revm results match Foundry/Anvil return data, reverts, logs, balances, deltas, and storage for fixtures.
8. Seeded hidden branches are found within the fuzz budget; actual executions/coverage are reported.
9. Cancellation terminates workers and performs no report POST.
10. Proxy upgrades invalidate currentness through implementation codehash identity.
11. Pool overflow and unavailable capabilities remain conspicuous.
12. First scan, cache hit/history, rerun, export, worker failure, database failure, stale code, and mobile static-only behavior pass end-to-end tests.

## 13. Known limitations

- Bounded fuzzing cannot prove the absence of unobserved material mechanics.
- Anonymous browser reports cannot attest that every claimed negative test ran; positive witnesses and deterministic fingerprints are independently checkable.
- Public RPC/browser CORS policies can reduce capability without a credentialed read proxy.
- Source-level findings are unavailable for unverified contracts; bytecode evidence remains available.
- The literal user-provided test address is malformed. The inferred Ethereum HFA address may be used as an optional research case but no adverse verdict is forced.

### Supplied-address Sourcify check

The literal `0xD0a606aDf58b69a28D479aAA510CE6FE96E0a1eb2` has 41 hex digits and is rejected before network access. Removing the duplicated `A` yields `0xD0a606aDf58b69a28D479aA510CE6FE96E0a1eb2`. On Ethereum, Sourcify currently records that inferred address as:

- contract `HardFloorAssets`, `src/HardFloorAssets.sol:HardFloorAssets`;
- Solidity `0.8.35+commit.47b9dedd`, Cancun, via-IR, optimizer runs `1`;
- `37` function signatures, `5` event signatures, and `9` error signatures;
- not a proxy according to Sourcify's proxy resolution;
- verification match recorded at `2026-08-12T18:15:03Z`.

These are source/interface facts only. They do not predetermine the token or any associated pool/hook behavior; that comes from pinned pool discovery and concrete execution.

## 14. Primary references

- [Uniswap v4 hook concepts](https://developers.uniswap.org/docs/protocols/v4/concepts/hooks)
- [Uniswap v4 protocol framework](https://developers.uniswap.org/docs/protocols/v4/security)
- [Uniswap v4 core Hooks library](https://github.com/Uniswap/v4-core/blob/main/src/libraries/Hooks.sol)
- [Uniswap hooklist](https://github.com/Uniswap/hooklist)
- [revm repository](https://github.com/bluealloy/revm)
- [LibAFL repository](https://github.com/AFLplusplus/LibAFL)
- [LibAFL official browser Wasm example](https://github.com/AFLplusplus/LibAFL/tree/main/fuzzers/fuzz_anything/baby_fuzzer_wasm)
- [Sourcify v2 contract lookup API](https://docs.sourcify.dev/docs/api/index.html)
- [Sourcify repository UI and artifacts](https://docs.sourcify.dev/docs/repo-ui/)
- [Remix compiler worker](https://github.com/remix-project-org/remix-project/blob/master/libs/remix-solidity/src/lib/es-web-worker/compiler-worker.ts)
- [Remix Analyzer module runner](https://github.com/remix-project-org/remix-project/blob/master/libs/remix-analyzer/src/solidity-analyzer/index.ts)
- [Remix Simulator provider package](https://github.com/remix-project-org/remix-project/tree/master/libs/remix-simulator)
- [Hacken v4 checker](https://github.com/hknio/uni-v4-hooks-checker)
- [PostgreSQL frontend/backend protocol](https://www.postgresql.org/docs/current/protocol.html)
- [Vercel Functions](https://vercel.com/docs/functions)
