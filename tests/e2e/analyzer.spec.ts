import { expect, test } from '@playwright/test'

test('runs the deterministic browser engines and records bounded outcomes', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Load deterministic example' }).click()
  await page.getByRole('button', { name: 'Analyze token' }).click()

  await expect(page.getByText('Completed browser report')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('Pinned-state hydration loop completed')).toBeVisible()
  await expect(page.getByText('Inputs produce different state outcomes')).toBeVisible()
  await expect(page.getByText('HookAuthorization.run_Auth_OnlyPoolManager_OnEntrypoints', { exact: false })).toBeVisible()
  await expect(page.getByText('HookConfiguration.run_PermissionsMatchAddressFlags_ifExposed', { exact: false })).toBeVisible()
  await expect(page.getByTitle(/80 real PoolManager executions/)).toBeVisible()
  await expect(page.getByText(/30,000 inputs/)).toBeVisible()
  await page.getByRole('button').filter({ hasText: 'Inputs produce different state outcomes' }).click()
  await expect(page.getByText(/libafl-worker-fanout-corpus-exchange\/0.2.0/)).toBeVisible()
  await expect(page.getByTitle(/cold reads · 0 warm reads/)).toBeVisible()

  // The three PoolManager suites must stay visibly separate, each reporting its
  // own result, so a skipped suite can never read as another suite's outcome.
  await page.getByRole('tab', { name: /Tests/ }).click()
  for (const suite of ['HackenBrowserPort', 'GeneratedPoolManagerScenarios', 'LivePoolManagerScenarios']) {
    await expect(page.getByRole('heading', { name: suite, exact: true })).toBeVisible()
  }
  await expect(page.getByLabel('GeneratedPoolManagerScenarios scenario output')).toContainText('SKIP')
  await expect(page.getByLabel('HackenBrowserPort scenario output')).toContainText('Suite result: OK')
})

test('rejects the supplied malformed address before starting workers', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('textbox', { name: 'Token address' }).fill('0xD0a606aDf58b69a28D479aAA510CE6FE96E0a1eb2')
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
