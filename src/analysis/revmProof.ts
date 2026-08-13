import { getAddress, toHex, type Address, type Hex, type PublicClient } from 'viem'

export type RevmStepEvidence = { address: string; pc: number; opcode: string }
export type RevmCallEvidence = {
  caller: string
  target: string
  bytecodeAddress: string
  scheme: string
  value: string
  inputLength: number
}
export type RevmStorageDiff = { address: string; slot: Hex; before: Hex; after: Hex }
export type RevmExecutionProof = {
  engine: string
  success: boolean
  gasUsed: number
  output: Hex
  steps: RevmStepEvidence[]
  storageOperations: RevmStepEvidence[]
  calls: RevmCallEvidence[]
  storageDiffs: RevmStorageDiff[]
  logCount: number
  selfdestructs: [string, string, string][]
  truncated: boolean
}

export type RevmExplorationWitness = {
  calldata: Hex
  success: boolean
  gasUsed: number
  newEdges: number
  output: Hex
  storageDiffs: RevmStorageDiff[]
}

export type RevmExploration = {
  engine: string
  strategy: string
  executions: number
  coverageEdges: number
  uniqueOutcomes: number
  witnesses: RevmExplorationWitness[]
  elapsedMs: number
}

type RevmWorkerEvent =
  | { type: 'complete'; scanId: string; proof: RevmExecutionProof }
  | { type: 'complete-exploration'; scanId: string; exploration: RevmExploration }
  | { type: 'fork-session-phase'; scanId: string; phase: 'loading-wasm' | 'loading-snapshot' }
  | { type: 'fork-session-ready'; scanId: string }
  | { type: 'fork-step'; scanId: string; runId: string; step: ForkReplayStep }
  | { type: 'complete-fork-exploration'; scanId: string; runId: string; exploration: ForkExplorationEpoch }
  | { type: 'failure'; scanId: string; message: string }

export type ForkReplayTransaction = {
  caller: Address
  to: Address
  calldata: Hex
  value: bigint
  gasLimit: bigint
  gasPrice: bigint
  nonce: number
  chainId: number
  maxPriorityFeePerGas?: bigint
  /** Maximum instruction observations returned to the browser. Execution itself is not truncated. */
  traceLimit?: number
}

export type ForkReplayBlock = {
  number: bigint
  beneficiary: Address
  timestamp: bigint
  gasLimit: bigint
  baseFee: bigint
  difficulty: bigint
  prevrandao?: Hex
}

export type ForkSnapshotAccount = {
  address: Address
  exists: boolean
  balance: Hex
  nonce: number
  code: Hex
  storage: Record<string, Hex>
  storageComplete?: boolean
}

export type ForkSnapshot = {
  accounts: ForkSnapshotAccount[]
  blockHashes: { number: number; hash: Hex }[]
}

export type ForkHydrationUpdate =
  | { kind: 'account'; account: ForkSnapshotAccount }
  | { kind: 'storage'; address: Address; slot: Hex; value: Hex }
  | { kind: 'block-hash'; blockNumber: number; hash: Hex }

export type ForkHydrationRequest =
  | { kind: 'account'; address: Address }
  | { kind: 'code'; codeHash: Hex }
  | { kind: 'storage'; address: Address; slot: Hex }
  | { kind: 'block-hash'; blockNumber: number }

type ForkReplayStep =
  | { status: 'complete'; proof: RevmExecutionProof }
  | { status: 'missing'; request: ForkHydrationRequest }
  | { status: 'failure'; message: string }

export type ForkReplayResult = {
  proof: RevmExecutionProof
  hydrationRequests: number
  hydratedAccounts: number
  hydratedStorageSlots: number
}

export type ForkExplorationEpoch = RevmExploration & {
  skippedExecutions: number
  missingRequests: ForkHydrationRequest[]
  missingCandidates: { calldata: Hex; request: ForkHydrationRequest }[]
}

export type ForkStatePrefetch = {
  accounts?: Address[]
  storage?: { address: Address; slot: Hex }[]
  blockHashes?: number[]
}

export type ForkSessionMetrics = {
  hydratedAccounts: number
  hydratedStorageSlots: number
  hydratedBlockHashes: number
  rpcReads: number
  executions: number
}

