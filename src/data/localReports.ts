import type { Address } from 'viem'
import type { AnalysisReport } from '../domain/report'

const DB_NAME = 'hookscope-reports'
const STORE = 'reports'

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE)) {
        const store = database.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex('identity', ['chainId', 'token'])
        store.createIndex('createdAt', 'createdAt')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function readLocalReports(chainId: number, token: Address): Promise<AnalysisReport[]> {
  if (!('indexedDB' in globalThis)) return []
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readonly')
    const index = transaction.objectStore(STORE).index('identity')
    const request = index.getAll([chainId, token])
    request.onsuccess = () => resolve((request.result as AnalysisReport[]).sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
    request.onerror = () => reject(request.error)
    transaction.oncomplete = () => database.close()
  })
}

export async function saveLocalReport(report: AnalysisReport): Promise<void> {
  if (!('indexedDB' in globalThis)) return
  const database = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite')
    transaction.objectStore(STORE).put(report)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  database.close()
}
