const STATUSES = new Set(['passed', 'degraded', 'unsupported'])

export function capability(status, reason, evidence = undefined) {
  if (!STATUSES.has(status)) throw new Error(`Invalid capability status: ${status}.`)
  return evidence === undefined ? { status, reason } : { status, reason, evidence }
}

/** Unsupported optional capabilities do not hide successful checks; a degraded check does. */
export function aggregateCapabilities(capabilities) {
  const values = Object.values(capabilities)
  if (values.some((item) => item.status === 'degraded')) return 'degraded'
  if (values.some((item) => item.status === 'passed')) return 'passed'
  return 'unsupported'
}

export function safeError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/https?:\/\/[^\s"']+/giu, '[redacted-url]')
    .replace(/[\r\n]+/gu, ' ')
    .slice(0, 500)
}

export function json(value) {
  return `${JSON.stringify(value, (_key, candidate) => typeof candidate === 'bigint' ? candidate.toString() : candidate, 2)}\n`
}

export function optionValues(argv, name) {
  const values = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== name) continue
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`)
    values.push(value)
    index += 1
  }
  return values
}

export function optionValue(argv, name) {
  const values = optionValues(argv, name)
  if (values.length > 1) throw new Error(`${name} may only be provided once.`)
  return values[0]
}

export function hasFlag(argv, name) {
  return argv.includes(name)
}

export function assertKnownOptions(argv, optionsWithValues, flags) {
  const valued = new Set(optionsWithValues)
  const allowedFlags = new Set(flags)
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (valued.has(argument)) {
      if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`${argument} requires a value.`)
      index += 1
      continue
    }
    if (allowedFlags.has(argument)) continue
    throw new Error(`Unknown option: ${argument}.`)
  }
}

export function positiveInteger(value, fallback, label) {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`)
  return parsed
}

export function commandArguments(argv = process.argv.slice(2)) {
  return argv[0] === '--' ? argv.slice(1) : argv
}