function serializedTransaction(input: ForkReplayTransaction) {
  return {
    caller: input.caller,
    to: input.to,
    calldata: input.calldata,
    value: toHex(input.value),
    gasLimit: Number(input.gasLimit),
    gasPrice: toHex(input.gasPrice),
    nonce: input.nonce,
    chainId: input.chainId,
    maxPriorityFeePerGas: input.maxPriorityFeePerGas === undefined ? undefined : toHex(input.maxPriorityFeePerGas),
    traceLimit: Math.min(50_000, Math.max(64, input.traceLimit ?? 8_192)),
  }
}

function serializedBlock(input: ForkReplayBlock) {
  return {
    number: Number(input.number),
    beneficiary: input.beneficiary,
    timestamp: toHex(input.timestamp),
    gasLimit: Number(input.gasLimit),
    baseFee: Number(input.baseFee),
    difficulty: toHex(input.difficulty),
    prevrandao: input.prevrandao,
  }
}

export async function loadForkHydration(input: {
  client: PublicClient
  stateBlockNumber: bigint
  request: ForkHydrationRequest
}): Promise<ForkHydrationUpdate> {
  const { client, stateBlockNumber, request } = input
  if (request.kind === 'account') {
    const address = getAddress(request.address)
    const [balance, nonce, code] = await Promise.all([
      client.getBalance({ address, blockNumber: stateBlockNumber }),
      client.getTransactionCount({ address, blockNumber: stateBlockNumber }),
      client.getCode({ address, blockNumber: stateBlockNumber }),
    ])
    return {
      kind: 'account',
      account: {
        address,
        exists: balance !== 0n || nonce !== 0 || Boolean(code && code !== '0x'),
        balance: toHex(balance),
        nonce,
        code: code ?? '0x',
        storage: {},
      },
    }
  }
  if (request.kind === 'storage') {
    const address = getAddress(request.address)
    const value = await client.getStorageAt({ address, slot: request.slot, blockNumber: stateBlockNumber })
    return { kind: 'storage', address, slot: request.slot, value: value ?? '0x0' }
  }
  if (request.kind === 'block-hash') {
    const block = await client.getBlock({ blockNumber: BigInt(request.blockNumber) })
    if (!block.hash) throw new Error(`RPC returned block ${request.blockNumber} without a hash.`)
    return { kind: 'block-hash', blockNumber: request.blockNumber, hash: block.hash }
  }
  throw new Error(`revm requested code ${request.codeHash} without identifying its account.`)
}

export function runRevmProof(input: {
  scanId: string
  bytecode: Hex
  calldata?: Hex
  signal: AbortSignal
}): Promise<RevmExecutionProof> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/execution.worker.ts', import.meta.url), { type: 'module', name: 'hookscope-revm' })
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      worker.terminate()
      input.signal.removeEventListener('abort', cancel)
      callback()
    }
    const cancel = () => finish(() => reject(new DOMException('Execution cancelled', 'AbortError')))
    input.signal.addEventListener('abort', cancel, { once: true })
    worker.onerror = (event) => finish(() => reject(new Error(event.message || 'revm worker failed.')))
    worker.onmessage = (event: MessageEvent<RevmWorkerEvent>) => {
      const message = event.data
      if (message.scanId !== input.scanId) return
      if (message.type === 'failure') finish(() => reject(new Error(message.message)))
      else if (message.type === 'complete') finish(() => resolve(message.proof))
    }
    worker.postMessage({ type: 'inspect', scanId: input.scanId, bytecode: input.bytecode, calldata: input.calldata ?? '0x' })
  })
}

