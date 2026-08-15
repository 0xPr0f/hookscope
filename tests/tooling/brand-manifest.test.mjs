import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const project = new URL('../../', import.meta.url)

async function pngDimensions(path) {
  const bytes = await readFile(new URL(path, project))
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${path} must be a PNG`)
  assert.equal(bytes.subarray(12, 16).toString('ascii'), 'IHDR', `${path} must start with an IHDR chunk`)
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

async function pngColorType(path) {
  const bytes = await readFile(new URL(path, project))
  return bytes[25]
}

test('web manifest publishes complete, correctly sized Hookscope icons', async () => {
  const manifest = JSON.parse(await readFile(new URL('public/manifest.webmanifest', project), 'utf8'))

  assert.equal(manifest.id, '/')
  assert.equal(manifest.name, 'Hookscope — Uniswap v4 hook analyzer')
  assert.equal(manifest.short_name, 'Hookscope')
  assert.equal(manifest.display, 'standalone')
  assert.equal(manifest.theme_color, '#171714')

  const icons = manifest.icons.map(({ src, sizes, type, purpose }) => ({ src, sizes, type, purpose }))
  assert.deepEqual(icons, [
    { src: '/brand/hookscope-transparent-v2-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/brand/hookscope-transparent-v2-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/brand/hookscope-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ])

  assert.deepEqual(await pngDimensions('public/brand/hookscope-icon-180.png'), { width: 180, height: 180 })
  assert.deepEqual(await pngDimensions('public/brand/hookscope-icon-192.png'), { width: 192, height: 192 })
  assert.deepEqual(await pngDimensions('public/brand/hookscope-icon-512.png'), { width: 512, height: 512 })
  assert.deepEqual(await pngDimensions('public/brand/hookscope-icon-1024.png'), { width: 1024, height: 1024 })
  assert.deepEqual(await pngDimensions('public/brand/hookscope-transparent-v2-32.png'), { width: 32, height: 32 })
  assert.deepEqual(await pngDimensions('public/brand/hookscope-transparent-v2-48.png'), { width: 48, height: 48 })
  assert.deepEqual(await pngDimensions('public/brand/hookscope-transparent-v2-180.png'), { width: 180, height: 180 })
  assert.deepEqual(await pngDimensions('public/brand/hookscope-transparent-v2-192.png'), { width: 192, height: 192 })
  assert.deepEqual(await pngDimensions('public/brand/hookscope-transparent-v2-512.png'), { width: 512, height: 512 })
  assert.deepEqual(await pngDimensions('public/brand/hookscope-transparent-v2-1024.png'), { width: 1024, height: 1024 })

  for (const size of [32, 48, 180, 192, 512, 1024]) {
    assert.equal(await pngColorType(`public/brand/hookscope-transparent-v2-${size}.png`), 6, `the ${size}px mark must retain an alpha channel`)
  }
})

test('document metadata links the manifest, favicon, and Apple touch icon', async () => {
  const html = await readFile(new URL('index.html', project), 'utf8')
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/)
  assert.match(html, /rel="icon"[^>]+sizes="32x32"[^>]+href="\/brand\/hookscope-transparent-v2-32\.png"/)
  assert.match(html, /rel="icon"[^>]+sizes="48x48"[^>]+href="\/brand\/hookscope-transparent-v2-48\.png"/)
  assert.match(html, /rel="apple-touch-icon"[^>]+href="\/brand\/hookscope-transparent-v2-180\.png"/)
  assert.match(html, /property="og:image" content="\/brand\/hookscope-transparent-v2-1024\.png"/)
})
