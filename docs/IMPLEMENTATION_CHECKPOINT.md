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
- WhatsABI, Sourcify, sevm, EVMole, and exact-solc source passes in browser workers.
- Lean revm Wasm transaction execution and iterative pinned-state hydration.
- Receipt-matched historical PoolManager transaction reproduction.
- Conservative Universal Router/PositionManager calldata codec and receipt-context variant execution.
- Pinned `getPoolAndPositionInfo` attribution for direct PositionManager token-ID actions.
- Canonical Universal Router `EXECUTE_SUB_PLAN` decoding and nested variant execution with stable operation paths.
- 40-scenario/80-transaction Hacken-derived deterministic PoolManager fixture suite.
- LibAFL/revm two-round Dedicated Worker fan-out under one shared budget, compact corpus exchange, and representative minimization.
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

The Rust exchanged-seed entry point and generated Wasm/TypeScript bindings are complete. Current gates pass: 59 Vitest checks across 18 files, 11 tooling checks, five Rust tests, nine Foundry tests, production build, deployment validation, and nine browser checks across Chromium, Firefox, and WebKit. The latest full browser flow completed in 3.2 s, 9.4 s, and 6.5 s respectively.

## Next slices

1. Connect coverage-guided mutation to hydrated live fork targets using canonical router payload seeds; controlled router variants already run in the pinned fork.
2. Add recognized production donation envelopes and signed entrypoints only after their official codecs have conformance fixtures. Signed payload mutation must not invalidate or misrepresent the original signature.
3. Run actual per-chain native differential/canary lanes with production read endpoints and publish the generated indexes on a schedule.
4. Provision Railway/Vercel environments and perform the documented preview/production rollout when deployment authority and credentials are supplied.

## Resume

Task ID: `019ff8cb-e309-7f43-8a25-b496578f46d7`

```bash
cd /Users/praise/Documents/Projects/Experiments
codex resume 019ff8cb-e309-7f43-8a25-b496578f46d7 "Continue from docs/IMPLEMENTATION_CHECKPOINT.md and verify each remaining slice."
```
