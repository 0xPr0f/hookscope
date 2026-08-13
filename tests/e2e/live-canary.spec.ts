import { expect, test } from '@playwright/test'

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'

test('Ethereum WETH read-only canary', async ({ page }) => {
  test.skip(!process.env.LIVE_CANARY, 'Set LIVE_CANARY=1 to exercise public RPC discovery and replay.')
  test.setTimeout(180_000)

  await page.goto('/')
  await page.getByRole('textbox', { name: 'Token address' }).fill(WETH)
  await page.getByRole('button', { name: 'Analyze token' }).click()

  await expect(page.getByText('Completed browser report')).toBeVisible({ timeout: 170_000 })
  await expect(page.getByText('Historical pool transaction reproduced in revm')).toBeVisible()
})
