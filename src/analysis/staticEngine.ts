import { abiFromBytecode, selectorsFromBytecode } from '@shazow/whatsabi'
import type { EvmoleContractInfo } from 'evmole'
import { toFunctionSelector, type Hex } from 'viem'
import { decodeHookPermissions, HOOK_FLAGS } from '../domain/hooks'
import type { ContractNode, Evidence, StaticAnalysisResult, StaticSubject } from '../domain/report'
import { buildCfgReachability, classifyOffset, type CfgReachability } from './cfgReachability'

const DETECTOR_VERSION = '0.3.0'

type EvmoleContractInfoFn = (
  code: string,
  args: {
    selectors?: boolean
    arguments?: boolean
    stateMutability?: boolean
    storage?: boolean
    disassemble?: boolean
    basicBlocks?: boolean
    controlFlowGraph?: boolean
    metadata?: boolean
  },
) => EvmoleContractInfo

let evmoleContractInfo: EvmoleContractInfoFn | undefined

export function registerEvmoleContractInfo(engine: EvmoleContractInfoFn) {
  evmoleContractInfo = engine
}

type OpcodeRecord = { pc: number; mnemonic: string; raw: string }

function evidence(
  subject: StaticSubject,
  input: Omit<Evidence, 'id' | 'subject' | 'detectorVersion' | 'affectedPools'>,
): Evidence {
  return {
    ...input,
    id: `${input.detectorId}:${subject.address}:${input.programCounter ?? 'contract'}`,
    subject: subject.address,
    detectorVersion: DETECTOR_VERSION,
    affectedPools: subject.affectedPools,
  }
}

function firstPc(opcodes: OpcodeRecord[], mnemonic: string): number | undefined {
  return opcodes.find((opcode) => opcode.mnemonic === mnemonic)?.pc
}

function allPcs(opcodes: OpcodeRecord[], mnemonic: string): number[] {
  return opcodes.filter((opcode) => opcode.mnemonic === mnemonic).map((opcode) => opcode.pc)
}

function has(opcodes: OpcodeRecord[], mnemonic: string): boolean {
  return opcodes.some((opcode) => opcode.mnemonic === mnemonic)
}

function normalizeSelector(value: string): Hex {
  return (value.startsWith('0x') ? value : `0x${value}`) as Hex
}

/**
 * Graded evidence for one opcode.
 *
 * Presence in the disassembly is the weakest claim there is, and until this
 * point it was being reported as a reachable high-severity finding. The levels
 * separate what is known: the bytes exist, a control-flow path admits them, and
 * — established elsewhere, by execution — something actually happened.
 */
function opcodeReachabilityFinding(input: {
  subject: StaticSubject
  graph?: CfgReachability
  pc: number
  opcode: 'DELEGATECALL' | 'SELFDESTRUCT'
  presentClaim: string
  reachableClaim: string
}): Evidence {
  const verdict = input.graph ? classifyOffset(input.graph, input.pc) : undefined
  const reachable = verdict?.status === 'reachable'
  const slug = input.opcode.toLowerCase()

  return evidence(input.subject, {
    detectorId: reachable ? `cfg-reachable-${slug}` : `${slug}-opcode-present`,
    // Structural reachability is worth more than presence and less than an
    // observed execution, so it sits between them rather than at the top.
    severity: reachable ? 'medium' : 'info',
    evidenceClass: 'static-reachability',
    title: reachable
      ? `${input.opcode} is reachable in the control-flow graph`
      : `${input.opcode} is present in the bytecode`,
    claim: reachable ? input.reachableClaim : input.presentClaim,
    confidence: reachable ? 'supported' : 'heuristic',
    programCounter: input.pc,
    reproducibility: 'not-applicable',
    technical: {
      opcode: input.opcode,
      reachability: verdict?.status ?? 'not-analyzed',
      reachabilityReason: verdict && verdict.status === 'unknown' ? verdict.reason : undefined,
      blockId: verdict && verdict.status !== 'unknown' ? verdict.blockId : undefined,
      cfgEntryPoints: input.graph?.entryPoints.length,
    },
  })
}

