import type { RunView } from './contracts.ts'
import { errorText, RunGateway } from './controller.ts'
import { isLive } from './view-models.ts'

export interface RunStoreSnapshot {
  runs: RunView[]
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string
  revision: number
}

/** Polling lifecycle isolated from React. A live run uses a short cadence; settled history backs off. */
export class RunPollStore {
  private state: RunStoreSnapshot = { runs: [], status: 'idle', error: '', revision: 0 }
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private generation = 0
  private detailId: string | null = null

  constructor(private readonly gateway: RunGateway, readonly sessionId: string, readonly limit = 30) {}

  readonly getSnapshot = (): RunStoreSnapshot => this.state
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1) this.start()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.stop()
    }
  }

  refresh(): void { this.start(true) }

  watchDetail(id: string | null): void { this.detailId = id }

  replaceRun(run: RunView): void {
    const runs = this.state.runs.some(item => item.id === run.id)
      ? this.state.runs.map(item => item.id === run.id ? run : item)
      : [run, ...this.state.runs]
    this.publish({ ...this.state, runs, revision: this.state.revision + 1 })
  }

  private start(force = false): void {
    if (force) this.generation += 1
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    const generation = this.generation
    if (this.state.status === 'idle') this.publish({ ...this.state, status: 'loading', error: '' })
    void this.refreshRuns(generation).then(runs => {
      if (generation !== this.generation || this.listeners.size === 0) return
      this.publish({ runs, status: 'ready', error: '', revision: this.state.revision + 1 })
      const live = runs.some(run => isLive(run.status))
      this.timer = setTimeout(() => { this.start() }, live ? 850 : 5_000)
    }, reason => {
      if (generation !== this.generation || this.listeners.size === 0) return
      this.publish({ ...this.state, status: 'error', error: errorText(reason), revision: this.state.revision + 1 })
      this.timer = setTimeout(() => { this.start() }, 5_000)
    })
  }

  private async refreshRuns(generation: number): Promise<RunView[]> {
    const response = await this.gateway.list(this.sessionId, this.limit, false)
    if (generation !== this.generation || this.listeners.size === 0) return response.runs
    const detailId = this.detailId
    if (detailId === null || !response.runs.some(run => run.id === detailId)) {
      if (detailId !== null) this.detailId = null
      return response.runs
    }
    const { run: detail } = await this.gateway.get(detailId)
    if (detail === null) {
      this.detailId = null
      return response.runs.filter(run => run.id !== detailId)
    }
    return response.runs.map(run => run.id === detailId ? detail : run)
  }

  private stop(): void {
    this.generation += 1
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private publish(state: RunStoreSnapshot): void {
    this.state = state
    for (const listener of this.listeners) listener()
  }
}
