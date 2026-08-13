import { createHash } from 'node:crypto'
import {
  decodeEventLog,
  encodeAbiParameters,
  getAddress,
  isAddress,
  keccak256,
  encodePacked,
  parseAbiItem,
  parseAbiParameters,
  toEventSelector,
} from 'viem'
import { capability, safeError } from './tooling-outcomes.mjs'
import { parseQuantity, toQuantity } from './read-only-rpc.mjs'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/u
const HASH = /^0x[0-9a-fA-F]{64}$/u
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u
const REPLAY_KINDS = new Set(['initialize', 'swap', 'modify-liquidity', 'donate'])

export const INITIALIZE_EVENT = parseAbiItem(
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
)

function decimalBigInt(value, label) {
  const text = String(value)
  if (!DECIMAL.test(text)) throw new Error(`${label} must be a non-negative decimal integer.`)
  return BigInt(text)
}

function safeInteger(value, label, minimum, maximum) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} is outside its supported integer range.`)
  }
  return parsed
}

function address(value, label) {
  if (typeof value !== 'string' || !ADDRESS.test(value) || !isAddress(value)) {
    throw new Error(`${label} is not an EVM address.`)
  }
  return getAddress(value)
}

export function computePoolId(pool) {
  return keccak256(encodeAbiParameters(
    parseAbiParameters('address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks'),
    [
      address(pool.currency0, 'currency0'),
      address(pool.currency1, 'currency1'),
      safeInteger(pool.fee, 'fee', 0, 0xffffff),
      safeInteger(pool.tickSpacing, 'tickSpacing', -0x800000, 0x7fffff),
      address(pool.hook ?? pool.hooks, 'hook'),
    ],
  ))
}

export function computePoolStateSlot(poolId) {
  if (typeof poolId !== 'string' || !HASH.test(poolId)) throw new Error('PoolId is not a bytes32 value.')
  return keccak256(encodePacked(['bytes32', 'uint256'], [poolId, 6n]))
}

function normalizeReplayTransactions(value, initializedAtBlock, warnings) {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('replayTransactions must be an array.')
  if (value.length > 16) throw new Error('replayTransactions exceeds the 16-reference ceiling.')
  const seen = new Set()
  const normalized = []
  for (const reference of value) {
    if (!reference || typeof reference !== 'object') throw new Error('Replay reference must be an object.')
    if (!REPLAY_KINDS.has(reference.kind)) throw new Error(`Unsupported replay reference kind: ${String(reference.kind)}.`)
    if (typeof reference.transactionHash !== 'string' || !HASH.test(reference.transactionHash)) {
      throw new Error('Replay reference has an invalid transaction hash.')
    }
    const blockNumber = decimalBigInt(reference.blockNumber, 'Replay reference block number')
    if (blockNumber < initializedAtBlock) throw new Error('Replay reference predates pool initialization.')
    const key = `${reference.kind}:${reference.transactionHash.toLowerCase()}`
    if (seen.has(key)) {
      warnings.push(`Duplicate replay reference ${key} is ignored by the browser loader.`)
      continue
    }
    seen.add(key)
    normalized.push({
      kind: reference.kind,
      transactionHash: reference.transactionHash.toLowerCase(),
      blockNumber: blockNumber.toString(),
    })
  }
  return normalized
}

export function normalizePool(pool, token, warnings = []) {
  if (!pool || typeof pool !== 'object' || Array.isArray(pool)) throw new Error('Pool entry must be an object.')
  const currency0 = address(pool.currency0 ?? pool.token0?.id, 'currency0')
  const currency1 = address(pool.currency1 ?? pool.token1?.id, 'currency1')
  const hook = address(pool.hook ?? pool.hooks, 'hook')
  const normalizedToken = address(token, 'document token')
  if (currency0.toLowerCase() !== normalizedToken.toLowerCase() && currency1.toLowerCase() !== normalizedToken.toLowerCase()) {
    throw new Error('Pool entry does not contain the document token.')
  }
  if (typeof pool.poolId !== 'string' && typeof pool.id !== 'string') throw new Error('Pool entry has no PoolId.')
  const poolId = String(pool.poolId ?? pool.id).toLowerCase()
  if (!HASH.test(poolId)) throw new Error('Pool entry has an invalid PoolId.')
  const initializedAtBlock = decimalBigInt(
    pool.initializedAtBlock ?? pool.createdAtBlockNumber,
    'Pool initialization block',
  )
  const transactionHash = pool.transactionHash === undefined ? undefined : String(pool.transactionHash).toLowerCase()
  if (transactionHash !== undefined && !HASH.test(transactionHash)) throw new Error('Pool entry has an invalid transaction hash.')
  const normalized = {
    poolId,
    currency0,
    currency1,
    fee: safeInteger(pool.fee ?? pool.feeTier, 'fee', 0, 0xffffff),
    tickSpacing: safeInteger(pool.tickSpacing, 'tickSpacing', -0x800000, 0x7fffff),
    hook,
    initializedAtBlock: initializedAtBlock.toString(),
    ...(transactionHash === undefined ? {} : { transactionHash }),
    ...(pool.replayTransactions === undefined
      ? {}
      : { replayTransactions: normalizeReplayTransactions(pool.replayTransactions, initializedAtBlock, warnings) }),
    ...(pool.liquidity === undefined ? {} : { liquidity: String(pool.liquidity) }),
    activity: Math.max(0, Number(pool.activity ?? pool.txCount ?? 0) || 0),
  }
  if (computePoolId(normalized).toLowerCase() !== poolId) {
    throw new Error(`PoolId does not match its pool key: ${poolId}.`)
  }
  return normalized
}

export function validatePoolIndexDocument(document, options = {}) {
  const errors = []
  const warnings = []
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return { capability: capability('degraded', 'Pool-index document is not an object.'), errors: ['Document must be an object.'], warnings }
  }
  if (document.schemaVersion !== '1') {
    return {
      capability: capability('unsupported', `Pool-index schema ${String(document.schemaVersion)} is unsupported.`),
      errors: [],
      warnings,
    }
  }
  let token
  let manager
  let indexedThroughBlock
  try { token = address(document.token, 'document token') } catch (error) { errors.push(safeError(error)) }
  try { manager = address(document.poolManager, 'document PoolManager') } catch (error) { errors.push(safeError(error)) }
  try { indexedThroughBlock = decimalBigInt(document.indexedThroughBlock, 'Indexed-through block') } catch (error) { errors.push(safeError(error)) }
  if (!Number.isSafeInteger(document.chainId) || document.chainId <= 0) errors.push('Document has an invalid chain ID.')
  if (document.generatedAt !== undefined && Number.isNaN(Date.parse(document.generatedAt))) errors.push('Document has an invalid generatedAt timestamp.')
  if (!Array.isArray(document.pools)) errors.push('Document pools must be an array.')

  const chain = options.chain
  if (chain) {
    if (document.chainId !== chain.id) errors.push(`Document chain ID does not match ${chain.slug}.`)
    if (manager && chain.poolManager && manager.toLowerCase() !== chain.poolManager.toLowerCase()) {
      errors.push(`Document PoolManager does not match ${chain.slug}.`)
    }
    if (indexedThroughBlock !== undefined && chain.deploymentBlock !== undefined && indexedThroughBlock < chain.deploymentBlock) {
      errors.push('Document ends before the configured PoolManager deployment block.')
    }
    if (chain.poolManager && getAddress(chain.poolManager) !== chain.poolManager) {
      warnings.push('The chain registry PoolManager is not checksummed; the current browser loader compares its normalized address case-sensitively.')
    }
  }
  if (options.expectedToken && token && token.toLowerCase() !== address(options.expectedToken, 'expected token').toLowerCase()) {
    errors.push('Document token does not match the expected token.')
  }

  const pools = []
  const seen = new Set()
  if (token && Array.isArray(document.pools)) {
    for (let index = 0; index < document.pools.length; index += 1) {
      try {
        const pool = normalizePool(document.pools[index], token, warnings)
        if (seen.has(pool.poolId)) errors.push(`Pool ${pool.poolId} appears more than once.`)
        seen.add(pool.poolId)
        if (indexedThroughBlock !== undefined && BigInt(pool.initializedAtBlock) > indexedThroughBlock) {
          errors.push(`Pool ${pool.poolId} was initialized after indexedThroughBlock.`)
        }
        pools.push(pool)
      } catch (error) {
        errors.push(`Pool ${index}: ${safeError(error)}`)
      }
    }
  }
  const status = errors.length > 0 || warnings.length > 0 ? 'degraded' : 'passed'
  const reason = errors.length > 0
    ? `${errors.length} pool-index validation error${errors.length === 1 ? '' : 's'}.`
    : warnings.length > 0
      ? `${warnings.length} compatibility warning${warnings.length === 1 ? '' : 's'}.`
      : `Validated ${pools.length} pool entr${pools.length === 1 ? 'y' : 'ies'}.`
  return { capability: capability(status, reason, { pools: pools.length }), errors, warnings, pools }
}

export function decodeInitializeLog(log) {
  if (!log || typeof log !== 'object') throw new Error('Initialize log must be an object.')
  if (log.removed === true) return undefined
  const decoded = decodeEventLog({
    abi: [INITIALIZE_EVENT],
    data: log.data,
    topics: log.topics,
    strict: true,
  })
  const blockNumber = parseQuantity(log.blockNumber, 'log block number')
  if (typeof log.transactionHash !== 'string' || !HASH.test(log.transactionHash)) {
    throw new Error('Initialize log has an invalid transaction hash.')
  }
  const pool = {
    poolId: decoded.args.id.toLowerCase(),
    currency0: getAddress(decoded.args.currency0),
    currency1: getAddress(decoded.args.currency1),
    fee: Number(decoded.args.fee),
    tickSpacing: Number(decoded.args.tickSpacing),
    hook: getAddress(decoded.args.hooks),
    initializedAtBlock: blockNumber.toString(),
    transactionHash: log.transactionHash.toLowerCase(),
    replayTransactions: [{
      kind: 'initialize',
      transactionHash: log.transactionHash.toLowerCase(),
      blockNumber: blockNumber.toString(),
    }],
    activity: 0,
  }
  if (computePoolId(pool).toLowerCase() !== pool.poolId) {
    throw new Error(`Initialize log PoolId does not match its pool key: ${pool.poolId}.`)
  }
  return pool
}

export async function scanInitializeLogs(options) {
  const {
    rpc,
    poolManager,
    fromBlock,
    toBlock,
    initialChunk = 50_000n,
    minimumChunk = 500n,
    maxRequests = 10_000,
    onProgress,
  } = options
  if (fromBlock > toBlock) throw new Error('fromBlock must not exceed toBlock.')
  if (initialChunk <= 0n || minimumChunk <= 0n) throw new Error('Log chunk sizes must be positive.')
  const unique = new Map()
  let cursor = fromBlock
  let chunk = initialChunk
  let requests = 0
  while (cursor <= toBlock) {
    if (requests >= maxRequests) throw new Error(`Pool-index generation exceeded its ${maxRequests}-request ceiling.`)
    const end = cursor + chunk - 1n < toBlock ? cursor + chunk - 1n : toBlock
    requests += 1
    try {
      const logs = await rpc('eth_getLogs', [{
        address: getAddress(poolManager),
        topics: [toEventSelector(INITIALIZE_EVENT)],
        fromBlock: toQuantity(cursor),
        toBlock: toQuantity(end),
      }])
      if (!Array.isArray(logs)) throw new Error('eth_getLogs returned a non-array result.')
      for (const log of logs) {
        const pool = decodeInitializeLog(log)
        if (!pool) continue
        const previous = unique.get(pool.poolId)
        if (previous && JSON.stringify(previous) !== JSON.stringify(pool)) {
          throw new Error(`Conflicting Initialize logs for ${pool.poolId}.`)
        }
        unique.set(pool.poolId, pool)
      }
      onProgress?.({ fromBlock: cursor, toBlock: end, requests, pools: unique.size })
      cursor = end + 1n
    } catch (error) {
      if (chunk <= minimumChunk) throw error
      chunk = chunk / 2n < minimumChunk ? minimumChunk : chunk / 2n
    }
  }
  const pools = [...unique.values()].sort((left, right) => {
    const blockOrder = BigInt(left.initializedAtBlock) - BigInt(right.initializedAtBlock)
    if (blockOrder !== 0n) return blockOrder < 0n ? -1 : 1
    return left.poolId.localeCompare(right.poolId)
  })
  return { pools, requests, finalChunk: chunk }
}

export function serializeDocument(document) {
  return `${JSON.stringify(document, null, 2)}\n`
}

function checksum(contents) {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`
}

