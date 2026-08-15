/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export const inspect_fork: (a: any, b: any, c: any) => [number, number, number];
export const create_fork_session: (a: number, b: number, c: any) => [number, number];
export const hydrate_fork_session: (a: number, b: number, c: any) => [number, number];
export const inspect_fork_session: (a: number, b: number, c: any, d: any, e: number) => [number, number, number];
export const dispose_fork_session: (a: number, b: number) => void;
export const engine_version: () => [number, number];
export const inspect_runtime: (a: number, b: number, c: number, d: number) => [number, number, number];
export const explore_runtime: (a: number, b: number, c: number) => [number, number, number];
export const __wbindgen_malloc: (a: number, b: number) => number;
export const __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
export const __wbindgen_exn_store: (a: number) => void;
export const __externref_table_alloc: () => number;
export const __wbindgen_externrefs: WebAssembly.Table;
export const __externref_table_dealloc: (a: number) => void;
export const __wbindgen_free: (a: number, b: number, c: number) => void;
export const __wbindgen_start: () => void;
