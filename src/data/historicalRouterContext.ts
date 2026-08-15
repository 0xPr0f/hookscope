import type { Address, Hex } from 'viem'
import {
  decodeUniswapV4Calldata,
  type DecodedUniswapV4Calldata,
  type V4PoolKey,
} from '../adapters/uniswapV4RouterCodec'
import {
  decodeCustomV4UnlockCalldata,
  CUSTOM_V4_UNLOCK_TEMPLATE,
  type CustomV4UnlockSwap,
} from '../adapters/customV4UnlockRouterCodec'
import {
  recognizeCustomRouterRuntime,
  type CustomRouterRuntimeRejection,
} from '../adapters/customV4UnlockRouterRuntime'
import { CUSTOM_ROUTER_TEMPLATE_HASH } from '../fixtures/customRouter9409'
import {
  attestCustomRouterExecution,
  type CustomRouterAttestation,
} from '../analysis/customRouterAttestation'
import type { LivePoolReplayCoverage, PoolReplayOutcome } from '../analysis/livePoolReplay'
import type { PoolReplayCandidate } from './replay'
import type { ForkHydrationRequest, ForkHydrationUpdate } from '../analysis/revmProof'
import type { PoolDescriptor } from '../domain/report'

/**
 * Recognition of the routers that historical transactions actually used.
 *
 * Two families are recognized, and they earn their standing very differently.
 * The official Universal Router envelope is decoded from a published ABI. The
 * custom family is recognized from pinned runtime bytecode plus a reproduced
 * execution trace — no published ABI exists, and nothing here should ever be
 * described as verified source.
 *
 * Recognition is optional throughout. A router this cannot place still gets its
 * exact historical replay; it simply receives no controlled variants and no
 * bounded exploration, and the report says why.
 */

export type HistoricalRouterContext =
  | {
      family: 'official'
      poolId: Hex
      transactionHash: Hex
      router: Address
      decoded: DecodedUniswapV4Calldata
    }
  | {
      family: typeof CUSTOM_V4_UNLOCK_TEMPLATE
      poolId: Hex
      transactionHash: Hex
      router: Address
      decoded: CustomV4UnlockSwap
      codeHash: Hex
      normalizedTemplateHash: Hex
      configurationAddress: Address
      attestation: CustomRouterAttestation
    }

export type HistoricalRouterRejection = {
  poolId: Hex
  transactionHash: Hex
  router: Address
  stage: 'runtime' | 'calldata' | 'attestation'
  reason: string
  detail?: CustomRouterRuntimeRejection | string
}

export type HistoricalRouterContexts = {
  /** Keyed by `poolId:transactionHash`, both lowercased. */
  byTransaction: Map<string, HistoricalRouterContext>
  rejected: HistoricalRouterRejection[]
  /** Contracts a recognized router points at, worth prefetching before execution. */
  companions: Address[]
  limitations: string[]
}

export function contextKey(poolId: Hex, transactionHash: Hex) {
  return `${poolId.toLowerCase()}:${transactionHash.toLowerCase()}`
}

type LoadHydration = (
  stateBlockNumber: bigint,
  request: ForkHydrationRequest,
) => Promise<ForkHydrationUpdate>

function poolKeyOf(pool: PoolDescriptor): V4PoolKey {
  return {
    currency0: pool.currency0,
    currency1: pool.currency1,
    fee: pool.fee,
    tickSpacing: pool.tickSpacing,
    hooks: pool.hook,
  }
}

/**
 * Reads a router's runtime at the pinned parent block.
 *
 * Routed through the scan-wide hydration cache, so when replay already hydrated
 * this account the recognition costs no extra RPC request at all.
 */
async function routerRuntime(input: {
  loadHydration: LoadHydration
  stateBlockNumber: bigint
  router: Address
}): Promise<Hex | undefined> {
  const update = await input.loadHydration(input.stateBlockNumber, { kind: 'account', address: input.router })
  return update.kind === 'account' ? update.account.code : undefined
}

/**
 * Recognizes the router behind each receipt-matched replay.
 *
 * Only outcomes that already reproduced their chain receipt are considered: a
 * recognition claim about a transaction the analyzer could not reproduce would
 * rest on nothing.
 */
