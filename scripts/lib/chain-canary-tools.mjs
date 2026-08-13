import { getAddress, isAddress } from 'viem'
import { selectRpc } from './read-only-rpc.mjs'
import { aggregateCapabilities, capability, safeError } from './tooling-outcomes.mjs'
import { computePoolStateSlot, validatePoolIndexDocument } from './pool-index-tools.mjs'

function codePresent(value) {
  return typeof value === 'string' && /^0x[0-9a-f]+$/iu.test(value) && value !== '0x' && !/^0x0+$/iu.test(value)
}

function sourceConfiguration(chain, environment) {
  return {
    poolIndexUrl: environment[`HOOKSCOPE_POOL_INDEX_${chain.id}`]
      ?? environment[`VITE_V4_POOL_INDEX_${chain.id}`]
      ?? chain.poolIndexUrl,
    subgraphUrl: environment[`HOOKSCOPE_SUBGRAPH_${chain.id}`]
      ?? environment[`VITE_V4_SUBGRAPH_${chain.id}`]
      ?? chain.subgraphUrl,
  }
}

export function resolveIndexTemplate(template, chain, token) {
  return template
    .replaceAll('{chainId}', String(chain.id))
    .replaceAll('{chainSlug}', chain.slug)
    .replaceAll('{token}', token.toLowerCase())
}

async function fetchJson(url, init, timeoutMs, fetcher) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal })
    if (!response.ok) throw new Error(`Index source returned HTTP ${response.status}.`)
    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > 32 * 1024 * 1024) {
      throw new Error('Index response exceeds the 32 MiB resource ceiling.')
    }
    const contents = await response.text()
    if (Buffer.byteLength(contents) > 32 * 1024 * 1024) {
      throw new Error('Index response exceeds the 32 MiB resource ceiling.')
    }
    return JSON.parse(contents)
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Index request exceeded ${timeoutMs} ms.`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function canaryStaticIndex(chain, token, url, options) {
  const document = await fetchJson(
    resolveIndexTemplate(url, chain, token),
    { headers: { accept: 'application/json' } },
    options.timeoutMs,
    options.fetcher,
  )
  const result = validatePoolIndexDocument(document, { chain, expectedToken: token })
  return {
    ...result.capability,
    candidates: result.pools ?? [],
    evidence: {
      source: 'static-index',
      pools: result.pools?.length ?? 0,
      indexedThroughBlock: document.indexedThroughBlock === undefined ? undefined : String(document.indexedThroughBlock),
    },
  }
}

const SUBGRAPH_CANARY_QUERY = `
  query PoolIndexCanary($token: String!) {
    token0Pools: pools(first: 1, orderBy: id, orderDirection: asc, where: { token0: $token }) {
      id token0 { id } token1 { id } feeTier tickSpacing hooks liquidity txCount createdAtBlockNumber
    }
    token1Pools: pools(first: 1, orderBy: id, orderDirection: asc, where: { token1: $token }) {
      id token0 { id } token1 { id } feeTier tickSpacing hooks liquidity txCount createdAtBlockNumber
    }
    _meta { block { number } hasIndexingErrors }
  }
