import { describe, expect, it } from 'vitest'
import { getAddress, toHex, type Address, type Hex } from 'viem'
import manifest from '../fixtures/generated/protocol-scenario-router.json'
import {
  DEFAULT_FUNDING,
  buildScenarioStateOverlay,
  claimBalanceSlot,
  currencyId,
} from './protocolScenarioState'

const POOL_MANAGER = '0x000000000004444c5dc75cB358380D2e3dE08A90' as Address
const ROUTER = '0x00000000000000000000000000000000ScEnAr10'.replace('ScEnAr10', '5ce4a710') as Address
const ACTOR = '0x1111111111111111111111111111111111111111' as Address
const CURRENCY0 = '0x0000000000000000000000000000000000000000' as Address
const CURRENCY1 = '0x2222222222222222222222222222222222222222' as Address

describe('generated-scenario state overlay', () => {
  it('derives the ERC-6909 claim slot Foundry actually writes', () => {
    // Ground truth from test_erc6909ClaimSlotDerivationMatchesStorage: minting
    // to 0xBEEF placed the balance at this slot in a real PoolManager.
    const owner = '0x000000000000000000000000000000000000bEEF' as Address
    const currency = getAddress('0x15cf58144ef33af1e14b5208015d11f9143e27b9')
    expect(claimBalanceSlot(owner, currency)).toBe(
      '0x47d4634536a12c531603a7952e6a002ea6ccf9bf189b5bcd7420d15fd46cd25d',
    )
  })

  it('treats a currency id as the address widened to uint256', () => {
    expect(currencyId(getAddress('0x15cf58144ef33af1e14b5208015d11f9143e27b9')))
      .toBe(124512733235148509670984850249661524172173354937n)
    expect(currencyId(CURRENCY0)).toBe(0n)
  })

  it('keeps PoolManager state real apart from the declared claim slots', () => {
    const overlay = buildScenarioStateOverlay({
      poolManager: POOL_MANAGER,
      poolManagerAccount: { balance: toHex(5n, { size: 32 }), nonce: 7, code: '0x6001' as Hex },
      router: ROUTER,
      actors: [ACTOR],
      currencies: [CURRENCY0, CURRENCY1],
    })

    const managerAccount = overlay.snapshot.accounts.find((a) => a.address === POOL_MANAGER)!
    expect(managerAccount.code).toBe('0x6001')
    expect(managerAccount.nonce).toBe(7)
    expect(managerAccount.balance).toBe(toHex(5n, { size: 32 }))
    // Pool state must still hydrate from chain.
    expect(managerAccount.storageComplete).toBe(false)
    expect(Object.keys(managerAccount.storage)).toEqual([
      claimBalanceSlot(ROUTER, CURRENCY0),
      claimBalanceSlot(ROUTER, CURRENCY1),
    ])
    expect(Object.values(managerAccount.storage)).toEqual([
      toHex(DEFAULT_FUNDING.claimsPerCurrency, { size: 32 }),
      toHex(DEFAULT_FUNDING.claimsPerCurrency, { size: 32 }),
    ])
  })

  it('injects the harness bound to this chain manager and funds the actors', () => {
    const overlay = buildScenarioStateOverlay({
      poolManager: POOL_MANAGER,
      poolManagerAccount: { balance: '0x0' as Hex, nonce: 0, code: '0x60' as Hex },
      router: ROUTER,
      actors: [ACTOR],
      currencies: [CURRENCY0, CURRENCY1],
    })

    const router = overlay.snapshot.accounts.find((a) => a.address === ROUTER)!
    expect(router.code).toBe(overlay.patched.runtimeBytecode)
    expect(overlay.patched.poolManager).toBe(getAddress(POOL_MANAGER))
    const actor = overlay.snapshot.accounts.find((a) => a.address === ACTOR)!
    expect(actor.code).toBe('0x')
    expect(actor.balance).toBe(toHex(DEFAULT_FUNDING.nativeWei, { size: 32 }))
  })

  it('enumerates every override so a report declares rather than implies them', () => {
    const overlay = buildScenarioStateOverlay({
      poolManager: POOL_MANAGER,
      poolManagerAccount: { balance: '0x0' as Hex, nonce: 0, code: '0x60' as Hex },
      router: ROUTER,
      actors: [ACTOR],
      currencies: [CURRENCY0, CURRENCY1],
    })
    expect(overlay.declaredOverrides.map((o) => o.kind)).toEqual([
      'harness-code',
      'native-balance',
      'erc6909-claims',
    ])
    expect(overlay.declaredOverrides.at(-1)!.detail).toContain(`slot ${manifest.poolManagerStorage.slot}`)
    expect(overlay.overlaidAccounts).toEqual([POOL_MANAGER, ROUTER, ACTOR])
  })
})