export function runRevmExploration(input: {
  scanId: string
  bytecode: Hex
  maxExecutions: number
  signal: AbortSignal
  timeoutMs?: number
  scheduler?: 'libafl' | 'baseline'
  seed?: bigint
  seedCorpus?: Hex[]
}): Promise<RevmExploration> {
  return new Promise((resolve, reject) => {
    const scheduler = input.scheduler ?? 'libafl'
    const worker = scheduler === 'libafl'
      ? new Worker(new URL('../workers/fuzz.worker.ts', import.meta.url), { type: 'module', name: 'hookscope-libafl-revm' })
      : new Worker(new URL('../workers/execution.worker.ts', import.meta.url), { type: 'module', name: 'hookscope-revm-explorer' })
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      worker.terminate()
      input.signal.removeEventListener('abort', cancel)
      callback()
    }
    const cancel = () => finish(() => reject(new DOMException('Input exploration cancelled', 'AbortError')))
    const timeout = window.setTimeout(
      () => finish(() => reject(new Error('Bounded input exploration exceeded its worker time budget.'))),
      input.timeoutMs ?? 30_000,
    )
    input.signal.addEventListener('abort', cancel, { once: true })
    worker.onerror = (event) => finish(() => reject(new Error(event.message || 'revm exploration worker failed.')))
    worker.onmessage = (event: MessageEvent<RevmWorkerEvent>) => {
      const message = event.data
      if (message.scanId !== input.scanId) return
      if (message.type === 'failure') finish(() => reject(new Error(message.message)))
      else if (message.type === 'complete-exploration') finish(() => resolve(message.exploration))
    }
    worker.postMessage({
      type: scheduler === 'libafl' ? 'fuzz' : 'explore',
      scanId: input.scanId,
      bytecode: input.bytecode,
      maxExecutions: Math.min(30_000, Math.max(1, input.maxExecutions)),
      scheduler,
      seed: (input.seed ?? 0x484f_4f4b_5343_4f50n).toString(),
      seedCorpus: input.seedCorpus?.slice(0, 64),
    })
  })
}

export type ParallelRevmExploration = RevmExploration & {
  workers: number
  rounds: number
  exchangedSeeds: number
  workerRuns: {
    worker: number
    round: number
    executions: number
    coverageEdges: number
    uniqueOutcomes: number
    elapsedMs: number
  }[]
}

function witnessOutcomeIdentity(witness: RevmExplorationWitness) {
  const storage = witness.storageDiffs
    .map((diff) => `${diff.address.toLowerCase()}:${diff.slot.toLowerCase()}:${diff.after.toLowerCase()}`)
    .sort()
    .join('|')
  return `${witness.success}|${witness.output.toLowerCase()}|${storage}`
}

function betterWitness(left: RevmExplorationWitness, right: RevmExplorationWitness) {
  const leftBytes = (left.calldata.length - 2) / 2
  const rightBytes = (right.calldata.length - 2) / 2
  if (leftBytes !== rightBytes) return leftBytes < rightBytes ? left : right
  if (left.gasUsed !== right.gasUsed) return left.gasUsed < right.gasUsed ? left : right
  return left.calldata.localeCompare(right.calldata) <= 0 ? left : right
}

export function minimizeExplorationWitnesses(witnesses: RevmExplorationWitness[], limit = 128) {
  const byOutcome = new Map<string, RevmExplorationWitness>()
  const coverageOnly: RevmExplorationWitness[] = []
  for (const witness of witnesses) {
    const identity = witnessOutcomeIdentity(witness)
    const current = byOutcome.get(identity)
    byOutcome.set(identity, current ? betterWitness(current, witness) : witness)
    if (witness.newEdges > 0) coverageOnly.push(witness)
  }
  const selected = [...byOutcome.values()]
  coverageOnly.sort((left, right) => right.newEdges - left.newEdges || left.calldata.length - right.calldata.length)
  const seen = new Set(selected.map((witness) => witness.calldata.toLowerCase()))
  for (const witness of coverageOnly) {
    if (selected.length >= limit) break
    if (seen.has(witness.calldata.toLowerCase())) continue
    selected.push(witness)
    seen.add(witness.calldata.toLowerCase())
  }
  return selected.slice(0, limit)
}

function splitBudget(total: number, count: number) {
  const base = Math.floor(total / count)
  let remainder = total % count
  return Array.from({ length: count }, () => base + (remainder-- > 0 ? 1 : 0))
}

/**
 * Runs independent single-threaded LibAFL instances in Dedicated Workers.
 * Round one discovers compact outcome/coverage seeds. Round two exchanges that
 * corpus between fresh workers. Coverage is reported conservatively as the
 * largest observed edge-map cardinality because worker-local maps cannot be
 * unioned from summary counts alone.
 */