`

async function canarySubgraph(chain, token, url, options) {
  const body = await fetchJson(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ query: SUBGRAPH_CANARY_QUERY, variables: { token: token.toLowerCase() } }),
  }, options.timeoutMs, options.fetcher)
  if (body.errors?.length) throw new Error(body.errors.map((error) => error.message ?? 'Subgraph request failed.').join(' '))
  const indexedThroughBlock = body.data?._meta?.block?.number
  if (!Number.isSafeInteger(indexedThroughBlock) || indexedThroughBlock < 0) {
    throw new Error('Subgraph did not report an indexed block.')
  }
  const document = {
    schemaVersion: '1',
    chainId: chain.id,
    poolManager: chain.poolManager,
    token,
    indexedThroughBlock: String(indexedThroughBlock),
    pools: [...(body.data?.token0Pools ?? []), ...(body.data?.token1Pools ?? [])].map((pool) => ({
      ...pool,
      poolId: pool.id,
    })),
  }
  const result = validatePoolIndexDocument(document, { chain, expectedToken: token })
  const indexingErrors = body.data?._meta?.hasIndexingErrors === true
  return {
    status: indexingErrors || result.capability.status === 'degraded' ? 'degraded' : result.capability.status,
    reason: indexingErrors ? 'Subgraph reports indexing errors.' : result.capability.reason,
    candidates: result.pools ?? [],
    evidence: { source: 'subgraph', pools: result.pools?.length ?? 0, indexedThroughBlock: String(indexedThroughBlock) },
  }
}

async function verifyIndexedPoolState(chain, discovery, rpc, blockNumber) {
  const candidates = discovery.candidates ?? []
  if (discovery.status === 'unsupported') {
    return capability('unsupported', 'Pool discovery is unsupported, so indexed state cannot be sampled.')
  }
  if (candidates.length === 0) {
    return capability(
      discovery.status === 'degraded' ? 'degraded' : 'unsupported',
      discovery.status === 'degraded'
        ? 'Pool discovery did not produce valid candidates for a state sample.'
        : 'The canary token has no indexed pool candidate to sample.',
    )
  }
  if (!rpc || blockNumber === undefined) {
    return capability('degraded', 'RPC reads are unavailable, so indexed pool state was not sampled.')
  }
  const eligible = candidates.filter((pool) => BigInt(pool.initializedAtBlock) <= blockNumber)
  if (eligible.length === 0) {
    return capability('unsupported', 'Indexed candidates were initialized after the confirmed canary block.')
  }
  const sample = eligible.slice(0, 16)
  let verified = 0
  try {
    for (const pool of sample) {
      const value = await rpc('eth_getStorageAt', [
        chain.poolManager,
        computePoolStateSlot(pool.poolId),
        `0x${blockNumber.toString(16)}`,
      ])
      if (typeof value !== 'string' || !/^0x[0-9a-f]+$/iu.test(value)) {
        throw new Error('eth_getStorageAt returned an invalid storage value.')
      }
      if (BigInt(value) !== 0n) verified += 1
    }
  } catch (error) {
    return capability('degraded', safeError(error), { candidates: candidates.length, sampled: sample.length, verified })
  }
  const passed = verified === sample.length
  return capability(
    passed ? 'passed' : 'degraded',
    passed ? 'Bounded indexed pool-state sample passed.' : 'One or more indexed candidates have no initialized state at the confirmed block.',
    { candidates: candidates.length, eligible: eligible.length, sampled: sample.length, verified, sampleLimit: 16 },
  )
}

export async function canaryPoolDiscovery(chain, token, options = {}) {
  if (!chain.poolManager || chain.deploymentBlock === undefined) {
    return capability('unsupported', chain.limitation ?? 'No verified PoolManager deployment is configured.')
  }
  if (!token) return capability('unsupported', 'No canary token is configured for this chain.')
  if (!isAddress(token)) return capability('degraded', 'The configured canary token is not an EVM address.')
  const normalizedToken = getAddress(token)
  const environment = options.environment ?? process.env
  const source = sourceConfiguration(chain, environment)
  const fetchOptions = {
    fetcher: options.fetcher ?? fetch,
    timeoutMs: options.timeoutMs ?? 15_000,
  }
  if (!source.poolIndexUrl && !source.subgraphUrl) {
    return capability('unsupported', 'No static pool index or subgraph is configured for this chain.')
  }
  const limitations = []
  if (source.poolIndexUrl) {
    try {
      return await canaryStaticIndex(chain, normalizedToken, source.poolIndexUrl, fetchOptions)
    } catch (error) {
      limitations.push(`Static index: ${safeError(error)}`)
    }
  }
  if (source.subgraphUrl) {
    try {
      const result = await canarySubgraph(chain, normalizedToken, source.subgraphUrl, fetchOptions)
      if (limitations.length === 0) return result
      return {
        ...result,
        status: 'degraded',
        reason: `${limitations.join(' ')} Fallback subgraph ${result.status === 'passed' ? 'passed' : result.reason}`,
      }
    } catch (error) {
      limitations.push(`Subgraph: ${safeError(error)}`)
    }
  }
  return capability('degraded', limitations.join(' '))
}

export async function runChainCanary(chain, options = {}) {
  const capabilities = {
    registry: chain.poolManager && chain.deploymentBlock !== undefined
      ? capability('passed', 'PoolManager identity and deployment block are configured.')
      : capability('unsupported', chain.limitation ?? 'No verified PoolManager deployment is configured.'),
  }
  let selected
  let confirmedHead
  try {
    selected = await (options.selectRpc ?? selectRpc)(chain, {
      environment: options.environment,
      fetcher: options.fetcher,
      timeoutMs: options.timeoutMs,
    })
    const head = BigInt(await selected.rpc('eth_blockNumber'))
    confirmedHead = head > BigInt(chain.confirmations) ? head - BigInt(chain.confirmations) : 0n
    capabilities.rpcRead = capability('passed', 'Chain identity and confirmed head are readable.', {
      rpcSource: selected.source,
      rpcAttempt: selected.attempt,
      headBlock: head.toString(),
      confirmedBlock: confirmedHead.toString(),
    })
    if (!chain.poolManager || chain.deploymentBlock === undefined) {
      capabilities.deploymentState = capability('unsupported', 'No verified PoolManager deployment is configured.')
      capabilities.historicalState = capability('unsupported', 'No deployment block is available for a historical state read.')
    } else {
      try {
        const code = await selected.rpc('eth_getCode', [chain.poolManager, `0x${confirmedHead.toString(16)}`])
        capabilities.deploymentState = codePresent(code)
          ? capability('passed', 'PoolManager code is present at the confirmed block.', { bytecodeBytes: (code.length - 2) / 2 })
          : capability('degraded', 'PoolManager code is absent at the confirmed block.')
      } catch (error) {
        capabilities.deploymentState = capability('degraded', safeError(error))
      }
      try {
        const code = await selected.rpc('eth_getCode', [chain.poolManager, `0x${chain.deploymentBlock.toString(16)}`])
        capabilities.historicalState = codePresent(code)
          ? capability('passed', 'Historical PoolManager code is readable at the deployment block.', { blockNumber: chain.deploymentBlock.toString() })
          : capability('degraded', 'PoolManager code is absent at the configured deployment block.')
      } catch (error) {
        capabilities.historicalState = capability('degraded', safeError(error))
      }
    }
  } catch (error) {
    capabilities.rpcRead = capability('degraded', safeError(error))
    const dependent = chain.poolManager
      ? 'RPC chain identity did not pass, so deployment state was not read.'
      : 'No verified PoolManager deployment is configured.'
    capabilities.deploymentState = capability(chain.poolManager ? 'degraded' : 'unsupported', dependent)
    capabilities.historicalState = capability(chain.deploymentBlock !== undefined ? 'degraded' : 'unsupported', dependent)
  }
  const discovery = await canaryPoolDiscovery(chain, options.token, options)
  const publicDiscovery = { ...discovery }
  delete publicDiscovery.candidates
  capabilities.poolDiscovery = publicDiscovery
  capabilities.indexedPoolState = await verifyIndexedPoolState(chain, discovery, selected?.rpc, confirmedHead)
  return {
    chainId: chain.id,
    chainSlug: chain.slug,
    chainName: chain.name,
    evmVariant: chain.evmVariant,
    readOnly: true,
    status: aggregateCapabilities(capabilities),
    capabilities,
  }
}
