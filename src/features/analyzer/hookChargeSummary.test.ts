import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import type { Evidence, PoolDescriptor } from '../../domain/report'
import { readHookChargeObservation, summarizePoolHookCharges } from './hookChargeSummary'

const TOKEN = '0x1111111111111111111111111111111111111111' as Address
const OTHER = '0x2222222222222222222222222222222222222222' as Address
const HOOK = '0x3333333333333333333333333333333333333333' as Address
const OTHER_HOOK = '0x4444444444444444444444444444444444444444' as Address
const FOREIGN = '0x5555555555555555555555555555555555555555' as Address
const POOL_ID = `0x${'ab'.repeat(32)}` as Hex
const OTHER_POOL_ID = `0x${'cd'.repeat(32)}` as Hex
const pool: PoolDescriptor = {
  poolId: POOL_ID,
  currency0: TOKEN,
  currency1: OTHER,
  fee: 0,
  tickSpacing: 60,
  hook: HOOK,
  initializedAtBlock: '1',
  activity: 1,
}

function finding(input: {
  id: string
  status: 'observed' | 'none-observed' | 'not-quantified'
  inputCurrency?: Address
  outputCurrency?: Address
  ratePpm?: number
}): Evidence {
  return {
    id: input.id,
    detectorId: 'test',
    detectorVersion: '1',
    severity: 'info',
    evidenceClass: 'concrete-observation',
    subject: HOOK,
    title: 'test',
    claim: 'test',
    confidence: 'confirmed',
    affectedPools: [POOL_ID],
    reproducibility: 'replayed',
    technical: {
      hookCharge: {
        source: 'pool-manager-hook-delta',
        status: input.status,
        reason: 'test',
        poolId: POOL_ID,
        hook: HOOK,
        poolFee: 0,
        observedLpFee: input.id === 'buy' ? 5_000 : 0,
        inputCurrency: input.inputCurrency,
        outputCurrency: input.outputCurrency,
        components: input.ratePpm === undefined ? [] : [{ currency: input.inputCurrency, side: 'input', amount: '1', denominator: '10', ratePpm: input.ratePpm }],
        rebateComponents: [],
        primaryRatePpm: input.ratePpm,
        hookDeltaTimelines: [],
      },
    },
  }
}

