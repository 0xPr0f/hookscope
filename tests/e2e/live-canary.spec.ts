import { expect, test } from '@playwright/test'

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'

test('Ethereum WETH read-only canary', async ({ page }) => {
  test.skip(!process.env.LIVE_CANARY, 'Set LIVE_CANARY=1 to exercise public RPC discovery and replay.')
  // Discovery on a token with many v4 pools dominates this run, and the point
  // of the canary is the execution suites that follow it.
  test.setTimeout(420_000)

  await page.goto('/')
  await page.getByRole('textbox', { name: 'Token address' }).fill(WETH)
  await page.getByRole('button', { name: 'Analyze token' }).click()

  await expect(page.getByText('Completed browser report')).toBeVisible({ timeout: 400_000 })

  await page.getByRole('tab', { name: /Evidence/ }).click()
  await expect(page.getByText('Historical pool transaction reproduced in revm')).toBeVisible()
  // The generated suite is the rollout canary: it must produce protocol-level
  // observations on a real Ethereum pool without any historical router.
  await expect(page.getByText('Generated PoolManager scenario suite')).toBeVisible()

  await page.getByRole('tab', { name: /Tests/ }).click()
  const generated = page.getByLabel('GeneratedPoolManagerScenarios scenario output')
  await expect(generated).toBeVisible()
  await expect(generated).not.toContainText('[SKIP]')
  // A revert is an observation; only an analyzer malfunction fails the suite.
  await expect(generated).not.toContainText('[ERROR]')
  await expect(generated).toContainText(/\[PASS\]|\[OBSERVED REVERT\]/)
})
