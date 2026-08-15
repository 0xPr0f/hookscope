import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'
import type { RevmCallEvidence } from './revmProof'
import {
  create_fork_session,
  dispose_fork_session,
  initSync,
  inspect_fork_session,
} from '../wasm/revm/hookscope_revm_wasm.js'
import { HACKEN_FIXTURE_CONTEXT, hackenFixtureSnapshot } from '../fixtures/hackenBrowserFixture'
import { buildScenarioStateOverlay } from './protocolScenarioState'
import { buildProtocolScenarioMatrix } from './protocolNativeScenarios'
import { deriveScenarioMutationMask, isScenarioDerivative } from './protocolScenarioMask'
import { selectExplorationSeeds } from './protocolScenarioExploration'

/**
 * Proves the generated-scenario path end to end in the real browser engine.
 *
 * The harness is injected into a snapshot of an actual PoolManager deployment,
 * funded only through declared ERC-6909 claim slots, and then asked to perform a
 * swap through `unlock`/`unlockCallback`. Nothing about the pool, the hook, or
 * either token is simulated: a passing run means a browser can observe a
 * deployed hook without any historical router.
 */

const ROUTER = '0x00000000000000000000000000000000000f0000' as Address
const ACTOR = '0x00000000000000000000000000000000000ac701' as Address

// Uniswap's canonical price bounds; a swap must stay inside them.
const MIN_SQRT_PRICE_PLUS_ONE = 4_295_128_740n
const MAX_SQRT_PRICE_MINUS_ONE = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341n

const RUN_ABI = parseAbi([
  'struct Step { uint8 operation; PoolKey key; bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; int24 tickLower; int24 tickUpper; int256 liquidityDelta; bytes32 salt; uint256 amount0; uint256 amount1; bytes hookData; }',
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'function run(Step[] steps) returns (int256[] deltas)',
])

function swapCalldata(input: { zeroForOne: boolean; amountSpecified: bigint; hookData: Hex }): Hex {
  return encodeFunctionData({
    abi: RUN_ABI,
    functionName: 'run',
    args: [[{
      operation: 0,
      key: {
        currency0: HACKEN_FIXTURE_CONTEXT.currency0,
        currency1: HACKEN_FIXTURE_CONTEXT.currency1,
        fee: HACKEN_FIXTURE_CONTEXT.fee,
        tickSpacing: HACKEN_FIXTURE_CONTEXT.tickSpacing,
        hooks: HACKEN_FIXTURE_CONTEXT.hook,
      },
      zeroForOne: input.zeroForOne,
      amountSpecified: input.amountSpecified,
      sqrtPriceLimitX96: input.zeroForOne ? MIN_SQRT_PRICE_PLUS_ONE : MAX_SQRT_PRICE_MINUS_ONE,
      tickLower: 0,
      tickUpper: 0,
      liquidityDelta: 0n,
      salt: `0x${'0'.repeat(64)}` as Hex,
      amount0: 0n,
      amount1: 0n,
      hookData: input.hookData,
    }]],
  })
}

/** Merges the declared overlay into the fixture snapshot, overriding by address. */
function snapshotWithHarness(router: Address = ROUTER) {
  const base = hackenFixtureSnapshot()
  const manager = base.accounts.find(
    (account) => account.address.toLowerCase() === HACKEN_FIXTURE_CONTEXT.poolManager.toLowerCase(),
  )
  expect(manager, 'fixture must contain the PoolManager account').toBeTruthy()

  const overlay = buildScenarioStateOverlay({
    poolManager: HACKEN_FIXTURE_CONTEXT.poolManager,
    poolManagerAccount: { balance: manager!.balance, nonce: manager!.nonce, code: manager!.code },
    routers: [router],
    actors: [ACTOR],
    currencies: [HACKEN_FIXTURE_CONTEXT.currency0, HACKEN_FIXTURE_CONTEXT.currency1],
  })

  const overridden = new Map(overlay.snapshot.accounts.map((account) => [account.address.toLowerCase(), account]))
  const accounts = base.accounts.map((account) => {
    const replacement = overridden.get(account.address.toLowerCase())
    if (!replacement) return account
    overridden.delete(account.address.toLowerCase())
    // The PoolManager keeps its fixture storage; claims are merged on top.
    //
    // `storageComplete` is forced back to the fixture's value: the overlay marks
    // PoolManager incomplete so a browser hydrates untouched slots from RPC, but
    // this fixture is a complete Foundry state dump with no RPC behind it, so an
    // unlisted slot must read as zero rather than raise a hydration request.
    return {
      ...account,
      ...replacement,
      storage: { ...account.storage, ...replacement.storage },
      storageComplete: account.storageComplete,
    }
  })
  return { snapshot: { ...base, accounts: [...accounts, ...overridden.values()] }, overlay }
}