export async function runParallelRevmExploration(input: {
  scanId: string
  bytecode: Hex
  maxExecutions: number
  signal: AbortSignal
  timeoutMs?: number
  maxWorkers?: number
  seed?: bigint
  runWorker?: typeof runRevmExploration
  onProgress?: (completed: number, total: number, detail: string) => void
}): Promise<ParallelRevmExploration> {
  const executionBudget = Math.min(30_000, Math.max(1, input.maxExecutions))
  const hardwareConcurrency = typeof navigator === 'undefined' ? 2 : navigator.hardwareConcurrency || 2
  const requestedWorkers = input.maxWorkers ?? Math.min(4, Math.max(1, hardwareConcurrency - 1))
  const workers = Math.max(1, Math.min(4, requestedWorkers, executionBudget))
  const runWorker = input.runWorker ?? runRevmExploration
  if (workers === 1 || executionBudget < 16) {
    const result = await runWorker({ ...input, scheduler: 'libafl' })
    return { ...result, workers: 1, rounds: 1, exchangedSeeds: 0, workerRuns: [{ worker: 0, round: 1, executions: result.executions, coverageEdges: result.coverageEdges, uniqueOutcomes: result.uniqueOutcomes, elapsedMs: result.elapsedMs }] }
  }

  const started = performance.now()
  const timeoutMs = input.timeoutMs ?? 30_000
  const deadline = started + timeoutMs
  const firstBudget = Math.max(workers * 3, Math.floor(executionBudget * 0.6))
  const secondBudget = executionBudget - firstBudget
  const runs: ParallelRevmExploration['workerRuns'] = []
  let completed = 0
  const runRound = async (round: number, budgets: number[], seedCorpus?: Hex[]) => {
    return await Promise.all(budgets.map(async (budget, worker) => {
      const remainingMs = Math.max(250, Math.floor(deadline - performance.now()))
      if (remainingMs <= 250) throw new Error('Bounded input exploration exhausted its shared worker time budget.')
      const result = await runWorker({
        scanId: `${input.scanId}-round-${round}-worker-${worker}`,
        bytecode: input.bytecode,
        maxExecutions: budget,
        timeoutMs: remainingMs,
        signal: input.signal,
        scheduler: 'libafl',
        seed: (input.seed ?? 0x484f_4f4b_5343_4f50n) + BigInt(round * 0x100 + worker),
        seedCorpus,
      })
      completed += result.executions
      runs.push({ worker, round, executions: result.executions, coverageEdges: result.coverageEdges, uniqueOutcomes: result.uniqueOutcomes, elapsedMs: result.elapsedMs })
      input.onProgress?.(completed, executionBudget, `round ${round} · worker ${worker + 1}/${workers}`)
      return result
    }))
  }

  const first = await runRound(1, splitBudget(firstBudget, workers))
  const firstWitnesses = minimizeExplorationWitnesses(first.flatMap((result) => result.witnesses), 64)
  const exchangeCorpus = firstWitnesses.map((witness) => witness.calldata)
  const second = secondBudget > 0
    ? await runRound(2, splitBudget(secondBudget, workers), exchangeCorpus)
    : []
  const all = [...first, ...second]
  const witnesses = minimizeExplorationWitnesses(all.flatMap((result) => result.witnesses))
  const outcomes = new Set(witnesses.map(witnessOutcomeIdentity))
  return {
    engine: 'revm/36.0.0 + libafl/0.15.4',
    strategy: 'libafl-worker-fanout-corpus-exchange/0.2.0',
    executions: all.reduce((sum, result) => sum + result.executions, 0),
    coverageEdges: Math.max(0, ...all.map((result) => result.coverageEdges)),
    uniqueOutcomes: outcomes.size,
    witnesses,
    elapsedMs: Math.round(performance.now() - started),
    workers,
    rounds: second.length ? 2 : 1,
    exchangedSeeds: exchangeCorpus.length,
    workerRuns: runs.sort((left, right) => left.round - right.round || left.worker - right.worker),
  }
}

export type ForkExecutionSessionInput = {
  scanId: string
  client: PublicClient
  stateBlockNumber: bigint
  snapshot?: ForkSnapshot
  onPhase?: (phase: 'loading-wasm' | 'loading-snapshot' | 'ready') => void
  readyTimeoutMs?: number
  loadHydration?: (request: ForkHydrationRequest) => Promise<ForkHydrationUpdate>
}

type ForkExecutionInput = {
  transaction: ForkReplayTransaction
  block: ForkReplayBlock
  signal: AbortSignal
  timeoutMs?: number
  maxHydrationRequests?: number
  commit?: boolean
  onHydration?: (requestCount: number, request: ForkHydrationRequest) => void
}

type ActiveForkRun = {
  runId: string
  input: ForkExecutionInput
  resolve: (result: ForkReplayResult) => void
  reject: (error: unknown) => void
  timeout: number
  cancel: () => void
  seenRequests: Set<string>
  requestCount: number
  handling: boolean
}

