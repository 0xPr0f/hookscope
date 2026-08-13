import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters } from 'viem'
import {
  INITIALIZE_EVENT,
  buildPoolIndexBundle,
  computePoolId,
  computePoolStateSlot,
  scanInitializeLogs,
  serializeDocument,
  validateManifest,
  validatePoolIndexDocument,
} from '../../scripts/lib/pool-index-tools.mjs'

const ZERO = '0x0000000000000000000000000000000000000000'
const TOKEN = '0x1111111111111111111111111111111111111111'
const MANAGER = '0x2222222222222222222222222222222222222222'
const HOOK = '0x3333333333333333333333333333333333333333'
const BLOCK_HASH = `0x${'44'.repeat(32)}`

const chain = {
  id: 1,
  slug: 'one',
  name: 'One',
  poolManager: MANAGER,
  deploymentBlock: 10n,
}

function pool(overrides = {}) {
  const key = {
    currency0: ZERO,
    currency1: TOKEN,
    fee: 3_000,
    tickSpacing: 60,
    hook: HOOK,
    ...overrides,
  }
  const transactionHash = `0x${'ab'.repeat(32)}`
  return {
    poolId: computePoolId(key),
    ...key,
    initializedAtBlock: '12',
    transactionHash,
    replayTransactions: [{ kind: 'initialize', transactionHash, blockNumber: '12' }],
    activity: 0,
  }
}

function initializeLog(descriptor, blockNumber = 12n, logIndex = 0n) {
  return {
    address: MANAGER,
    blockNumber: `0x${blockNumber.toString(16)}`,
    transactionHash: descriptor.transactionHash,
    transactionIndex: '0x0',
    blockHash: `0x${'cd'.repeat(32)}`,
    logIndex: `0x${logIndex.toString(16)}`,
    removed: false,
    topics: encodeEventTopics({
      abi: [INITIALIZE_EVENT],
      eventName: 'Initialize',
      args: { id: descriptor.poolId, currency0: descriptor.currency0, currency1: descriptor.currency1 },
    }),
    data: encodeAbiParameters(
      parseAbiParameters('uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick'),
      [descriptor.fee, descriptor.tickSpacing, descriptor.hook, 1n, 0],
    ),
  }
}

test('pool-index bundle is deterministic, token-sharded, versioned, and runtime-valid', () => {
  const descriptor = pool()
  const first = buildPoolIndexBundle(chain, [descriptor], 10n, 20n, BLOCK_HASH)
  const second = buildPoolIndexBundle(chain, [descriptor], 10n, 20n, BLOCK_HASH)
  assert.deepEqual(first, second)
  assert.equal(first.manifest.schemaVersion, '1')
  assert.equal(first.manifest.source, 'pool-manager-initialize-logs')
  assert.equal(first.manifest.poolCount, 1)
  assert.equal(first.manifest.indexedThroughBlockHash, BLOCK_HASH)
  assert.equal(first.files.length, 2)
  for (const file of first.files) {
    const validation = validatePoolIndexDocument(file.document, { chain, expectedToken: file.token })
    assert.equal(validation.capability.status, 'passed')
    assert.equal(validation.errors.length, 0)
  }

  const filesByPath = new Map(first.files.map((file) => [file.path, file.contents]))
  assert.equal(validateManifest(first.manifest, filesByPath, chain).capability.status, 'passed')
  filesByPath.set(first.files[0].path, `${first.files[0].contents} `)
  assert.equal(validateManifest(first.manifest, filesByPath, chain).capability.status, 'degraded')
})

test('pool state slot matches the runtime Pool.State mapping location', () => {
  assert.equal(
    computePoolStateSlot(`0x${'00'.repeat(32)}`),
    '0x54cdd369e4e8a8515e52ca72ec816c2101831ad1f18bf44102ed171459c9b4f8',
  )
})

test('pool-index validator catches a mismatched PoolId and unsupported schema explicitly', () => {
  const bundle = buildPoolIndexBundle(chain, [pool()], 10n, 20n, BLOCK_HASH)
  const document = structuredClone(bundle.files[0].document)
  document.pools[0].poolId = `0x${'00'.repeat(32)}`
  const invalid = validatePoolIndexDocument(document, { chain })
  assert.equal(invalid.capability.status, 'degraded')
  assert.match(invalid.errors.join(' '), /PoolId does not match/u)
  const unsupported = validatePoolIndexDocument({ ...document, schemaVersion: '2' }, { chain })
  assert.equal(unsupported.capability.status, 'unsupported')
})

test('adaptive Initialize-log scan halves rejected ranges and deduplicates records', async () => {
  const descriptor = pool()
  const rawLog = initializeLog(descriptor)
  const ranges = []
  const result = await scanInitializeLogs({
    rpc: async (method, params) => {
      assert.equal(method, 'eth_getLogs')
      const from = BigInt(params[0].fromBlock)
      const to = BigInt(params[0].toBlock)
      ranges.push([from, to])
      if (to - from + 1n > 2n) throw new Error('range ceiling')
      return from <= 12n && to >= 12n ? [rawLog, rawLog] : []
    },
    poolManager: MANAGER,
    fromBlock: 10n,
    toBlock: 13n,
    initialChunk: 4n,
    minimumChunk: 2n,
    maxRequests: 5,
  })
  assert.deepEqual(ranges, [[10n, 13n], [10n, 11n], [12n, 13n]])
  assert.equal(result.requests, 3)
  assert.equal(result.pools.length, 1)
  assert.equal(result.pools[0].poolId, descriptor.poolId)
})

test('serialized documents end with one newline for stable checksums', () => {
  assert.equal(serializeDocument({ schemaVersion: '1' }), '{\n  "schemaVersion": "1"\n}\n')
})