describe('pool hook charge summary', () => {
  it('labels token input as sell-side and token output as buy-side', () => {
    const summary = summarizePoolHookCharges({
      pool,
      token: TOKEN,
      findings: [
        finding({ id: 'sell', status: 'observed', inputCurrency: TOKEN, outputCurrency: OTHER, ratePpm: 100_000 }),
        finding({ id: 'buy', status: 'observed', inputCurrency: OTHER, outputCurrency: TOKEN, ratePpm: 50_000 }),
      ],
    })
    expect(summary.status).toBe('observed')
    expect(summary.directions).toEqual([
      {
        direction: 'buy',
        ratesPpm: [50_000],
        label: '5%',
        samples: 1,
        components: [{ side: 'input', ratesPpm: [50_000], label: '5%', samples: 1 }],
        simultaneousComponents: false,
      },
      {
        direction: 'sell',
        ratesPpm: [100_000],
        label: '10%',
        samples: 1,
        components: [{ side: 'input', ratesPpm: [100_000], label: '10%', samples: 1 }],
        simultaneousComponents: false,
      },
    ])
    expect(summary.directionalDifference).toBe(true)
    expect(summary.lpFeeDirections.map(({ direction, label }) => ({ direction, label }))).toEqual([
      { direction: 'buy', label: '0.5%' },
      { direction: 'sell', label: '0%' },
    ])
    expect(summary.lpFeeDirectionalDifference).toBe(true)
  })

  it('keeps no observed hook delta distinct from not quantified', () => {
    expect(summarizePoolHookCharges({
      pool,
      token: TOKEN,
      findings: [finding({ id: 'none', status: 'none-observed', inputCurrency: TOKEN, outputCurrency: OTHER })],
    }).status).toBe('none-observed')

    expect(summarizePoolHookCharges({ pool, token: TOKEN, findings: [] }).status).toBe('not-quantified')
  })

  it('does not turn a missing positive delta into a measured zero rate', () => {
    const summary = summarizePoolHookCharges({
      pool,
      token: TOKEN,
      findings: [
        finding({ id: 'sell', status: 'observed', inputCurrency: TOKEN, outputCurrency: OTHER, ratePpm: 100_000 }),
        finding({ id: 'buy', status: 'none-observed', inputCurrency: OTHER, outputCurrency: TOKEN }),
      ],
    })
    expect(summary.directions.map(({ direction, label }) => ({ direction, label }))).toEqual([
      { direction: 'sell', label: '10%' },
    ])
    expect(summary.directionalDifference).toBe(false)
    expect(summary.reason).toContain('1 additional completed execution did not expose a quantifiable positive hook return delta')
  })

  it('deduplicates the exact historical replay retained by two report phases', () => {
    const replay = finding({ id: 'original', status: 'observed', inputCurrency: TOKEN, outputCurrency: OTHER, ratePpm: 100_000 })
    replay.detectorId = 'revm-pool-replay'
    replay.technical = { ...replay.technical, transactionHash: `0x${'12'.repeat(32)}` }
    const retained = finding({ id: 'retained', status: 'observed', inputCurrency: TOKEN, outputCurrency: OTHER, ratePpm: 100_000 })
    retained.technical = {
      ...retained.technical,
      historicalTransaction: `0x${'12'.repeat(32)}`,
      mutation: 'historical-replay',
    }

    const summary = summarizePoolHookCharges({ pool, token: TOKEN, findings: [replay, retained] })
    expect(summary.observedSamples).toBe(1)
    expect(summary.directions[0]?.samples).toBe(1)
  })

  it('retains separately quantified input and output components', () => {
    const sample = finding({ id: 'both', status: 'observed', inputCurrency: TOKEN, outputCurrency: OTHER })
    sample.technical = {
      ...sample.technical,
      hookCharge: {
        ...(sample.technical!.hookCharge as Record<string, unknown>),
        components: [
          { currency: TOKEN, side: 'input', amount: '100', denominator: '1000', ratePpm: 100_000 },
          { currency: OTHER, side: 'output', amount: '40', denominator: '800', ratePpm: 50_000 },
        ],
        primaryRatePpm: undefined,
      },
    }
    const summary = summarizePoolHookCharges({ pool, token: TOKEN, findings: [sample] })
    expect(summary.status).toBe('observed')
    expect(summary.directions[0]).toMatchObject({
      direction: 'sell',
      label: 'input 10% + output 5%',
      samples: 1,
      simultaneousComponents: true,
      components: [
        { side: 'input', label: '10%' },
        { side: 'output', label: '5%' },
      ],
    })
  })

  it('uses a range only for variation within the same charge component', () => {
    const first = finding({ id: 'first', status: 'observed', inputCurrency: TOKEN, outputCurrency: OTHER, ratePpm: 80_000 })
    const second = finding({ id: 'second', status: 'observed', inputCurrency: TOKEN, outputCurrency: OTHER, ratePpm: 100_000 })
    const summary = summarizePoolHookCharges({ pool, token: TOKEN, findings: [first, second] })

    expect(summary.directions[0]).toMatchObject({
      direction: 'sell',
      label: '8%–10%',
      simultaneousComponents: false,
      components: [{ side: 'input', label: '8%–10%' }],
    })
  })

  it('retains an input charge all-in share without replacing its nominal rate', () => {
    const sample = finding({ id: 'buy', status: 'observed', inputCurrency: OTHER, outputCurrency: TOKEN })
    sample.technical = {
      ...sample.technical,
      hookCharge: {
        ...(sample.technical!.hookCharge as Record<string, unknown>),
        components: [{
          currency: OTHER,
          side: 'input',
          amount: '369',
          denominator: '3694',
          ratePpm: 99_891,
          allInDenominator: '4063',
          allInRatePpm: 90_819,
        }],
        primaryRatePpm: 99_891,
      },
    }

    const summary = summarizePoolHookCharges({ pool, token: TOKEN, findings: [sample] })
    expect(summary.directions[0]).toMatchObject({
      direction: 'buy',
      label: '9.9891%',
      allInLabel: '9.0819%',
    })
  })

  it('does not call bounded integer rounding a directional rate difference', () => {
    const buy = finding({ id: 'buy-rounded', status: 'observed', inputCurrency: OTHER, outputCurrency: TOKEN })
    const sell = finding({ id: 'sell-rounded', status: 'observed', inputCurrency: TOKEN, outputCurrency: OTHER })
    buy.technical = {
      ...buy.technical,
      hookCharge: {
        ...(buy.technical!.hookCharge as Record<string, unknown>),
        components: [{ currency: OTHER, side: 'input', amount: '369', denominator: '3694', ratePpm: 99_891, allInDenominator: '4063', allInRatePpm: 90_819 }],
        primaryRatePpm: 99_891,
      },
    }
    sell.technical = {
      ...sell.technical,
      hookCharge: {
        ...(sell.technical!.hookCharge as Record<string, unknown>),
        components: [{ currency: OTHER, side: 'output', amount: '369', denominator: '3693', ratePpm: 99_918 }],
        primaryRatePpm: 99_918,
      },
    }

    const summary = summarizePoolHookCharges({ pool, token: TOKEN, findings: [buy, sell] })
    expect(summary.directions.map(({ direction, label, allInLabel }) => ({ direction, label, allInLabel }))).toEqual([
      { direction: 'buy', label: '9.9891%', allInLabel: '9.0819%' },
      { direction: 'sell', label: '9.9918%', allInLabel: undefined },
    ])
    expect(summary.directionalDifference).toBe(false)
  })

  it('rejects malformed nested accounting records from cached reports', () => {
    const sample = finding({ id: 'bad', status: 'observed', inputCurrency: TOKEN, outputCurrency: OTHER, ratePpm: 100_000 })
    const record = sample.technical!.hookCharge as Record<string, unknown>
    expect(readHookChargeObservation({
      ...record,
      components: [{ currency: 'not-an-address', side: 'input', amount: '1', denominator: '10', ratePpm: 100_000 }],
    })).toBeUndefined()
  })

  it.each([
    ['pool id', { poolId: OTHER_POOL_ID }],
    ['hook', { hook: OTHER_HOOK }],
    ['input currency', { inputCurrency: FOREIGN }],
  ] as const)('rejects cached hook-charge evidence with a mismatched nested %s', (_label, mismatch) => {
    const sample = finding({ id: 'mismatched-context', status: 'observed', inputCurrency: TOKEN, outputCurrency: OTHER, ratePpm: 100_000 })
    sample.technical = {
      ...sample.technical,
      hookCharge: {
        ...(sample.technical!.hookCharge as Record<string, unknown>),
        ...mismatch,
      },
    }

    const summary = summarizePoolHookCharges({ pool, token: TOKEN, findings: [sample] })
    expect(summary.status).toBe('not-quantified')
    expect(summary.observedSamples).toBe(0)
  })

  it.each(['inputCurrency', 'outputCurrency'] as const)(
    'rejects a completed cached hook-charge observation with a missing %s',
    (missingCurrency) => {
      const sample = finding({ id: `missing-${missingCurrency}`, status: 'observed', inputCurrency: TOKEN, outputCurrency: OTHER, ratePpm: 100_000 })
      const hookCharge = { ...(sample.technical!.hookCharge as Record<string, unknown>) }
      delete hookCharge[missingCurrency]
      sample.technical = { ...sample.technical, hookCharge }

      const summary = summarizePoolHookCharges({ pool, token: TOKEN, findings: [sample] })
      expect(summary.status).toBe('not-quantified')
      expect(summary.observedSamples).toBe(0)
    },
  )

  it.each(['inputCurrency', 'outputCurrency'] as const)(
    'retains a not-quantified cached observation with a missing %s',
    (missingCurrency) => {
      const sample = finding({ id: `unquantified-missing-${missingCurrency}`, status: 'not-quantified', inputCurrency: TOKEN, outputCurrency: OTHER })
      const hookCharge = { ...(sample.technical!.hookCharge as Record<string, unknown>) }
      delete hookCharge[missingCurrency]
      sample.technical = { ...sample.technical, hookCharge }

      const summary = summarizePoolHookCharges({ pool, token: TOKEN, findings: [sample] })
      expect(summary.status).toBe('not-quantified')
      expect(summary.unquantifiedSamples).toBe(1)
      expect(summary.reason).toContain('could not be reconciled')
    },
  )

  it('rejects a not-quantified cached observation when its available currency is foreign', () => {
    const sample = finding({ id: 'unquantified-foreign-currency', status: 'not-quantified', inputCurrency: FOREIGN })
    expect(summarizePoolHookCharges({ pool, token: TOKEN, findings: [sample] }).unquantifiedSamples).toBe(0)
  })

  it('rejects cached components whose currency is outside the selected pool', () => {
    const sample = finding({ id: 'foreign-component', status: 'observed', inputCurrency: TOKEN, outputCurrency: OTHER, ratePpm: 100_000 })
    sample.technical = {
      ...sample.technical,
      hookCharge: {
        ...(sample.technical!.hookCharge as Record<string, unknown>),
        components: [{ currency: FOREIGN, side: 'input', amount: '1', denominator: '10', ratePpm: 100_000 }],
      },
    }

    expect(summarizePoolHookCharges({ pool, token: TOKEN, findings: [sample] }).status).toBe('not-quantified')
  })
})