export class ForkExecutionSession {
  private readonly worker: Worker
  private readonly hydratedAccounts = new Set<string>()
  private readonly hydratedStorage = new Set<string>()
  private readonly hydratedBlockHashes = new Set<number>()
  private readonly ready: Promise<void>
  private readyResolve!: () => void
  private readyReject!: (error: unknown) => void
  private active?: ActiveForkRun
  private closed = false
  private readyTimeout: number
  private rpcReads = 0
  private executionCount = 0

  constructor(private readonly input: ForkExecutionSessionInput) {
    this.worker = new Worker(new URL('../workers/execution.worker.ts', import.meta.url), { type: 'module', name: 'hookscope-revm-fork-session' })
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    this.readyTimeout = window.setTimeout(
      () => this.fail(new Error('revm worker did not finish loading its Wasm module and snapshot in time.')),
      input.readyTimeoutMs ?? 20_000,
    )
    this.worker.onerror = (event) => this.fail(new Error(event.message || 'revm fork worker failed.'))
    this.worker.onmessage = (event: MessageEvent<RevmWorkerEvent>) => this.onMessage(event.data)
    const snapshot: ForkSnapshot = input.snapshot ?? { accounts: [], blockHashes: [] }
    this.worker.postMessage({ type: 'create-fork-session', scanId: input.scanId, snapshot })
  }

  metrics(): ForkSessionMetrics {
    return {
      hydratedAccounts: this.hydratedAccounts.size,
      hydratedStorageSlots: this.hydratedStorage.size,
      hydratedBlockHashes: this.hydratedBlockHashes.size,
      rpcReads: this.rpcReads,
      executions: this.executionCount,
    }
  }

  async prefetch(input: ForkStatePrefetch): Promise<ForkSessionMetrics> {
    this.assertOpen()
    await this.ready
    const accountAddresses = new Map<string, Address>()
    for (const address of input.accounts ?? []) accountAddresses.set(address.toLowerCase(), getAddress(address))
    for (const item of input.storage ?? []) accountAddresses.set(item.address.toLowerCase(), getAddress(item.address))
    const updates: ForkHydrationUpdate[] = []
    for (const [identity, address] of accountAddresses) {
      if (this.hydratedAccounts.has(identity)) continue
      updates.push(await this.load({ kind: 'account', address }))
    }
    for (const item of input.storage ?? []) {
      const identity = `${item.address.toLowerCase()}:${item.slot.toLowerCase()}`
      if (this.hydratedStorage.has(identity)) continue
      updates.push(await this.load({ kind: 'storage', address: getAddress(item.address), slot: item.slot }))
    }
    for (const blockNumber of input.blockHashes ?? []) {
      if (this.hydratedBlockHashes.has(blockNumber)) continue
      updates.push(await this.load({ kind: 'block-hash', blockNumber }))
    }
    if (updates.length) this.worker.postMessage({ type: 'prime-fork-session', scanId: this.input.scanId, updates })
    return this.metrics()
  }

  async execute(input: ForkExecutionInput): Promise<ForkReplayResult> {
    this.assertOpen()
    if (this.active) throw new Error('A fork session supports one execution at a time.')
    await this.ready
    if (input.signal.aborted) throw new DOMException('Fork replay cancelled', 'AbortError')
    return new Promise((resolve, reject) => {
      const runId = crypto.randomUUID()
      const cancel = () => this.finishActive(() => reject(new DOMException('Fork replay cancelled', 'AbortError')))
      const timeout = window.setTimeout(
        () => this.finishActive(() => reject(new Error('Fork replay exceeded its browser time budget.'))),
        input.timeoutMs ?? 30_000,
      )
      this.active = {
        runId,
        input,
        resolve,
        reject,
        timeout,
        cancel,
        seenRequests: new Set(),
        requestCount: 0,
        handling: false,
      }
      input.signal.addEventListener('abort', cancel, { once: true })
      this.worker.postMessage({
        type: 'execute-fork',
        scanId: this.input.scanId,
        runId,
        transaction: serializedTransaction(input.transaction),
        block: serializedBlock(input.block),
        commit: input.commit ?? false,
      })
    })
  }

