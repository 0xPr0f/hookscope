import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createPublicClient, http, type Address, type Hex, type PublicClient } from 'viem'
import {
  create_fork_session,
  dispose_fork_session,
  hydrate_fork_session,
  initSync,
  inspect_fork_session,
} from '../wasm/revm/hookscope_revm_wasm.js'
import { getChainConfig } from '../config/chains'
import { GRAPH_GATEWAY_ORIGIN, UNISWAP_V4_SUBGRAPHS } from '../config/subgraphs'
import { loadForkHydration } from './revmProof'

/**
 * Per-chain execution conformance, measured against the chain's own receipts.
 *
 * The chain receipt is the oracle: if revm reproduces a real transaction's
 * outcome, gas, and log count from pinned parent state, this chain's EVM
 * semantics match what the analyzer assumes. Only transactions at index 0 of
 * their block are used, because a later transaction's pre-state includes
 * in-block predecessors that replaying from the parent block cannot reproduce —
 * a mismatch there would say nothing about engine conformance.
 *
 * Opt-in, because it needs archive RPC access:
 *
 *   DIFFERENTIAL=1 CHAIN_ID=1 pnpm exec vitest run src/analysis/chainDifferential.live.test.ts
 */

const SWAP_TOPIC = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f' as Hex
const MODIFY_LIQUIDITY_TOPIC = '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec' as Hex
// Busy chains exceed the 10,000-result cap long before the 10,000-block range cap.
const MAX_LOG_RANGE = 200n
const MAX_HYDRATION_REQUESTS = 3_000
const SEARCH_WINDOWS = 40
/** Ceiling on in-block predecessors replayed to rebuild exact pre-state. */
const MAX_PRECEDING = 64

const enabled = process.env.DIFFERENTIAL === '1'
const chainId = Number(process.env.CHAIN_ID ?? 1)

function rpcUrl(): string {
  const override = process.env[`HOOKSCOPE_RPC_${chainId}`]
  if (override) return override
  const [primary] = getChainConfig(chainId).rpcUrls
  if (!primary) throw new Error(`No RPC candidate is configured for chain ${chainId}.`)
  return primary
}

/**
 * Highest transaction index whose pre-state equals the parent block's state.
 *
 * OP-stack blocks always begin with the L1-attributes deposit, so no user
 * transaction is ever at index 0. That deposit only writes L1 block attributes,
 * which pool execution does not read, so index 1 there is equivalent to index 0
 * elsewhere.
 */
function replayableIndex(variant: string) {
  return variant === 'op-stack' ? 1 : 0
}

/**
 * Asks the chain's indexer for recent swap transactions.
 *
 * This sidesteps `eth_getLogs` entirely. Log scanning has to guess a window that
 * satisfies three unrelated provider limits at once — block range, result count,
 * and response size — and an active chain breaches the result cap long before
 * the range cap. The indexer already knows which transactions touched a pool.
 */
