import type { Address, Hex } from 'viem'
import runtimes from './generated/custom-router-9409-runtimes.json'

/**
 * Frozen mainnet fixtures for the custom v4 unlock router family.
 *
 * Every value here was read once from Ethereum mainnet and checked in, so the
 * test suite never depends on Etherscan, Blockscout, or a public RPC. Two of the
 * three samples share a router deployment; the third is a different deployment
 * of the same compiled program, which is what makes the template hypothesis
 * testable rather than assumed.
 *
 * Nothing in this file is derived from a block explorer's decoded view. The
 * calldata, runtime bytecode, receipts and call trace all come from raw JSON-RPC
 * responses, and the expected fields below were decoded from that calldata and
 * cross-checked against the PoolManager `Swap` event each receipt actually
 * contains.
 */

export const CUSTOM_ROUTER_CHAIN_ID = 1
export const CUSTOM_ROUTER_POOL_MANAGER = '0x000000000004444c5dc75cB358380D2e3dE08A90' as Address

/**
 * keccak256 of either deployment's runtime with the five configuration ranges
 * zeroed. Both deployments produce this, which is the template identity.
 */
export const CUSTOM_ROUTER_TEMPLATE_HASH =
  '0xd6326d112ed2fcea1db130c8cf7885cb3fc05c284fb821d932031f77696e27ac' as Hex

export type CustomRouterSample = {
  id: string
  label: string
  transactionHash: Hex
  blockNumber: bigint
  stateBlockNumber: bigint
  actor: Address
  router: Address
  value: bigint
  calldata: Hex
  receipt: {
    status: 'success'
    gasUsed: number
    logCount: number
    /** Raw receipt logs, so payer identification is exercised on real data. */
    logs: { address: Address; topics: Hex[]; data: Hex }[]
  }
  runtimeKey: 'owl' | 'hfa'
  runtimeCodeHash: Hex
  configurationAddress: Address
  expected: {
    zeroForOne: boolean
    token: Address
    fee: number
    tickSpacing: number
    hook: Address
    amountIn: bigint
    settlementCurrency: Address
    poolId: Hex
  }
  /**
   * Ordered calls from the chain's own callTracer output.
   *
   * Present for one sample. The provider served a single trace request and then
   * refused the rest, and a partially captured trace is worth more frozen than a
   * synthesized one: the attestation this feeds is built from the browser's own
   * revm proof, so this fixture exists to prove the expected shape is real, not
   * to be the source of truth at runtime.
   */
  tracedCalls?: { from: Address; to: Address; selector: Hex }[]
}

