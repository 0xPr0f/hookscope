import { toFunctionSelector, type Address, type Hex } from 'viem'
import type { AnalysisReport, ContractNode } from '../domain/report'
import {
  normalizeFunctionSelector,
  type SelectorSignatureCandidate,
  type SelectorSignatureLookup,
} from '../domain/selectors'

const EMBEDDED_SELECTOR = /0x[0-9a-fA-F]{8}(?![0-9a-fA-F])/g
const CALLDATA_KEY = /(?:^|_)(?:input|calldata|rawcalldata|output|reason|revertdata)$/i
const MAX_REPORT_SELECTORS = 4_096

// These names come from protocol interfaces bundled with the application, not
// from selector guessing. Exact verified ABIs can still override them for a
// particular call target.
const CANONICAL_SIGNATURES = [
  'balanceOf(address)',
  'allowance(address,address)',
  'approve(address,uint256)',
  'transfer(address,uint256)',
  'transferFrom(address,address,uint256)',
  'unlock(bytes)',
  'unlockCallback(bytes)',
  'settle()',
  'sync(address)',
  'take(address,address,uint256)',
  'clear(address,uint256)',
  'mint(address,uint256,uint256)',
  'burn(address,uint256,uint256)',
  'execute(bytes,bytes[])',
  'execute(bytes,bytes[],uint256)',
  'modifyLiquidities(bytes,uint256)',
  'modifyLiquiditiesWithoutUnlock(bytes,bytes[])',
  'initializePool((address,address,uint24,int24,address),uint160)',
  'multicall(bytes[])',
  'getHookPermissions()',
  'poolManager()',
  'supportsInterface(bytes4)',
  'beforeInitialize(address,(address,address,uint24,int24,address),uint160)',
  'afterInitialize(address,(address,address,uint24,int24,address),uint160,int24)',
  'beforeAddLiquidity(address,(address,address,uint24,int24,address),(int24,int24,int256,bytes32),bytes)',
  'afterAddLiquidity(address,(address,address,uint24,int24,address),(int24,int24,int256,bytes32),int256,int256,bytes)',
  'beforeRemoveLiquidity(address,(address,address,uint24,int24,address),(int24,int24,int256,bytes32),bytes)',
  'afterRemoveLiquidity(address,(address,address,uint24,int24,address),(int24,int24,int256,bytes32),int256,int256,bytes)',
  'beforeSwap(address,(address,address,uint24,int24,address),(bool,int256,uint160),bytes)',
  'afterSwap(address,(address,address,uint24,int24,address),(bool,int256,uint160),int256,bytes)',
  'beforeDonate(address,(address,address,uint24,int24,address),uint256,uint256,bytes)',
  'afterDonate(address,(address,address,uint24,int24,address),uint256,uint256,bytes)',
] as const

function addSelector(output: Set<Hex>, value: string | undefined) {
  if (!value || output.size >= MAX_REPORT_SELECTORS) return
  const normalized = normalizeFunctionSelector(value)
  if (normalized) output.add(normalized)
}

function collectValue(output: Set<Hex>, value: unknown, key?: string) {
  if (output.size >= MAX_REPORT_SELECTORS || value === null || value === undefined) return
  if (typeof value === 'string') {
    addSelector(output, value)
    for (const match of value.matchAll(EMBEDDED_SELECTOR)) addSelector(output, match[0])
    if (key && CALLDATA_KEY.test(key) && /^0x[0-9a-fA-F]{8,}$/.test(value)) {
      addSelector(output, value.slice(0, 10))
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectValue(output, item, key)
    return
  }
  if (typeof value !== 'object') return
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    collectValue(output, child, childKey)
  }
}

export function collectSelectorsFromValue(value: unknown): Hex[] {
  const selectors = new Set<Hex>()
  collectValue(selectors, value)
  return [...selectors]
}

export function collectReportSelectors(report: AnalysisReport): Hex[] {
  return collectSelectorsFromValue({
    contractGraph: report.contractGraph,
    findings: report.findings,
    phases: report.phases,
    limitations: report.limitations,
  })
}

function candidateKey(candidate: SelectorSignatureCandidate) {
  return `${candidate.source}:${candidate.name}:${(candidate.subjects ?? []).map((item) => item.toLowerCase()).sort().join(',')}`
}