function runScenario(
  sessionId: string,
  snapshot: ReturnType<typeof snapshotWithHarness>['snapshot'],
  calldata: Hex,
  router: Address = ROUTER,
) {
  create_fork_session(sessionId, snapshot)
  try {
    return inspect_fork_session(
      sessionId,
      {
        caller: ACTOR,
        to: router,
        calldata,
        value: '0x0',
        // EIP-7825 caps a transaction at 2**24 gas; revm enforces it on recent forks.
        gasLimit: 16_000_000,
        gasPrice: '0x0',
        nonce: 0,
        chainId: HACKEN_FIXTURE_CONTEXT.chainId,
        traceLimit: 4_096,
      },
      {
        number: 2,
        beneficiary: '0x0000000000000000000000000000000000000000',
        timestamp: '0x6553f100',
        gasLimit: 30_000_000,
        baseFee: 0,
        difficulty: '0x0',
        prevrandao: `0x${'0'.repeat(64)}`,
      },
      false,
    )
  } finally {
    dispose_fork_session(sessionId)
  }
}

const WRAPPED_ERROR = '0x90bfb865'
const ROUTER_UNAVAILABLE = '4216758d'

describe('generated PoolManager scenarios in browser revm', () => {
  function ready() {
    initSync({ module: readFileSync(new URL('../wasm/revm/hookscope_revm_wasm_bg.wasm', import.meta.url)) })
  }

  it('drives the deployed pool and hook through the injected harness', () => {
    ready()
    const { snapshot, overlay } = snapshotWithHarness()
    const step = runScenario(
      'protocol-scenario-path',
      snapshot,
      swapCalldata({ zeroForOne: true, amountSpecified: -1_000n, hookData: '0x' }),
    )

    expect(step.status, `fork step failed: ${step.message ?? ''}`).toBe('complete')
    const targets = step.proof.calls.map((call: RevmCallEvidence) => call.target.toLowerCase())
    // Reaching both is what makes this an observation about the deployed pool.
    expect(targets).toContain(HACKEN_FIXTURE_CONTEXT.poolManager.toLowerCase())
    expect(targets).toContain(HACKEN_FIXTURE_CONTEXT.hook.toLowerCase())
    expect(overlay.patched.poolManager).toBe(HACKEN_FIXTURE_CONTEXT.poolManager)
  })

  it('records a hook router policy as an observed revert, not an analyzer failure', () => {
    ready()
    const { snapshot } = snapshotWithHarness()
    const step = runScenario(
      'protocol-scenario-policy',
      snapshot,
      swapCalldata({ zeroForOne: true, amountSpecified: -1_000n, hookData: '0x' }),
    )

    expect(step.status).toBe('complete')
    expect(step.proof.success).toBe(false)
    // WrappedError(hook, beforeSwap, RouterUnavailable(harness)) — the hook
    // refused an unfamiliar router, which is a fact about the hook.
    expect(step.proof.output.startsWith(WRAPPED_ERROR)).toBe(true)
    expect(step.proof.output).toContain(ROUTER_UNAVAILABLE)
    expect(step.proof.output.toLowerCase()).toContain(ROUTER.slice(2).toLowerCase())
  })

  it('completes swap settlement when the hook permits the calling router', () => {
    ready()
    // Injecting at the router the fixture hook already allows isolates settlement
    // from the policy above, proving claims-only settlement actually balances.
    const allowed = HACKEN_FIXTURE_CONTEXT.swapRouter
    const { snapshot } = snapshotWithHarness(allowed)

    for (const zeroForOne of [true, false]) {
      const step = runScenario(
        `protocol-scenario-settle-${zeroForOne}`,
        snapshot,
        swapCalldata({ zeroForOne, amountSpecified: -1_000n, hookData: '0x' }),
        allowed,
      )
      expect(step.status, `fork step failed: ${step.message ?? ''}`).toBe('complete')
      expect(step.proof.success, `swap reverted: ${step.proof.output}`).toBe(true)
      expect(step.proof.calls.map((call: RevmCallEvidence) => call.target.toLowerCase()))
        .toContain(HACKEN_FIXTURE_CONTEXT.hook.toLowerCase())
    }
  })

  it('executes the generated matrix against the deployed pool', () => {
    ready()
    const allowed = HACKEN_FIXTURE_CONTEXT.swapRouter
    const { snapshot } = snapshotWithHarness(allowed)
    const { scenarios, unavailable } = buildProtocolScenarioMatrix({
      key: {
        currency0: HACKEN_FIXTURE_CONTEXT.currency0,
        currency1: HACKEN_FIXTURE_CONTEXT.currency1,
        fee: HACKEN_FIXTURE_CONTEXT.fee,
        tickSpacing: HACKEN_FIXTURE_CONTEXT.tickSpacing,
        hooks: HACKEN_FIXTURE_CONTEXT.hook,
      },
      currentTick: 0,
      actor: ACTOR,
    })

    expect(unavailable).toEqual([])
    const tally = { completed: 0, reverted: 0, failed: 0 }
    const reverts: string[] = []
    for (const scenario of scenarios) {
      const step = runScenario(`matrix-${scenario.id}`, snapshot, scenario.calldata, allowed)
      if (step.status !== 'complete') {
        tally.failed++
        console.log(`  FAILED ${scenario.id}: status=${step.status} ${JSON.stringify(step.request ?? step.message ?? '').slice(0, 120)}`)
        continue
      }
      if (step.proof.success) tally.completed++
      else { tally.reverted++; reverts.push(scenario.id) }
    }

    console.log(
      `generated matrix: ${scenarios.length} scenarios · ${tally.completed} completed · `
      + `${tally.reverted} observed reverts · ${tally.failed} infrastructure failures`
      + (reverts.length ? `\n  reverted: ${reverts.join(', ')}` : ''),
    )

    // An infrastructure failure means the analyzer broke; a revert is a finding.
    expect(tally.failed, 'no scenario may fail for infrastructure reasons').toBe(0)
    expect(tally.completed, 'at least the swap family must execute').toBeGreaterThan(0)
  })

  it('executes mask-derived mutations of every exploration seed', () => {
    ready()
    const allowed = HACKEN_FIXTURE_CONTEXT.swapRouter
    const { snapshot } = snapshotWithHarness(allowed)
    const { scenarios } = buildProtocolScenarioMatrix({
      key: {
        currency0: HACKEN_FIXTURE_CONTEXT.currency0,
        currency1: HACKEN_FIXTURE_CONTEXT.currency1,
        fee: HACKEN_FIXTURE_CONTEXT.fee,
        tickSpacing: HACKEN_FIXTURE_CONTEXT.tickSpacing,
        hooks: HACKEN_FIXTURE_CONTEXT.hook,
      },
      currentTick: 0,
      actor: ACTOR,
    })
    const seeds = selectExplorationSeeds(scenarios)
    expect(seeds.length).toBeGreaterThan(0)

    let reachedPoolManager = 0
    for (const { scenario } of seeds) {
      const mask = deriveScenarioMutationMask(scenario)
      // A mutation the real mutator could produce: flip the low byte of every
      // masked region, which is where magnitude and hookData actually live.
      const bytes = Buffer.from(scenario.calldata.slice(2), 'hex')
      for (const index of mask.byteIndices) bytes[index] = (bytes[index]! ^ 0x0f) & 0xff
      const mutated = `0x${bytes.toString('hex')}` as Hex

      // The mask is the contract with the mutator: a mutation inside it must
      // still decode as the same generated scenario against the same pool.
      expect(isScenarioDerivative(mask, mutated), `${scenario.id} escaped its mask`).toBe(true)

      const step = runScenario(`mask-${scenario.id}`, snapshot, mutated, allowed)
      expect(step.status, `mutated ${scenario.id} failed: ${step.message ?? ''}`).toBe('complete')
      const targets = step.proof.calls.map((call: RevmCallEvidence) => call.target.toLowerCase())
      if (targets.includes(HACKEN_FIXTURE_CONTEXT.poolManager.toLowerCase())) reachedPoolManager++
    }
    // A mask that only mutated inert bytes would never reach the pool at all.
    expect(reachedPoolManager, 'no mask-derived mutation reached the PoolManager').toBe(seeds.length)
  })

  it('carries hook data to the hook through a permitted router', () => {
    ready()
    const allowed = HACKEN_FIXTURE_CONTEXT.swapRouter
    const { snapshot } = snapshotWithHarness(allowed)
    const step = runScenario(
      'protocol-scenario-hookdata',
      snapshot,
      swapCalldata({ zeroForOne: true, amountSpecified: -1_000n, hookData: '0x686f6f6b73636f7065' }),
      allowed,
    )
    expect(step.status).toBe('complete')
    expect(step.proof.success, `hookData swap reverted: ${step.proof.output}`).toBe(true)
  })
})
