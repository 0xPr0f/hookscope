import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseChainRegistry, selectChains } from '../../scripts/lib/chain-registry.mjs'
import { runChainCanary } from '../../scripts/lib/chain-canary-tools.mjs'
import { computePoolId } from '../../scripts/lib/pool-index-tools.mjs'
import { createRpcClient, parseQuantity, selectRpc, toQuantity } from '../../scripts/lib/read-only-rpc.mjs'
import { aggregateCapabilities, capability, commandArguments, safeError } from '../../scripts/lib/tooling-outcomes.mjs'

const SOURCE = `
  const config = (input: unknown) => input
  export const CHAINS = [
    config({ id: 1, slug: 'one', name: 'One', shortName: 'ONE', explorerUrl: 'https://explorer.test', publicRpcs: ['https://rpc.test'], poolManager: '0x2222222222222222222222222222222222222222', deploymentBlock: 100n, evmVariant: 'ethereum', confirmations: 12, deepExecution: true }),
    config({ id: 2, slug: 'two', name: 'Two', shortName: 'TWO', explorerUrl: 'https://explorer.test', publicRpcs: [], evmVariant: 'other', confirmations: 5, deepExecution: false, limitation: 'Deployment is not verified.' }),
  ]
`

test('chain registry parser reads literal config without executing Vite environment access', () => {
  const chains = parseChainRegistry(SOURCE)
  assert.equal(chains.length, 2)
  assert.equal(chains[0].deploymentBlock, 100n)
  assert.deepEqual(selectChains(chains, ['two', '1']).map((chain) => chain.id), [2, 1])
  assert.deepEqual(selectChains(chains, ['all']).map((chain) => chain.id), [1, 2])
})

test('capability aggregation preserves explicit degraded and unsupported outcomes', () => {
  assert.equal(aggregateCapabilities({ a: capability('unsupported', 'not configured') }), 'unsupported')
  assert.equal(aggregateCapabilities({ a: capability('unsupported', 'optional'), b: capability('passed', 'readable') }), 'passed')
  assert.equal(aggregateCapabilities({ a: capability('passed', 'readable'), b: capability('degraded', 'timed out') }), 'degraded')
  assert.deepEqual(commandArguments(['--', '--chain', 'one']), ['--chain', 'one'])
})

test('read-only RPC client validates identity, rotates candidates, and redacts endpoint text', async () => {
  const calls = []
  const chain = parseChainRegistry(SOURCE)[0]
  const result = await selectRpc(chain, {
    candidates: [
      { url: 'https://secret.example/first-key', source: 'environment' },
      { url: 'https://public.example', source: 'public-registry' },
    ],
    fetcher: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) })
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: url.includes('secret') ? '0x2' : '0x1' }))
    },
  })
  assert.equal(result.source, 'public-registry')
  assert.equal(result.attempt, 2)
  assert.deepEqual(calls.map((call) => call.body.method), ['eth_chainId', 'eth_chainId'])
  assert.equal(safeError(new Error('request to https://secret.example/key failed')).includes('secret.example'), false)

  const rpc = createRpcClient('https://rpc.test', {
    fetcher: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x10' })),
  })
  assert.equal(await rpc('eth_blockNumber'), '0x10')
  assert.equal(parseQuantity('0x10', 'block'), 16n)
  assert.equal(toQuantity(16n), '0x10')
})

test('chain canary reports read-only capability states without treating optional discovery as a pass', async () => {
  const chain = parseChainRegistry(SOURCE)[0]
  const methods = []
  const result = await runChainCanary(chain, {
    selectRpc: async () => ({
      source: 'test',
      attempt: 1,
      rpc: async (method) => {
        methods.push(method)
        if (method === 'eth_blockNumber') return '0x100'
        if (method === 'eth_getCode') return '0x6000'
        throw new Error(`Unexpected method ${method}`)
      },
    }),
    environment: {},
  })
  assert.equal(result.readOnly, true)
  assert.equal(result.status, 'passed')
  assert.equal(result.capabilities.rpcRead.status, 'passed')
  assert.equal(result.capabilities.deploymentState.status, 'passed')
  assert.equal(result.capabilities.historicalState.status, 'passed')
  assert.equal(result.capabilities.poolDiscovery.status, 'unsupported')
  assert.equal(result.capabilities.indexedPoolState.status, 'unsupported')
  assert.deepEqual(methods, ['eth_blockNumber', 'eth_getCode', 'eth_getCode'])
})

test('chain canary makes unavailable deployments explicit', async () => {
  const chain = parseChainRegistry(SOURCE)[1]
  const result = await runChainCanary(chain, {
    selectRpc: async () => { throw new Error('No endpoint') },
    environment: {},
  })
  assert.equal(result.capabilities.registry.status, 'unsupported')
  assert.equal(result.capabilities.rpcRead.status, 'degraded')
  assert.equal(result.capabilities.deploymentState.status, 'unsupported')
  assert.equal(result.capabilities.poolDiscovery.status, 'unsupported')
  assert.equal(result.capabilities.indexedPoolState.status, 'unsupported')
})

test('chain canary validates a static candidate and samples initialized pool state', async () => {
  const chain = parseChainRegistry(SOURCE)[0]
  const token = '0x1111111111111111111111111111111111111111'
  const zero = '0x0000000000000000000000000000000000000000'
  const key = { currency0: zero, currency1: token, fee: 3_000, tickSpacing: 60, hook: zero }
  const result = await runChainCanary(chain, {
    token,
    environment: { HOOKSCOPE_POOL_INDEX_1: 'https://index.test/{token}.json' },
    fetcher: async () => new Response(JSON.stringify({
      schemaVersion: '1',
      chainId: 1,
      poolManager: chain.poolManager,
      token,
      indexedThroughBlock: '240',
      pools: [{ poolId: computePoolId(key), ...key, initializedAtBlock: '120' }],
    })),
    selectRpc: async () => ({
      source: 'test',
      attempt: 1,
      rpc: async (method) => {
        if (method === 'eth_blockNumber') return '0x100'
        if (method === 'eth_getCode') return '0x6000'
        if (method === 'eth_getStorageAt') return '0x01'
        throw new Error(`Unexpected method ${method}`)
      },
    }),
  })
  assert.equal(result.capabilities.poolDiscovery.status, 'passed')
  assert.equal(result.capabilities.indexedPoolState.status, 'passed')
  assert.deepEqual(result.capabilities.indexedPoolState.evidence, {
    candidates: 1,
    eligible: 1,
    sampled: 1,
    verified: 1,
    sampleLimit: 16,
  })
})
