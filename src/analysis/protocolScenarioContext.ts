import { getAddress, type Address, type Hex, type PublicClient } from 'viem'
import { computePoolStateSlot } from '../adapters/uniswapV4Pool'
import type { PoolDescriptor } from '../domain/report'
import type { ForkReplayBlock } from './revmProof'
import { buildScenarioStateOverlay, type ScenarioStateOverlay } from './protocolScenarioState'

/**
 * Pinned context for generated PoolManager scenarios.
 *
 * Deliberately independent of historical replay: it needs a discovered pool, a
 * pinned block, and read access. No historical transaction, router, or calldata
 * is consulted, which is what lets generated scenarios run when replay cannot.
 */

/**
 * Preferred deterministic addresses, documented so a report can name what was
 * injected. Each is checked for emptiness at the pinned block before use, and a
 * deterministic alternative is derived when one is already occupied.
 */
const SCENARIO_ROUTER_ADDRESS = '0x0000000000000000000000000000000000005ce4' as Address
const SCENARIO_ALTERNATE_ROUTER_ADDRESS = '0x0000000000000000000000000000000000005ce5' as Address
/** The ERC-20 settlement lane's harness, a separate compiled program. */
const SCENARIO_ERC20_ROUTER_ADDRESS = '0x0000000000000000000000000000000000005ce6' as Address
const SCENARIO_ACTOR_ADDRESS = '0x00000000000000000000000000000000000ac7a1' as Address
const SCENARIO_ALTERNATE_ACTOR_ADDRESS = '0x00000000000000000000000000000000000ac7a2' as Address

/** How many deterministic alternatives to try before giving up on a slot. */
const MAX_ADDRESS_PROBES = 64

/**
 * Derives the nth deterministic alternative for a preferred address.
 *
 * Stepping the low bytes keeps the alternative recognizable in a trace and keeps
 * the choice reproducible: the same chain and block yields the same address.
 */
function deriveAlternateAddress(preferred: Address, attempt: number): Address {
  const shifted = (BigInt(preferred) + BigInt(attempt) * 0x1_0000n) & ((1n << 160n) - 1n)
  return getAddress(`0x${shifted.toString(16).padStart(40, '0')}`)
}

const UINT160_MASK = (1n << 160n) - 1n
const UINT24_MASK = (1n << 24n) - 1n
const INT24_SIGN = 1n << 23n

export type PoolSlot0 = {
  sqrtPriceX96: bigint
  tick: number
  protocolFee: number
  lpFee: number
}

/**
 * Decodes PoolManager's packed slot0.
 *
 * Layout is `sqrtPriceX96(160) | tick(24) | protocolFee(24) | lpFee(24)`, and the
 * tick is a signed 24-bit value, so the sign bit has to be extended by hand — an
 * unsigned read would place a negative tick near 16.7 million and produce a
 * liquidity range far outside the pool.
 */
export function decodeSlot0(word: Hex): PoolSlot0 {
  const value = BigInt(word)
  const rawTick = (value >> 160n) & UINT24_MASK
  return {
    sqrtPriceX96: value & UINT160_MASK,
    tick: Number(rawTick >= INT24_SIGN ? rawTick - (1n << 24n) : rawTick),
    protocolFee: Number((value >> 184n) & UINT24_MASK),
    lpFee: Number((value >> 208n) & UINT24_MASK),
  }
}

export type ProtocolScenarioContext = {
  chainId: number
  stateBlockNumber: bigint
  executionBlock: ForkReplayBlock
  poolManager: Address
  pool: PoolDescriptor
  router: Address
  /** A second identical harness instance, so a scenario can vary the `sender` a hook sees. */
  alternateRouter: Address
  /** The ERC-20 settlement harness, present when that lane could be injected. */
  erc20Router: Address
  actor: Address
  alternateActor: Address
  /** True when a preferred synthetic address was occupied and an alternative was derived. */
  relocatedAddresses: { preferred: Address; used: Address }[]
  overlay: ScenarioStateOverlay
  /** Absent when slot0 could not be read; liquidity scenarios then report unavailable. */
  slot0?: PoolSlot0
}

const EXTSLOAD_ABI = [{
  type: 'function',
  name: 'extsload',
  stateMutability: 'view',
  inputs: [{ name: 'slot', type: 'bytes32' }],
  outputs: [{ name: 'value', type: 'bytes32' }],
}] as const

