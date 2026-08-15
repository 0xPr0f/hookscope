import { expect, test } from '@playwright/test'

const malformedAddress = `0x${'a'.repeat(41)}`

test('runs the deterministic browser engines and records bounded outcomes', async ({ page }) => {
  // The three browser projects run their 30k-input workers concurrently in CI;
  // slower shared runners can legitimately take longer than one worker's
  // internal 30-second exploration budget to render the completed report.
  test.setTimeout(90_000)
  await page.goto('/')
  await page.getByRole('button', { name: 'Load deterministic example' }).click()
  await page.getByRole('button', { name: 'Analyze token' }).click()

  await expect(page.getByText('Completed browser report')).toBeVisible({ timeout: 60_000 })
  await expect(
    page.getByLabel('Analysis phase coverage').getByText('80 real PoolManager executions', { exact: false }),
  ).toBeVisible()
  await expect(page.getByRole('heading', { name: /\d+ of 5 passed/ })).toBeVisible()
  await expect(page.getByText(/deterministic pools/)).toBeVisible()

  // Findings live in the evidence ledger, not in the overview summary.
  await page.getByRole('tab', { name: /Evidence/ }).click()
  await expect(page.getByText('Pinned-state hydration loop completed')).toBeVisible()
  await expect(page.getByText('Inputs produce different state outcomes')).toBeVisible()
  await expect(page.getByText('HookAuthorization.run_Auth_OnlyPoolManager_OnEntrypoints', { exact: false })).toBeVisible()
  await expect(page.getByText('HookConfiguration.run_PermissionsMatchAddressFlags_ifExposed', { exact: false })).toBeVisible()
  await page.getByRole('button').filter({ hasText: 'Inputs produce different state outcomes' }).click()
  await page.getByText('Raw technical record', { exact: true }).click()
  await expect(page.getByText(/libafl-worker-fanout-corpus-exchange\/0.2.0/)).toBeVisible()

  // Fixture conformance and public-pool suites are different products. The
  // deterministic report must show only its assertion oracle, never public
  // suites that did not run.
  await page.getByRole('tab', { name: /Tests/ }).click()
  await expect(page.getByText('How to read these suites')).toBeVisible()
  await expect(page.getByText('Runs the complete 40-case port against deterministic expected outcomes.', { exact: false })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'HackenPortFixtureConformance', exact: true })).toBeVisible()
  for (const suite of ['HackenPublicPoolAssertions', 'GeneratedPoolManagerScenarios', 'Erc20SettlementLane', 'LivePoolManagerScenarios']) {
    await expect(page.getByRole('heading', { name: suite, exact: true })).toHaveCount(0)
  }
  const transcript = page.getByLabel('HackenPortFixtureConformance scenario output')
  await expect(transcript).toContainText('Suite result: OK')
  await expect(transcript).toContainText('Tiny exact-input swap')
  await expect(transcript).toContainText('Executed against the deterministic browser conformance fixture')

  // Dense test rows must reflow instead of widening the document on phones.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('rejects a malformed address before starting workers', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('textbox', { name: 'Token address' }).fill(malformedAddress)
  await page.getByRole('button', { name: 'Analyze token' }).click()

  await expect(page.getByRole('alert')).toHaveText('Enter a valid 20-byte EVM address.')
  await expect(page.getByText('Browser analysis in progress')).toHaveCount(0)
})

test('loads the exact Solidity compiler lazily and returns compact AST facts', async ({ page }) => {
  test.setTimeout(120_000)
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  await page.goto('/')
  await expect(page).toHaveTitle(/Hookscope/)
  await page.getByRole('button', { name: 'Load deterministic example' }).click()
  await expect(page.getByRole('textbox', { name: 'Token address' })).not.toHaveValue('')

  const result = await page.evaluate(async () => {
    const id = crypto.randomUUID()
    const worker = new Worker('/solc.worker.js', { name: 'hookscope-solc-e2e' })
    try {
      return await new Promise<{ summary: { compilerVersion: string; functions: { name: string }[]; stateWrites: { variable: string }[] } }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Compiler worker timed out.')), 90_000)
        worker.onerror = (event) => {
          clearTimeout(timeout)
          reject(new Error(event.message))
        }
        worker.onmessage = (event) => {
          if (event.data?.id !== id || event.data?.type === 'progress') return
          clearTimeout(timeout)
          if (event.data.type === 'failure') reject(new Error(event.data.message))
          else resolve(event.data)
        }
        worker.postMessage({
          type: 'compile',
          id,
          compilerVersion: '0.8.35+commit.47b9dedd',
          fullyQualifiedName: 'src/Hook.sol:Hook',
          input: {
            language: 'Solidity',
            sources: {
              'src/Hook.sol': {
                content: 'pragma solidity ^0.8.35; contract Hook { uint256 public fee; function beforeSwap() external { fee = 1; } }',
              },
            },
            settings: {
              optimizer: { enabled: true, runs: 1 },
              evmVersion: 'cancun',
              outputSelection: {
                '*': { '': ['ast'] },
                'src/Hook.sol': { Hook: ['abi', 'storageLayout', 'evm.methodIdentifiers'] },
              },
            },
          },
        })
      })
    } finally {
      worker.terminate()
    }
  })

  expect(result.summary.compilerVersion).toContain('0.8.35+commit.47b9dedd')
  expect(result.summary.functions.some((fn) => fn.name === 'beforeSwap')).toBe(true)
  expect(result.summary.stateWrites.some((write) => write.variable === 'fee')).toBe(true)
  expect(consoleErrors).toEqual([])
  await page.screenshot({ path: '/tmp/hookscope-source-worker.png', fullPage: false })
})
