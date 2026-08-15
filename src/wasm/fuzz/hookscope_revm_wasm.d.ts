/* tslint:disable */
/* eslint-disable */
export function inspect_fork(snapshot: any, transaction: any, block: any): any;
export function create_fork_session(session_id: string, snapshot: any): void;
export function hydrate_fork_session(session_id: string, update: any): void;
export function inspect_fork_session(session_id: string, transaction: any, block: any, commit: boolean): any;
export function fuzz_fork_session(session_id: string, transaction: any, block: any, max_executions: number, seed: bigint, mutable_indices: any, seed_corpus: any): any;
export function dispose_fork_session(session_id: string): void;
export function engine_version(): string;
export function inspect_runtime(runtime_bytecode: string, calldata: string): any;
export function explore_runtime(runtime_bytecode: string, max_executions: number): any;
export function fuzz_runtime(runtime_bytecode: string, max_executions: number, seed: bigint): any;
export function fuzz_runtime_with_seeds(runtime_bytecode: string, max_executions: number, seed: bigint, exchange_seeds: any): any;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly external_current_millis: () => bigint;
  readonly inspect_fork: (a: any, b: any, c: any) => [number, number, number];
  readonly create_fork_session: (a: number, b: number, c: any) => [number, number];
  readonly hydrate_fork_session: (a: number, b: number, c: any) => [number, number];
  readonly inspect_fork_session: (a: number, b: number, c: any, d: any, e: number) => [number, number, number];
  readonly fuzz_fork_session: (a: number, b: number, c: any, d: any, e: number, f: bigint, g: any, h: any) => [number, number, number];
  readonly dispose_fork_session: (a: number, b: number) => void;
  readonly engine_version: () => [number, number];
  readonly inspect_runtime: (a: number, b: number, c: number, d: number) => [number, number, number];
  readonly explore_runtime: (a: number, b: number, c: number) => [number, number, number];
  readonly fuzz_runtime: (a: number, b: number, c: number, d: bigint) => [number, number, number];
  readonly fuzz_runtime_with_seeds: (a: number, b: number, c: number, d: bigint, e: any) => [number, number, number];
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_externrefs: WebAssembly.Table;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
