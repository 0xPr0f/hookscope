import { encodeAbiParameters, encodePacked, keccak256, type Address, type Hex } from 'viem'

export function computePoolId(input: {
  currency0: Address
  currency1: Address
  fee: number
  tickSpacing: number
  hook: Address
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'uint24' },
        { type: 'int24' },
        { type: 'address' },
      ],
      [input.currency0, input.currency1, input.fee, input.tickSpacing, input.hook],
    ),
  )
}

export function computePoolStateSlot(poolId: Hex): Hex {
  return keccak256(encodePacked(['bytes32', 'uint256'], [poolId, 6n]))
}