  close() {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.readyTimeout)
    if (this.active) {
      const active = this.active
      this.finishActive(() => active.reject(new DOMException('Fork session closed', 'AbortError')))
    }
    this.worker.postMessage({ type: 'dispose-fork-session', scanId: this.input.scanId })
    this.worker.terminate()
  }

  private assertOpen() {
    if (this.closed) throw new Error('Fork execution session is closed.')
  }

  private record(update: ForkHydrationUpdate) {
    if (update.kind === 'account') this.hydratedAccounts.add(update.account.address.toLowerCase())
    else if (update.kind === 'storage') this.hydratedStorage.add(`${update.address.toLowerCase()}:${update.slot.toLowerCase()}`)
    else this.hydratedBlockHashes.add(update.blockNumber)
  }

  private async load(request: ForkHydrationRequest) {
    const update = this.input.loadHydration
      ? await this.input.loadHydration(request)
      : await loadForkHydration({
          client: this.input.client,
          stateBlockNumber: this.input.stateBlockNumber,
          request,
        })
    this.rpcReads += request.kind === 'account' ? 3 : 1
    this.record(update)
    return update
  }

  private onMessage(message: RevmWorkerEvent) {
    if (message.scanId !== this.input.scanId) return
    if (message.type === 'fork-session-phase') {
      this.input.onPhase?.(message.phase)
      return
    }
    if (message.type === 'fork-session-ready') {
      clearTimeout(this.readyTimeout)
      this.input.onPhase?.('ready')
      this.readyResolve()
      return
    }
    if (message.type === 'failure') {
      this.fail(new Error(message.message))
      return
    }
    if (message.type !== 'fork-step' || !this.active || message.runId !== this.active.runId || this.active.handling) return
    const step = message.step
    if (step.status === 'failure') {
      const error = new Error(step.message)
      const active = this.active
      this.finishActive(() => active.reject(error))
      return
    }
    if (step.status === 'complete') {
      const active = this.active
      this.executionCount += 1
      this.finishActive(() => active.resolve({
        proof: step.proof,
        hydrationRequests: active.requestCount,
        hydratedAccounts: this.hydratedAccounts.size,
        hydratedStorageSlots: this.hydratedStorage.size,
      }))
      return
    }
    const active = this.active
    active.handling = true
    void this.handleMissing(active, step.request)
  }

  private async handleMissing(active: ActiveForkRun, request: ForkHydrationRequest) {
    try {
      const identity = JSON.stringify(request)
      if (active.seenRequests.has(identity)) throw new Error(`revm repeated unresolved hydration request ${identity}.`)
      active.seenRequests.add(identity)
      active.requestCount += 1
      if (active.requestCount > (active.input.maxHydrationRequests ?? 2_048)) {
        throw new Error(`Fork replay exceeded the ${active.input.maxHydrationRequests ?? 2_048}-request hydration ceiling.`)
      }
      active.input.onHydration?.(active.requestCount, request)
      const update = await this.load(request)
      if (active.input.signal.aborted) throw new DOMException('Fork replay cancelled', 'AbortError')
      active.handling = false
      this.worker.postMessage({ type: 'hydrate-fork', scanId: this.input.scanId, runId: active.runId, update })
    } catch (error) {
      this.finishActive(() => active.reject(error))
    }
  }

  private finishActive(callback: () => void) {
    const active = this.active
    if (!active) return
    this.active = undefined
    clearTimeout(active.timeout)
    active.input.signal.removeEventListener('abort', active.cancel)
    callback()
  }

  private fail(error: Error) {
    this.readyReject(error)
    if (this.active) {
      const active = this.active
      this.finishActive(() => active.reject(error))
    }
    this.close()
  }
}

export type ForkExplorationSessionInput = ForkExecutionSessionInput

type ActiveExplorationWarmup = {
  runId: string
  input: ForkExecutionInput
  resolve: (result: ForkReplayResult) => void
  reject: (error: unknown) => void
  timeout: number
  cancel: () => void
  seenRequests: Set<string>
  requestCount: number
  handling: boolean
}

type ActiveExplorationEpoch = {
  runId: string
  signal: AbortSignal
  resolve: (result: ForkExplorationEpoch) => void
  reject: (error: unknown) => void
  timeout: number
  cancel: () => void
}

/**
 * LibAFL-enabled fork session. It first warms one canonical transaction using
 * the same iterative pinned-state protocol as ordinary replay, then runs only
 * byte-index-masked exploration epochs against the retained parent-state DB.
 */
