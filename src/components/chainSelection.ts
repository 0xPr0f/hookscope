import type { ChainConfig } from '../config/chains'

export function selectableChains(chains: readonly ChainConfig[]) {
  return chains.filter((chain) => chain.deepExecution)
}