function mergeCandidates(...groups: readonly (readonly SelectorSignatureCandidate[])[]) {
  const merged = new Map<string, SelectorSignatureCandidate>()
  for (const candidate of groups.flat()) merged.set(candidateKey(candidate), candidate)
  return [...merged.values()].sort((left, right) => {
    const rank = (candidate: SelectorSignatureCandidate) =>
      candidate.source === 'verified-contract-abi' ? 0
        : candidate.source === 'canonical-interface' ? 1
          : candidate.hasVerifiedContract ? 2 : 3
    return rank(left) - rank(right) || left.name.localeCompare(right.name)
  }).slice(0, 16)
}

export function mergeSelectorSignatureLookups(
  ...lookups: readonly (SelectorSignatureLookup | undefined)[]
): SelectorSignatureLookup {
  const keys = new Set(lookups.flatMap((lookup) => Object.keys(lookup ?? {})))
  return Object.fromEntries([...keys].map((selector) => [
    selector,
    mergeCandidates(...lookups.map((lookup) => lookup?.[selector] ?? [])),
  ]))
}

function addCandidate(
  output: Record<string, SelectorSignatureCandidate[]>,
  selector: Hex,
  candidate: SelectorSignatureCandidate,
) {
  output[selector] = mergeCandidates(output[selector] ?? [], [candidate])
}

function verifiedAbiCandidates(nodes: ContractNode[]) {
  const output: Record<string, SelectorSignatureCandidate[]> = {}
  for (const node of nodes) {
    for (const signature of node.sourceMetadata?.functionSignatures ?? []) {
      try {
        addCandidate(output, toFunctionSelector(signature), {
          name: signature,
          source: 'verified-contract-abi',
          hasVerifiedContract: true,
          subjects: [node.address],
        })
      } catch {
        // A malformed optional metadata signature cannot invalidate the exact
        // runtime-code match or the rest of the report.
      }
    }
  }
  return output
}

function canonicalCandidates(selectors: readonly Hex[]) {
  const wanted = new Set(selectors)
  const output: Record<string, SelectorSignatureCandidate[]> = {}
  for (const signature of CANONICAL_SIGNATURES) {
    const selector = toFunctionSelector(signature)
    if (!wanted.has(selector)) continue
    addCandidate(output, selector, {
      name: signature,
      source: 'canonical-interface',
      hasVerifiedContract: false,
    })
  }
  return output
}

export type ReportSelectorResolution = {
  lookup: SelectorSignatureLookup
  selectors: Hex[]
  externallyResolved: number
  unresolved: Hex[]
  failure?: string
}

/**
 * Creates one selector snapshot for the completed report. IO stays at this
 * orchestration boundary; every later UI view is a pure lookup.
 */
export async function resolveReportSelectors(input: {
  report: AnalysisReport
  signal: AbortSignal
  fetchCandidates: (selectors: Hex[], signal: AbortSignal) => Promise<SelectorSignatureLookup>
}): Promise<ReportSelectorResolution> {
  const selectors = collectReportSelectors(input.report)
  const local = mergeSelectorSignatureLookups(
    verifiedAbiCandidates(input.report.contractGraph),
    canonicalCandidates(selectors),
    input.report.selectorSignatures,
  )
  const missing = selectors.filter((selector) => !(local[selector]?.length))
  let external: SelectorSignatureLookup = {}
  let failure: string | undefined
  if (missing.length) {
    try {
      external = await input.fetchCandidates(missing, input.signal)
    } catch (error) {
      if (input.signal.aborted) throw error
      failure = error instanceof Error ? error.message : String(error)
    }
  }
  const lookup = mergeSelectorSignatureLookups(local, external)
  return {
    lookup,
    selectors,
    externallyResolved: missing.filter((selector) => Boolean(external[selector]?.length)).length,
    unresolved: selectors.filter((selector) => !lookup[selector]?.length),
    failure,
  }
}

export function selectorSubjects(
  lookup: SelectorSignatureLookup,
  selector: Hex,
): Address[] {
  return [...new Set((lookup[selector] ?? []).flatMap((candidate) => candidate.subjects ?? []))]
}
