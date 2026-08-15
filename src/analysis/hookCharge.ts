import { getAddress, toFunctionSelector, type Address, type Hex } from 'viem'
import {
  currencyDeltaSlot,
  decodeCurrencyDeltaTimelines,
  decodeSignedDelta,
  type CurrencyDeltaTimeline,
} from './currencyDeltas'
import { decodePoolManagerSwaps } from './poolEvents'
import type { RevmExecutionProof } from './revmProof'

const RATE_SCALE_PPM = 1_000_000n
const POOL_MANAGER_SWAP_SELECTOR = toFunctionSelector(
  'function swap((address,address,uint24,int24,address),(bool,int256,uint160),bytes)',
)

export type HookChargeComponent = {
  currency: Address
  side: 'input' | 'output'
  amount: string
  /** Pool-side trade amount used to express the nominal charge rate. */
  denominator: string
  /** Parts per million. 100,000 is 10%. */
  ratePpm: number
  /** For an input-side surcharge, the total amount paid including the charge. */
  allInDenominator?: string
  /** Charge as a share of total input paid, when distinct from the nominal rate. */
  allInRatePpm?: number
}

export type HookChargeObservation = {
  source: 'pool-manager-hook-delta'
  status: 'observed' | 'none-observed' | 'not-quantified'
  reason: string
  poolId: Hex
  hook: Address
  poolFee: number
  /** Actual LP fee emitted for this swap; the pool key may only say Dynamic. */
  observedLpFee?: number
  inputCurrency?: Address
  outputCurrency?: Address
  poolInputAmount?: string
  poolOutputAmount?: string
  components: HookChargeComponent[]
  /** Hook-funded value returned to the swap rather than collected from it. */
  rebateComponents: HookChargeComponent[]
  /** Set only when every charge component shares one denominator. */
  primaryRatePpm?: number
  hookDeltaTimelines: CurrencyDeltaTimeline[]
}

function absolute(value: bigint) {
  return value < 0n ? -value : value
}

function ratePpm(amount: bigint, denominator: bigint): number | undefined {
  if (amount <= 0n || denominator <= 0n) return undefined
  const scaled = (amount * RATE_SCALE_PPM) / denominator
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) return undefined
  return Number(scaled)
}

function sameAddress(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase()
}

function poolManagerOperationFrame(input: {
  proof: RevmExecutionProof
  poolManager: Address
}): { frameId: number } | undefined {
  const swaps = input.proof.calls.filter((call) =>
    call.committed !== false
    && sameAddress(call.target, input.poolManager)
    && call.selector !== undefined
    && call.selector.toLowerCase() === POOL_MANAGER_SWAP_SELECTOR)
  if (swaps.length !== 1) return undefined
  const frameId = swaps[0]!.frameId
  if (frameId === undefined) return undefined
  return { frameId }
}

function returnedHookDelta(input: {
  proof: RevmExecutionProof
  poolManager: Address
  hook: Address
  currency: Address
  operationFrameId: number
}): bigint | undefined {
  const slot = currencyDeltaSlot(input.hook, input.currency).toLowerCase()
  // EIP-1153 transient storage starts at zero for the transaction. Following
  // every write below advances this to the real value at swap entry.
  let transactionValue = 0n
  let returned: bigint | undefined
  for (const access of input.proof.storageOperations) {
    if (
      access.opcode !== 'TSTORE'
      || access.frameId === undefined
      || !sameAddress(access.storageAddress ?? access.address, input.poolManager)
      || access.slot?.toLowerCase() !== slot
      || access.value === undefined
    ) continue
    const next = decodeSignedDelta(access.value)
    if (access.frameId === input.operationFrameId) {
      const applied = next - transactionValue
      // PoolManager accounts the hook's returned BalanceDelta once per currency
      // in the swap frame. More than one non-zero application is not safely
      // attributable to a single callback result.
      if (applied !== 0n) {
        if (returned !== undefined) return undefined
        returned = applied
      }
    }
    // Transient storage is transaction-scoped, not call-frame-scoped. A prior
    // PoolManager operation can leave this slot non-zero when swap() begins, so
    // every committed write to the exact slot must advance the entry value even
    // when it occurred outside the selected swap's call tree.
    transactionValue = next
  }
  return returned ?? 0n
}

