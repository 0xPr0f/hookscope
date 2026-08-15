import { z } from 'zod'
import type { Address, Hex } from 'viem'

export const severitySchema = z.enum(['critical', 'high', 'medium', 'low', 'info'])
export const evidenceClassSchema = z.enum([
  'deterministic-fact',
  'static-reachability',
  'concrete-observation',
  'fuzz-discovery',
  'solver-derived',
])

const hexSchema = z.string().regex(/^0x[0-9a-fA-F]*$/)
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/)

export const replayWitnessSchema = z.object({
  from: addressSchema,
  to: addressSchema,
  input: hexSchema,
  value: z.string(),
  blockNumber: z.string(),
  expectedOutcome: z.enum(['success', 'revert']),
  stateOverrides: z.record(z.string(), z.unknown()).optional(),
})

export const evidenceSchema = z.object({
  id: z.string().min(1).max(160),
  detectorId: z.string().min(1).max(100),
  detectorVersion: z.string().min(1).max(32),
  severity: severitySchema,
  evidenceClass: evidenceClassSchema,
  subject: addressSchema,
  title: z.string().min(1).max(160),
  claim: z.string().min(1).max(2_000),
  confidence: z.enum(['confirmed', 'supported', 'heuristic']),
  programCounter: z.number().int().nonnegative().optional(),
  callPath: z.array(addressSchema).max(64).optional(),
  storage: z
    .array(
      z.object({
        slot: hexSchema,
        before: hexSchema.optional(),
        after: hexSchema.optional(),
      }),
    )
    .max(128)
    .optional(),
  affectedPools: z.array(hexSchema).max(20).default([]),
  witness: replayWitnessSchema.optional(),
  reproducibility: z.enum(['replayed', 'replayable', 'not-applicable', 'failed']),
  technical: z.record(z.string(), z.unknown()).optional(),
})

export const capabilityStateSchema = z.object({
  supported: z.boolean(),
  status: z.enum(['passed', 'degraded', 'unsupported']),
  reason: z.string().max(500).optional(),
  verifiedAt: z.string().datetime().optional(),
})

export const poolReplayKindSchema = z.enum(['initialize', 'swap', 'modify-liquidity', 'donate'])

export const poolReplayReferenceSchema = z.object({
  kind: poolReplayKindSchema,
  transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  blockNumber: z.string(),
})

export const poolSchema = z.object({
  poolId: hexSchema,
  currency0: addressSchema,
  currency1: addressSchema,
  fee: z.number().int().nonnegative(),
  tickSpacing: z.number().int(),
  hook: addressSchema,
  initializedAtBlock: z.string(),
  transactionHash: hexSchema.optional(),
  replayTransactions: z.array(poolReplayReferenceSchema).max(16).optional(),
  liquidity: z.string().optional(),
  activity: z.number().nonnegative().default(0),
})

export const sourceMetadataSchema = z.object({
  provider: z.literal('sourcify'),
  match: z.string().max(64),
  runtimeCodeHash: hexSchema,
  verifiedAt: z.string().datetime().optional(),
  language: z.string().max(64).optional(),
  compilerVersion: z.string().max(128).optional(),
  contractName: z.string().max(256).optional(),
  fullyQualifiedName: z.string().max(512).optional(),
  proxyType: z.string().max(128).optional(),
  functionSignatures: z.array(z.string().max(512)).max(1_024).default([]),
  eventSignatures: z.array(z.string().max(512)).max(1_024).default([]),
})

export const contractNodeSchema = z.object({
  address: addressSchema,
  role: z.enum(['token', 'hook', 'implementation', 'admin', 'dependency', 'pool-manager']),
  codeHash: hexSchema,
  bytecodeSize: z.number().int().nonnegative(),
  verifiedSource: z.boolean(),
  implementation: addressSchema.optional(),
  selectors: z.array(hexSchema).max(4_096).default([]),
  sourceMetadata: sourceMetadataSchema.optional(),
})

export const phaseSchema = z.object({
  id: z.enum(['pin', 'discover', 'resolve', 'static', 'replay', 'generated', 'scenarios', 'fuzz', 'report']),
  label: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'degraded', 'cancelled', 'failed']),
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  detail: z.string().optional(),
})

