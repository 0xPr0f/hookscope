import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { test } from 'node:test'

const project = new URL('../../', import.meta.url)

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  return (await Promise.all(entries.map(async (entry) => {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory)
    return entry.isDirectory() ? sourceFiles(url) : entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [url] : []
  }))).flat()
}

test('Vercel API relative ESM imports name their emitted .js files', async () => {
  const api = new URL('api/', project)
  for (const file of await sourceFiles(api)) {
    const source = await readFile(file, 'utf8')
    for (const match of source.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/gu)) {
      assert.ok(
        match[1].endsWith('.js'),
        `${file.pathname}: relative ESM import ${match[1]} must end in .js for the Vercel Node runtime`,
      )
    }
  }
})
