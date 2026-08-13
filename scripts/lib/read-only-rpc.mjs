import { safeError } from './tooling-outcomes.mjs'

export function parseQuantity(value, label) {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/iu.test(value)) {
    throw new Error(`RPC returned an invalid ${label}.`)
  }
  return BigInt(value)
}

export function toQuantity(value) {
  if (typeof value !== 'bigint' || value < 0n) throw new Error('JSON-RPC quantity must be a non-negative bigint.')
  return `0x${value.toString(16)}`
}

export function rpcCandidates(chain, environment = process.env) {
  const configured = environment[`HOOKSCOPE_RPC_${chain.id}`]
  return [configured, ...chain.rpcUrls]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .filter((value, index, values) => values.indexOf(value) === index)
    .map((url, index) => ({ url, source: index === 0 && configured ? 'environment' : 'public-registry' }))
}

export function createRpcClient(endpoint, options = {}) {
  const fetcher = options.fetcher ?? fetch
  const timeoutMs = options.timeoutMs ?? 15_000
  let id = 0
  return async function rpc(method, params = []) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetcher(endpoint, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`RPC returned HTTP ${response.status}.`)
      const body = await response.json()
      if (!body || typeof body !== 'object') throw new Error('RPC returned a non-object response.')
      if (body.error) {
        const code = typeof body.error.code === 'number' ? ` ${body.error.code}` : ''
        throw new Error(`RPC error${code}: ${String(body.error.message ?? 'request rejected')}`)
      }
      if (!Object.hasOwn(body, 'result')) throw new Error('RPC response omitted its result.')
      return body.result
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`RPC request exceeded ${timeoutMs} ms.`)
      throw new Error(safeError(error))
    } finally {
      clearTimeout(timer)
    }
  }
}

export async function selectRpc(chain, options = {}) {
  const candidates = options.candidates ?? rpcCandidates(chain, options.environment)
  const errors = []
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    const rpc = createRpcClient(candidate.url, options)
    try {
      const observed = Number(parseQuantity(await rpc('eth_chainId'), 'chain ID'))
      if (observed !== chain.id) throw new Error(`RPC identifies chain ${observed}, expected ${chain.id}.`)
      return { rpc, source: candidate.source, attempt: index + 1 }
    } catch (error) {
      errors.push(safeError(error))
    }
  }
  if (candidates.length === 0) throw new Error('No RPC candidates are configured.')
  throw new Error(`No RPC candidate passed chain identity: ${errors.join(' | ')}`)
}