function analyzeRules(subject: StaticSubject, opcodes: OpcodeRecord[], graph?: CfgReachability): Evidence[] {
  const findings: Evidence[] = []
  const delegatePcs = allPcs(opcodes, 'DELEGATECALL')
  const selfdestructPcs = allPcs(opcodes, 'SELFDESTRUCT')
  const callPcs = allPcs(opcodes, 'CALL')
  const originPc = firstPc(opcodes, 'ORIGIN')
  const transientPc = firstPc(opcodes, 'TSTORE') ?? firstPc(opcodes, 'TLOAD')
  const callerPc = firstPc(opcodes, 'CALLER')
  const sstorePc = firstPc(opcodes, 'SSTORE')

  for (const delegatePc of delegatePcs) {
    findings.push(opcodeReachabilityFinding({
      subject,
      graph,
      pc: delegatePc,
      opcode: 'DELEGATECALL',
      presentClaim: 'The bytecode contains DELEGATECALL, but no resolved control-flow path from an entry point reaches it. Presence alone says nothing about whether it can execute.',
      reachableClaim: 'A resolved control-flow path from an entry point reaches DELEGATECALL, which would execute another contract’s code in this contract’s storage context. Whether it executes, and against which target, requires concrete execution.',
    }))
  }

  for (const selfdestructPc of selfdestructPcs) {
    findings.push(opcodeReachabilityFinding({
      subject,
      graph,
      pc: selfdestructPc,
      opcode: 'SELFDESTRUCT',
      presentClaim: 'The bytecode contains SELFDESTRUCT, but no resolved control-flow path from an entry point reaches it. Presence alone says nothing about whether it can execute.',
      reachableClaim: 'A resolved control-flow path from an entry point reaches SELFDESTRUCT. On current Ethereum rules this can still transfer the contract balance; whether it executes requires concrete execution.',
    }))
  }

  if (originPc !== undefined) {
    findings.push(
      evidence(subject, {
        detectorId: 'origin-opcode-present',
        // A raw ORIGIN read is informational. It becomes meaningful only once
        // something is shown to depend on it — a branch, a call target, a write.
        severity: 'info',
        evidenceClass: 'static-reachability',
        title: 'Transaction origin is read',
        claim: 'The bytecode reads ORIGIN. Whether that read affects a branch, a call target, or a storage write is not established by its presence; controlled execution comparing direct and routed callers is what would show it.',
        confidence: 'heuristic',
        programCounter: originPc,
        reproducibility: 'not-applicable',
        technical: { opcode: 'ORIGIN' },
      }),
    )
  }

  if (callerPc !== undefined && sstorePc !== undefined) {
    findings.push(
      evidence(subject, {
        detectorId: 'caller-and-storage-present',
        severity: 'info',
        evidenceClass: 'static-reachability',
        title: 'Caller is read and persistent storage is written',
        claim: 'The bytecode both reads CALLER and writes persistent storage. These are two separate facts: no data-flow between them is established here, and a controlled comparison that changes only the caller is what would establish one.',
        confidence: 'heuristic',
        programCounter: callerPc,
        reproducibility: 'not-applicable',
        technical: { sourceOpcode: 'CALLER', sinkOpcode: 'SSTORE', sinkPc: sstorePc },
      }),
    )
  }

  if (transientPc !== undefined) {
    findings.push(
      evidence(subject, {
        detectorId: 'transient-state',
        severity: 'medium',
        evidenceClass: 'static-reachability',
        title: 'Transient state controls execution',
        claim: 'The hook uses EIP-1153 transient storage. Replay must preserve the complete PoolManager unlock and callback sequence.',
        confidence: 'supported',
        programCounter: transientPc,
        reproducibility: 'not-applicable',
        technical: { tload: has(opcodes, 'TLOAD'), tstore: has(opcodes, 'TSTORE') },
      }),
    )
  }

  for (const callPc of callPcs) {
    const verdict = graph ? classifyOffset(graph, callPc) : undefined
    const reachable = verdict?.status === 'reachable'
    findings.push(
      evidence(subject, {
        detectorId: reachable ? 'external-call-surface' : 'call-opcode-present',
        severity: reachable ? 'medium' : 'info',
        evidenceClass: 'static-reachability',
        title: reachable ? 'External call is reachable in the control-flow graph' : 'External call opcode is present in bytecode',
        claim: reachable
          ? 'A resolved control-flow path reaches CALL. Pool-specific execution should record the target, returned data, nested callbacks, and resulting balance or delta changes.'
          : verdict?.status === 'unknown'
            ? 'The bytecode contains CALL, but unresolved computed control flow means its reachability is unknown. Presence is not presented as an executed external call.'
            : 'The bytecode contains CALL, but no resolved path from an entry point reaches it. Presence is not presented as an executed external call.',
        confidence: reachable ? 'supported' : 'heuristic',
        programCounter: callPc,
        reproducibility: 'not-applicable',
        technical: {
          opcode: 'CALL',
          reachability: verdict?.status ?? 'not-analyzed',
          reachabilityReason: verdict?.status === 'unknown' ? verdict.reason : undefined,
          blockId: verdict && verdict.status !== 'unknown' ? verdict.blockId : undefined,
        },
      }),
    )
  }

  if (subject.role === 'hook') {
    const permissions = decodeHookPermissions(subject.address)
    findings.push(
      evidence(subject, {
        detectorId: 'hook-permission-bits',
        severity: 'info',
        evidenceClass: 'deterministic-fact',
        title: permissions.length ? 'Hook callback permissions decoded' : 'No callback permission bits set',
        claim: permissions.length
          ? `The address enables: ${permissions.join(', ')}.`
          : 'The hook address does not enable a Uniswap v4 callback bit.',
        confidence: 'confirmed',
        reproducibility: 'not-applicable',
        technical: { permissions },
      }),
    )

    const hookFlagMask = Number(BigInt(subject.address) & 0x3fffn)
    const returnDeltaRelationships = [
      { action: 'beforeSwap', actionFlag: 1 << 7, delta: 'beforeSwapReturnDelta', deltaFlag: 1 << 3 },
      { action: 'afterSwap', actionFlag: 1 << 6, delta: 'afterSwapReturnDelta', deltaFlag: 1 << 2 },
      { action: 'afterAddLiquidity', actionFlag: 1 << 10, delta: 'afterAddLiquidityReturnDelta', deltaFlag: 1 << 1 },
      { action: 'afterRemoveLiquidity', actionFlag: 1 << 8, delta: 'afterRemoveLiquidityReturnDelta', deltaFlag: 1 },
    ]
    const invalidDeltaFlags = returnDeltaRelationships.filter(({ actionFlag, deltaFlag }) =>
      (hookFlagMask & deltaFlag) !== 0 && (hookFlagMask & actionFlag) === 0)
    if (invalidDeltaFlags.length) {
      findings.push(
        evidence(subject, {
          detectorId: 'hook-return-delta-flag-relationship',
          severity: 'high',
          evidenceClass: 'deterministic-fact',
          title: 'Return-delta flag lacks its callback flag',
          claim: `The address enables ${invalidDeltaFlags.map(({ delta }) => delta).join(', ')} without the corresponding callback permission.`,
          confidence: 'confirmed',
          reproducibility: 'not-applicable',
          technical: { hookFlagMask, invalidDeltaFlags },
        }),
      )
    } else {
      findings.push(
        evidence(subject, {
          detectorId: 'hook-return-delta-flag-relationship',
          severity: 'info',
          evidenceClass: 'deterministic-fact',
          title: 'Return-delta flag relationships are coherent',
          claim: 'Every enabled return-delta address bit has its required callback bit.',
          confidence: 'confirmed',
          reproducibility: 'not-applicable',
          technical: { hookFlagMask, decodedFlags: HOOK_FLAGS.filter(([, flag]) => hookFlagMask & flag).map(([name]) => name) },
        }),
      )
    }
  }

  return findings
}

