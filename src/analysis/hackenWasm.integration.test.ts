import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  create_fork_session,
  dispose_fork_session,
  initSync,
  inspect_fork_session,
} from '../wasm/revm/hookscope_revm_wasm.js'
import { HACKEN_FIXTURE_CONTEXT, hackenFixtureSnapshot } from '../fixtures/hackenBrowserFixture'
import { buildHackenScenarios, permissionsMatchAddress, poolManagerMatches } from './hackenScenarios'

const ZERO_BYTES32 = `0x${'0'.repeat(64)}`
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`

describe('Hacken PoolManager Wasm fixture', () => {
  it('executes the upstream small-swap scenario from the generated snapshot', () => {
    const wasm = readFileSync(new URL('../wasm/revm/hookscope_revm_wasm_bg.wasm', import.meta.url))
    initSync({ module: wasm })
    const scenario = buildHackenScenarios(HACKEN_FIXTURE_CONTEXT)[0]!
    const step = scenario.steps[0]!
    const sessionId = 'vitest-hacken-small-swap'
    create_fork_session(sessionId, hackenFixtureSnapshot())
    try {
      const result = inspect_fork_session(
        sessionId,
        {
          caller: HACKEN_FIXTURE_CONTEXT.actor,
          to: step.to,
          calldata: step.calldata,
          value: '0x0',
          gasLimit: 5_000_000,
          gasPrice: '0x0',
          nonce: 0,
          chainId: HACKEN_FIXTURE_CONTEXT.chainId,
          traceLimit: 1_024,
        },
        {
          number: 1,
          beneficiary: ZERO_ADDRESS,
          timestamp: '0x6553f100',
          gasLimit: 30_000_000,
          baseFee: 0,
          difficulty: '0x0',
          prevrandao: ZERO_BYTES32,
        },
        true,
      )
      expect(result.status, JSON.stringify(result)).toBe('complete')
      expect(result.proof.engine).toBe('revm/36.0.0')
      expect(result.proof.steps.length).toBeLessThanOrEqual(1_024)
      expect(result.proof.calls.length).toBeGreaterThan(0)
    } finally {
      dispose_fork_session(sessionId)
    }
  }, 30_000)

  it('matches the expected outcome of every ported upstream scenario', () => {
    const wasm = readFileSync(new URL('../wasm/revm/hookscope_revm_wasm_bg.wasm', import.meta.url))
    initSync({ module: wasm })
    const failures: string[] = []
    let executions = 0

    const scenarios = buildHackenScenarios(HACKEN_FIXTURE_CONTEXT)
    expect(scenarios).toHaveLength(40)
    expect(scenarios.flatMap((scenario) => scenario.steps)).toHaveLength(80)
    expect(scenarios.map((scenario) => scenario.id)).toEqual(expect.arrayContaining([
      'hook-data-formats',
      'secondary-pool-open-policy',
      'secondary-pool-restricted-policy',
      'external-mutator-open-policy',
      'external-mutator-restricted-policy',
      'router-policy-pair',
      'swap-non-zero-return-deltas',
      'liquidity-non-zero-return-deltas',
    ]))

    for (const scenario of scenarios) {
      const sessionId = `vitest-${scenario.id}`
      const nonceByCaller = new Map<string, number>()
      create_fork_session(sessionId, hackenFixtureSnapshot())
      try {
        scenario.steps.forEach((step) => {
          const caller = step.caller ?? HACKEN_FIXTURE_CONTEXT.actor
          const nonce = nonceByCaller.get(caller.toLowerCase()) ?? 0
          nonceByCaller.set(caller.toLowerCase(), nonce + 1)
          const result = inspect_fork_session(
            sessionId,
            {
              caller,
              to: step.to,
              calldata: step.calldata,
              value: '0x0',
              gasLimit: 5_000_000,
              gasPrice: '0x0',
              nonce,
              chainId: HACKEN_FIXTURE_CONTEXT.chainId,
              traceLimit: 1_024,
            },
            {
              number: 1,
              beneficiary: ZERO_ADDRESS,
              timestamp: '0x6553f100',
              gasLimit: 30_000_000,
              baseFee: 0,
              difficulty: '0x0',
              prevrandao: ZERO_BYTES32,
            },
            true,
          )
          executions++
          if (result.status !== 'complete') {
            failures.push(`${scenario.upstream}/${step.label}: ${result.message}`)
            return
          }
          if (step.expected === 'success' && !result.proof.success) failures.push(`${scenario.upstream}/${step.label}: reverted`)
          if (step.expected === 'revert' && result.proof.success) failures.push(`${scenario.upstream}/${step.label}: unexpectedly completed`)
          if (step.expected === 'permissions-match' && !permissionsMatchAddress(result.proof, HACKEN_FIXTURE_CONTEXT)) {
            failures.push(`${scenario.upstream}/${step.label}: declared permissions differ from address flags`)
          }
          if (step.expected === 'pool-manager-match' && !poolManagerMatches(result.proof, HACKEN_FIXTURE_CONTEXT)) {
            failures.push(`${scenario.upstream}/${step.label}: poolManager getter differs from fixture`)
          }
        })
      } finally {
        dispose_fork_session(sessionId)
      }
    }

    expect(executions).toBe(scenarios.flatMap((scenario) => scenario.steps).length)
    expect(failures).toEqual([])
  }, 30_000)
})
