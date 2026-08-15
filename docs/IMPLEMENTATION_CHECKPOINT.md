# Hookscope implementation checkpoint

This file is the short, durable handoff for continuing implementation in Codex Desktop or the Codex CLI.

## Product framing

Hookscope is browser-native DeFi execution-transparency tooling for Uniswap v4. It discovers token pools, resolves deployed code and verified sources, reproduces historical pool transactions at pinned blocks, exercises callback behavior in local browser execution contexts, and presents reproducible mechanics evidence.

Use neutral implementation terms in task updates:

- contract behavior mapping
- transaction reproduction
- callback semantics
- control and liquidity mechanics
- bounded input exploration
- baseline and adverse-mechanics fixtures
- reproducible behavior sample

Avoid quoting the full historical conversation when a short reference to this checkpoint is sufficient.

## Verified implementation

- Vite, React, TypeScript, viem frontend.
- Versioned 21-chain registry and index-first Uniswap v4 pool discovery.
- Pinned-block pool verification and bounded recent-log fallback.
- WhatsABI 0.27, Sourcify, EVMole, and exact-solc source passes in browser workers.
- Lean revm Wasm transaction execution and iterative pinned-state hydration.
- Receipt-matched historical PoolManager transaction reproduction.
- Conservative Universal Router/PositionManager calldata codec and receipt-context variant execution.
- Pinned `getPoolAndPositionInfo` attribution for direct PositionManager token-ID actions.
- Canonical Universal Router `EXECUTE_SUB_PLAN` decoding and nested variant execution with stable operation paths.
- 40-scenario/80-transaction Hacken-derived deterministic PoolManager fixture suite.
- LibAFL/revm two-round Dedicated Worker fan-out under one shared budget, compact corpus exchange, and representative minimization.
- Coverage-guided mutation of hydrated live fork targets using pool-scoped canonical router masks.
- Explicit signature-bearing payload recognition, enforced immutability, and report disclosure.
- Universal-Router-nested PositionManager attribution from the replay-observed call target.
- Normalized logs, native balance movement, transient-storage keys/values, and external call selectors.
- Direction-flip and widened-tick-range router variants.
- Browser-side pool-index manifest checksum verification.
- Eight-chain Graph Network index registry with a server-side key proxy.
- Measured per-chain execution conformance against chain receipts.
- Dynamic-fee observation decoded from PoolManager `Swap` events.
- Repeated-sequence probe that commits one execution and observes the next.
- Release CI matrix with native oracle, SBOM, and pinned-version supply-chain gate.
- Reusable live callback contexts derived from receipt-matched historical actor/router state.
- Read-only chain conformance, deterministic pool-index generation, and offline index-validation commands.
- Background cached-report currentness checks for block, code, proxy, and receipt-backed behavior identities.
- Completed-report-only local/remote persistence contract.
- Vercel/Railway configuration, least-privilege runtime SQL role, deployment validator, and operator runbook.

## Latest verified state

Live pool contexts reuse a pinned-state revm session per selected pool. The implementation preloads the historical actor, router, PoolManager, hook, and currencies once, then invokes each callback enabled by the hook address, including exact-input, exact-output, direction, and hook-data variants. Unit coverage verifies callback selection and session reuse.

Canonical Universal Router and PositionManager calldata is now recognized using the official v4 action layouts. The codec rejects non-canonical payloads, identifies PoolKey/path operations for the selected PoolId, supports installed v1 and current v2 swap tuples, follows canonical `EXECUTE_SUB_PLAN` branches through a four-level recursion ceiling, and byte-preserves unrelated commands and settlement actions. Direct PositionManager token-ID actions are attributed with one cached `getPoolAndPositionInfo` read at the replay parent block; the returned PoolKey must reconstruct the selected PoolId. Universal Router token-ID calls stay explicit because the outer envelope does not encode the immutable PositionManager address. The live coordinator reuses the receipt-matched actor, router, value, parent block, approvals, balances, and one hydrated fork session while applying bounded hookData and smaller-amount variants.

The deterministic suite now includes non-zero swap/liquidity return-delta settlement, raw/ABI/UTF-8 hookData, and paired open/restricted PoolId, router, caller, and configuration policies.

The bounded-input coordinator now:

1. run independent Dedicated Workers under one shared execution/time ceiling;
2. exchange compact interesting inputs for a second round;
3. retain the shortest representative per distinct outcome; and
4. report worker/round accounting explicitly.

The Rust exchanged-seed entry point and generated Wasm/TypeScript bindings are complete.