export async function prepareHistoricalRouterContexts(input: {
  replay: LivePoolReplayCoverage
  pools: PoolDescriptor[]
  poolManager: Address
  loadHydration: LoadHydration
  signal: AbortSignal
  templateHash?: Hex
}): Promise<HistoricalRouterContexts> {
  const poolsById = new Map(input.pools.map((pool) => [pool.poolId.toLowerCase(), pool]))
  const byTransaction = new Map<string, HistoricalRouterContext>()
  const rejected: HistoricalRouterRejection[] = []
  const companions = new Map<string, Address>()

  const matched = input.replay.outcomes.filter(
    (outcome): outcome is PoolReplayOutcome & { candidate: PoolReplayCandidate } =>
      outcome.status === 'passed' && Boolean(outcome.candidate),
  )

  for (const outcome of matched) {
    if (input.signal.aborted) throw new DOMException('Router recognition cancelled', 'AbortError')
    const pool = poolsById.get(outcome.poolId.toLowerCase())
    if (!pool) continue
    const { candidate } = outcome
    const router = candidate.transaction.to
    const key = contextKey(pool.poolId, candidate.transactionHash)

    // The official envelope is decoded from a published ABI and needs no
    // runtime recognition, so it is tried first and costs nothing.
    const official = decodeUniswapV4Calldata(candidate.transaction.calldata)
    if (official) {
      byTransaction.set(key, {
        family: 'official',
        poolId: pool.poolId,
        transactionHash: candidate.transactionHash,
        router,
        decoded: official,
      })
      continue
    }

    // Custom family: calldata shape, runtime template, and reproduced trace all
    // have to agree before anything is generated from this transaction.
    const decoded = decodeCustomV4UnlockCalldata(candidate.transaction.calldata, {
      poolKey: poolKeyOf(pool),
      poolId: pool.poolId,
      transactionValue: candidate.transaction.value,
    })
    if (!decoded.ok) {
      rejected.push({
        poolId: pool.poolId,
        transactionHash: candidate.transactionHash,
        router,
        stage: 'calldata',
        reason: decoded.detail,
        detail: decoded.reason,
      })
      continue
    }

    let runtime: Hex | undefined
    try {
      runtime = await routerRuntime({
        loadHydration: input.loadHydration,
        stateBlockNumber: candidate.stateBlockNumber,
        router,
      })
    } catch (error) {
      if (input.signal.aborted) throw error
      rejected.push({
        poolId: pool.poolId,
        transactionHash: candidate.transactionHash,
        router,
        stage: 'runtime',
        reason: error instanceof Error ? error.message : String(error),
      })
      continue
    }
    if (!runtime || runtime === '0x') {
      rejected.push({
        poolId: pool.poolId,
        transactionHash: candidate.transactionHash,
        router,
        stage: 'runtime',
        reason: 'No router code was available at the pinned parent block.',
      })
      continue
    }

    const recognized = recognizeCustomRouterRuntime(runtime, input.templateHash ?? CUSTOM_ROUTER_TEMPLATE_HASH)
    if (!recognized.ok) {
      rejected.push({
        poolId: pool.poolId,
        transactionHash: candidate.transactionHash,
        router,
        stage: 'runtime',
        reason: recognized.detail,
        detail: recognized.reason,
      })
      continue
    }

    // The reproduced trace is the part that says what the router did, rather
    // than only what it looks like.
    if (!outcome.replay) {
      rejected.push({
        poolId: pool.poolId,
        transactionHash: candidate.transactionHash,
        router,
        stage: 'attestation',
        reason: 'The receipt-matched replay carried no execution proof to attest.',
      })
      continue
    }
    const attested = attestCustomRouterExecution({
      proof: outcome.replay.proof,
      poolManager: input.poolManager,
      router,
      hook: pool.hook,
      poolId: pool.poolId,
    })
    if (!attested.ok) {
      rejected.push({
        poolId: pool.poolId,
        transactionHash: candidate.transactionHash,
        router,
        stage: 'attestation',
        reason: attested.detail,
        detail: attested.reason,
      })
      continue
    }

    companions.set(recognized.runtime.configurationAddress.toLowerCase(), recognized.runtime.configurationAddress)
    byTransaction.set(key, {
      family: CUSTOM_V4_UNLOCK_TEMPLATE,
      poolId: pool.poolId,
      transactionHash: candidate.transactionHash,
      router,
      decoded: decoded.decoded,
      codeHash: recognized.runtime.codeHash,
      normalizedTemplateHash: recognized.runtime.normalizedTemplateHash,
      configurationAddress: recognized.runtime.configurationAddress,
      attestation: attested.attestation,
    })
  }

  const custom = [...byTransaction.values()].filter((context) => context.family !== 'official')
  const limitations = [
    rejected.length
      ? `${rejected.length} receipt-matched transaction${rejected.length === 1 ? '' : 's'} used a router this analyzer could not place; ${rejected.length === 1 ? 'it keeps' : 'they keep'} exact replay but receive no generated variants.`
      : undefined,
    custom.length
      ? `${custom.length} transaction${custom.length === 1 ? ' was' : 's were'} recognized as a custom router template derived from pinned runtime bytecode and reproduced execution, not from verified source or a published ABI.`
      : undefined,
  ].filter((value): value is string => Boolean(value))

  return { byTransaction, rejected, companions: [...companions.values()], limitations }
}

/** Report-ready identity of a recognized custom-router context. */
export function customRouterTechnical(context: HistoricalRouterContext) {
  if (context.family === 'official') return undefined
  return {
    routerFamily: context.family,
    selector: '0x9409a78f',
    runtimeCodeHash: context.codeHash,
    normalizedTemplateHash: context.normalizedTemplateHash,
    configurationAddress: context.configurationAddress,
    decodedPoolKey: context.decoded.poolKey,
    mutableFields: ['amountIn'],
    attestedCalls: context.attestation.attestedCalls,
    recognition: 'Template-derived from pinned runtime and reproduced execution',
  }
}
