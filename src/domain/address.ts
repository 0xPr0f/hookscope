import { getAddress, isAddress, type Address } from 'viem'

export class InvalidTokenAddressError extends Error {
  constructor(message = 'Enter a valid 20-byte EVM address.') {
    super(message)
    this.name = 'InvalidTokenAddressError'
  }
}

export function parseTokenAddress(value: string): Address {
  const trimmed = value.trim()
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed) || !isAddress(trimmed, { strict: false })) {
    throw new InvalidTokenAddressError()
  }
  return getAddress(trimmed)
}

export function shortAddress(address: Address, start = 6, end = 6): string {
  return `${address.slice(0, start + 2)}…${address.slice(-end)}`
}
