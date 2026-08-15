import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import {
  create_fork_session, dispose_fork_session, initSync, inspect_fork_session,
} from '../wasm/revm/hookscope_revm_wasm.js'
import { HACKEN_FIXTURE_CONTEXT, hackenFixtureSnapshot } from '../fixtures/hackenBrowserFixture'
import { buildScenarioStateOverlay } from './protocolScenarioState'
import { buildProtocolScenarioMatrix } from './protocolNativeScenarios'

/**
 * Guards the evidence a router attestation is built from.
 *
 * revm hands a nested call its input as a range into the caller's memory rather
 * than as owned bytes, so an inspector that only reads owned inputs records a
 * selector for the outermost call and nothing else. Every selector below —
 * unlock, unlockCallback, swap, the hook callbacks, the settlement calls — is a
 * nested call, so losing them would make an ordered call-path claim impossible.
 */
describe('nested call selectors', () => {
  it('resolves a selector for every nested call with input', () => {
    initSync({ module: readFileSync(new URL('../wasm/revm/hookscope_revm_wasm_bg.wasm', import.meta.url)) })
    const base = hackenFixtureSnapshot()
    const router = HACKEN_FIXTURE_CONTEXT.swapRouter
    const actor = '0x00000000000000000000000000000000000ac701' as Address
    const manager = base.accounts.find((a) => a.address.toLowerCase() === HACKEN_FIXTURE_CONTEXT.poolManager.toLowerCase())!
    const overlay = buildScenarioStateOverlay({
      poolManager: HACKEN_FIXTURE_CONTEXT.poolManager,
      poolManagerAccount: { balance: manager.balance, nonce: manager.nonce, code: manager.code },
      routers: [router], actors: [actor],
      currencies: [HACKEN_FIXTURE_CONTEXT.currency0, HACKEN_FIXTURE_CONTEXT.currency1],
    })
    const overridden = new Map(overlay.snapshot.accounts.map((a) => [a.address.toLowerCase(), a]))
    const accounts = base.accounts.map((a) => {
      const r = overridden.get(a.address.toLowerCase())
      if (!r) return a
      overridden.delete(a.address.toLowerCase())
      return { ...a, ...r, storage: { ...a.storage, ...r.storage }, storageComplete: a.storageComplete }
    })
    const snapshot = { ...base, accounts: [...accounts, ...overridden.values()] }
    const scenario = buildProtocolScenarioMatrix({
      key: {
        currency0: HACKEN_FIXTURE_CONTEXT.currency0, currency1: HACKEN_FIXTURE_CONTEXT.currency1,
        fee: HACKEN_FIXTURE_CONTEXT.fee, tickSpacing: HACKEN_FIXTURE_CONTEXT.tickSpacing, hooks: HACKEN_FIXTURE_CONTEXT.hook,
      },
      currentTick: 0, actor,
    }).scenarios.find((s) => s.id === 'swap:exact-input:0-for-1:medium')!

    create_fork_session('selector-probe', snapshot)
    const step = inspect_fork_session('selector-probe', {
      caller: actor, to: router, calldata: scenario.calldata as Hex, value: '0x0',
      gasLimit: 16_000_000, gasPrice: '0x0', nonce: 0, chainId: HACKEN_FIXTURE_CONTEXT.chainId, traceLimit: 4_096,
    }, {
      number: 2, beneficiary: '0x0000000000000000000000000000000000000000', timestamp: '0x6553f100',
      gasLimit: 30_000_000, baseFee: 0, difficulty: '0x0', prevrandao: `0x${'0'.repeat(64)}`,
    }, false)
    dispose_fork_session('selector-probe')

    const calls = step.proof.calls as { target: string; selector?: string; inputLength: number }[]
    const withInput = calls.filter((call) => call.inputLength >= 4)
    expect(withInput.length).toBeGreaterThan(2)
    expect(withInput.filter((call) => call.selector)).toHaveLength(withInput.length)

    // The v4 unlock path specifically, since that is what attestation asserts.
    const selectors = new Set(calls.map((call) => call.selector))
    for (const selector of ['0x48c89491', '0x91dd7346', '0xf3cd914c']) {
      expect(selectors, `missing ${selector} in the recorded call path`).toContain(selector)
    }
  })
})
