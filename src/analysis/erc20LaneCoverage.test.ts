import { describe, expect, it, vi } from 'vitest'
import { getAddress, toHex, type Address, type Hex } from 'viem'
import { ERC20_LANE_VERSION, resolvePayerFromReplay, runErc20LaneCoverage } from './erc20LaneCoverage'
import { ERC20_SELECTORS } from './erc20Provisioning'
import { POOL_EVENT_TOPICS } from './protocolScenarioValidation'
import { CUSTOM_ROUTER_POOL_MANAGER, CUSTOM_ROUTER_SAMPLES, customRouterPoolKey } from '../fixtures/customRouter9409'
import type { LivePoolReplayCoverage } from './livePoolReplay'
import type { ProtocolScenarioContext } from './protocolScenarioContext'
import type { ProtocolScenarioOutcome } from './protocolScenarioRunner'
import type { ForkReplayResult } from './revmProof'

const sample = CUSTOM_ROUTER_SAMPLES[0]!
const key = customRouterPoolKey(sample)
const MANAGER = CUSTOM_ROUTER_POOL_MANAGER
const ERC20_HARNESS = getAddress('0x0000000000000000000000000000000000005ce6')

/** Replay coverage whose proof carries the real receipt's Transfer logs. */
const replay = {
  status: 'passed', selectedPools: 1, candidateTransactions: 1, passedTransactions: 1, coveredPools: 1,
  hydrationReads: 0, findings: [], limitations: [],
  outcomes: [{
    poolId: sample.expected.poolId, hook: sample.expected.hook, kind: 'swap',
    transactionHash: sample.transactionHash, status: 'passed',
    candidate: { transactionHash: sample.transactionHash },
    replay: {
      hydrationRequests: 0, hydratedAccounts: 0, hydratedStorageSlots: 0,
      proof: {
        engine: 'revm/36.0.0', success: true, gasUsed: 1, output: '0x',
        steps: [], storageOperations: [], storageDiffs: [], balanceChanges: [], selfdestructs: [], truncated: false,
        calls: [], logs: sample.receipt.logs, logCount: sample.receipt.logCount,
      },
    },
  }],
} as unknown as LivePoolReplayCoverage

const context = {
  chainId: 1,
  stateBlockNumber: sample.stateBlockNumber,
  executionBlock: {
    number: sample.stateBlockNumber + 1n, beneficiary: MANAGER, timestamp: 1n,
    gasLimit: 30_000_000n, baseFee: 0n, difficulty: 0n, prevrandao: `0x${'0'.repeat(64)}` as Hex,
  },
  poolManager: MANAGER,
  pool: {
    poolId: sample.expected.poolId, currency0: key.currency0, currency1: key.currency1,
    fee: key.fee, tickSpacing: key.tickSpacing, hook: key.hooks,
    initializedAtBlock: '1', activity: 1,
  },
  router: getAddress('0x0000000000000000000000000000000000005ce4'),
  alternateRouter: getAddress('0x0000000000000000000000000000000000005ce5'),
  erc20Router: ERC20_HARNESS,
  actor: getAddress('0x00000000000000000000000000000000000ac7a1'),
  alternateActor: getAddress('0x00000000000000000000000000000000000ac7a2'),
  relocatedAddresses: [],
  overlay: { snapshot: { accounts: [], blockHashes: [] } },
  slot0: { sqrtPriceX96: 1n, tick: 0, protocolFee: 0, lpFee: 0 },
} as unknown as ProtocolScenarioContext

function reply(output: Hex, success = true, extra: Record<string, unknown> = {}): ForkReplayResult {
  return {
    hydrationRequests: 0, hydratedAccounts: 0, hydratedStorageSlots: 0,
    proof: {
      engine: 'revm/36.0.0', success, gasUsed: 100, output,
      steps: [], storageOperations: [], storageDiffs: [], balanceChanges: [],
      calls: [], logs: [], logCount: 0, selfdestructs: [], truncated: false,
      ...extra,
    },
  }
}