export function buildPoolIndexBundle(chain, pools, indexedFromBlock, indexedThroughBlock, indexedThroughBlockHash) {
  if (!chain.poolManager || chain.deploymentBlock === undefined) {
    throw new Error(`${chain.name} has no verified PoolManager deployment.`)
  }
  const normalizedManager = getAddress(chain.poolManager)
  const uniquePools = new Map()
  for (const pool of pools) {
    const normalized = normalizePool(pool, pool.currency0)
    const previous = uniquePools.get(normalized.poolId)
    if (previous && JSON.stringify(previous) !== JSON.stringify(normalized)) {
      throw new Error(`Conflicting pool records for ${normalized.poolId}.`)
    }
    uniquePools.set(normalized.poolId, normalized)
  }
  const byToken = new Map()
  for (const pool of uniquePools.values()) {
    for (const token of new Set([pool.currency0, pool.currency1])) {
      const key = token.toLowerCase()
      const entry = byToken.get(key) ?? { token, pools: [] }
      entry.pools.push(pool)
      byToken.set(key, entry)
    }
  }
  const files = [...byToken.values()]
    .sort((left, right) => left.token.toLowerCase().localeCompare(right.token.toLowerCase()))
    .map(({ token, pools: tokenPools }) => {
      const document = {
        schemaVersion: '1',
        chainId: chain.id,
        poolManager: normalizedManager,
        token,
        indexedThroughBlock: indexedThroughBlock.toString(),
        pools: [...tokenPools].sort((left, right) => left.poolId.localeCompare(right.poolId)),
      }
      const contents = serializeDocument(document)
      return {
        path: `${token.toLowerCase()}.json`,
        token,
        pools: tokenPools.length,
        checksum: checksum(contents),
        document,
        contents,
      }
    })
  const manifest = {
    schemaVersion: '1',
    chainId: chain.id,
    chainSlug: chain.slug,
    poolManager: normalizedManager,
    indexedFromBlock: indexedFromBlock.toString(),
    indexedThroughBlock: indexedThroughBlock.toString(),
    indexedThroughBlockHash,
    source: 'pool-manager-initialize-logs',
    poolCount: uniquePools.size,
    tokenCount: files.length,
    documents: files.map((file) => ({
      token: file.token,
      path: file.path,
      pools: file.pools,
      checksum: file.checksum,
    })),
  }
  return { manifest, files }
}

