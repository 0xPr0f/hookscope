import { describe, expect, it } from 'vitest'
import { keccak256, type Address } from 'viem'
import { fetchSourcifyCompilationBundle, fetchSourcifyStatus, sourcifyMatchesCodeHash } from './source'

const ADDRESS = '0x1111111111111111111111111111111111111111' as Address

describe('Sourcify contract metadata', () => {
  it('maps verified compiler identity and authoritative signatures without downloading source text', async () => {
    let requestedUrl = ''
    const result = await fetchSourcifyStatus(1, ADDRESS, undefined, async (url) => {
      requestedUrl = String(url)
      return new Response(JSON.stringify({
        match: 'match',
        verifiedAt: '2026-08-12T18:15:03.000Z',
        runtimeBytecode: { onchainBytecode: '0x6000' },
        compilation: {
          language: 'Solidity',
          compilerVersion: '0.8.35+commit.47b9dedd',
          name: 'HardFloorAssets',
          fullyQualifiedName: 'src/HardFloorAssets.sol:HardFloorAssets',
        },
        signatures: {
          function: [{ signature: 'transfer(address,uint256)', signatureHash4: '0xa9059cbb' }],
          event: [{ signature: 'Transfer(address,address,uint256)', signatureHash4: '0xddf252ad' }],
        },
        proxyResolution: { proxyType: null },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    expect(requestedUrl).toContain('fields=creationBytecode,runtimeBytecode,compilation,signatures,proxyResolution')
    expect(requestedUrl).not.toContain('sources')
    expect(result).toMatchObject({
      verified: true,
      compilerVersion: '0.8.35+commit.47b9dedd',
      contractName: 'HardFloorAssets',
      runtimeCodeHash: keccak256('0x6000'),
      selectors: ['0xa9059cbb'],
      functionSignatures: ['transfer(address,uint256)'],
    })
    expect(sourcifyMatchesCodeHash(result, keccak256('0x6000'))).toBe(true)
    expect(sourcifyMatchesCodeHash(result, keccak256('0x6001'))).toBe(false)
  })

  it('builds a bounded reproducible compiler input only on the lazy source path', async () => {
    const bundle = await fetchSourcifyCompilationBundle(1, ADDRESS, undefined, async () => new Response(JSON.stringify({
      match: 'match',
      verifiedAt: '2026-08-12T18:15:03.000Z',
      runtimeBytecode: { onchainBytecode: '0x6000' },
      sources: { 'src/Hook.sol': { content: 'pragma solidity ^0.8.0; contract Hook {}' } },
      compilation: {
        language: 'Solidity',
        compilerVersion: '0.8.35+commit.47b9dedd',
        fullyQualifiedName: 'src/Hook.sol:Hook',
        compilerSettings: { optimizer: { enabled: true, runs: 1 }, viaIR: true, evmVersion: 'cancun' },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    expect(bundle).toMatchObject({
      language: 'Solidity',
      compilerVersion: '0.8.35+commit.47b9dedd',
      fullyQualifiedName: 'src/Hook.sol:Hook',
      totalSourceBytes: 40,
      runtimeCodeHash: keccak256('0x6000'),
    })
  })
})