Coverage-guided mutation now runs against hydrated live fork targets. Each selected pool receives one canonical receipt-matched router transaction, a mutation mask restricted to the operations that provably act on that pool, and one hydrated revm session under a single 30,000-execution/30-second budget split across two rounds. State a round reports as missing is hydrated before the next round starts, and interesting inputs — including the ones skipped for that missing state — are handed forward as a compact corpus that is re-checked against the mask. Fan-out is applied across pools rather than inside one pool, because hydrated fork state cannot be transferred between Wasm sessions. The fuzz phase is bounded to three hydrated targets per scan so it stays inside the product time budget; every uncovered hooked pool is reported as an explicit `unsupported` outcome.

Current gates pass: 117 Vitest checks across 27 files, 11 tooling checks, six Rust tests by default and eight with `libafl-fuzz`, nine Foundry tests, production build, deployment validation, and nine browser checks across Chromium, Firefox, and WebKit. `pnpm verify` now runs the Rust tests in both feature configurations.

## Next slices

1. Remaining scenario shapes: exact-in/exact-out conversion, and alternate actors with prepared token balances, allowances, and Permit2 state. Direction flips, widened tick ranges, and committed repeat sequences are implemented. Actor funding is the blocker: native value can be injected as a hydration update, but ERC-20 balances and Permit2 allowances live at token-specific storage slots that cannot be derived reliably, so preparing a fresh actor would mean guessing a layout per token.
2. Widen conformance sampling to the chains that currently have no usable indexer or archive endpoint: Arbitrum, Monad, Robinhood Chain, BNB, and Linea. The differential itself is implemented and has already produced verdicts for seven chains.
3. Publish generated indexes on a schedule. The generator, the offline validator, the browser-side manifest checksum check, and the read-only canary are implemented; only the hosting and cron remain.
4. Provision Railway/Vercel environments and perform the documented preview/production rollout when deployment authority and credentials are supplied.
5. Resolve the open anonymous-write integrity decision below.

## Open design decision — anonymous write integrity

Deferred, not resolved. Anonymous report submission stays; authentication is out of scope by product choice. The threat is a fabricated report served to a later reader as a cached result.

Rejected with reasons:

- **Client attestation** ("prove the report came from our code"): impossible against a client-side adversary. Any embedded secret is extractable; Web Environment Integrity was withdrawn in 2023 and Private Access Tokens attest device authenticity, not which code ran.
- **Full server recomputation**: strongest guarantee, but it converts every anonymous POST into 60–180 s of compute plus credentialed archive RPC, which is a denial-of-wallet on an unauthenticated endpoint. It also makes the browser tier redundant and crosses the "no server-side analysis service" line.
- **ZK/SNARK/STARK proof of the analysis**: proving runs ~10⁵–10⁶× native, and one pool's fuzz phase is roughly 200 Ethereum blocks of EVM work. Infeasible in a browser. More fundamentally the crossover never opens: at any piece small enough to prove, re-execution is already ~1 ms, and the one capability ZK uniquely offers — privacy — is unused because every input is public chain state.

Preferred design when this resumes:

1. **Sampled re-execution at write time** — replay one randomly chosen witness from the submitted report and require it to match its recorded outcome. Bounded cost (~200–500 ms, RPC-latency dominated), reuses `loadPoolReplayCandidate` and `assertReplayMatchesReceipt`. Catches invented outcomes.
2. **Reproduction counting** — a claims digest over the deterministic subset of a report (excluding `id`, `createdAt`, `elapsedMs`, worker/round accounting), counting independent clients that produced the same digest. Catches omission, which sampling cannot.
3. **Durable rate limiter** replacing the instance-local IP brake. Proof-of-work was considered and rejected: browser provers are ~1000× weaker than a rented GPU, so any difficulty tolerable for a phone is free for an attacker.
4. **MPT input proofs** (`eth_getProof` against the pinned `stateRoot`) if input authenticity needs to be checkable without RPC access.

The React Router 8 framework migration was evaluated and declined: a framework `action` is still a public HTTP endpoint, so it does not change who can call the write path. It would be justified only by a future need for server-rendered report pages.

## Resume

Task ID: `019ff8cb-e309-7f43-8a25-b496578f46d7`

```bash
cd /Users/praise/Documents/Projects/Experiments
codex resume 019ff8cb-e309-7f43-8a25-b496578f46d7 "Continue from docs/IMPLEMENTATION_CHECKPOINT.md and verify each remaining slice."
```