const COMMON_MUTATOR_SIGNATURES = [
  'updatePool(address)', 'setPool(address)', 'setPoolManager(address)', 'setManager(address)',
  'authorizePool(address)', 'setTrustedPool(address)', 'setHookEnabled(bool)', 'setAuthorizedCaller(address)',
  'setOwner(address)', 'pause()', 'unpause()', 'emergencyWithdraw()', 'claimFees()',
  'configureDirection(bool)', 'configureRouter(address)', 'configureSwapFee(uint24)',
] as const

function analyzeHookSurface(subject: StaticSubject, selectors: Hex[], bytecodeSize: number): Evidence[] {
  if (subject.role !== 'hook') return []
  const selectorSet = new Set(selectors.map((selector) => selector.toLowerCase()))
  const mutators = COMMON_MUTATOR_SIGNATURES.filter((signature) => selectorSet.has(toFunctionSelector(signature).toLowerCase()))
  const complexity = bytecodeSize < 5_000 ? 'simple' : bytecodeSize < 15_000 ? 'moderate' : bytecodeSize < 24_576 ? 'complex' : 'near the EIP-170 size limit'
  return [
    evidence(subject, {
      detectorId: 'hacken-introspect-complexity',
      severity: 'info',
      evidenceClass: 'deterministic-fact',
      title: 'Hook bytecode size classified',
      claim: `${bytecodeSize} bytes of deployed code are classified as ${complexity}.`,
      confidence: 'confirmed',
      reproducibility: 'not-applicable',
      technical: { upstream: 'HookIntrospectionSuite.run_Introspect_Complexity', bytecodeSize, complexity },
    }),
    evidence(subject, {
      detectorId: 'hacken-introspect-external-functions',
      severity: mutators.length ? 'medium' : 'info',
      evidenceClass: 'deterministic-fact',
      title: mutators.length ? 'Common configuration selectors exposed' : 'No common configuration selector identified',
      claim: mutators.length
        ? `Deployed bytecode exposes: ${mutators.join(', ')}. Concrete calls determine their caller policy.`
        : 'The inferred selector set contains none of the configured common mutation signatures.',
      confidence: 'confirmed',
      reproducibility: 'not-applicable',
      technical: { upstream: 'HookIntrospectionSuite.run_Introspect_ExternalFunctions', mutators },
    }),
  ]
}