function sessionFactory(options: { balance?: bigint; delivered?: bigint } = {}) {
  const close = vi.fn()
  const seen: string[] = []
  const preparedTokens: Address[] = []
  const poolTokens = [key.currency0, key.currency1]
    .map((token) => getAddress(token))
    .filter((token) => token !== '0x0000000000000000000000000000000000000000')
  let created = 0
  const factory = () => {
    created++
    // A real fork session starts from the pinned snapshot. Keeping this state
    // inside the factory makes the test fail if coverage accidentally reuses a
    // committed session for independent scenarios.
    const balances: Record<string, bigint> = {}
    const execute = vi.fn(async (input: { transaction: { to: Address; calldata: Hex } }) => {
      const selector = input.transaction.calldata.slice(0, 10) as Hex
      if (poolTokens.some((token) => token.toLowerCase() === input.transaction.to.toLowerCase())) {
        preparedTokens.push(input.transaction.to)
        if (selector === ERC20_SELECTORS.balanceOf) {
          const owner = getAddress(`0x${input.transaction.calldata.slice(34, 74)}`).toLowerCase()
          return reply(toHex(balances[owner] ?? (owner === sample.actor.toLowerCase() ? options.balance ?? 10n ** 21n : 0n), { size: 32 }))
        }
        if (selector === ERC20_SELECTORS.allowance) return reply(toHex(10n ** 19n, { size: 32 }))
        if (selector === ERC20_SELECTORS.approve) return reply(toHex(1n, { size: 32 }))
      }
      seen.push(selector)
      const delivered = options.delivered ?? 1_000_000n
      balances[MANAGER.toLowerCase()] = (balances[MANAGER.toLowerCase()] ?? 0n) + delivered
      // Model the exact token output acquired by the synthetic native-funded
      // actor. The round-trip implementation must carry this committed balance
      // into its reverse leg; independent scenario sessions still start clean.
      balances[context.actor.toLowerCase()] = (balances[context.actor.toLowerCase()] ?? 0n) + delivered
      return reply('0x', true, {
        calls: [
          { caller: sample.actor, target: ERC20_HARNESS, bytecodeAddress: ERC20_HARNESS, scheme: 'Call', value: '0', inputLength: 100, selector: '0x89aca655' },
          { caller: ERC20_HARNESS, target: MANAGER, bytecodeAddress: MANAGER, scheme: 'Call', value: '0', inputLength: 100, selector: '0x48c89491' },
          { caller: ERC20_HARNESS, target: sample.expected.token, bytecodeAddress: sample.expected.token, scheme: 'Call', value: '0', inputLength: 100, selector: ERC20_SELECTORS.transferFrom },
        ],
        logs: [{ address: MANAGER, topics: [POOL_EVENT_TOPICS.swap, sample.expected.poolId], data: '0x' }],
        logCount: 1,
      })
    })
    return { execute, close }
  }
  return { close, seen, preparedTokens, factory, get created() { return created } }
}

const claimsOutcomes: ProtocolScenarioOutcome[] = [
  { poolId: sample.expected.poolId, scenarioId: 'swap:exact-input:0-for-1:medium', operation: 'swap', status: 'completed' },
  { poolId: sample.expected.poolId, scenarioId: 'swap:exact-input:1-for-0:medium', operation: 'swap', status: 'completed' },
]

const base = {
  scanId: 'lane',
  signal: new AbortController().signal,
  contexts: [context],
  claimsOutcomes,
  readPayerCode: vi.fn(async () => '0x' as Hex),
}