async function indexedSwapTransactions(chainId: number, apiKey: string | undefined) {
  const published = UNISWAP_V4_SUBGRAPHS[chainId]
  if (!published || published.schema !== 'pool-entities' || !apiKey) return []
  const response = await fetch(`${GRAPH_GATEWAY_ORIGIN}/api/subgraphs/id/${published.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query: '{ swaps(first: 100, orderBy: timestamp, orderDirection: desc) { transaction { id } } }' }),
  })
  const body = await response.json() as { data?: { swaps?: { transaction?: { id?: Hex } }[] } }
  return (body.data?.swaps ?? []).map((swap) => swap.transaction?.id).filter((id): id is Hex => Boolean(id))
}

/**
 * Picks the indexed transaction with the fewest in-block predecessors.
 *
 * Requiring index 0 is unworkable on an active chain, where swaps sit deep in a
 * block. Instead the differential replays each preceding transaction with commit
 * enabled to rebuild the exact pre-state, so a low index simply keeps that
 * rebuild cheap.
 */
async function selectReplayable(client: PublicClient, hashes: readonly Hex[], maxIndex: number) {
  let best: { hash: Hex; index: number } | undefined
  let probes = 0
  for (const hash of [...new Set(hashes)]) {
    if (probes++ >= 40) break
    const receipt = await client.getTransactionReceipt({ hash }).catch(() => undefined)
    if (!receipt) continue
    if (!best || receipt.transactionIndex < best.index) best = { hash, index: receipt.transactionIndex }
    // Good enough: a handful of predecessors is cheap to rebuild.
    if (best.index <= Math.max(maxIndex, 4)) break
  }
  return best && best.index <= MAX_PRECEDING ? best.hash : undefined
}

async function findReplayableTransaction(client: PublicClient, poolManager: Address, variant: string) {
  const head = await client.getBlockNumber()
  const maxIndex = replayableIndex(variant)
  for (let window = 0; window < SEARCH_WINDOWS; window++) {
    const toBlock = head - BigInt(window) * MAX_LOG_RANGE
    const fromBlock = toBlock > MAX_LOG_RANGE ? toBlock - MAX_LOG_RANGE : 0n
    let logs: { transactionHash?: Hex; transactionIndex?: Hex }[]
    try {
      // Raw request: viem's typed getLogs overloads drop a bare topics filter.
      logs = await client.request({
        method: 'eth_getLogs',
        params: [{
          address: poolManager,
          fromBlock: `0x${fromBlock.toString(16)}`,
          toBlock: `0x${toBlock.toString(16)}`,
          // A single topic0 filter would exclude liquidity activity on quiet chains.
          topics: [[SWAP_TOPIC, MODIFY_LIQUIDITY_TOPIC]],
        }],
      } as never) as typeof logs
    } catch {
      // Range and response-size caps vary per provider; skip this window.
      continue
    }
    // Newest first: recent state is the most likely to still be served.
    for (const log of [...logs].reverse()) {
      if (!log.transactionHash) continue
      if (Number(log.transactionIndex ?? '0xff') > maxIndex) continue
      return log.transactionHash
    }
  }
  return undefined
}

describe.skipIf(!enabled)('per-chain execution conformance', () => {
  it('reproduces a real v4 transaction from pinned parent state', async () => {
    const chain = getChainConfig(chainId)
    expect(chain.poolManager, `chain ${chainId} has no PoolManager`).toBeTruthy()

    const client = createPublicClient({ transport: http(rpcUrl()) }) as PublicClient
    const indexed = await indexedSwapTransactions(chainId, process.env.SUBGRAPH_API_KEY)
    const hash = await selectReplayable(client, indexed, replayableIndex(chain.evmVariant))
      // Log scanning stays as the fallback for chains with no usable indexer.
      ?? await findReplayableTransaction(client, chain.poolManager!, chain.evmVariant)
    if (!hash) {
      console.log(`chain ${chainId}: no replayable PoolManager transaction found`)
      return
    }

    const [transaction, receipt] = await Promise.all([
      client.getTransaction({ hash }),
      client.getTransactionReceipt({ hash }),
    ])
    const block = await client.getBlock({ blockNumber: transaction.blockNumber! })
    const stateBlockNumber = transaction.blockNumber! - 1n

    initSync({ module: readFileSync(new URL('../wasm/revm/hookscope_revm_wasm_bg.wasm', import.meta.url)) })
    const sessionId = `differential-${chainId}-${hash.slice(2, 10)}`
    create_fork_session(sessionId, { accounts: [], blockHashes: [] })

    const serialize = (item: typeof transaction) => ({
      caller: item.from,
      to: item.to!,
      calldata: item.input,
      value: `0x${item.value.toString(16)}`,
      gasLimit: Number(item.gas),
      gasPrice: `0x${(item.maxFeePerGas ?? item.gasPrice ?? block.baseFeePerGas ?? 0n).toString(16)}`,
      nonce: item.nonce,
      chainId,
      traceLimit: 1_024,
    })
    const serializedTransaction = serialize(transaction)
    const serializedBlock = {
      number: Number(block.number),
      beneficiary: block.miner,
      timestamp: `0x${block.timestamp.toString(16)}`,
      gasLimit: Number(block.gasLimit),
      baseFee: Number(block.baseFeePerGas ?? 0n),
      difficulty: `0x${(block.difficulty ?? 0n).toString(16)}`,
      prevrandao: block.mixHash ?? `0x${'0'.repeat(64)}`,
    }

    let requests = 0
    const run = async (tx: Record<string, unknown>, commit: boolean) => {
      let step = inspect_fork_session(sessionId, tx, serializedBlock, commit)
      while (step.status === 'missing') {
        expect(++requests, 'hydration ceiling').toBeLessThanOrEqual(MAX_HYDRATION_REQUESTS)
        const update = await loadForkHydration({ client, stateBlockNumber, request: step.request })
        hydrate_fork_session(sessionId, update)
        step = inspect_fork_session(sessionId, tx, serializedBlock, commit)
      }
      return step
    }

    try {
      // Rebuild the target's exact pre-state by committing its in-block predecessors.
      const full = await client.getBlock({ blockNumber: transaction.blockNumber!, includeTransactions: true })
      const predecessors = (full.transactions as typeof transaction[])
        .filter((item) => typeof item === 'object' && item.transactionIndex! < receipt.transactionIndex)
        .sort((left, right) => left.transactionIndex! - right.transactionIndex!)
      for (const item of predecessors) {
        if (!item.to) continue
        await run(serialize(item), true)
      }
      const step = await run(serializedTransaction, false)
      expect(step.status, `fork step failed: ${step.message ?? ''}`).toBe('complete')

      const proof = step.proof
      const expectedSuccess = receipt.status === 'success'
      console.log(
        `chain ${chainId} tx ${hash}\n`
        + `  outcome  revm=${proof.success} chain=${expectedSuccess}\n`
        + `  gasUsed  revm=${proof.gasUsed} chain=${receipt.gasUsed}\n`
        + `  logs     revm=${proof.logCount} chain=${receipt.logs.length}\n`
        + `  predecessors replayed=${predecessors.length}\n`
        + `  hydration requests=${requests}`,
      )

      expect(proof.success).toBe(expectedSuccess)
      expect(proof.logCount).toBe(receipt.logs.length)
      expect(BigInt(proof.gasUsed)).toBe(receipt.gasUsed)
    } finally {
      dispose_fork_session(sessionId)
    }
  }, 300_000)
})
