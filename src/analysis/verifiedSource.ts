import type { Address, Hex } from 'viem'
import type { Evidence } from '../domain/report'
import type { SourcifyCompilationBundle } from '../data/source'

export type SourceFunctionFact = {
  name: string
  visibility?: string
  stateMutability?: string
  modifiers: string[]
  sourcePath: string
  src?: string
}

export type SourceCallFact = {
  operation: 'call' | 'delegatecall' | 'staticcall'
  function?: string
  modifiers: string[]
  sourcePath: string
  src?: string
}

export type SourceWriteFact = { variable: string; function?: string; sourcePath: string; src?: string }
export type SourceGateFact = { kind: 'require' | 'assert' | 'if'; function?: string; sourcePath: string; src?: string }

export type VerifiedSourceSummary = {
  fullyQualifiedName: string
  compilerVersion: string
  astNodeCount: number
  functions: SourceFunctionFact[]
  externalCalls: SourceCallFact[]
  stateWrites: SourceWriteFact[]
  senderGates: SourceGateFact[]
  abi: unknown[]
  storageLayout: { storage?: unknown[]; types?: Record<string, unknown> }
  methodIdentifiers: Record<string, string>
}

export type SolidityCompilerInput = {
  language: string
  sources: Record<string, { content: string }>
  settings: Record<string, unknown>
}

const VERSION_PATTERN = /^0\.\d+\.\d+\+commit\.[0-9a-f]{8}$/i

export function buildAstCompilerInput(bundle: SourcifyCompilationBundle): SolidityCompilerInput {
  if (bundle.language !== 'Solidity') throw new Error(`Verified-source AST passes do not support ${bundle.language}.`)
  if (!VERSION_PATTERN.test(bundle.compilerVersion)) throw new Error(`Unsupported Solidity compiler version: ${bundle.compilerVersion}`)
  const separator = bundle.fullyQualifiedName.lastIndexOf(':')
  if (separator <= 0) throw new Error(`Invalid fully-qualified contract name: ${bundle.fullyQualifiedName}`)
  const sourcePath = bundle.fullyQualifiedName.slice(0, separator)
  const contractName = bundle.fullyQualifiedName.slice(separator + 1)
  const settings = structuredClone(bundle.compilerSettings)
  settings.outputSelection = {
    '*': { '': ['ast'] },
    [sourcePath]: {
      [contractName]: ['abi', 'storageLayout', 'evm.methodIdentifiers'],
    },
  }
  return { language: bundle.language, sources: bundle.sources, settings }
}

function evidence(input: {
  subject: Address
  affectedPools: Hex[]
  detectorId: string
  severity: Evidence['severity']
  title: string
  claim: string
  technical: Record<string, unknown>
}): Evidence {
  return {
    id: `${input.detectorId}:${input.subject}`,
    detectorId: input.detectorId,
    detectorVersion: '0.1.0',
    severity: input.severity,
    evidenceClass: 'deterministic-fact',
    subject: input.subject,
    title: input.title,
    claim: input.claim,
    confidence: 'confirmed',
    affectedPools: input.affectedPools,
    reproducibility: 'not-applicable',
    technical: input.technical,
  }
}

export function sourceSummaryEvidence(input: {
  subject: Address
  affectedPools: Hex[]
  summary: VerifiedSourceSummary
}): Evidence[] {
  const { summary } = input
  const publicFunctions = summary.functions.filter((fn) => fn.visibility === 'public' || fn.visibility === 'external')
  const callbackFunctions = publicFunctions.filter((fn) => /^(before|after)(Initialize|AddLiquidity|RemoveLiquidity|Swap|Donate)$/.test(fn.name))
  const findings: Evidence[] = [evidence({
    ...input,
    detectorId: 'verified-source-surface',
    severity: 'info',
    title: 'Verified Solidity interface mapped',
    claim: `The exact ${summary.compilerVersion} AST contains ${publicFunctions.length} public/external function(s), ${summary.stateWrites.length} direct state-write site(s), and ${summary.externalCalls.length} low-level call site(s).`,
    technical: {
      fullyQualifiedName: summary.fullyQualifiedName,
      astNodeCount: summary.astNodeCount,
      publicFunctions,
      callbackFunctions,
      abiEntries: summary.abi.length,
      storageEntries: summary.storageLayout.storage?.length ?? 0,
      methodIdentifiers: summary.methodIdentifiers,
    },
  })]

  if (callbackFunctions.length) {
    findings.push(evidence({
      ...input,
      detectorId: 'verified-hook-callbacks',
      severity: 'info',
      title: 'Hook callback implementations mapped from source',
      claim: `Verified source implements ${callbackFunctions.map((fn) => fn.name).join(', ')}. Runtime permission bits remain the authority for which callbacks PoolManager invokes.`,
      technical: { callbacks: callbackFunctions },
    }))
  }
  if (summary.externalCalls.length) {
    findings.push(evidence({
      ...input,
      detectorId: 'verified-low-level-calls',
      severity: summary.externalCalls.some((call) => call.operation === 'delegatecall') ? 'medium' : 'info',
      title: 'Low-level call sites mapped from verified source',
      claim: `Verified source contains ${summary.externalCalls.length} low-level call site(s). Their containing functions and declared modifiers are recorded for scenario generation.`,
      technical: { calls: summary.externalCalls },
    }))
  }
  if (summary.stateWrites.length || summary.senderGates.length) {
    findings.push(evidence({
      ...input,
      detectorId: 'verified-state-control-map',
      severity: 'info',
      title: 'State writes and caller gates mapped',
      claim: `Verified source exposes ${summary.stateWrites.length} direct state-write site(s) and ${summary.senderGates.length} explicit msg.sender gate(s). This syntactic map feeds caller and state-transition scenarios; it is not a whole-program proof.`,
      technical: { stateWrites: summary.stateWrites, senderGates: summary.senderGates },
    }))
  }
  return findings
}