async function readSlot0(input: {
  client: PublicClient
  poolManager: Address
  poolId: Hex
  blockNumber: bigint
}): Promise<PoolSlot0 | undefined> {
  try {
    const word = await input.client.readContract({
      address: input.poolManager,
      abi: EXTSLOAD_ABI,
      functionName: 'extsload',
      args: [computePoolStateSlot(input.poolId)],
      blockNumber: input.blockNumber,
    })
    const slot0 = decodeSlot0(word)
    // An uninitialized pool reads as zero; treating that as tick 0 would invent a price.
    return slot0.sqrtPriceX96 === 0n ? undefined : slot0
  } catch {
    return undefined
  }
}

/**
 * Builds the pinned scenario context for one pool.
 *
 * Execution happens on a deterministic block derived from the pinned block, so a
 * generated observation is explicitly a simulated transaction against pinned
 * state rather than anything that occurred on chain.
 */
export async function buildProtocolScenarioContext(input: {
  client: PublicClient
  chainId: number
  poolManager: Address
  pool: PoolDescriptor
  stateBlockNumber: bigint
  pinnedBlock: { timestamp: bigint; baseFeePerGas: bigint | null; gasLimit: bigint; miner: Address }
  signal?: AbortSignal
}): Promise<ProtocolScenarioContext> {
  const poolManager = getAddress(input.poolManager)
  const [balance, nonce, code] = await Promise.all([
    input.client.getBalance({ address: poolManager, blockNumber: input.stateBlockNumber }),
    input.client.getTransactionCount({ address: poolManager, blockNumber: input.stateBlockNumber }),
    input.client.getCode({ address: poolManager, blockNumber: input.stateBlockNumber }),
  ])
  if (!code || code === '0x') throw new Error('No PoolManager code at the pinned block.')

  // Injecting a harness over an address that already holds code or a balance
  // would overwrite real chain state inside the fork, and any observation made
  // afterwards would be about a pool this chain does not have.
  const relocatedAddresses: { preferred: Address; used: Address }[] = []
  const claimed = new Set<string>([poolManager.toLowerCase()])
  const claimAddress = async (preferred: Address): Promise<Address> => {
    for (let attempt = 0; attempt < MAX_ADDRESS_PROBES; attempt++) {
      const candidate = attempt === 0 ? getAddress(preferred) : deriveAlternateAddress(preferred, attempt)
      if (claimed.has(candidate.toLowerCase())) continue
      const [candidateCode, candidateBalance, candidateNonce] = await Promise.all([
        input.client.getCode({ address: candidate, blockNumber: input.stateBlockNumber }),
        input.client.getBalance({ address: candidate, blockNumber: input.stateBlockNumber }),
        input.client.getTransactionCount({ address: candidate, blockNumber: input.stateBlockNumber }),
      ])
      const empty = (!candidateCode || candidateCode === '0x') && candidateBalance === 0n && candidateNonce === 0
      if (!empty) continue
      claimed.add(candidate.toLowerCase())
      if (attempt > 0) relocatedAddresses.push({ preferred: getAddress(preferred), used: candidate })
      return candidate
    }
    throw new Error(`No empty address was available for the synthetic account near ${preferred}.`)
  }

  const [router, alternateRouter, erc20Router, actor, alternateActor] = [
    await claimAddress(SCENARIO_ROUTER_ADDRESS),
    await claimAddress(SCENARIO_ALTERNATE_ROUTER_ADDRESS),
    await claimAddress(SCENARIO_ERC20_ROUTER_ADDRESS),
    await claimAddress(SCENARIO_ACTOR_ADDRESS),
    await claimAddress(SCENARIO_ALTERNATE_ACTOR_ADDRESS),
  ]

  const slot0 = await readSlot0({
    client: input.client,
    poolManager,
    poolId: input.pool.poolId,
    blockNumber: input.stateBlockNumber,
  })

  const overlay = buildScenarioStateOverlay({
    poolManager,
    poolManagerAccount: { balance: `0x${balance.toString(16)}`, nonce, code },
    routers: [router, alternateRouter],
    erc20Routers: [erc20Router],
    actors: [actor, alternateActor],
    currencies: [input.pool.currency0, input.pool.currency1],
  })

  return {
    chainId: input.chainId,
    stateBlockNumber: input.stateBlockNumber,
    executionBlock: {
      // One block past pinned state: a generated transaction is not claiming to
      // have occupied the pinned block.
      number: input.stateBlockNumber + 1n,
      beneficiary: input.pinnedBlock.miner,
      timestamp: input.pinnedBlock.timestamp + 12n,
      gasLimit: input.pinnedBlock.gasLimit,
      baseFee: input.pinnedBlock.baseFeePerGas ?? 0n,
      difficulty: 0n,
      prevrandao: `0x${'0'.repeat(64)}`,
    },
    poolManager,
    pool: input.pool,
    router,
    alternateRouter,
    erc20Router,
    actor,
    alternateActor,
    relocatedAddresses,
    overlay,
    slot0,
  }
}
