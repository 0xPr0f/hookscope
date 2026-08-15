import type { Address, Hex } from 'viem'
import type { HookChargeObservation } from '../../analysis/hookCharge'
import { formatRatePpm } from '../../analysis/hookCharge'
import type { Evidence, PoolDescriptor } from '../../domain/report'

export type DirectionalHookCharge = {
  direction: 'buy' | 'sell'
  ratesPpm: number[]
  label: string
  samples: number
  allInRatesPpm?: number[]
  allInLabel?: string
  components?: Array<{
    side: 'input' | 'output'
    ratesPpm: number[]
    label: string
    samples: number
    allInRatesPpm?: number[]
    allInLabel?: string
  }>
  /** True when one execution charged both sides, rather than separate samples varying over time. */
  simultaneousComponents?: boolean
}

export type PoolHookChargeSummary = {
  status: 'observed' | 'none-observed' | 'not-quantified'
  directions: DirectionalHookCharge[]
  directionalDifference: boolean
  lpFeeDirections: DirectionalHookCharge[]
  lpFeeDirectionalDifference: boolean
  observedSamples: number
  noChargeSamples: number
  unquantifiedSamples: number
  reason: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isAddress(value: unknown): value is Address {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
}

function isBytes32(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)
}

function isDecimal(value: unknown) {
  return typeof value === 'string' && /^-?[0-9]+$/.test(value)
}

function isUnsignedDecimal(value: unknown) {
  return typeof value === 'string' && /^[0-9]+$/.test(value)
}

function isRate(value: unknown) {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= 1_000_000
}

function isComponent(value: unknown): value is HookChargeObservation['components'][number] {
  if (!isRecord(value)
    || !isAddress(value.currency)
    || (value.side !== 'input' && value.side !== 'output')
    || !isUnsignedDecimal(value.amount)
    || !isUnsignedDecimal(value.denominator)
    || !isRate(value.ratePpm)) return false
  const hasAllInDenominator = value.allInDenominator !== undefined
  const hasAllInRate = value.allInRatePpm !== undefined
  return hasAllInDenominator === hasAllInRate
    && (!hasAllInDenominator || (isUnsignedDecimal(value.allInDenominator) && isRate(value.allInRatePpm)))
}

function isTimeline(value: unknown): value is HookChargeObservation['hookDeltaTimelines'][number] {
  return isRecord(value)
    && isAddress(value.account)
    && isAddress(value.currency)
    && isBytes32(value.slot)
    && Array.isArray(value.values)
    && value.values.every(isDecimal)
    && isDecimal(value.finalDelta)
    && typeof value.settled === 'boolean'
}

/** Reads only the stable, report-facing subset of a hook-charge record. */
export function readHookChargeObservation(value: unknown): HookChargeObservation | undefined {
  if (!isRecord(value)) return undefined
  if (value.source !== 'pool-manager-hook-delta') return undefined
  if (!['observed', 'none-observed', 'not-quantified'].includes(String(value.status))) return undefined
  if (!isBytes32(value.poolId) || !isAddress(value.hook) || !(isRate(value.poolFee) || value.poolFee === 0x800_000)) return undefined
  if (!Array.isArray(value.components) || !value.components.every(isComponent)) return undefined
  const rebateComponents = value.rebateComponents ?? []
  if (!Array.isArray(rebateComponents) || !rebateComponents.every(isComponent)) return undefined
  if (!Array.isArray(value.hookDeltaTimelines) || !value.hookDeltaTimelines.every(isTimeline)) return undefined
  if (typeof value.reason !== 'string') return undefined
  if (value.primaryRatePpm !== undefined && (
    typeof value.primaryRatePpm !== 'number'
    || !Number.isSafeInteger(value.primaryRatePpm)
    || value.primaryRatePpm < 0
  )) return undefined
  if (value.observedLpFee !== undefined && (
    typeof value.observedLpFee !== 'number'
    || !Number.isSafeInteger(value.observedLpFee)
    || value.observedLpFee < 0
  )) return undefined
  if (value.inputCurrency !== undefined && !isAddress(value.inputCurrency)) return undefined
  if (value.outputCurrency !== undefined && !isAddress(value.outputCurrency)) return undefined
  if (value.poolInputAmount !== undefined && !isUnsignedDecimal(value.poolInputAmount)) return undefined
  if (value.poolOutputAmount !== undefined && !isUnsignedDecimal(value.poolOutputAmount)) return undefined
  return { ...value, rebateComponents } as unknown as HookChargeObservation
}

