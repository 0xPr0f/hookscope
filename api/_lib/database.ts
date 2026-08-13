import postgres from 'postgres'

let client: ReturnType<typeof postgres> | undefined

export function database() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is not configured.')
  client ??= postgres(connectionString, {
    max: 3,
    idle_timeout: 20,
    connect_timeout: 8,
    prepare: true,
    ssl: connectionString.includes('localhost') ? false : 'require',
  })
  return client
}
