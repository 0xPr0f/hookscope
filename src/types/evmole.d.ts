declare module 'evmole' {
  export type EvmoleFunction = {
    selector: string
    bytecodeOffset: number
    dispatch: 'abi' | 'fallback'
    arguments?: string
    stateMutability?: string
  }

  export type EvmoleStorageRecord = {
    slot: string
    offset: number
    type: string
    reads: string[]
    writes: string[]
  }

  export type EvmoleBlock = {
    id: number
    start: number
    end: number
    type: 'Terminate' | 'Jump' | 'Jumpi' | 'DynamicJump' | 'DynamicJumpi'
    data: unknown
  }

  export type EvmoleCborValue =
    | { type: 'string'; value: string }
    | { type: 'integer'; value: number }
    | { type: 'bytes'; value: string }
    | { type: 'bool'; value: boolean }
    | { type: 'undecoded'; value: string }

  export type EvmoleCborEntry = { key: string; value: EvmoleCborValue }

  /** Terminal CBOR metadata Solidity appends to deployed bytecode. */
  export type EvmoleCborMetadata = {
    bytecodeOffset: number
    cborLength: number
    entries: EvmoleCborEntry[]
  }

  export type EvmoleContractInfo = {
    functions?: EvmoleFunction[]
    storage?: EvmoleStorageRecord[]
    transientStorage?: EvmoleStorageRecord[]
    disassembled?: [number, string][]
    basicBlocks?: [number, number][]
    controlFlowGraph?: { blocks: EvmoleBlock[] }
    metadata?: EvmoleCborMetadata
  }

  export function contractInfo(
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
  ): EvmoleContractInfo

  export function initEvmole(input: {
    module_or_path: RequestInfo | URL | Response | BufferSource | WebAssembly.Module
  }): Promise<WebAssembly.Exports>
}

declare module 'evmole/no_tla' {
  export { contractInfo } from 'evmole'

  const initEvmole: (input: {
    module_or_path: RequestInfo | URL | Response | BufferSource | WebAssembly.Module
  }) => Promise<WebAssembly.Exports>

  export default initEvmole
}

declare module 'evmole/evmole_bg.wasm?url' {
  const url: string
  export default url
}
