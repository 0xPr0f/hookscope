import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const failures = []

function check(condition, message) {
  if (!condition) failures.push(message)
}

function filesUnder(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? filesUnder(path) : [path]
  })
}

let vercel
try {
  vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'))
} catch (error) {
  failures.push(`vercel.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
}

if (vercel) {
  check(vercel.$schema === 'https://openapi.vercel.sh/vercel.json', 'vercel.json must declare the official schema.')
  check(vercel.framework === 'vite', 'vercel.json must select the Vite framework preset.')
  check(vercel.installCommand === 'pnpm install --frozen-lockfile', 'vercel.json must install from the lockfile.')
  check(vercel.buildCommand === 'pnpm build', 'vercel.json must use the production build command.')
  check(vercel.outputDirectory === 'dist', 'vercel.json must publish dist/.')
  check(vercel.functions?.['api/**/*.ts']?.maxDuration === 10, 'Storage functions must have a 10-second maximum duration.')
  check(
    vercel.rewrites?.some((rewrite) => rewrite.source.includes('(?!api/)') && rewrite.destination === '/index.html'),
    'The SPA rewrite must exclude /api routes.',
  )
  check(!JSON.stringify(vercel).includes('DATABASE_URL'), 'vercel.json must not contain DATABASE_URL or its secret value.')
}

const envExample = readFileSync(join(root, '.env.example'), 'utf8')
const exampleKeys = envExample
  .split(/\r?\n/u)
  .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=/u)?.[1])
  .filter(Boolean)
check(exampleKeys.includes('DATABASE_URL'), '.env.example must document DATABASE_URL.')
check(!exampleKeys.includes('VITE_DATABASE_URL'), 'DATABASE_URL must never use the VITE_ public prefix.')
check(/^DATABASE_URL=$/mu.test(envExample), '.env.example must leave DATABASE_URL empty.')

const browserSourceFiles = filesUnder(join(root, 'src')).filter((path) => /\.[cm]?[jt]sx?$/u.test(path))
for (const path of browserSourceFiles) {
  const source = readFileSync(path, 'utf8')
  check(!source.includes('DATABASE_URL'), `${relative(root, path)} references the server-only DATABASE_URL.`)
  check(!source.includes('VITE_DATABASE_URL'), `${relative(root, path)} references forbidden VITE_DATABASE_URL.`)
}

const apiSourceFiles = filesUnder(join(root, 'api')).filter((path) => /\.ts$/u.test(path))
for (const path of apiSourceFiles) {
  const source = readFileSync(path, 'utf8')
  check(
    !/(?:src\/analysis|src\/workers|src\/wasm|\.wasm)/u.test(source),
    `${relative(root, path)} pulls an analysis engine or Wasm artifact into the storage-only server boundary.`,
  )
}

check(existsSync(join(root, 'api/reports/index.ts')), 'The report collection endpoint is missing.')
check(existsSync(join(root, 'api/reports/[id].ts')), 'The immutable report endpoint is missing.')
const migrationPath = join(root, 'db/001_analysis_reports.sql')
check(existsSync(migrationPath), 'The report-storage migration is missing.')
check(existsSync(join(root, 'db/runtime-role.example.sql')), 'The least-privilege runtime-role template is missing.')
if (existsSync(migrationPath)) check(statSync(migrationPath).size > 0, 'The report-storage migration is empty.')

if (failures.length) {
  console.error('Deployment validation failed:')
  failures.forEach((failure) => console.error(`- ${failure}`))
  process.exitCode = 1
} else {
  console.log('Deployment configuration is internally consistent.')
}
