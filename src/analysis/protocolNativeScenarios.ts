import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'

/**
 * Generated PoolManager scenarios, derived from a discovered PoolKey.
 *
 * Every scenario is a canonical protocol-level call through the pinned harness,
 * so the matrix is independent of whichever custom router produced a historical
 * transaction. Nothing here inspects or depends on historical calldata.
 */

/** Uniswap v4 tick bounds. */
export const MIN_TICK = -887_272
export const MAX_TICK = 887_272
/** Canonical price limits; a swap must stay strictly inside them. */
export const MIN_SQRT_PRICE_PLUS_ONE = 4_295_128_740n
export const MAX_SQRT_PRICE_MINUS_ONE =
  1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341n

export const SCENARIO_ABI = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct Step { uint8 operation; PoolKey key; bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; int24 tickLower; int24 tickUpper; int256 liquidityDelta; bytes32 salt; uint256 amount0; uint256 amount1; bytes hookData; }',
  'function run(Step[] steps) returns (int256[] deltas)',
])

export const OPERATION = { swap: 0, modifyLiquidity: 1, donate: 2 } as const

export type ScenarioPoolKey = {
  currency0: Address
  currency1: Address
  fee: number
  tickSpacing: number
  hooks: Address
}

export type ScenarioStep = {
  operation: number
  key: ScenarioPoolKey
  zeroForOne: boolean
  amountSpecified: bigint
  sqrtPriceLimitX96: bigint
  tickLower: number
  tickUpper: number
  liquidityDelta: bigint
  salt: Hex
  amount0: bigint
  amount1: bigint
  hookData: Hex
}

export type ProtocolScenario = {
  id: string
  operation: 'swap' | 'liquidity' | 'donate' | 'sequence'
  description: string
  /** The account the harness is called from. */
  caller: 'actor' | 'alternateActor'
  /**
   * Which injected harness instance to call.
   *
   * A hook's `sender` argument is whoever called the PoolManager, which is
   * always the harness — never the transaction caller. Varying the harness
   * instance is therefore the only way a generated scenario can present a
   * different `sender` to the hook.
   */
  via: 'router' | 'alternateRouter'
  /** Sequences commit each execution so the next one observes the previous. */
  commits: boolean
  steps: ScenarioStep[]
  calldata: Hex
}

export type ScenarioUnavailable = { id: string; operation: ProtocolScenario['operation']; reason: string }

export type ProtocolScenarioMatrix = {
  scenarios: ProtocolScenario[]
  unavailable: ScenarioUnavailable[]
}

const EMPTY_SALT = `0x${'0'.repeat(64)}` as Hex
const MARKER_HOOK_DATA = '0x686f6f6b73636f7065' as Hex

/** Bounded amounts: large enough to move the pool, far below any real reserve. */
const SWAP_AMOUNTS: { label: string; amount: bigint }[] = [
  { label: 'small', amount: 1_000n },
  { label: 'medium', amount: 1_000_000n },
  { label: 'bounded', amount: 1_000_000_000n },
]

function baseStep(key: ScenarioPoolKey): ScenarioStep {
  return {
    operation: OPERATION.swap,
    key,
    zeroForOne: true,
    amountSpecified: 0n,
    sqrtPriceLimitX96: MIN_SQRT_PRICE_PLUS_ONE,
    tickLower: 0,
    tickUpper: 0,
    liquidityDelta: 0n,
    salt: EMPTY_SALT,
    amount0: 0n,
    amount1: 0n,
    hookData: '0x',
  }
}

export function encodeScenario(steps: ScenarioStep[]): Hex {
  return encodeFunctionData({ abi: SCENARIO_ABI, functionName: 'run', args: [steps] })
}

