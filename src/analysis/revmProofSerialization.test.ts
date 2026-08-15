import { describe, expect, it } from 'vitest'
import { getAddress, type Hex } from 'viem'
import { serializeForkReplayTransaction, type ForkReplayTransaction } from './revmProof'

const base: ForkReplayTransaction = {
  caller: getAddress('0x1111111111111111111111111111111111111111'),
  to: getAddress('0x2222222222222222222222222222222222222222'),
  calldata: '0x' as Hex,
  value: 0n,
  gasLimit: 21_000n,
  gasPrice: 1n,
  nonce: 7,
  chainId: 1,
}

describe('fork transaction worker serialization', () => {
  it('preserves explicit simulation semantics', () => {
    expect(serializeForkReplayTransaction({ ...base, executionMode: 'simulation' }))
      .toMatchObject({ executionMode: 'simulation', nonce: 7 })
  })

  it('omits the mode for strict historical transaction semantics', () => {
    expect(serializeForkReplayTransaction(base)).not.toHaveProperty('executionMode')
  })
})