export function validateManifest(manifest, filesByPath, chain) {
  const errors = []
  const warnings = []
  if (!manifest || typeof manifest !== 'object' || manifest.schemaVersion !== '1') {
    return { capability: capability('unsupported', 'Pool-index manifest schema is unsupported.'), errors, warnings: [] }
  }
  if (manifest.chainId !== chain.id) errors.push('Manifest chain ID does not match the selected chain.')
  if (String(manifest.poolManager).toLowerCase() !== String(chain.poolManager).toLowerCase()) {
    errors.push('Manifest PoolManager does not match the selected chain.')
  }
  let indexedFromBlock
  let indexedThroughBlock
  try { indexedFromBlock = decimalBigInt(manifest.indexedFromBlock, 'Manifest indexed-from block') } catch (error) { errors.push(safeError(error)) }
  try { indexedThroughBlock = decimalBigInt(manifest.indexedThroughBlock, 'Manifest indexed-through block') } catch (error) { errors.push(safeError(error)) }
  if (indexedFromBlock !== undefined && indexedThroughBlock !== undefined && indexedFromBlock > indexedThroughBlock) {
    errors.push('Manifest indexed-from block exceeds indexed-through block.')
  }
  if (chain.deploymentBlock !== undefined && indexedFromBlock !== undefined && indexedFromBlock < chain.deploymentBlock) {
    errors.push('Manifest starts before the configured PoolManager deployment block.')
  }
  if (manifest.source !== 'pool-manager-initialize-logs') errors.push('Manifest has an unsupported source.')
  if (typeof manifest.indexedThroughBlockHash !== 'string' || !HASH.test(manifest.indexedThroughBlockHash)) {
    errors.push('Manifest has an invalid indexed-through block hash.')
  }
  if (!Number.isSafeInteger(manifest.poolCount) || manifest.poolCount < 0) errors.push('Manifest has an invalid pool count.')
  if (!Number.isSafeInteger(manifest.tokenCount) || manifest.tokenCount < 0) errors.push('Manifest has an invalid token count.')
  if (!Array.isArray(manifest.documents)) errors.push('Manifest documents must be an array.')
  if (Array.isArray(manifest.documents)) {
    if (manifest.tokenCount !== manifest.documents.length) errors.push('Manifest token count does not match its document list.')
    const paths = new Set()
    const uniquePools = new Set()
    for (const entry of manifest.documents) {
      if (!entry || typeof entry !== 'object') {
        errors.push('Manifest document entry must be an object.')
        continue
      }
      if (typeof entry.path !== 'string' || !/^0x[0-9a-f]{40}\.json$/u.test(entry.path)) {
        errors.push(`Manifest has an invalid document path: ${String(entry.path)}.`)
        continue
      }
      if (paths.has(entry.path)) errors.push(`Manifest document path appears more than once: ${entry.path}.`)
      paths.add(entry.path)
      if (typeof entry.token !== 'string' || `${entry.token.toLowerCase()}.json` !== entry.path) {
        errors.push(`Manifest token does not match its document path: ${entry.path}.`)
      }
      if (!Number.isSafeInteger(entry.pools) || entry.pools < 0) errors.push(`Manifest has an invalid pool count for ${entry.path}.`)
      const contents = filesByPath.get(entry.path)
      if (contents === undefined) {
        errors.push(`Manifest document is missing: ${String(entry.path)}.`)
        continue
      }
      if (checksum(contents) !== entry.checksum) errors.push(`Manifest checksum does not match: ${entry.path}.`)
      try {
        const document = JSON.parse(contents)
        const validation = validatePoolIndexDocument(document, { chain, expectedToken: entry.token })
        errors.push(...validation.errors.map((error) => `${entry.path}: ${error}`))
        warnings.push(...validation.warnings.map((warning) => `${entry.path}: ${warning}`))
        if (document.indexedThroughBlock !== manifest.indexedThroughBlock) {
          errors.push(`${entry.path}: indexed-through block does not match the manifest.`)
        }
        if (entry.pools !== validation.pools?.length) {
          errors.push(`${entry.path}: pool count does not match the manifest entry.`)
        }
        for (const pool of validation.pools ?? []) uniquePools.add(pool.poolId)
      } catch (error) {
        errors.push(`${entry.path}: ${safeError(error)}`)
      }
    }
    if (Number.isSafeInteger(manifest.poolCount) && manifest.poolCount !== uniquePools.size) {
      errors.push('Manifest unique pool count does not match its documents.')
    }
    for (const path of filesByPath.keys()) {
      if (!paths.has(path)) warnings.push(`Unreferenced JSON document: ${path}.`)
    }
  }
  return {
    capability: capability(
      errors.length > 0 || warnings.length > 0 ? 'degraded' : 'passed',
      errors.length > 0
        ? `${errors.length} manifest validation error${errors.length === 1 ? '' : 's'}.`
        : warnings.length > 0
          ? `${warnings.length} manifest warning${warnings.length === 1 ? '' : 's'}.`
          : 'Manifest checksums passed.',
    ),
    errors,
    warnings,
  }
}