function swapStep(key: ScenarioPoolKey, input: {
  zeroForOne: boolean
  amountSpecified: bigint
  hookData?: Hex
}): ScenarioStep {
  return {
    ...baseStep(key),
    operation: OPERATION.swap,
    zeroForOne: input.zeroForOne,
    amountSpecified: input.amountSpecified,
    // A swap must approach, never cross, the canonical bound for its direction.
    sqrtPriceLimitX96: input.zeroForOne ? MIN_SQRT_PRICE_PLUS_ONE : MAX_SQRT_PRICE_MINUS_ONE,
    hookData: input.hookData ?? '0x',
  }
}

/** Rounds toward negative infinity so alignment holds for negative ticks too. */
export function alignTick(tick: number, spacing: number): number {
  return Math.floor(tick / spacing) * spacing
}

/**
 * Spacing-aligned range bracketing the current tick.
 *
 * `width` counts spacings on each side, so a narrow range is the tightest
 * position the pool can hold and a wider one spans surrounding liquidity.
 */
export function alignedRange(currentTick: number, spacing: number, width: number) {
  const centre = alignTick(currentTick, spacing)
  const lowerBound = alignTick(MIN_TICK, spacing) + spacing
  const upperBound = alignTick(MAX_TICK, spacing)
  const lower = Math.max(lowerBound, centre - width * spacing)
  const upper = Math.min(upperBound, centre + width * spacing)
  return lower < upper ? { tickLower: lower, tickUpper: upper } : undefined
}

export type ScenarioMatrixInput = {
  key: ScenarioPoolKey
  /** Pool tick at the pinned block. Absent means liquidity scenarios cannot be aligned. */
  currentTick?: number
  actor: Address
}

/**
 * Builds the full generated matrix for one pool.
 *
 * Liquidity scenarios only ever add a position and then remove exactly what they
 * added; a historical LP position belonging to someone else is never touched.
 */