export const analysisReportSchema = z.object({
  schemaVersion: z.literal('1'),
  id: z.string().uuid(),
  reportHash: hexSchema.optional(),
  source: z.literal('browser'),
  status: z.literal('completed'),
  partial: z.literal(false),
  chainId: z.number().int().positive(),
  chainName: z.string(),
  token: addressSchema,
  tokenSymbol: z.string().max(32).optional(),
  blockNumber: z.string(),
  blockHash: hexSchema,
  blockTagPolicy: z.string(),
  createdAt: z.string().datetime(),
  elapsedMs: z.number().int().nonnegative(),
  adapterVersion: z.string(),
  scenarioVersion: z.string(),
  engineVersions: z.record(z.string(), z.string()),
  capabilities: z.object({
    discovery: capabilityStateSchema,
    static: capabilityStateSchema,
    replay: capabilityStateSchema,
    // Optional so a report stored before generated scenarios existed still parses.
    generated: capabilityStateSchema.optional(),
    fuzz: capabilityStateSchema,
  }),
  pools: z.array(poolSchema).max(20),
  poolCoverage: z.object({
    discovered: z.number().int().nonnegative(),
    analyzed: z.number().int().nonnegative(),
    hasMore: z.boolean(),
    nextCursor: z.string().optional(),
  }),
  contractGraph: z.array(contractNodeSchema).max(512),
  findings: z.array(evidenceSchema).max(5_000),
  phases: z.array(phaseSchema),
  scenarios: z.object({ completed: z.number().int(), total: z.number().int() }),
  coverage: z.object({
    uniqueCodeHashes: z.number().int().nonnegative(),
    paths: z.number().int().nonnegative(),
    executions: z.number().int().nonnegative(),
    branches: z.number().int().nonnegative(),
  }),
  limitations: z.array(z.string().max(1_000)).max(100),
})

export type Severity = z.infer<typeof severitySchema>
export type EvidenceClass = z.infer<typeof evidenceClassSchema>
export type ReplayWitness = Omit<z.infer<typeof replayWitnessSchema>, 'from' | 'to' | 'input'> & {
  from: Address
  to: Address
  input: Hex
}
export type Evidence = Omit<z.infer<typeof evidenceSchema>, 'subject' | 'affectedPools' | 'callPath' | 'witness'> & {
  subject: Address
  affectedPools: Hex[]
  callPath?: Address[]
  witness?: ReplayWitness
}
export type CapabilityState = z.infer<typeof capabilityStateSchema>
export type PoolReplayKind = z.infer<typeof poolReplayKindSchema>
export type PoolReplayReference = Omit<z.infer<typeof poolReplayReferenceSchema>, 'transactionHash'> & {
  transactionHash: Hex
}
export type PoolDescriptor = Omit<z.infer<typeof poolSchema>, 'poolId' | 'currency0' | 'currency1' | 'hook' | 'transactionHash' | 'replayTransactions'> & {
  poolId: Hex
  currency0: Address
  currency1: Address
  hook: Address
  transactionHash?: Hex
  replayTransactions?: PoolReplayReference[]
}
export type SourceMetadata = z.infer<typeof sourceMetadataSchema>
export type ContractNode = Omit<z.infer<typeof contractNodeSchema>, 'address' | 'codeHash' | 'implementation' | 'selectors'> & {
  address: Address
  codeHash: Hex
  implementation?: Address
  selectors: Hex[]
}
export type AnalysisPhase = z.infer<typeof phaseSchema>
export type AnalysisReport = Omit<z.infer<typeof analysisReportSchema>, 'token' | 'blockHash' | 'pools' | 'findings' | 'contractGraph'> & {
  token: Address
  blockHash: Hex
  pools: PoolDescriptor[]
  findings: Evidence[]
  contractGraph: ContractNode[]
}

export type ReportSummary = Pick<
  AnalysisReport,
  'id' | 'chainId' | 'token' | 'blockNumber' | 'blockHash' | 'createdAt' | 'engineVersions' | 'findings'
>

export type ScanRequest = {
  chainId: number
  token: Address
  block?: bigint
  poolCursor?: string
  poolLimit: 20
}

export type StaticSubject = {
  address: Address
  role: ContractNode['role']
  bytecode: Hex
  codeHash: Hex
  affectedPools: Hex[]
}

export type StaticAnalysisResult = {
  findings: Evidence[]
  nodes: ContractNode[]
  paths: number
  branches: number
  engineAvailability: Record<string, { available: boolean; detail?: string }>
}

export type WorkerCommand =
  | { type: 'start-static'; scanId: string; subjects: StaticSubject[] }
  | { type: 'cancel'; scanId: string }

export type WorkerEvent =
  | { type: 'phase'; scanId: string; phase: AnalysisPhase }
  | { type: 'progress'; scanId: string; completed: number; total: number; detail: string }
  | { type: 'finding'; scanId: string; finding: Evidence }
  | { type: 'complete-static'; scanId: string; result: StaticAnalysisResult }
  | { type: 'failure'; scanId: string; message: string }
