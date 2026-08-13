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

  export type EvmoleContractInfo = {
    functions?: EvmoleFunction[]
    storage?: EvmoleStorageRecord[]
    transientStorage?: EvmoleStorageRecord[]
    disassembled?: [number, string][]
    basicBlocks?: [number, number][]
    controlFlowGraph?: { blocks: EvmoleBlock[] }
    metadata?: unknown
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
