import { getAddress, type Address, type Hex } from 'viem'
import type { ForkSnapshot } from '../analysis/revmProof'
import contextJson from './generated/hacken-context.json'
import stateJson from './generated/hacken-state.json'

type DumpedAccount = {
  nonce: Hex
  balance: Hex
  code: Hex
  storage: Record<string, Hex>
}

export type HackenFixtureContext = {
  chainId: number
  actor: Address
  observer: Address
  poolManager: Address
  swapRouter: Address
  alternateSwapRouter: Address
  liquidityRouter: Address
  donateRouter: Address
  hook: Address
  currency0: Address
  currency1: Address
  fee: number
  tickSpacing: number
  poolId: Hex
  secondaryPoolId: Hex
  secondaryTickSpacing: number
  nativeCurrency0: Address
  nativeCurrency1: Address
  nativePoolId: Hex
  sqrtPriceX96: bigint
}

export const HACKEN_FIXTURE_CONTEXT: HackenFixtureContext = {
  chainId: Number(contextJson.chainId),
  actor: getAddress(contextJson.actor),
  observer: getAddress(contextJson.observer),
  poolManager: getAddress(contextJson.poolManager),
  swapRouter: getAddress(contextJson.swapRouter),
  alternateSwapRouter: getAddress(contextJson.alternateSwapRouter),
  liquidityRouter: getAddress(contextJson.liquidityRouter),
  donateRouter: getAddress(contextJson.donateRouter),
  hook: getAddress(contextJson.hook),
  currency0: getAddress(contextJson.currency0),
  currency1: getAddress(contextJson.currency1),
  fee: Number(contextJson.fee),
  tickSpacing: Number(contextJson.tickSpacing),
  poolId: contextJson.poolId as Hex,
  secondaryPoolId: contextJson.secondaryPoolId as Hex,
  secondaryTickSpacing: Number(contextJson.secondaryTickSpacing),
  nativeCurrency0: getAddress(contextJson.nativeCurrency0),
  nativeCurrency1: getAddress(contextJson.nativeCurrency1),
  nativePoolId: contextJson.nativePoolId as Hex,
  sqrtPriceX96: BigInt(contextJson.sqrtPriceX96),
}

export function hackenFixtureSnapshot(): ForkSnapshot {
  const accounts = Object.entries(stateJson as Record<string, DumpedAccount>).map(([address, account]) => ({
    address: getAddress(address),
    exists: true,
    balance: account.balance,
    nonce: Number(BigInt(account.nonce)),
    code: account.code,
    storage: account.storage,
    storageComplete: true,
  }))
  accounts.push({
    address: getAddress('0x0000000000000000000000000000000000000000'),
    exists: false,
    balance: '0x0',
    nonce: 0,
    code: '0x',
    storage: {},
    storageComplete: true,
  })
  return { accounts, blockHashes: [] }
}
