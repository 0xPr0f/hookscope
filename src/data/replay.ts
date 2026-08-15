import { getAddress, toEventSelector, type Address, type Hex, type PublicClient } from 'viem'
import type { ForkReplayBlock, ForkReplayTransaction } from '../analysis/revmProof'
import type { PoolDescriptor, PoolReplayKind, PoolReplayReference } from '../domain/report'

const EVENT_TOPICS: Record<PoolReplayKind, Hex> = {
  initialize: toEventSelector('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)'),
  swap: toEventSelector('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)'),
  'modify-liquidity': toEventSelector('ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)'),
  donate: toEventSelector('Donate(bytes32,address,uint256,uint256)'),
}

export type PoolReplayCandidate = {
  kind: PoolReplayKind
  poolId: Hex
  transactionHash: Hex
  stateBlockNumber: bigint
  transaction: ForkReplayTransaction
  block: ForkReplayBlock
  expected: {
    success: boolean
    gasUsed: bigint
    logCount: number
  }
}

export type InitializationReplayCandidate = PoolReplayCandidate & { kind: 'initialize' }

export function replayReferencesForPool(pool: PoolDescriptor): PoolReplayReference[] {
  const references: PoolReplayReference[] = pool.transactionHash
    ? [{ kind: 'initialize', transactionHash: pool.transactionHash, blockNumber: pool.initializedAtBlock }]
    : []
  references.push(...(pool.replayTransactions ?? []))
  const unique = new Map<string, PoolReplayReference>()
  for (const reference of references) {
    unique.set(`${reference.kind}:${reference.transactionHash.toLowerCase()}`, reference)
  }
  const kindPriority: Record<PoolReplayKind, number> = { swap: 0, 'modify-liquidity': 1, donate: 2, initialize: 3 }
  return [...unique.values()].sort((left, right) => {
    const kindOrder = kindPriority[left.kind] - kindPriority[right.kind]
    if (kindOrder !== 0) return kindOrder
    const blockOrder = BigInt(right.blockNumber) - BigInt(left.blockNumber)
    if (blockOrder !== 0n) return blockOrder < 0n ? -1 : 1
    return left.transactionHash.localeCompare(right.transactionHash)
  })
}

function receiptContainsPoolEvent(input: {
  receipt: Awaited<ReturnType<PublicClient['getTransactionReceipt']>>
  poolManager: Address
  poolId: Hex
  kind: PoolReplayKind
}) {
  const topic = EVENT_TOPICS[input.kind].toLowerCase()
  return input.receipt.logs.some((log) =>
    log.address.toLowerCase() === input.poolManager.toLowerCase()
      && log.topics[0]?.toLowerCase() === topic
      && log.topics[1]?.toLowerCase() === input.poolId.toLowerCase(),
  )
}

export async function loadPoolReplayCandidate(
  client: PublicClient,
  chainId: number,
  poolManager: Address,
  pool: PoolDescriptor,
  reference: PoolReplayReference,
): Promise<PoolReplayCandidate> {
  const [transaction, receipt] = await Promise.all([
    client.getTransaction({ hash: reference.transactionHash }),
    client.getTransactionReceipt({ hash: reference.transactionHash }),
  ])
  if (transaction.blockNumber === null || transaction.to === null) {
    throw new Error('The indexed replay transaction is not a mined call transaction.')
  }
  if (transaction.blockNumber !== BigInt(reference.blockNumber)) throw new Error('The indexed replay block does not match the mined transaction.')
  if (receipt.transactionHash.toLowerCase() !== reference.transactionHash.toLowerCase()) throw new Error('The replay receipt identity does not match the indexed transaction.')
  if (!receiptContainsPoolEvent({ receipt, poolManager, poolId: pool.poolId, kind: reference.kind })) {
    throw new Error(`The indexed transaction receipt has no ${reference.kind} event for this PoolId from the configured PoolManager.`)
  }
  const block = await client.getBlock({ blockNumber: transaction.blockNumber })
  const stateBlockNumber = transaction.blockNumber > 0n ? transaction.blockNumber - 1n : 0n
  const gasPrice = transaction.maxFeePerGas ?? transaction.gasPrice ?? block.baseFeePerGas ?? 0n

  return {
    kind: reference.kind,
    poolId: pool.poolId,
    transactionHash: reference.transactionHash,
    stateBlockNumber,
    transaction: {
      caller: getAddress(transaction.from),
      to: getAddress(transaction.to),
      calldata: transaction.input,
      value: transaction.value,
      gasLimit: transaction.gas,
      gasPrice,
      nonce: transaction.nonce,
      chainId,
      maxPriorityFeePerGas: transaction.maxPriorityFeePerGas ?? undefined,
    },
    block: {
      number: block.number,
      beneficiary: getAddress(block.miner),
      timestamp: block.timestamp,
      gasLimit: block.gasLimit,
      baseFee: block.baseFeePerGas ?? 0n,
      difficulty: block.difficulty,
      prevrandao: block.mixHash ?? undefined,
    },
    expected: {
      success: receipt.status === 'success',
      gasUsed: receipt.gasUsed,
      logCount: receipt.logs.length,
    },
  }
}

export async function loadInitializationReplayCandidate(
  client: PublicClient,
  chainId: number,
  poolManager: Address,
  pool: PoolDescriptor,
): Promise<InitializationReplayCandidate> {
  const reference = replayReferencesForPool(pool).find((candidate) => candidate.kind === 'initialize')
  if (!reference) throw new Error('The pool Initialize event has no transaction hash.')
  return await loadPoolReplayCandidate(client, chainId, poolManager, pool, reference) as InitializationReplayCandidate
}