export function buildProtocolScenarioMatrix(input: ScenarioMatrixInput): ProtocolScenarioMatrix {
  const { key } = input
  const scenarios: ProtocolScenario[] = []
  const unavailable: ScenarioUnavailable[] = []

  const push = (
    scenario: Omit<ProtocolScenario, 'calldata' | 'via'> & { via?: ProtocolScenario['via'] },
  ) => scenarios.push({ via: 'router', ...scenario, calldata: encodeScenario(scenario.steps) })

  // Swaps: both directions, exact input and exact output, bounded amounts.
  for (const { label, amount } of SWAP_AMOUNTS) {
    for (const zeroForOne of [true, false]) {
      for (const exactInput of [true, false]) {
        const direction = zeroForOne ? '0-for-1' : '1-for-0'
        const mode = exactInput ? 'exact-input' : 'exact-output'
        push({
          id: `swap:${mode}:${direction}:${label}`,
          operation: 'swap',
          description: `${mode} ${direction} swap of a ${label} amount`,
          caller: 'actor',
          commits: false,
          // Negative is exact input, positive is exact output.
          steps: [swapStep(key, { zeroForOne, amountSpecified: exactInput ? -amount : amount })],
        })
      }
    }
  }

  // Hook data shapes on a single representative swap.
  for (const [label, hookData] of [
    ['empty', '0x' as Hex],
    ['marker', MARKER_HOOK_DATA],
    ['abi-actor', `0x${input.actor.slice(2).toLowerCase().padStart(64, '0')}` as Hex],
  ] as const) {
    push({
      id: `swap:hook-data:${label}`,
      operation: 'swap',
      description: `exact-input 0-for-1 swap carrying ${label} hookData`,
      caller: 'actor',
      commits: false,
      steps: [swapStep(key, { zeroForOne: true, amountSpecified: -1_000n, hookData })],
    })
  }

  // Alternate sender: the same swap driven by a second, byte-identical harness
  // instance at a different address, sent by a different actor. This is what a
  // hook that gates on its caller actually sees change.
  push({
    id: 'swap:alternate-sender',
    operation: 'swap',
    description: 'exact-input 0-for-1 swap driven by a second identical harness instance at a different address, sent by an alternate synthetic actor',
    caller: 'alternateActor',
    via: 'alternateRouter',
    commits: false,
    steps: [swapStep(key, { zeroForOne: true, amountSpecified: -1_000n })],
  })

  // Repeated swaps in one committed sequence expose transient or one-shot gates.
  push({
    id: 'sequence:repeated-swap',
    operation: 'sequence',
    description: 'two exact-input swaps executed in one committed sequence',
    caller: 'actor',
    commits: true,
    steps: [
      swapStep(key, { zeroForOne: true, amountSpecified: -1_000n }),
      swapStep(key, { zeroForOne: true, amountSpecified: -1_000n }),
    ],
  })

  // Liquidity requires a tick to align against.
  if (input.currentTick === undefined) {
    unavailable.push({
      id: 'liquidity:*',
      operation: 'liquidity',
      reason: 'The pool tick was not readable at the pinned block, so no spacing-aligned range could be derived.',
    })
  } else {
    const narrow = alignedRange(input.currentTick, key.tickSpacing, 1)
    const wide = alignedRange(input.currentTick, key.tickSpacing, 10)
    if (!narrow) {
      unavailable.push({
        id: 'liquidity:*',
        operation: 'liquidity',
        reason: `Tick ${input.currentTick} with spacing ${key.tickSpacing} yields no valid aligned range inside the protocol tick bounds.`,
      })
    } else {
      const liquidity = 1_000_000_000n
      const add = (range: { tickLower: number; tickUpper: number }, delta: bigint): ScenarioStep => ({
        ...baseStep(key),
        operation: OPERATION.modifyLiquidity,
        tickLower: range.tickLower,
        tickUpper: range.tickUpper,
        liquidityDelta: delta,
      })

      push({
        id: 'liquidity:add:narrow',
        operation: 'liquidity',
        description: `add liquidity across a narrow aligned range [${narrow.tickLower}, ${narrow.tickUpper}]`,
        caller: 'actor',
        commits: false,
        steps: [add(narrow, liquidity)],
      })

      if (wide) {
        push({
          id: 'liquidity:add:wide',
          operation: 'liquidity',
          description: `add liquidity across a wider aligned range [${wide.tickLower}, ${wide.tickUpper}]`,
          caller: 'actor',
          commits: false,
          steps: [add(wide, liquidity)],
        })
      }

      // Add then remove exactly what was added: the pool must return to start.
      push({
        id: 'sequence:add-then-remove',
        operation: 'sequence',
        description: 'add a position and remove exactly the added liquidity in one sequence',
        caller: 'actor',
        commits: false,
        steps: [add(narrow, liquidity), add(narrow, -liquidity)],
      })

      push({
        id: 'sequence:partial-removal',
        operation: 'sequence',
        description: 'add a position and remove half of the added liquidity',
        caller: 'actor',
        commits: false,
        steps: [add(narrow, liquidity), add(narrow, -(liquidity / 2n))],
      })

      push({
        id: 'sequence:repeated-adds',
        operation: 'sequence',
        description: 'two liquidity additions to the same aligned range in one sequence',
        caller: 'actor',
        commits: false,
        steps: [add(narrow, liquidity), add(narrow, liquidity)],
      })
    }
  }

  // Donations.
  const donate = (amount0: bigint, amount1: bigint): ScenarioStep => ({
    ...baseStep(key),
    operation: OPERATION.donate,
    amount0,
    amount1,
  })
  for (const [label, amount0, amount1] of [
    ['currency0', 1_000_000n, 0n],
    ['currency1', 0n, 1_000_000n],
    ['both', 1_000_000n, 1_000_000n],
    ['minimal', 1n, 1n],
  ] as const) {
    push({
      id: `donate:${label}`,
      operation: 'donate',
      description: `donate ${label} to the pool`,
      caller: 'actor',
      commits: false,
      steps: [donate(amount0, amount1)],
    })
  }
  push({
    id: 'sequence:repeated-donation',
    operation: 'sequence',
    description: 'two donations executed in one sequence',
    caller: 'actor',
    commits: false,
    steps: [donate(1_000n, 1_000n), donate(1_000n, 1_000n)],
  })

  return { scenarios, unavailable }
}