export class ForkExplorationSession {
  private readonly worker: Worker
  private readonly ready: Promise<void>
  private readyResolve!: () => void
  private readyReject!: (error: unknown) => void
  private readyTimeout: number
  private warmup?: ActiveExplorationWarmup
  private epoch?: ActiveExplorationEpoch
  private closed = false
  private rpcReads = 0
  private hydratedAccounts = 0
  private hydratedStorageSlots = 0

  constructor(private readonly input: ForkExplorationSessionInput) {
    this.worker = new Worker(new URL('../workers/fuzz.worker.ts', import.meta.url), { type: 'module', name: 'hookscope-libafl-fork-session' })
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    this.readyTimeout = window.setTimeout(
      () => this.fail(new Error('LibAFL fork worker did not load its Wasm module in time.')),
      input.readyTimeoutMs ?? 25_000,
    )
    this.worker.onerror = (event) => this.fail(new Error(event.message || 'LibAFL fork worker failed.'))
    this.worker.onmessage = (event: MessageEvent<RevmWorkerEvent>) => this.onMessage(event.data)
    this.worker.postMessage({
      type: 'create-fork-session',
      scanId: input.scanId,
      snapshot: input.snapshot ?? { accounts: [], blockHashes: [] },
    })
  }

  metrics() {
    return { rpcReads: this.rpcReads, hydratedAccounts: this.hydratedAccounts, hydratedStorageSlots: this.hydratedStorageSlots }
  }

  async warm(input: ForkExecutionInput): Promise<ForkReplayResult> {
    this.assertOpen()
    if (this.warmup || this.epoch) throw new Error('The LibAFL fork session is already active.')
    await this.ready
    if (input.signal.aborted) throw new DOMException('Fork exploration cancelled', 'AbortError')
    return new Promise((resolve, reject) => {
      const runId = crypto.randomUUID()
      const cancel = () => this.finishWarmup(() => reject(new DOMException('Fork exploration cancelled', 'AbortError')))
      const timeout = window.setTimeout(
        () => this.finishWarmup(() => reject(new Error('Fork exploration warmup exceeded its browser time budget.'))),
        input.timeoutMs ?? 30_000,
      )
      this.warmup = {
        runId,
        input,
        resolve,
        reject,
        timeout,
        cancel,
        seenRequests: new Set(),
        requestCount: 0,
        handling: false,
      }
      input.signal.addEventListener('abort', cancel, { once: true })
      this.worker.postMessage({
        type: 'warm-fork',
        scanId: this.input.scanId,
        runId,
        transaction: serializedTransaction(input.transaction),
        block: serializedBlock(input.block),
      })
    })
  }

  async hydrate(requests: ForkHydrationRequest[]): Promise<number> {
    this.assertOpen()
    await this.ready
    const unique = new Map(requests.map((request) => [JSON.stringify(request), request]))
    const updates = await Promise.all([...unique.values()].map((request) => this.load(request)))
    if (updates.length) this.worker.postMessage({ type: 'prime-fork-session', scanId: this.input.scanId, updates })
    return updates.length
  }

  async explore(input: {
    transaction: ForkReplayTransaction
    block: ForkReplayBlock
    mutableIndices: number[]
    maxExecutions: number
    seed: bigint
    signal: AbortSignal
    seedCorpus?: Hex[]
    timeoutMs?: number
  }): Promise<ForkExplorationEpoch> {
    this.assertOpen()
    if (this.warmup || this.epoch) throw new Error('The LibAFL fork session is already active.')
    await this.ready
    if (input.signal.aborted) throw new DOMException('Fork exploration cancelled', 'AbortError')
    return new Promise((resolve, reject) => {
      const runId = crypto.randomUUID()
      const cancel = () => this.finishEpoch(() => reject(new DOMException('Fork exploration cancelled', 'AbortError')))
      const timeout = window.setTimeout(
        () => this.finishEpoch(() => reject(new Error('Fork exploration epoch exceeded its browser time budget.'))),
        input.timeoutMs ?? 30_000,
      )
      this.epoch = { runId, signal: input.signal, resolve, reject, timeout, cancel }
      input.signal.addEventListener('abort', cancel, { once: true })
      this.worker.postMessage({
        type: 'fuzz-fork',
        scanId: this.input.scanId,
        runId,
        transaction: serializedTransaction(input.transaction),
        block: serializedBlock(input.block),
        mutableIndices: input.mutableIndices,
        maxExecutions: Math.min(30_000, Math.max(1, input.maxExecutions)),
        seed: input.seed.toString(),
        seedCorpus: input.seedCorpus?.slice(0, 64),
      })
    })
  }