describe('payer resolution from replay', () => {
  it('picks the non-native side and the account that funded it', () => {
    const result = resolvePayerFromReplay({
      replay, poolId: sample.expected.poolId,
      currency0: key.currency0, currency1: key.currency1, poolManager: MANAGER,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.token).toBe(sample.expected.token)
    expect(result.payer).toBe(sample.actor)
    expect(result.source).toBe('receipt-derived')
  })

  it('declines when no replay covered the pool', () => {
    const result = resolvePayerFromReplay({
      replay, poolId: `0x${'99'.repeat(32)}` as Hex,
      currency0: key.currency0, currency1: key.currency1, poolManager: MANAGER,
    })
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.reason).toContain('No receipt-matched swap replay')
  })

  it('picks the leg that moved into the PoolManager, not currency0', () => {
    // An ERC-20/ERC-20 pool where currency0 is some other token entirely. The
    // replayed transfers only ever reach the manager for the real input leg.
    const other = getAddress('0x9999999999999999999999999999999999999999')
    const result = resolvePayerFromReplay({
      replay, poolId: sample.expected.poolId,
      currency0: other, currency1: sample.expected.token, poolManager: MANAGER,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.token).toBe(sample.expected.token)
      expect(result.payer).toBe(sample.actor)
    }
  })

  it('uses the decoded Swap direction rather than the scanned token', () => {
    const result = resolvePayerFromReplay({
      replay, poolId: sample.expected.poolId,
      currency0: key.currency0, currency1: key.currency1, poolManager: MANAGER,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.token).toBe(sample.expected.token)
  })

  it('declines when nothing moved into the PoolManager', () => {
    const unrelated = getAddress('0x8888888888888888888888888888888888888888')
    const result = resolvePayerFromReplay({
      replay, poolId: sample.expected.poolId,
      currency0: unrelated, currency1: unrelated, poolManager: MANAGER,
    })
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.reason).toContain('no Transfer event')
  })

  it('declines a pool with no ERC-20 side at all', () => {
    const zero = '0x0000000000000000000000000000000000000000' as Address
    const result = resolvePayerFromReplay({
      replay, poolId: sample.expected.poolId, currency0: zero, currency1: zero, poolManager: MANAGER,
    })
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.reason).toContain('native')
  })
})