/**
 * Evidence derived from EVMole facts the opcode scan cannot produce.
 *
 * The opcode pass can say "this contract writes storage somewhere"; EVMole
 * resolves which selector writes which slot, what each entrypoint's mutability
 * is, which compiler emitted the code, and where the control flow stops being
 * statically resolvable. Reporting those separately keeps a decoded fact from
 * being presented as a reachability inference.
 */
function analyzeContractSurface(subject: StaticSubject, info: EvmoleContractInfo, graph?: CfgReachability): Evidence[] {
  const findings: Evidence[] = []
  const functions = info.functions ?? []

  const payable = functions.filter((fn) => fn.stateMutability === 'payable')
  if (payable.length) {
    findings.push(evidence(subject, {
      detectorId: 'evmole-payable-entrypoints',
      severity: 'medium',
      evidenceClass: 'deterministic-fact',
      title: 'Contract accepts native value on specific entrypoints',
      claim: `${payable.length} entrypoint(s) are payable: ${payable.map((fn) => normalizeSelector(fn.selector)).join(', ')}. Native value sent to any other selector reverts.`,
      confidence: 'confirmed',
      reproducibility: 'not-applicable',
      technical: {
        payable: payable.map((fn) => ({ selector: normalizeSelector(fn.selector), arguments: fn.arguments, dispatch: fn.dispatch })),
      },
    }))
  }

  const fallbackDispatched = functions.filter((fn) => fn.dispatch === 'fallback')
  if (fallbackDispatched.length) {
    findings.push(evidence(subject, {
      detectorId: 'evmole-fallback-dispatch',
      severity: 'low',
      evidenceClass: 'deterministic-fact',
      title: 'Entrypoints reachable only through fallback dispatch',
      claim: `${fallbackDispatched.length} selector(s) are not handled by the ordinary ABI dispatcher and are reached through fallback logic, which ABI-only inspection does not reveal.`,
      confidence: 'confirmed',
      reproducibility: 'not-applicable',
      technical: { selectors: fallbackDispatched.map((fn) => normalizeSelector(fn.selector)) },
    }))
  }

  // Which selector writes which slot: a decoded fact, not an inference.
  const writers = (records: typeof info.storage, kind: 'persistent' | 'transient') => {
    const written = (records ?? []).filter((record) => record.writes.length > 0)
    if (!written.length) return
    findings.push(evidence(subject, {
      detectorId: `evmole-${kind}-storage-writers`,
      severity: kind === 'transient' ? 'medium' : 'low',
      evidenceClass: 'deterministic-fact',
      title: kind === 'transient'
        ? 'Transient storage slots and their writers mapped'
        : 'Persistent storage slots and their writers mapped',
      claim: `${written.length} ${kind} slot(s) are written by decoded entrypoints: ${written.slice(0, 6).map((record) => `slot ${record.slot} (${record.type}) by ${record.writes.map(normalizeSelector).join('/')}`).join('; ')}${written.length > 6 ? '; …' : ''}.`,
      confidence: 'confirmed',
      reproducibility: 'not-applicable',
      storage: written.slice(0, 32).map((record) => ({ slot: `0x${record.slot}` as Hex })),
      technical: {
        slots: written.slice(0, 32).map((record) => ({
          slot: record.slot,
          offset: record.offset,
          type: record.type,
          writes: record.writes.map(normalizeSelector),
          reads: record.reads.map(normalizeSelector),
        })),
      },
    }))
  }
  writers(info.storage, 'persistent')
  writers(info.transientStorage, 'transient')

  const solc = info.metadata?.entries.find((entry) => entry.key === 'solc')
  if (solc) {
    // CBOR encodes the version as three bytes; a string entry is passed through.
    const version = solc.value.type === 'bytes'
      ? (solc.value.value.match(/.{2}/g) ?? []).map((byte) => parseInt(byte, 16)).join('.')
      : String(solc.value.value)
    findings.push(evidence(subject, {
      detectorId: 'evmole-embedded-compiler',
      severity: 'info',
      evidenceClass: 'deterministic-fact',
      title: 'Compiler identity embedded in deployed bytecode',
      claim: `The trailing CBOR metadata records solc ${version}. This is read from the deployed code itself, so it is independent of any verification service.`,
      confidence: 'confirmed',
      reproducibility: 'not-applicable',
      technical: {
        solc: version,
        entries: info.metadata?.entries.map((entry) => ({ key: entry.key, type: entry.value.type })),
      },
    }))
  }

  const unresolvedDynamicJumps = graph?.unresolvedBlocks ?? []
  if (unresolvedDynamicJumps.length) {
    findings.push(evidence(subject, {
      detectorId: 'evmole-unresolved-control-flow',
      severity: 'low',
      evidenceClass: 'static-reachability',
      title: 'Control flow contains computed jumps',
      claim: `${unresolvedDynamicJumps.length} reachable block(s) end in a computed jump whose destination is not statically fixed, so static reachability under-approximates this contract. Resolved computed jumps are included in traversal and are not counted here. Concrete execution remains authoritative.`,
      confidence: 'supported',
      reproducibility: 'not-applicable',
      technical: { unresolvedBlockIds: unresolvedDynamicJumps, dynamicJumpBlocks: unresolvedDynamicJumps.length, totalBlocks: info.controlFlowGraph?.blocks.length ?? 0 },
    }))
  }

  return findings
}