function sameHex(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase()
}

/**
 * Cached report payloads are untrusted input. Bind every nested identifier back
 * to the selected pool before allowing an observation into its summary.
 */
function observationMatchesPool(observation: HookChargeObservation, pool: PoolDescriptor) {
  if (!sameHex(observation.poolId, pool.poolId) || !sameHex(observation.hook, pool.hook)) return false
  if (observation.poolFee !== pool.fee) return false

  const poolCurrencies = new Set([pool.currency0.toLowerCase(), pool.currency1.toLowerCase()])
  const { inputCurrency, outputCurrency } = observation
  const belongsToPool = (currency: Address) => poolCurrencies.has(currency.toLowerCase())

  if (observation.status === 'not-quantified') {
    // An incomplete execution may legitimately stop before both swap legs are
    // decoded. Preserve that limitation in the report, but reject any partial
    // currency metadata that contradicts the selected pool.
    if ((inputCurrency && !belongsToPool(inputCurrency)) || (outputCurrency && !belongsToPool(outputCurrency))) return false
  } else {
    // Completed observations can affect charge/no-charge conclusions, so both
    // legs must bind exactly to the selected pool before they are accepted.
    if (!inputCurrency || !outputCurrency) return false
    const observationCurrencies = new Set([inputCurrency.toLowerCase(), outputCurrency.toLowerCase()])
    if (
      observationCurrencies.size !== poolCurrencies.size
      || [...poolCurrencies].some((currency) => !observationCurrencies.has(currency))
    ) return false
  }

  const components = [...observation.components, ...observation.rebateComponents]
  if (components.some((component) => {
    if (!belongsToPool(component.currency)) return true
    const expected = component.side === 'input' ? observation.inputCurrency : observation.outputCurrency
    return expected === undefined || !sameHex(component.currency, expected)
  })) return false

  return observation.hookDeltaTimelines.every((timeline) =>
    sameHex(timeline.account, pool.hook) && belongsToPool(timeline.currency))
}

function rateLabel(rates: readonly number[]): string {
  const unique = [...new Set(rates)].sort((left, right) => left - right)
  if (!unique.length) return 'Not quantified'
  if (unique.length === 1) return formatRatePpm(unique[0]!)
  return `${formatRatePpm(unique[0]!)}–${formatRatePpm(unique.at(-1)!)}`
}

