import { encodeAbiParameters, keccak256, toHex, type Address, type Hex } from 'viem'
import manifest from '../fixtures/generated/protocol-scenario-router.json'
import type { ForkSnapshot, ForkSnapshotAccount } from './revmProof'
import { patchScenarioRouter, type PatchedScenarioRouter } from './protocolScenarioArtifact'

/**
 * Declared state overlay for generated PoolManager scenarios.
 *
 * Everything the scenario needs beyond real chain state is enumerated here, and
 * nothing else is touched: the harness code, native balances for the synthetic
 * actors, and ERC-6909 claim balances for the harness inside PoolManager.
 *
 * Hook storage, token storage, and pool state are never overwritten — the
 * scenario runs against the deployed pool as it actually is. That boundary is
 * what lets a generated observation be reported as evidence about the real hook
 * rather than about a simulated one.
 */

/** Uniswap represents a currency id as the address widened to uint256. */
export function currencyId(currency: Address): bigint {
  return BigInt(currency)
}

/**
 * Slot of `balanceOf[owner][id]` in PoolManager.
 *
 * Two nested mappings: the owner resolves to an intermediate slot, and the
 * currency id resolves within it. The base slot comes from the pinned build's
 * storage layout, never a hardcoded number.
 */
export function claimBalanceSlot(owner: Address, currency: Address): Hex {
  const base = BigInt(manifest.poolManagerStorage.slot)
  const ownerBase = keccak256(
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [owner, base]),
  )
  return keccak256(
    encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }], [currencyId(currency), ownerBase]),
  )
}

export type ScenarioActorFunding = {
  /** Native balance granted to each synthetic actor. */
  nativeWei: bigint
  /** ERC-6909 claim balance granted to the harness for each pool currency. */
  claimsPerCurrency: bigint
}

export const DEFAULT_FUNDING: ScenarioActorFunding = {
  nativeWei: 10n ** 18n,
  // Bounded on purpose: enough for the scenario corpus, nowhere near a pool's
  // reserves, so a generated swap cannot move the pool in ways no real actor could.
  claimsPerCurrency: 10n ** 21n,
}

export type ScenarioStateInput = {
  poolManager: Address
  poolManagerAccount: { balance: Hex; nonce: number; code: Hex }
  /**
   * Harness instances to inject. More than one identical instance at different
   * addresses is what lets a scenario vary the address the PoolManager — and so
   * the hook — sees as `sender`; changing the transaction caller alone cannot,
   * because the harness is always the contract that calls the PoolManager.
   */
  routers: readonly Address[]
  actors: readonly Address[]
  currencies: readonly [Address, Address]
  funding?: ScenarioActorFunding
}

export type ScenarioStateOverlay = {
  snapshot: ForkSnapshot
  patched: PatchedScenarioRouter
  /** Every override applied, so a report can declare them rather than imply them. */
  declaredOverrides: {
    address: Address
    kind: 'harness-code' | 'native-balance' | 'erc6909-claims'
    detail: string
  }[]
  /** Accounts the session must not overwrite with a plain RPC read. */
  overlaidAccounts: Address[]
}

/**
 * Builds the fork snapshot for a generated scenario.
 *
 * PoolManager keeps its real code, balance, and nonce; only claim slots are
 * merged in, and `storageComplete` stays false so every other slot still
 * hydrates from the pinned block on demand.
 */
export function buildScenarioStateOverlay(input: ScenarioStateInput): ScenarioStateOverlay {
  const funding = input.funding ?? DEFAULT_FUNDING
  const patched = patchScenarioRouter(input.poolManager)

  if (!input.routers.length) throw new Error('A scenario overlay needs at least one harness instance.')

  const claims: Record<string, Hex> = {}
  for (const router of input.routers) {
    for (const currency of input.currencies) {
      claims[claimBalanceSlot(router, currency)] = toHex(funding.claimsPerCurrency, { size: 32 })
    }
  }

  const poolManagerAccount: ForkSnapshotAccount = {
    address: input.poolManager,
    exists: true,
    balance: input.poolManagerAccount.balance,
    nonce: input.poolManagerAccount.nonce,
    code: input.poolManagerAccount.code,
    storage: claims,
    // Other PoolManager slots — pool state, fee growth — must still come from
    // the chain, so this account is explicitly incomplete.
    storageComplete: false,
  }

  const routerAccounts: ForkSnapshotAccount[] = input.routers.map((address) => ({
    address,
    exists: true,
    balance: toHex(funding.nativeWei, { size: 32 }),
    nonce: 1,
    code: patched.runtimeBytecode,
    storage: {},
    storageComplete: true,
  }))

  const actorAccounts: ForkSnapshotAccount[] = input.actors.map((address) => ({
    address,
    exists: true,
    balance: toHex(funding.nativeWei, { size: 32 }),
    nonce: 0,
    code: '0x',
    storage: {},
    storageComplete: true,
  }))

  const declaredOverrides: ScenarioStateOverlay['declaredOverrides'] = [
    ...input.routers.map((address) => ({
      address,
      kind: 'harness-code' as const,
      detail: `Injected scenario harness runtime ${patched.runtimeHash} bound to PoolManager ${patched.poolManager}.`,
    })),
    ...input.actors.map((address) => ({
      address,
      kind: 'native-balance' as const,
      detail: `Synthetic actor funded with ${funding.nativeWei} wei.`,
    })),
    {
      address: input.poolManager,
      kind: 'erc6909-claims',
      detail: `Each harness instance granted ${funding.claimsPerCurrency} ERC-6909 claims for each pool currency at balanceOf slot ${manifest.poolManagerStorage.slot}. No other PoolManager slot is overridden.`,
    },
  ]

  return {
    snapshot: { accounts: [poolManagerAccount, ...routerAccounts, ...actorAccounts], blockHashes: [] },
    patched,
    declaredOverrides,
    overlaidAccounts: [input.poolManager, ...input.routers, ...input.actors],
  }
}