function normalizeOpcodes(disassembled: [number, string][] | undefined): OpcodeRecord[] {
  const byPc = new Map<number, OpcodeRecord>()
  for (const [pc, raw] of disassembled ?? []) {
    byPc.set(pc, { pc, raw, mnemonic: raw.split(' ', 1)[0] ?? raw })
  }
  return [...byPc.values()].sort((a, b) => a.pc - b.pc)
}

export function analyzeStaticSubjects(subjects: StaticSubject[]): StaticAnalysisResult {
  const findings: Evidence[] = []
  const nodes: ContractNode[] = []
  // Reachability caveats, surfaced so a report never presents an unresolved
  // computed jump as proof that code is dead.
  const cfgLimitations: string[] = []
  let paths = 0
  let branches = 0
  const availability: StaticAnalysisResult['engineAvailability'] = {
    whatsabi: { available: true },
    evmole: { available: true },
  }

  for (const subject of subjects) {
    let selectors: Hex[] = []
    let contractInfo: EvmoleContractInfo | undefined
    let disassembled: [number, string][] = []
    let storageCount = 0
    let transientStorageCount = 0
    let cfgBlocks = 0

    try {
      if (!evmoleContractInfo) throw new Error('EVMole has not been initialized in this runtime.')
      const info = evmoleContractInfo(subject.bytecode, {
        selectors: true,
        arguments: true,
        stateMutability: true,
        storage: true,
        disassemble: true,
        basicBlocks: true,
        controlFlowGraph: true,
        metadata: true,
      })
      contractInfo = info
      disassembled = info.disassembled ?? []
      selectors = (info.functions ?? []).map((fn) => normalizeSelector(fn.selector))
      storageCount = info.storage?.length ?? 0
      transientStorageCount = info.transientStorage?.length ?? 0
      cfgBlocks = info.controlFlowGraph?.blocks.length ?? info.basicBlocks?.length ?? 0
      paths += cfgBlocks
      // evmole's current wasm-bindgen build materializes CFG blocks as Map
      // instances even though its declaration file describes plain objects.
      // Read both representations so the browser and native Node harness agree.
      branches +=
        info.controlFlowGraph?.blocks.filter((block) => {
          const value: unknown = block
          const blockType = value instanceof Map ? value.get('type') : (value as { type?: unknown }).type
          return typeof blockType === 'string' && blockType.includes('Jumpi')
        }).length ?? 0
    } catch (error) {
      availability.evmole = { available: false, detail: error instanceof Error ? error.message : String(error) }
    }

    try {
      selectors = [...new Set([...selectors, ...selectorsFromBytecode(subject.bytecode).map(normalizeSelector)])]
      // Running ABI inference is part of the feasibility gate even when the report only stores selectors.
      abiFromBytecode(subject.bytecode)
    } catch (error) {
      availability.whatsabi = { available: false, detail: error instanceof Error ? error.message : String(error) }
    }

    const opcodes = normalizeOpcodes(disassembled)
    // Structural reachability, so an opcode is never reported as reachable
    // merely because it appears in the flat disassembly.
    const cfg = contractInfo ? buildCfgReachability(contractInfo) : undefined
    if (cfg?.limitations.length) cfgLimitations.push(...cfg.limitations)
    findings.push(...analyzeRules(subject, opcodes, cfg))
    const bytecodeSize = Math.max(0, (subject.bytecode.length - 2) / 2)
    findings.push(...analyzeHookSurface(subject, selectors, bytecodeSize))
    if (contractInfo) findings.push(...analyzeContractSurface(subject, contractInfo, cfg))
    nodes.push({
      address: subject.address,
      role: subject.role,
      codeHash: subject.codeHash,
      bytecodeSize,
      verifiedSource: false,
      selectors,
    })

    if (storageCount || transientStorageCount) {
      findings.push(
        evidence(subject, {
          detectorId: 'storage-layout',
          severity: 'info',
          evidenceClass: 'deterministic-fact',
          title: 'Storage layout recovered from bytecode',
          claim: `EVMole recovered ${storageCount} persistent and ${transientStorageCount} transient storage record(s).`,
          confidence: 'confirmed',
          reproducibility: 'not-applicable',
          technical: { storageCount, transientStorageCount, cfgBlocks },
        }),
      )
    }
  }

  return {
    findings,
    nodes,
    paths,
    branches,
    engineAvailability: availability,
    limitations: [...new Set(cfgLimitations)],
  }
}
