import { useMemo } from 'react'
import type { ChainConfig } from '../config/chains'
import { AppDropdown } from './AppDropdown'
import { selectableChains } from './chainSelection'

const UNISWAP_INTERFACE_COMMIT = 'da6d36f71c4d2fd665b0aae1a052a4ffda917b31'
const UNISWAP_CHAIN_ASSET_ROOT = `https://raw.githubusercontent.com/Uniswap/interface/${UNISWAP_INTERFACE_COMMIT}/packages/ui/src/assets/logos/png`
const CHAIN_ICONS: Readonly<Record<number, string>> = {
  1: `${UNISWAP_CHAIN_ASSET_ROOT}/ethereum-logo.png`,
  10: `${UNISWAP_CHAIN_ASSET_ROOT}/optimism-logo.png`,
  130: `${UNISWAP_CHAIN_ASSET_ROOT}/unichain-logo.png`,
  196: `${UNISWAP_CHAIN_ASSET_ROOT}/xlayer-logo.png`,
  8453: `${UNISWAP_CHAIN_ASSET_ROOT}/base-logo.png`,
}

function ChainIcon({ chain }: { chain: ChainConfig }) {
  const source = CHAIN_ICONS[chain.id]
  return (
    <span className="chain-symbol">
      <span>{chain.shortName.slice(0, 2)}</span>
      {source && <img src={source} alt="" onError={(event) => { event.currentTarget.hidden = true }} />}
    </span>
  )
}

export function ChainDropdown({ chains, value, disabled = false, onChange }: {
  chains: readonly ChainConfig[]
  value: number
  disabled?: boolean
  onChange: (chainId: number) => void
}) {
  const available = useMemo(() => selectableChains(chains), [chains])
  return (
    <AppDropdown
      className="chain-dropdown"
      ariaLabel="Available chains"
      disabled={disabled}
      value={value}
      onChange={onChange}
      options={available.map((chain) => ({
        value: chain.id,
        label: chain.name,
        description: `${chain.shortName} · Chain ID ${chain.id}`,
        icon: <ChainIcon chain={chain} />,
      }))}
      menuMaxHeight={290}
    />
  )
}