function base(input: {
  poolId: Hex
  hook: Address
  poolFee: number
  status: HookChargeObservation['status']
  reason: string
  timelines?: CurrencyDeltaTimeline[]
}): HookChargeObservation {
  return {
    source: 'pool-manager-hook-delta',
    status: input.status,
    reason: input.reason,
    poolId: input.poolId,
    hook: getAddress(input.hook),
    poolFee: input.poolFee,
    components: [],
    rebateComponents: [],
    hookDeltaTimelines: input.timelines ?? [],
  }
}

/**
 * Reconstructs a hook's per-swap custom charge from PoolManager accounting.
 *
 * `Swap.fee` contains only the LP fee. A return-delta hook is accounted
 * separately under the hook address in PoolManager transient storage. A hook
 * that returns a positive delta normally takes or mints the matching value in a
 * nested callback first (negative balance), then PoolManager applies the return
 * delta in the outer swap frame and settles it to zero. The signed transition in
 * that exact frame distinguishes a charge from a hook-funded rebate.
 *
 * Multi-operation executions are deliberately not apportioned until their event
 * records also carry frame identity; accepting only one PoolManager operation
 * prevents a different pool or callback from contaminating this observation.
 */
export function observeHookCharge(input: {
  proof: RevmExecutionProof
  poolManager: Address
  poolId: Hex
  hook: Address
  currency0: Address
  currency1: Address
  poolFee: number
}): HookChargeObservation {
  const hook = getAddress(input.hook)
  if (!input.proof.success) {
    return base({
      ...input,
      status: 'not-quantified',
      reason: 'The execution reverted, so its intermediate hook accounting was not an executed charge.',
    })
  }
  // `truncated` also covers the bounded instruction-PC list. Calls and storage
  // operations are unbounded, and `logCount === logs.length` proves the event
  // stream used here is complete, so instruction-only truncation is harmless.
  if (input.proof.truncated && input.proof.logCount !== input.proof.logs.length) {
    return base({
      ...input,
      status: 'not-quantified',
      reason: 'The execution log stream was truncated before complete hook accounting could be proven.',
    })
  }

  const operation = poolManagerOperationFrame(input)
  const allSwaps = decodePoolManagerSwaps(input.proof, input.poolManager)
  const selectedSwaps = allSwaps.filter((swap) => swap.poolId.toLowerCase() === input.poolId.toLowerCase())
  if (!operation || allSwaps.length !== 1 || selectedSwaps.length !== 1) {
    return base({
      ...input,
      status: 'not-quantified',
      reason: selectedSwaps.length === 0
        ? 'No completed Swap event for the selected PoolId was available to price hook accounting.'
        : 'The execution did not expose exactly one frame-attributed PoolManager swap operation, so its hook deltas were not apportioned.',
    })
  }
  const timelines = decodeCurrencyDeltaTimelines({
    proof: input.proof,
    poolManager: input.poolManager,
    accounts: [hook],
    currencies: [input.currency0, input.currency1],
  })
  if (timelines.some((timeline) => !timeline.settled)) {
    return base({
      ...input,
      status: 'not-quantified',
      reason: 'A decoded hook currency delta did not settle to zero by the end of execution.',
      timelines,
    })
  }

  const swap = selectedSwaps[0]!
  const legs = [
    { currency: getAddress(input.currency0), amount: swap.amount0 },
    { currency: getAddress(input.currency1), amount: swap.amount1 },
  ]
  const inputLeg = legs.find((leg) => leg.amount < 0n)
  const outputLeg = legs.find((leg) => leg.amount > 0n)
  if (!inputLeg || !outputLeg) {
    return base({
      ...input,
      status: 'not-quantified',
      reason: 'The selected Swap event did not expose one unambiguous input leg and one output leg.',
      timelines,
    })
  }

  const poolInputAmount = absolute(inputLeg.amount)
  const poolOutputAmount = absolute(outputLeg.amount)
  const components: HookChargeComponent[] = []
  const rebateComponents: HookChargeComponent[] = []
  for (const currency of [getAddress(input.currency0), getAddress(input.currency1)]) {
    const returned = returnedHookDelta({
      proof: input.proof,
      poolManager: input.poolManager,
      hook,
      currency,
      operationFrameId: operation.frameId,
    })
    if (returned === undefined) {
      return base({
        ...input,
        status: 'not-quantified',
        reason: 'More than one hook-delta application occurred in the selected swap frame.',
        timelines,
      })
    }
    if (returned === 0n) continue
    const amount = absolute(returned)
    const side = currency.toLowerCase() === inputLeg.currency.toLowerCase()
      ? 'input' as const
      : currency.toLowerCase() === outputLeg.currency.toLowerCase()
        ? 'output' as const
        : undefined
    if (!side) continue

    // The nominal rate always uses the pool-side trade amount. This makes an
    // input surcharge directly comparable with an output deduction. For input
    // charges we also preserve the charge's share of the user's total payment
    // as a distinct all-in metric instead of silently swapping denominators.
    const charge = returned > 0n
    const denominator = side === 'input'
      ? poolInputAmount
      : poolOutputAmount
    const rate = ratePpm(amount, denominator)
    const allInDenominator = charge && side === 'input' ? poolInputAmount + amount : undefined
    const allInRate = allInDenominator === undefined ? undefined : ratePpm(amount, allInDenominator)
    if (rate === undefined || (allInDenominator !== undefined && allInRate === undefined) || (!charge && amount > denominator) || (charge && side === 'output' && amount > denominator)) {
      return base({
        ...input,
        status: 'not-quantified',
        reason: 'The observed hook credit could not be reconciled with the selected swap amount.',
        timelines,
      })
    }
    const component = {
      currency,
      side,
      amount: amount.toString(),
      denominator: denominator.toString(),
      ratePpm: rate,
      ...(allInDenominator === undefined ? {} : {
        allInDenominator: allInDenominator.toString(),
        allInRatePpm: allInRate,
      }),
    }
    if (charge) components.push(component)
    else rebateComponents.push(component)
  }

  const commonDenominator = components.length > 0
    && components.every((component) => component.currency.toLowerCase() === components[0]!.currency.toLowerCase())
  const observation: HookChargeObservation = {
    source: 'pool-manager-hook-delta',
    status: components.length ? 'observed' : 'none-observed',
    reason: components.length
      ? 'The selected swap frame applied a positive hook return delta that settled the hook’s earlier withdrawal to zero.'
      : rebateComponents.length
        ? 'No hook charge was observed; the selected swap instead received a hook-funded rebate.'
        : 'No non-zero hook return delta was applied during this completed single-swap execution.',
    poolId: input.poolId,
    hook,
    poolFee: input.poolFee,
    observedLpFee: swap.fee,
    inputCurrency: inputLeg.currency,
    outputCurrency: outputLeg.currency,
    poolInputAmount: poolInputAmount.toString(),
    poolOutputAmount: poolOutputAmount.toString(),
    components,
    rebateComponents,
    hookDeltaTimelines: timelines,
  }
  if (commonDenominator) {
    observation.primaryRatePpm = components.reduce((total, component) => total + component.ratePpm, 0)
  }
  return observation
}

export function formatRatePpm(rate: number): string {
  const percent = rate / 10_000
  return `${Number(percent.toFixed(4))}%`
}