function sameRates(left: readonly number[], right: readonly number[]) {
  const a = [...new Set(left)].sort((x, y) => x - y)
  const b = [...new Set(right)].sort((x, y) => x - y)
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function directionalLabel(input: {
  rates: readonly number[]
  components: ReadonlyMap<'input' | 'output', readonly number[]>
  allInComponents: ReadonlyMap<'input' | 'output', readonly number[]>
  simultaneous: boolean
}) {
  const components = (['input', 'output'] as const).flatMap((side) => {
    const rates = input.components.get(side)
    if (!rates?.length) return []
    const allInRates = input.allInComponents.get(side)
    return [{
      side,
      ratesPpm: [...rates],
      label: rateLabel(rates),
      samples: rates.length,
      ...(allInRates?.length ? { allInRatesPpm: [...allInRates], allInLabel: rateLabel(allInRates) } : {}),
    }]
  })
  const allInComponents = components.filter((component) => component.allInLabel)
  return {
    label: components.length > 1
      ? components.map((component) => `${component.side} ${component.label}`).join(input.simultaneous ? ' + ' : ' · ')
      : components[0]?.label ?? rateLabel(input.rates),
    components,
    ...(allInComponents.length ? {
      allInRatesPpm: allInComponents.flatMap((component) => component.allInRatesPpm ?? []),
      allInLabel: allInComponents.length === 1 && components.length === 1
        ? allInComponents[0]!.allInLabel
        : allInComponents.map((component) => `${component.side} ${component.allInLabel}`).join(' + '),
    } : {}),
  }
}

const DIRECTIONAL_RATE_TOLERANCE_PPM = 100

function sameDirectionalRates(left: DirectionalHookCharge, right: DirectionalHookCharge) {
  if (!left.ratesPpm.length || !right.ratesPpm.length) return false
  const leftMin = Math.min(...left.ratesPpm)
  const leftMax = Math.max(...left.ratesPpm)
  const rightMin = Math.min(...right.ratesPpm)
  const rightMax = Math.max(...right.ratesPpm)
  return Math.abs(leftMin - rightMin) <= DIRECTIONAL_RATE_TOLERANCE_PPM
    && Math.abs(leftMax - rightMax) <= DIRECTIONAL_RATE_TOLERANCE_PPM
}

/**
 * Maps execution evidence into the scanned token's buy/sell perspective.
 *
 * The execution layer stays token-neutral: it records objective input/output
 * currencies. Only this report mapper knows which token the user scanned, so
 * it is the correct place to call an input-token swap a sell and an output-token
 * swap a buy.
 */
export function summarizePoolHookCharges(input: {
  pool: PoolDescriptor
  token: Address
  findings: readonly Evidence[]
}): PoolHookChargeSummary {
  const samples = input.findings.flatMap((finding) => {
    if (!finding.affectedPools.some((poolId) => poolId.toLowerCase() === input.pool.poolId.toLowerCase())) return []
    const observation = readHookChargeObservation(finding.technical?.hookCharge)
    if (!observation || !observationMatchesPool(observation, input.pool)) return []
    const transactionHash = typeof finding.technical?.transactionHash === 'string'
      ? finding.technical.transactionHash
      : typeof finding.technical?.historicalTransaction === 'string'
        ? finding.technical.historicalTransaction
        : undefined
    const exactHistoricalReplay = transactionHash && (
      finding.detectorId === 'revm-pool-replay'
      || finding.technical?.mutation === 'historical-replay'
    )
    return [{
      observation,
      identity: exactHistoricalReplay
        ? `historical:${input.pool.poolId.toLowerCase()}:${transactionHash.toLowerCase()}`
        : `finding:${finding.id}`,
    }]
  })
  const relevant = [...new Map(samples.map((sample) => [sample.identity, sample.observation])).values()]

  const buyRates: number[] = []
  const sellRates: number[] = []
  const buyComponentRates = new Map<'input' | 'output', number[]>()
  const sellComponentRates = new Map<'input' | 'output', number[]>()
  const buyAllInComponentRates = new Map<'input' | 'output', number[]>()
  const sellAllInComponentRates = new Map<'input' | 'output', number[]>()
  const buyLpFees: number[] = []
  const sellLpFees: number[] = []
  let buySamples = 0
  let sellSamples = 0
  let buySimultaneous = false
  let sellSimultaneous = false
  let observedSamples = 0
  let noChargeSamples = 0
  let unquantifiedSamples = 0
  for (const observation of relevant) {
    const perspective = observation.inputCurrency?.toLowerCase() === input.token.toLowerCase()
      ? 'sell' as const
      : observation.outputCurrency?.toLowerCase() === input.token.toLowerCase()
        ? 'buy' as const
        : undefined
    if (perspective && observation.observedLpFee !== undefined) {
      if (perspective === 'sell') sellLpFees.push(observation.observedLpFee)
      else buyLpFees.push(observation.observedLpFee)
    }
    if (observation.status === 'none-observed') {
      noChargeSamples++
      continue
    }
    if (observation.status !== 'observed' || observation.components.length === 0) {
      unquantifiedSamples++
      continue
    }
    const rates = observation.components.map((component) => component.ratePpm)
    const sides = new Set(observation.components.map((component) => component.side))
    if (perspective === 'sell') {
      sellRates.push(...rates)
      for (const component of observation.components) {
        const series = sellComponentRates.get(component.side) ?? []
        series.push(component.ratePpm)
        sellComponentRates.set(component.side, series)
        if (component.allInRatePpm !== undefined) {
          const allInSeries = sellAllInComponentRates.get(component.side) ?? []
          allInSeries.push(component.allInRatePpm)
          sellAllInComponentRates.set(component.side, allInSeries)
        }
      }
      sellSimultaneous ||= sides.size > 1
      sellSamples++
      observedSamples++
    } else if (perspective === 'buy') {
      buyRates.push(...rates)
      for (const component of observation.components) {
        const series = buyComponentRates.get(component.side) ?? []
        series.push(component.ratePpm)
        buyComponentRates.set(component.side, series)
        if (component.allInRatePpm !== undefined) {
          const allInSeries = buyAllInComponentRates.get(component.side) ?? []
          allInSeries.push(component.allInRatePpm)
          buyAllInComponentRates.set(component.side, allInSeries)
        }
      }
      buySimultaneous ||= sides.size > 1
      buySamples++
      observedSamples++
    } else {
      // A selected pool should contain the scanned token. Treat contradictory
      // cached evidence as unavailable instead of assigning the wrong label.
      unquantifiedSamples++
    }
  }

  const directions: DirectionalHookCharge[] = []
  if (buyRates.length) {
    const presentation = directionalLabel({ rates: buyRates, components: buyComponentRates, allInComponents: buyAllInComponentRates, simultaneous: buySimultaneous })
    directions.push({ direction: 'buy', ratesPpm: buyRates, samples: buySamples, ...presentation, simultaneousComponents: buySimultaneous })
  }
  if (sellRates.length) {
    const presentation = directionalLabel({ rates: sellRates, components: sellComponentRates, allInComponents: sellAllInComponentRates, simultaneous: sellSimultaneous })
    directions.push({ direction: 'sell', ratesPpm: sellRates, samples: sellSamples, ...presentation, simultaneousComponents: sellSimultaneous })
  }
  const lpFeeDirections: DirectionalHookCharge[] = []
  if (buyLpFees.length) lpFeeDirections.push({ direction: 'buy', ratesPpm: buyLpFees, label: rateLabel(buyLpFees), samples: buyLpFees.length })
  if (sellLpFees.length) lpFeeDirections.push({ direction: 'sell', ratesPpm: sellLpFees, label: rateLabel(sellLpFees), samples: sellLpFees.length })
  const lpFeeDirectionalDifference = buyLpFees.length > 0 && sellLpFees.length > 0 && !sameRates(buyLpFees, sellLpFees)
  const buyDirection = directions.find((direction) => direction.direction === 'buy')
  const sellDirection = directions.find((direction) => direction.direction === 'sell')

  if (observedSamples > 0) {
    const noChargeSuffix = noChargeSamples > 0
      ? ` ${noChargeSamples} additional completed execution${noChargeSamples === 1 ? '' : 's'} did not expose a quantifiable positive hook return delta.`
      : ''
    return {
      status: 'observed',
      directions,
      directionalDifference: Boolean(buyDirection && sellDirection && !sameDirectionalRates(buyDirection, sellDirection)),
      lpFeeDirections,
      lpFeeDirectionalDifference,
      observedSamples,
      noChargeSamples,
      unquantifiedSamples,
      reason: `A positive hook charge was quantified in ${observedSamples} completed single-swap execution${observedSamples === 1 ? '' : 's'} with fully settled hook deltas.${noChargeSuffix}`,
    }
  }
  if (noChargeSamples > 0) {
    return {
      status: 'none-observed',
      directions: [],
      directionalDifference: false,
      lpFeeDirections,
      lpFeeDirectionalDifference,
      observedSamples: 0,
      noChargeSamples,
      unquantifiedSamples,
      reason: `No positive PoolManager hook delta was observed in ${noChargeSamples} completed single-swap execution${noChargeSamples === 1 ? '' : 's'}.`,
    }
  }
  return {
    status: 'not-quantified',
    directions: [],
    directionalDifference: false,
    lpFeeDirections,
    lpFeeDirectionalDifference,
    observedSamples: 0,
    noChargeSamples: 0,
    unquantifiedSamples,
    reason: relevant.length
      ? 'Available executions could not be reconciled into one completed single-swap hook charge.'
      : 'No completed single-swap execution retained enough PoolManager hook accounting to quantify a charge.',
  }
}