describe('ERC-20 lane coverage', () => {
  it('runs paired scenarios using the payer recovered from history', async () => {
    const harness = sessionFactory()
    const coverage = await runErc20LaneCoverage({ ...base, replay, createSession: harness.factory })

    expect(coverage.version).toBe(ERC20_LANE_VERSION)
    expect(coverage.coveredPools).toBe(1)
    expect(coverage.completed).toBeGreaterThan(0)
    // One finding per scenario outcome, plus one per committed round trip.
    expect(coverage.findings.length).toBe(coverage.outcomes.length + coverage.roundTrips.length)
    expect(coverage.roundTrips).toHaveLength(1)
    expect(coverage.findings.some((finding) => finding.detectorId === 'protocol-native-erc20-round-trip')).toBe(true)
    // Every finding names the lane and carries the comparison.
    for (const finding of coverage.findings) {
      expect(['erc20-transfers', 'erc20-transfers-with-native-value']).toContain(finding.technical!.settlement)
    }
    // The per-scenario findings carry the cross-lane comparison.
    for (const finding of coverage.findings.filter((item) => item.detectorId === 'protocol-native-erc20-lane')) {
      expect(finding.technical!.laneComparison).toBeTruthy()
    }
    // All four exact-input directions now run, including the two native-input
    // cases, and the committed round trip gets its own clean session.
    expect(harness.created).toBe(5)
    expect(harness.close).toHaveBeenCalledTimes(5)
    expect(new Set(harness.preparedTokens.map((token) => token.toLowerCase()))).toEqual(
      new Set([sample.expected.token.toLowerCase()]),
    )
  })

  it('still runs native-funded directions when no historical token holder exists', async () => {
    const harness = sessionFactory()
    const coverage = await runErc20LaneCoverage({ ...base, replay: undefined, createSession: harness.factory })

    expect(coverage.status).toBe('passed')
    expect(coverage.unavailable).toBe(0)
    expect(coverage.coveredByRoundTrip).toBe(2)
    expect(coverage.outcomes.some((outcome) => outcome.tokenRole === 'output' && outcome.status === 'completed')).toBe(true)
    expect(coverage.outcomes.filter((outcome) => outcome.coveredByRoundTrip)).toHaveLength(2)
    expect(coverage.limitations.join(' ')).toContain('covered directionally')
    // The standalone token-input calls retain their original unavailable
    // status, while the completed native-first round trip covers that direction
    // without pretending those exact standalone amounts executed.
    expect(coverage.outcomes.filter((outcome) => outcome.coveredByRoundTrip)
      .every((outcome) => outcome.status === 'preparation-unavailable')).toBe(true)
    expect(harness.seen.length).toBeGreaterThan(0)
    expect(coverage.roundTrips).toHaveLength(1)
    expect(coverage.roundTrips[0]!.status).toBe('completed')
    expect(coverage.findings.filter((finding) => finding.technical?.coveredByRoundTrip)).toHaveLength(2)
  })

  it('remains unavailable for an ERC-20/ERC-20 pool without a verified holder', async () => {
    const harness = sessionFactory()
    const tokenTokenContext = {
      ...context,
      pool: {
        ...context.pool,
        currency0: getAddress('0x1111111111111111111111111111111111111111'),
        currency1: getAddress('0x2222222222222222222222222222222222222222'),
      },
    } as ProtocolScenarioContext
    const coverage = await runErc20LaneCoverage({
      ...base,
      contexts: [tokenTokenContext],
      replay: undefined,
      createSession: harness.factory,
    })

    expect(coverage.status).toBe('unavailable')
    expect(coverage.outcomes.every((outcome) => outcome.status === 'preparation-unavailable')).toBe(true)
    expect(coverage.roundTrips).toEqual([])
    expect(harness.created).toBe(0)
  })

  it('surfaces a delivery shortfall as a token observation', async () => {
    // The pool receives less than the scenario requested.
    const harness = sessionFactory({ delivered: 1n })
    const coverage = await runErc20LaneCoverage({ ...base, replay, createSession: harness.factory })
    const shortfalls = coverage.outcomes.filter((outcome) => (outcome.observations?.shortfall ?? 0n) > 0n)
    expect(shortfalls.length).toBeGreaterThan(0)
    expect(shortfalls[0]!.classifications).toContain('pool-received-less-than-requested')
  })

  it('reports unavailable when the payer holds too little to fund a scenario', async () => {
    const harness = sessionFactory({ balance: 0n })
    const coverage = await runErc20LaneCoverage({ ...base, replay, createSession: harness.factory })
    // ERC-20-input directions cannot be funded, while native-input directions
    // still execute and observe the deployed token on the output rail.
    expect(coverage.outcomes.some((outcome) => outcome.status === 'preparation-unavailable')).toBe(true)
    expect(coverage.outcomes.some((outcome) => outcome.tokenRole === 'output' && outcome.status === 'completed')).toBe(true)
    expect(coverage.status).toBe('passed')
    expect(coverage.coveredByRoundTrip).toBe(2)
    expect(coverage.unavailable).toBe(0)
  })

  it('declines to impersonate a replay-derived contract payer', async () => {
    const harness = sessionFactory()
    const coverage = await runErc20LaneCoverage({
      ...base,
      replay,
      createSession: harness.factory,
      readPayerCode: vi.fn(async () => '0x6000' as Hex),
    })

    expect(coverage.status).toBe('passed')
    expect(coverage.coveredByRoundTrip).toBe(2)
    expect(coverage.limitations.join(' ')).toContain('covered directionally')
    expect(coverage.outcomes.some((outcome) => outcome.reason?.includes('is a contract'))).toBe(true)
    expect(coverage.outcomes.some((outcome) => outcome.tokenRole === 'output' && outcome.status === 'completed')).toBe(true)
    expect(harness.created).toBeGreaterThan(0)
  })

  it('closes its session when cancelled', async () => {
    const controller = new AbortController()
    const harness = sessionFactory()
    controller.abort()
    await expect(runErc20LaneCoverage({
      ...base, replay, signal: controller.signal, createSession: harness.factory,
    })).rejects.toThrow()
  })
})
