import { abiFromBytecode, selectorsFromBytecode } from '@shazow/whatsabi'
import type { EvmoleContractInfo } from 'evmole'
import { Contract } from 'sevm'
import { toFunctionSelector, type Hex } from 'viem'
import { decodeHookPermissions, HOOK_FLAGS } from '../domain/hooks'
import type { ContractNode, Evidence, StaticAnalysisResult, StaticSubject } from '../domain/report'

const DETECTOR_VERSION = '0.2.0'

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

function has(opcodes: OpcodeRecord[], mnemonic: string): boolean {
  return opcodes.some((opcode) => opcode.mnemonic === mnemonic)
}

function normalizeSelector(value: string): Hex {
  return (value.startsWith('0x') ? value : `0x${value}`) as Hex
}

function analyzeRules(subject: StaticSubject, opcodes: OpcodeRecord[]): Evidence[] {
  const findings: Evidence[] = []
  const delegatePc = firstPc(opcodes, 'DELEGATECALL')
  const selfdestructPc = firstPc(opcodes, 'SELFDESTRUCT')
  const callPc = firstPc(opcodes, 'CALL')
  const originPc = firstPc(opcodes, 'ORIGIN')
  const transientPc = firstPc(opcodes, 'TSTORE') ?? firstPc(opcodes, 'TLOAD')
  const callerPc = firstPc(opcodes, 'CALLER')
  const sstorePc = firstPc(opcodes, 'SSTORE')

  if (delegatePc !== undefined) {
    findings.push(
      evidence(subject, {
        detectorId: 'reachable-delegatecall',
        severity: 'high',
        evidenceClass: 'static-reachability',
        title: 'Delegated code path is reachable',
        claim: 'A reachable path executes another contract’s code in this contract’s storage context. The target and resulting state changes need pool-specific execution.',
        confidence: 'supported',
        programCounter: delegatePc,
        reproducibility: 'not-applicable',
        technical: { opcode: 'DELEGATECALL' },
      }),
    )
  }

  if (selfdestructPc !== undefined) {
    findings.push(
      evidence(subject, {
        detectorId: 'reachable-selfdestruct',
        severity: 'high',
        evidenceClass: 'static-reachability',
        title: 'SELFDESTRUCT value-transfer path is reachable',
        claim: 'A reachable path executes SELFDESTRUCT. On current Ethereum rules this can still transfer the contract balance; legacy and chain-specific code-removal semantics are recorded separately.',
        confidence: 'supported',
        programCounter: selfdestructPc,
        reproducibility: 'not-applicable',
        technical: { opcode: 'SELFDESTRUCT' },
      }),
    )
  }

  if (originPc !== undefined) {
    findings.push(
      evidence(subject, {
        detectorId: 'origin-authorization',
        severity: 'high',
        evidenceClass: 'static-reachability',
        title: 'Transaction origin affects execution',
        claim: 'Reachable code reads ORIGIN, so the hook can behave differently when a swap is routed through another contract. Scenarios should compare direct and routed calls.',
        confidence: 'supported',
        programCounter: originPc,
        reproducibility: 'not-applicable',
        technical: { opcode: 'ORIGIN' },
      }),
    )
  }

  if (callerPc !== undefined && sstorePc !== undefined) {
    findings.push(
      evidence(subject, {
        detectorId: 'caller-dependent-storage',
        severity: 'medium',
        evidenceClass: 'static-reachability',
        title: 'Caller-dependent state update',
        claim: 'The reachable graph reads CALLER and writes persistent storage. Concrete scenarios must compare privileged, router, and ordinary callers.',
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

  if (callPc !== undefined) {
    findings.push(
      evidence(subject, {
        detectorId: 'external-call-surface',
        severity: 'medium',
        evidenceClass: 'static-reachability',
        title: 'External call during hook execution',
        claim: 'A reachable path calls an external contract. Pool-specific execution should record the target, returned data, any nested callback, and resulting balance or delta changes.',
        confidence: 'supported',
        programCounter: callPc,
        reproducibility: 'not-applicable',
        technical: { opcode: 'CALL' },
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

function normalizeOpcodes(
  disassembled: [number, string][] | undefined,
  sevmMnemonics: { pc: number; mnemonic: string }[],
): OpcodeRecord[] {
  const byPc = new Map<number, OpcodeRecord>()
  for (const [pc, raw] of disassembled ?? []) {
    byPc.set(pc, { pc, raw, mnemonic: raw.split(' ', 1)[0] ?? raw })
  }
  for (const opcode of sevmMnemonics) {
    if (!byPc.has(opcode.pc)) byPc.set(opcode.pc, { ...opcode, raw: opcode.mnemonic })
  }
  return [...byPc.values()].sort((a, b) => a.pc - b.pc)
}

export function analyzeStaticSubjects(subjects: StaticSubject[]): StaticAnalysisResult {
  const findings: Evidence[] = []
  const nodes: ContractNode[] = []
  let paths = 0
  let branches = 0
  const availability: StaticAnalysisResult['engineAvailability'] = {
    whatsabi: { available: true },
    sevm: { available: true },
    evmole: { available: true },
  }

  for (const subject of subjects) {
    let selectors: Hex[] = []
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

    let sevmOpcodes: { pc: number; mnemonic: string }[] = []
    try {
      const contract = new Contract(subject.bytecode)
      sevmOpcodes = contract.opcodes().map((opcode) => ({ pc: opcode.pc, mnemonic: opcode.mnemonic }))
      paths = Math.max(paths, contract.blocks.size)
    } catch (error) {
      availability.sevm = { available: false, detail: error instanceof Error ? error.message : String(error) }
    }

    try {
      selectors = [...new Set([...selectors, ...selectorsFromBytecode(subject.bytecode).map(normalizeSelector)])]
      // Running ABI inference is part of the feasibility gate even when the report only stores selectors.
      abiFromBytecode(subject.bytecode)
    } catch (error) {
      availability.whatsabi = { available: false, detail: error instanceof Error ? error.message : String(error) }
    }

    const opcodes = normalizeOpcodes(disassembled, sevmOpcodes)
    findings.push(...analyzeRules(subject, opcodes))
    const bytecodeSize = Math.max(0, (subject.bytecode.length - 2) / 2)
    findings.push(...analyzeHookSurface(subject, selectors, bytecodeSize))
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

  return { findings, nodes, paths, branches, engineAvailability: availability }
}