  close() {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.readyTimeout)
    if (this.warmup) {
      const active = this.warmup
      this.finishWarmup(() => active.reject(new DOMException('Fork exploration session closed', 'AbortError')))
    }
    if (this.epoch) {
      const active = this.epoch
      this.finishEpoch(() => active.reject(new DOMException('Fork exploration session closed', 'AbortError')))
    }
    this.worker.postMessage({ type: 'dispose-fork-session', scanId: this.input.scanId })
    this.worker.terminate()
  }

  private async load(request: ForkHydrationRequest) {
    const update = this.input.loadHydration
      ? await this.input.loadHydration(request)
      : await loadForkHydration({ client: this.input.client, stateBlockNumber: this.input.stateBlockNumber, request })
    this.rpcReads += request.kind === 'account' ? 3 : 1
    if (update.kind === 'account') this.hydratedAccounts++
    if (update.kind === 'storage') this.hydratedStorageSlots++
    return update
  }

  private onMessage(message: RevmWorkerEvent) {
    if (message.scanId !== this.input.scanId) return
    if (message.type === 'fork-session-ready') {
      clearTimeout(this.readyTimeout)
      this.readyResolve()
      return
    }
    if (message.type === 'failure') {
      this.fail(new Error(message.message))
      return
    }
    if (message.type === 'complete-fork-exploration' && this.epoch?.runId === message.runId) {
      const active = this.epoch
      this.finishEpoch(() => active.resolve(message.exploration))
      return
    }
    if (message.type !== 'fork-step' || !this.warmup || message.runId !== this.warmup.runId || this.warmup.handling) return
    const step = message.step
    if (step.status === 'failure') {
      const active = this.warmup
      this.finishWarmup(() => active.reject(new Error(step.message)))
      return
    }
    if (step.status === 'complete') {
      const active = this.warmup
      this.finishWarmup(() => active.resolve({
        proof: step.proof,
        hydrationRequests: active.requestCount,
        hydratedAccounts: this.hydratedAccounts,
        hydratedStorageSlots: this.hydratedStorageSlots,
      }))
      return
    }
    const active = this.warmup
    active.handling = true
    void this.handleWarmMissing(active, step.request)
  }

  private async handleWarmMissing(active: ActiveExplorationWarmup, request: ForkHydrationRequest) {
    try {
      const identity = JSON.stringify(request)
      if (active.seenRequests.has(identity)) throw new Error(`revm repeated unresolved exploration hydration request ${identity}.`)
      active.seenRequests.add(identity)
      active.requestCount++
      if (active.requestCount > (active.input.maxHydrationRequests ?? 2_048)) {
        throw new Error(`Fork exploration exceeded the ${active.input.maxHydrationRequests ?? 2_048}-request warmup ceiling.`)
      }
      const update = await this.load(request)
      if (active.input.signal.aborted) throw new DOMException('Fork exploration cancelled', 'AbortError')
      active.handling = false
      this.worker.postMessage({ type: 'hydrate-warm-fork', scanId: this.input.scanId, runId: active.runId, update })
    } catch (error) {
      this.finishWarmup(() => active.reject(error))
    }
  }

  private finishWarmup(callback: () => void) {
    const active = this.warmup
    if (!active) return
    this.warmup = undefined
    clearTimeout(active.timeout)
    active.input.signal.removeEventListener('abort', active.cancel)
    callback()
  }

  private finishEpoch(callback: () => void) {
    const active = this.epoch
    if (!active) return
    this.epoch = undefined
    clearTimeout(active.timeout)
    active.signal.removeEventListener('abort', active.cancel)
    callback()
  }

  private assertOpen() {
    if (this.closed) throw new Error('Fork exploration session is closed.')
  }

  private fail(error: Error) {
    this.readyReject(error)
    if (this.warmup) {
      const active = this.warmup
      this.finishWarmup(() => active.reject(error))
    }
    if (this.epoch) {
      const active = this.epoch
      this.finishEpoch(() => active.reject(error))
    }
    this.close()
  }
}

export async function runForkReplay(input: ForkExecutionSessionInput & ForkExecutionInput): Promise<ForkReplayResult> {
  const session = new ForkExecutionSession(input)
  try {
    return await session.execute(input)
  } finally {
    session.close()
  }
}