export const CUSTOM_ROUTER_SAMPLES: CustomRouterSample[] = [
  {
    id: 'owl-1',
    label: 'OWL — One Way Liquidity',
    transactionHash: '0x3bc74bfb8faaaef19b0fe08f0bf4fe6bb5cf35959d0eccb1453d70e4a6871564',
    blockNumber: 25754415n,
    /** Parent block: the state a replay pins to. */
    stateBlockNumber: 25754414n,
    actor: '0xbbd64a6De020a1e2CaF3eABe3781B8958D03C728',
    router: '0xDA5cA0eF1c9c8c19bf497C4cEd61d9FFCD49bE6f',
    value: 0n,
    calldata: '0x9409a78f00000000000000000000000000000000000000000000000000000000000000000000000000000000000000003c4952ccf02d4dbb4c48077bbfe8296b3dfdb4bc000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000000c8000000000000000000000000239732813d5f9b531abc736b1c9478f7088e00400000000000000000000000000000000000000000000523dbeff3aea22ae60dd70000000000000000000000003c4952ccf02d4dbb4c48077bbfe8296b3dfdb4bc',
    receipt: { status: 'success', gasUsed: 124207, logCount: 3,
      logs: [
        { address: '0x3c4952ccf02d4dbb4c48077bbfe8296b3dfdb4bc', topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x000000000000000000000000bbd64a6de020a1e2caf3eabe3781b8958d03c728', '0x000000000000000000000000da5ca0ef1c9c8c19bf497c4ced61d9ffcd49be6f'], data: '0x0000000000000000000000000000000000000000000523dbeff3aea22ae60dd7' },
        { address: '0x000000000004444c5dc75cb358380d2e3de08a90', topics: ['0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f', '0x7636dcfb1f625890f8c5a0d745d1ddee098ae303d667df6ff7f93460b5eaa557', '0x000000000000000000000000da5ca0ef1c9c8c19bf497c4ced61d9ffcd49be6f'], data: '0x00000000000000000000000000000000000000000000000000562df7ad256daffffffffffffffffffffffffffffffffffffffffffffadc24100c515dd519f2290000000000000000000000000000000000003ed4ebe4f9990158e1c20acf40f700000000000000000000000000000000000000000000084759fb64dcc797526c000000000000000000000000000000000000000000000000000000000002f4ba0000000000000000000000000000000000000000000000000000000000000000' },
        { address: '0x3c4952ccf02d4dbb4c48077bbfe8296b3dfdb4bc', topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x000000000000000000000000da5ca0ef1c9c8c19bf497c4ced61d9ffcd49be6f', '0x000000000000000000000000000000000004444c5dc75cb358380d2e3de08a90'], data: '0x0000000000000000000000000000000000000000000523dbeff3aea22ae60dd7' },
      ],
    },
    runtimeKey: 'owl',
    runtimeCodeHash: '0x9a1482db696ef780bfa6118c89ed776b320d384e329909ad70f4ee420ab85528',
    configurationAddress: '0x8Dd4BDd944ccb9D6D5f37941c609744299776845',
    expected: {
      zeroForOne: false,
      token: '0x3c4952CCF02d4dbB4C48077BBfe8296b3dfdb4bC',
      fee: 8388608,
      tickSpacing: 200,
      hook: '0x239732813D5F9B531abc736B1C9478F7088E0040',
      amountIn: 6213969052281131780935127n,
      settlementCurrency: '0x3c4952CCF02d4dbB4C48077BBfe8296b3dfdb4bC',
      poolId: '0x7636dcfb1f625890f8c5a0d745d1ddee098ae303d667df6ff7f93460b5eaa557',
    },
    /** Ordered calls from the chain's own callTracer output, when captured. */
    tracedCalls: [
      { from: '0xbbd64a6De020a1e2CaF3eABe3781B8958D03C728', to: '0xDA5cA0eF1c9c8c19bf497C4cEd61d9FFCD49bE6f', selector: '0x9409a78f' },
      { from: '0xDA5cA0eF1c9c8c19bf497C4cEd61d9FFCD49bE6f', to: '0x3c4952CCF02d4dbB4C48077BBfe8296b3dfdb4bC', selector: '0x23b872dd' },
      { from: '0xDA5cA0eF1c9c8c19bf497C4cEd61d9FFCD49bE6f', to: '0x239732813D5F9B531abc736B1C9478F7088E0040', selector: '0xd28cebb8' },
      { from: '0xDA5cA0eF1c9c8c19bf497C4cEd61d9FFCD49bE6f', to: '0x000000000004444c5dc75cB358380D2e3dE08A90', selector: '0x48c89491' },
      { from: '0x000000000004444c5dc75cB358380D2e3dE08A90', to: '0xDA5cA0eF1c9c8c19bf497C4cEd61d9FFCD49bE6f', selector: '0x91dd7346' },
      { from: '0xDA5cA0eF1c9c8c19bf497C4cEd61d9FFCD49bE6f', to: '0x000000000004444c5dc75cB358380D2e3dE08A90', selector: '0xf3cd914c' },
      { from: '0x000000000004444c5dc75cB358380D2e3dE08A90', to: '0x239732813D5F9B531abc736B1C9478F7088E0040', selector: '0xb47b2fb1' },
      { from: '0xDA5cA0eF1c9c8c19bf497C4cEd61d9FFCD49bE6f', to: '0x000000000004444c5dc75cB358380D2e3dE08A90', selector: '0xa5841194' },
      { from: '0x000000000004444c5dc75cB358380D2e3dE08A90', to: '0x3c4952CCF02d4dbB4C48077BBfe8296b3dfdb4bC', selector: '0x70a08231' },
      { from: '0xDA5cA0eF1c9c8c19bf497C4cEd61d9FFCD49bE6f', to: '0x3c4952CCF02d4dbB4C48077BBfe8296b3dfdb4bC', selector: '0xa9059cbb' },
      { from: '0xDA5cA0eF1c9c8c19bf497C4cEd61d9FFCD49bE6f', to: '0x000000000004444c5dc75cB358380D2e3dE08A90', selector: '0x11da60b4' },
      { from: '0x000000000004444c5dc75cB358380D2e3dE08A90', to: '0x3c4952CCF02d4dbB4C48077BBfe8296b3dfdb4bC', selector: '0x70a08231' },
      { from: '0xDA5cA0eF1c9c8c19bf497C4cEd61d9FFCD49bE6f', to: '0x000000000004444c5dc75cB358380D2e3dE08A90', selector: '0x0b0d9c09' },
    ],
  },
  {
    id: 'owl-2',
    label: 'OWL — One Way Liquidity',
    transactionHash: '0xe8c2d9a49884b837ded357476196f5b64c633a32755585db543a8d82334302b0',
    blockNumber: 25754415n,
    /** Parent block: the state a replay pins to. */
    stateBlockNumber: 25754414n,
    actor: '0xBF31a22188327CDdBc25737d3c5e0A0176E1AbD1',
    router: '0xDA5cA0eF1c9c8c19bf497C4cEd61d9FFCD49bE6f',
    value: 0n,
    calldata: '0x9409a78f00000000000000000000000000000000000000000000000000000000000000000000000000000000000000003c4952ccf02d4dbb4c48077bbfe8296b3dfdb4bc000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000000c8000000000000000000000000239732813d5f9b531abc736b1c9478f7088e004000000000000000000000000000000000000000000003b035cf1b7feaa8b791180000000000000000000000003c4952ccf02d4dbb4c48077bbfe8296b3dfdb4bc',
    receipt: { status: 'success', gasUsed: 119347, logCount: 3,
      logs: [
        { address: '0x3c4952ccf02d4dbb4c48077bbfe8296b3dfdb4bc', topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x000000000000000000000000bf31a22188327cddbc25737d3c5e0a0176e1abd1', '0x000000000000000000000000da5ca0ef1c9c8c19bf497c4ced61d9ffcd49be6f'], data: '0x00000000000000000000000000000000000000000003b035cf1b7feaa8b79118' },
        { address: '0x000000000004444c5dc75cb358380d2e3de08a90', topics: ['0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f', '0x7636dcfb1f625890f8c5a0d745d1ddee098ae303d667df6ff7f93460b5eaa557', '0x000000000000000000000000da5ca0ef1c9c8c19bf497c4ced61d9ffcd49be6f'], data: '0x000000000000000000000000000000000000000000000000003ccc07ef15712dfffffffffffffffffffffffffffffffffffffffffffc4fca30e4801557486ee80000000000000000000000000000000000003f46f9643d622632f0663210908f00000000000000000000000000000000000000000000084759fb64dcc797526c000000000000000000000000000000000000000000000000000000000002f5470000000000000000000000000000000000000000000000000000000000000000' },
        { address: '0x3c4952ccf02d4dbb4c48077bbfe8296b3dfdb4bc', topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x000000000000000000000000da5ca0ef1c9c8c19bf497c4ced61d9ffcd49be6f', '0x000000000000000000000000000000000004444c5dc75cb358380d2e3de08a90'], data: '0x00000000000000000000000000000000000000000003b035cf1b7feaa8b79118' },
      ],
    },
    runtimeKey: 'owl',
    runtimeCodeHash: '0x9a1482db696ef780bfa6118c89ed776b320d384e329909ad70f4ee420ab85528',
    configurationAddress: '0x8Dd4BDd944ccb9D6D5f37941c609744299776845',
    expected: {
      zeroForOne: false,
      token: '0x3c4952CCF02d4dbB4C48077BBfe8296b3dfdb4bC',
      fee: 8388608,
      tickSpacing: 200,
      hook: '0x239732813D5F9B531abc736B1C9478F7088E0040',
      amountIn: 4458906560927287739912472n,
      settlementCurrency: '0x3c4952CCF02d4dbB4C48077BBfe8296b3dfdb4bC',
      poolId: '0x7636dcfb1f625890f8c5a0d745d1ddee098ae303d667df6ff7f93460b5eaa557',
    },
    /** Ordered calls from the chain's own callTracer output, when captured. */
    tracedCalls: undefined,
  },
  {
    id: 'hfa-1',
    label: 'HFA — HardFloorAssets',
    transactionHash: '0xe1b5a03b7795bc7069feddb7910d7ff2e0bf0c7d1d849196152e3b3a8d68c5b3',
    blockNumber: 25740689n,
    /** Parent block: the state a replay pins to. */
    stateBlockNumber: 25740688n,
    actor: '0x6b46996F27139c261B3697FF20B0ba639B0f1C79',
    router: '0x251BC5A5C72c7c73B39398bdCe3dd4437237337A',
    value: 0n,
    calldata: '0x9409a78f0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000d0a606adf58b69a28d479aa510ce6fe96e0a1eb2000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000000c800000000000000000000000007f49e9ffb3a275004b7af057888d02a7569004000000000000000000000000000000000000000000005f894bc2f40abba72ef83000000000000000000000000d0a606adf58b69a28d479aa510ce6fe96e0a1eb2',
    receipt: { status: 'success', gasUsed: 119343, logCount: 3,
      logs: [
        { address: '0xd0a606adf58b69a28d479aa510ce6fe96e0a1eb2', topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x0000000000000000000000006b46996f27139c261b3697ff20b0ba639b0f1c79', '0x000000000000000000000000251bc5a5c72c7c73b39398bdce3dd4437237337a'], data: '0x00000000000000000000000000000000000000000005f894bc2f40abba72ef83' },
        { address: '0x000000000004444c5dc75cb358380d2e3de08a90', topics: ['0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f', '0xdea61bc786351aea1567f7110eaa590b051beec9fad227a8b2411c427ad0b210', '0x000000000000000000000000251bc5a5c72c7c73b39398bdce3dd4437237337a'], data: '0x000000000000000000000000000000000000000000000000009ca9a39a4da26cfffffffffffffffffffffffffffffffffffffffffffa076b43d0bf54458d107d000000000000000000000000000000000000325718fbbc0b2bfc960fcc0e75d000000000000000000000000000000000000000000000084759fb64dcc797526c000000000000000000000000000000000000000000000000000000000002e3690000000000000000000000000000000000000000000000000000000000000000' },
        { address: '0xd0a606adf58b69a28d479aa510ce6fe96e0a1eb2', topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x000000000000000000000000251bc5a5c72c7c73b39398bdce3dd4437237337a', '0x000000000000000000000000000000000004444c5dc75cb358380d2e3de08a90'], data: '0x00000000000000000000000000000000000000000005f894bc2f40abba72ef83' },
      ],
    },
    runtimeKey: 'hfa',
    runtimeCodeHash: '0xab38329ccdbf0eb9cff786c0d6389dc5d758589e788ba57e9298ca2d9bc92fc0',
    configurationAddress: '0x730B06524ECA6135A6A547B983580A06737A2423',
    expected: {
      zeroForOne: false,
      token: '0xD0a606aDf58b69a28D479aA510CE6FE96E0a1eb2',
      fee: 8388608,
      tickSpacing: 200,
      hook: '0x07f49E9FFb3A275004b7af057888d02a75690040',
      amountIn: 7218519664075836247699331n,
      settlementCurrency: '0xD0a606aDf58b69a28D479aA510CE6FE96E0a1eb2',
      poolId: '0xdea61bc786351aea1567f7110eaa590b051beec9fad227a8b2411c427ad0b210',
    },
    /** Ordered calls from the chain's own callTracer output, when captured. */
    tracedCalls: undefined,
  },
]

/** Runtime bytecode for each deployment, at that sample's parent block. */
export function customRouterRuntime(key: 'owl' | 'hfa'): Hex {
  return runtimes.runtimes[key].bytecode as Hex
}

/**
 * The pool each sample trades, as the analyzer would have discovered it.
 *
 * currency0 is native ETH for both pools, so the token the calldata carries is
 * currency1. The fee is the dynamic-fee flag rather than a fixed tier.
 */
export function customRouterPoolKey(sample: CustomRouterSample) {
  return {
    currency0: '0x0000000000000000000000000000000000000000' as Address,
    currency1: sample.expected.token,
    fee: sample.expected.fee,
    tickSpacing: sample.expected.tickSpacing,
    hooks: sample.expected.hook,
  }
}
