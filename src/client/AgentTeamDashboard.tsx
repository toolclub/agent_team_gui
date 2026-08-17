/** 小队设置页与会话输入区的小队模式控件。 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'

export interface AgentView {
  id: string
  name: string
  systemPrompt: string
  provider: string
  model: string
  maxTokens?: number
  toolScope?: { allow?: string[]; deny?: string[] }
  fallbackProvider?: string
  fallbackModel?: string
}

export interface SquadView {
  id: string
  name: string
  members: string[]
  collabNote: string
  executionOrder?: string[]
  executionMode?: 'serial' | 'parallel'
  contextMode?: 'spawn' | 'fork' | 'chain'
  leaderAgentId?: string
  triggerMode?: 'guaranteed' | 'model-tool'
  failurePolicy?: 'continue' | 'stop' | 'retry-once'
  maxConcurrency?: number
  memberTimeoutMs?: number
  tokenBudget?: number
}

interface ModelGroup {
  provider: string
  name: string
  models: Array<{ id: string; name: string }>
}

export interface TeamSnapshot {
  apiVersion: number
  agents: AgentView[]
  squads: SquadView[]
  models: ModelGroup[]
  tools: Array<{ name: string; description: string }>
}

interface ControllerSnapshot {
  status: 'idle' | 'loading' | 'ready' | 'error'
  data: TeamSnapshot
  error: string
  /** Successful host snapshots; changes after every reconnect refresh. */
  revision: number
}

export type AgentTeamRpc = <T>(endpoint: string, payload: unknown) => Promise<T>

/** Kept in sync with the host RPC contract; intentionally duplicated across bundles. */
export const AGENT_TEAM_RPC_API_VERSION = 2

const EMPTY_DATA: TeamSnapshot = { apiVersion: AGENT_TEAM_RPC_API_VERSION, agents: [], squads: [], models: [], tools: [] }

/** 两个 slot 共享的只读目录缓存；持久数据始终由 host service 持有。 */
export class AgentTeamController {
  private state: ControllerSnapshot = { status: 'idle', data: EMPTY_DATA, error: '', revision: 0 }
  private readonly listeners = new Set<() => void>()
  private pending: Promise<TeamSnapshot> | undefined
  private queuedRefresh: Promise<TeamSnapshot> | undefined

  constructor(readonly call: AgentTeamRpc) {}

  readonly getSnapshot = (): ControllerSnapshot => this.state
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  load(force = false): Promise<TeamSnapshot> {
    if (!force && this.state.status === 'ready') return Promise.resolve(this.state.data)
    if (this.pending !== undefined) {
      if (!force) return this.pending
      if (this.queuedRefresh !== undefined) return this.queuedRefresh

      // A reconnect may arrive while the cold-start request is still failing.
      // Do not let `force` collapse into that stale request: queue one fresh
      // read after it settles so persisted teams become usable automatically.
      const active = this.pending
      const refresh = active.then(
        () => {
          this.queuedRefresh = undefined
          return this.load(true)
        },
        () => {
          this.queuedRefresh = undefined
          return this.load(true)
        },
      )
      this.queuedRefresh = refresh
      return refresh
    }
    this.set({ ...this.state, status: 'loading', error: '' })
    const pending = this.call<TeamSnapshot>('snapshot', {})
      .then((data) => {
        if (data.apiVersion !== AGENT_TEAM_RPC_API_VERSION) {
          throw new Error(incompatibleHostMessage())
        }
        this.set({ status: 'ready', data, error: '', revision: this.state.revision + 1 })
        return data
      })
      .catch((reason: unknown) => {
        const error = errorText(reason)
        this.set({ ...this.state, status: 'error', error })
        throw reason
      }).finally(() => {
        if (this.pending === pending) this.pending = undefined
      })
    this.pending = pending
    return pending
  }

  async mutate(endpoint: string, payload: unknown): Promise<void> {
    await this.call(endpoint, payload)
    await this.load(true)
  }

  private set(state: ControllerSnapshot): void {
    this.state = state
    for (const listener of this.listeners) listener()
  }
}

interface HostDescriptionSource {
  getSnapshot(): unknown | undefined
  subscribe(listener: () => void): () => void
}

/** Refresh the shared catalog after every completed DSH connection handshake. */
export function refreshAgentTeamsOnReconnect(
  controller: AgentTeamController,
  source: HostDescriptionSource,
): () => void {
  const retryDelays = [100, 300, 1_000, 2_000] as const
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const refresh = (): void => {
    generation += 1
    const current = generation
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (source.getSnapshot() === undefined) return

    const attempt = (index: number): void => {
      void controller.load(true).catch(() => {
        if (current !== generation || source.getSnapshot() === undefined || index >= retryDelays.length) return
        timer = setTimeout(() => { attempt(index + 1) }, retryDelays[index])
      })
    }
    attempt(0)
  }
  const unsubscribe = source.subscribe(refresh)
  refresh()
  return () => {
    generation += 1
    if (timer !== undefined) clearTimeout(timer)
    unsubscribe()
  }
}

interface ModeValue {
  sessionId: string
  squadId: string
  squadName: string
}

interface ModeResponse {
  mode: ModeValue | null
  /** Durable explicit choice; `inherit` may still need a restored Session. */
  sessionOverride?: 'enabled' | 'disabled' | 'inherit'
  /** False while the restored conversation Agent is not live yet. */
  sessionReady?: boolean
  projectKey?: string | null
  projectDefault?: { projectKey: string; squadId: string; enabled: boolean } | null
}

/** Whether a mode response is final without waiting for Session/project hydration. */
export function isAuthoritativeModeResponse(response: {
  mode: unknown | null
  sessionOverride?: 'enabled' | 'disabled' | 'inherit'
  sessionReady?: boolean
}): boolean {
  return response.sessionReady !== false
    || response.sessionOverride === 'enabled'
    || response.sessionOverride === 'disabled'
    || response.mode !== null
}

interface TokenUsageView {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  providerReported: boolean
}

interface RunMemberView {
  agentId: string
  agentName: string
  provider: string
  model: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped'
  attempts: number
  startedAt?: number
  endedAt?: number
  runId?: string
  childId?: string
  output: Array<{ type?: string; text?: string }>
  error?: string
  usage?: TokenUsageView
}

interface RunView {
  id: string
  sessionId: string
  squadName: string
  task: string
  status: 'planning' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled'
  startedAt: number
  endedAt?: number
  executionMode: 'serial' | 'parallel'
  contextMode: 'spawn' | 'fork' | 'chain'
  members: RunMemberView[]
  usage: TokenUsageView
  plan?: {
    summary: string
    memberOrder: string[]
    assignments: Array<{ agentId: string; task: string }>
    planner: 'main-agent' | 'squad-leader'
    plannerProvider?: string
    plannerModel?: string
    warning?: string
  }
}

interface ComposerProps {
  controller: AgentTeamController
  sessionId: string
  input: { phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting' }
}

/** 普通发送旁只保留“小队 + 模式开关”；真正编排由 host 的会话模式完成。 */
export function TeamComposerControl({ controller, sessionId, input }: ComposerProps): ReactNode {
  const zh = localeIsZh()
  const catalog = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const [selected, setSelected] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [initialized, setInitialized] = useState(false)
  const [projectKey, setProjectKey] = useState<string | null>(null)
  const [projectDefault, setProjectDefault] = useState<string | null>(null)
  const requestRef = useRef(0)

  useEffect(() => {
    void controller.load().catch(() => undefined)
  }, [controller])

  useEffect(() => {
    if (catalog.status !== 'ready') {
      setInitialized(false)
      return
    }
    const request = ++requestRef.current
    const retryDelays = [100, 300, 1_000, 2_000] as const
    let timer: ReturnType<typeof setTimeout> | undefined
    setBusy(true)
    setInitialized(false)
    setError('')

    const complete = (): void => {
      if (request !== requestRef.current) return
      setBusy(false)
      setInitialized(true)
    }
    const readMode = (attempt: number): void => {
      void controller.call<ModeResponse>('mode/get', { sessionId }).then((response) => {
        if (request !== requestRef.current) return
        // With no restored Session, `mode:null` cannot distinguish an explicit
        // Solo choice from a project default that has not hydrated yet. Keep
        // the last trustworthy UI state until the Host can answer completely.
        const authoritative = isAuthoritativeModeResponse(response)
        if (authoritative) {
          setEnabled(response.mode !== null)
          setSelected(response.mode?.squadId ?? '')
          setProjectKey(response.projectKey ?? null)
          setProjectDefault(response.projectDefault?.squadId ?? null)
        }
        // Any successful read unlocks the controls. Only an unresolved
        // inherited project default needs a background retry; explicit Solo
        // and explicit Team are already durable, authoritative answers.
        complete()
        if (!authoritative && attempt < retryDelays.length) {
          timer = setTimeout(() => { readMode(attempt + 1) }, retryDelays[attempt])
          return
        }
      }, (reason: unknown) => {
        if (request !== requestRef.current) return
        if (attempt < retryDelays.length) {
          timer = setTimeout(() => { readMode(attempt + 1) }, retryDelays[attempt])
          return
        }
        setError(errorText(reason))
        complete()
      })
    }
    readMode(0)
    return () => {
      requestRef.current += 1
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [catalog.revision, catalog.status, controller, sessionId])

  useEffect(() => {
    if (catalog.status !== 'ready') return
    const first = catalog.data.squads[0]?.id ?? ''
    if (selected === '') {
      if (first !== '') setSelected(first)
      return
    }
    if (catalog.data.squads.some(item => item.id === selected)) return

    // Settings 删除了当前小队：本地立即收敛，host 也显式关闭，避免
    // composer 继续显示一个已经不存在的会话模式。
    setSelected(first)
    if (!enabled) return
    setEnabled(false)
    const request = ++requestRef.current
    setBusy(true)
    controller.call<ModeResponse>('mode/set', { sessionId, squadId: null }).catch((reason: unknown) => {
      if (request === requestRef.current) setError(errorText(reason))
    }).finally(() => {
      if (request === requestRef.current) setBusy(false)
    })
  }, [catalog.data.squads, catalog.status, controller, enabled, selected, sessionId])

  const setMode = async (squadId: string | null): Promise<void> => {
    const request = ++requestRef.current
    setBusy(true)
    setError('')
    try {
      const response = await controller.call<ModeResponse>('mode/set', { sessionId, squadId })
      if (request !== requestRef.current) return
      setEnabled(response.mode !== null)
      if (response.mode !== null) setSelected(response.mode.squadId)
    } catch (reason) {
      if (request === requestRef.current) setError(errorText(reason))
    } finally {
      if (request === requestRef.current) setBusy(false)
    }
  }

  const toggleProjectDefault = async (): Promise<void> => {
    if (projectKey === null || selected === '') return
    setBusy(true)
    setError('')
    try {
      const response = await controller.call<{ projectDefault: { squadId: string } | null }>('project/default-set', {
        sessionId,
        squadId: projectDefault === selected ? null : selected,
      })
      setProjectDefault(response.projectDefault?.squadId ?? null)
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(false)
    }
  }

  // `adjudicating` is also used while the idle composer checks trigger owners;
  // locking on it made the control appear permanently disabled and flicker.
  const locked = busy || !initialized || input.phase === 'submitting'
  const hasSquads = catalog.data.squads.length > 0
  const visibleError = error || catalog.error
  return (
    <div className={`atg-composer${enabled ? ' is-on' : ''}`} title={visibleError || (zh ? '开启后，普通发送会在主模型回复前可靠运行所选小队' : 'When enabled, the selected team runs before the lead model replies')}>
      <span className="atg-mode-label">{initialized ? (enabled ? (zh ? '小队' : 'Team') : (zh ? '单人' : 'Solo')) : '…'}</span>
      <select
        className="atg-composer-select"
        aria-label={zh ? '选择小队' : 'Select squad'}
        value={selected}
        disabled={locked || !hasSquads}
        onChange={(event) => {
          const squadId = event.currentTarget.value
          setSelected(squadId)
          if (enabled) void setMode(squadId)
        }}
      >
        {!hasSquads ? <option value="">{zh ? '先创建小队' : 'Create a squad first'}</option> : null}
        {catalog.data.squads.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
      {projectKey !== null ? <button
        type="button"
        className={`atg-project-pin${projectDefault === selected ? ' is-on' : ''}`}
        aria-label={zh ? '设为当前项目默认小队' : 'Set as this project default'}
        title={zh ? (projectDefault === selected ? '取消项目默认' : '设为当前项目默认') : (projectDefault === selected ? 'Clear project default' : 'Use by default in this project')}
        disabled={locked || selected === ''}
        onClick={() => { void toggleProjectDefault() }}
      >★</button> : null}
      <button
        type="button"
        className={`atg-switch${enabled ? ' is-on' : ''}`}
        role="switch"
        aria-checked={enabled}
        aria-label={zh ? '小队模式' : 'Squad mode'}
        disabled={locked || !hasSquads || selected === ''}
        onClick={() => { void setMode(enabled ? null : selected) }}
      >
        <span />
      </button>
      {visibleError ? <span className="atg-composer-error" role="alert" title={visibleError}>!</span> : null}
    </div>
  )
}

interface RunCenterProps {
  controller: AgentTeamController
  sessionId: string
}

function useRuns(controller: AgentTeamController, sessionId: string, limit = 30): { runs: RunView[]; error: string; refresh(): void } {
  const [runs, setRuns] = useState<RunView[]>([])
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const response = await controller.call<{ runs: RunView[] }>('run/list', { sessionId, limit })
        if (!active) return
        setRuns(response.runs)
        setError('')
        const live = response.runs.some(run => run.status === 'planning' || run.status === 'running')
        timer = setTimeout(() => { void poll() }, live ? 850 : 4_000)
      } catch (reason) {
        if (!active) return
        setError(errorText(reason))
        timer = setTimeout(() => { void poll() }, 4_000)
      }
    }
    void poll()
    return () => {
      active = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [controller, limit, revision, sessionId])
  return { runs, error, refresh: () => { setRevision(value => value + 1) } }
}

/** Per-session run center: durable plan, member progress, outputs and official token usage. */
export function TeamRunCenter({ controller, sessionId }: RunCenterProps): ReactNode {
  const zh = localeIsZh()
  const { runs, error, refresh } = useRuns(controller, sessionId)
  const [expanded, setExpanded] = useState<string | null>(null)
  const cancel = async (id: string): Promise<void> => {
    await controller.call('run/cancel', { id })
    refresh()
  }
  return <div className="atg-run-center">
    <header className="atg-run-header"><div><h2>{zh ? '小队运行' : 'Team runs'}</h2><p>{zh ? '查看规划、成员输出、失败与真实 token 成本。' : 'Inspect plans, member outputs, failures, and provider-reported token cost.'}</p></div><button className="atg-button ghost" onClick={refresh}>↻ {zh ? '刷新' : 'Refresh'}</button></header>
    {error ? <div className="atg-alert">{error}</div> : null}
    {runs.length === 0 ? <Empty text={zh ? '这个对话还没有小队运行记录。开启小队模式后正常发送即可。' : 'No team runs in this conversation yet. Enable Team mode and send normally.'} /> : null}
    <div className="atg-run-list">{runs.map((run) => {
      const open = expanded === run.id
      const completed = run.members.filter(member => member.status === 'completed').length
      return <article key={run.id} className={`atg-run-card status-${run.status}`}>
        <button type="button" className="atg-run-summary" onClick={() => { setExpanded(open ? null : run.id) }}>
          <span className={`atg-status-dot status-${run.status}`} />
          <span className="atg-run-title"><strong>{run.squadName}</strong><small>{truncate(run.task, 92)}</small></span>
          <span className="atg-run-metric"><strong>{completed}/{run.members.length}</strong><small>{zh ? '成员' : 'members'}</small></span>
          <span className="atg-run-metric"><strong>{run.usage.providerReported
            ? formatTokens(run.usage.totalTokens)
            : (run.status === 'planning' || run.status === 'running' ? (zh ? '统计中' : 'Metering') : '—')}</strong><small>tokens</small></span>
          <span className="atg-run-time">{formatDuration(run.startedAt, run.endedAt)}</span>
          <span>{open ? '⌃' : '⌄'}</span>
        </button>
        {open ? <div className="atg-run-detail">
          <div className="atg-run-meta"><span>{run.executionMode === 'parallel' ? (zh ? '并行' : 'Parallel') : (zh ? '串行' : 'Serial')}</span><span>{contextLabel(run.contextMode, zh)}</span><span>{new Date(run.startedAt).toLocaleString()}</span>{run.plan ? <span>{run.plan.planner === 'main-agent' ? (zh ? '主 Agent 动态编排' : 'Main Agent planned') : (zh ? '备用队长规划' : 'Fallback lead planned')}</span> : null}</div>
          {run.plan ? <div className={`atg-plan${run.plan.warning ? ' has-warning' : ''}`}><strong>{zh ? '执行计划' : 'Execution plan'}</strong><p>{run.plan.summary}</p>{run.plan.memberOrder.map((agentId, index) => { const assignment = run.plan?.assignments.find(item => item.agentId === agentId); return assignment === undefined ? null : <p key={agentId}><strong>{index + 1}. {run.members.find(member => member.agentId === agentId)?.agentName ?? agentId}</strong> — {assignment.task}</p> })}{run.plan.warning ? <small>{run.plan.warning}</small> : null}</div> : null}
          <div className="atg-token-grid"><TokenCell label={zh ? '非缓存输入' : 'Uncached input'} value={run.usage.uncachedInputTokens} /><TokenCell label={zh ? '缓存读取' : 'Cache read'} value={run.usage.cacheReadTokens} /><TokenCell label={zh ? '缓存写入' : 'Cache write'} value={run.usage.cacheWriteTokens} /><TokenCell label={zh ? '输出' : 'Output'} value={run.usage.outputTokens} /></div>
          <div className="atg-run-members">{run.members.map(member => <details key={member.agentId} className={`atg-run-member status-${member.status}`}>
            <summary><span className={`atg-status-dot status-${member.status}`} /><span><strong>{member.agentName}</strong><small>{member.provider} / {member.model}</small></span><span>{statusLabel(member.status, zh)}</span><span>{member.usage === undefined
              ? (member.status === 'running' ? (zh ? '统计中…' : 'Metering…') : '—')
              : `${formatTokens(member.usage.totalTokens)} tok`}</span><span>{member.attempts > 1 ? `×${member.attempts}` : ''}</span></summary>
            <div className="atg-member-output">{member.error ? <div className="atg-alert">{member.error}</div> : null}<pre>{member.output.map(block => block.text ?? '').filter(Boolean).join('\n') || (zh ? '没有文本输出' : 'No text output')}</pre>{member.childId ? <small>child: {member.childId}</small> : null}</div>
          </details>)}</div>
          {(run.status === 'planning' || run.status === 'running') ? <div className="atg-actions"><button className="atg-button danger" onClick={() => { void cancel(run.id) }}>{zh ? '停止运行' : 'Stop run'}</button></div> : null}
        </div> : null}
      </article>
    })}</div>
  </div>
}

/** Compact live progress strip above the composer. */
export function TeamRunDock({ controller, sessionId }: RunCenterProps): ReactNode {
  const zh = localeIsZh()
  const { runs } = useRuns(controller, sessionId, 3)
  const live = runs.find(run => run.status === 'planning' || run.status === 'running')
  if (live === undefined) return null
  const done = live.members.filter(member => member.status === 'completed' || member.status === 'failed').length
  return <div className="atg-run-dock"><span className="atg-live-pulse" /><strong>{live.squadName}</strong><span>{live.status === 'planning' ? (zh ? '正在规划…' : 'Planning…') : `${done}/${live.members.length} ${zh ? '名成员' : 'members'}`}</span><span>{live.usage.providerReported ? `${formatTokens(live.usage.totalTokens)} tok` : (zh ? 'token 统计中…' : 'Metering tokens…')}</span></div>
}

function TokenCell({ label, value }: { label: string; value: number }): ReactNode {
  return <div><strong>{formatTokens(value)}</strong><small>{label}</small></div>
}

interface SettingsProps {
  controller: AgentTeamController
}

interface AgentDraft {
  id: string
  name: string
  systemPrompt: string
  provider: string
  model: string
  maxTokens: string
  allow: string
  deny: string
  fallbackProvider: string
  fallbackModel: string
}

interface SquadDraft {
  id: string
  name: string
  collabNote: string
  members: string[]
  fixedOrder: boolean
  executionOrder: string[]
  executionMode?: 'serial' | 'parallel'
  contextMode?: 'spawn' | 'fork' | 'chain'
  leaderAgentId: string
  triggerMode: 'guaranteed' | 'model-tool'
  failurePolicy: 'continue' | 'stop' | 'retry-once'
  maxConcurrency: string
  memberTimeoutMs: string
  tokenBudget: string
}

const EMPTY_AGENT: AgentDraft = {
  id: '', name: '', systemPrompt: '', provider: '', model: '', maxTokens: '', allow: '', deny: '', fallbackProvider: '', fallbackModel: '',
}
const EMPTY_SQUAD: SquadDraft = {
  id: '', name: '', collabNote: '', members: [], fixedOrder: false, executionOrder: [], leaderAgentId: '',
  triggerMode: 'guaranteed', failurePolicy: 'continue', maxConcurrency: '', memberTimeoutMs: '', tokenBudget: '',
}

/** Settings 的“小队”页面：小队与成员模型在同一处完成 CRUD。 */
export function TeamSettingsPage({ controller }: SettingsProps): ReactNode {
  const zh = localeIsZh()
  const catalog = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const [squad, setSquad] = useState<SquadDraft>(EMPTY_SQUAD)
  const [agent, setAgent] = useState<AgentDraft>(EMPTY_AGENT)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [versions, setVersions] = useState<Array<{ version: number; createdAt: number }>>([])
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge')
  const [diagnostic, setDiagnostic] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void controller.load().catch(() => undefined)
  }, [controller])

  useEffect(() => {
    if (catalog.status !== 'ready') return
    setAgent(current => current.id === '' && current.name === '' && current.provider === ''
      ? defaultAgent(catalog.data)
      : current)
  }, [catalog.data, catalog.status])

  const activeModels = useMemo(
    () => catalog.data.models.find(group => group.provider === agent.provider)?.models ?? [],
    [agent.provider, catalog.data.models],
  )
  const orderedMembers = useMemo(
    () => normalizeOrder(squad.members, squad.executionOrder),
    [squad.executionOrder, squad.members],
  )

  const run = async (action: () => Promise<void>): Promise<boolean> => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
      return true
    } catch (reason) {
      setError(errorText(reason))
      return false
    } finally {
      setBusy(false)
    }
  }

  const saveSquad = async (): Promise<void> => {
    const record = {
      name: squad.name.trim(),
      members: squad.members,
      collabNote: squad.collabNote.trim(),
      ...(squad.fixedOrder
        ? { executionOrder: orderedMembers, executionMode: 'serial' as const }
        : (squad.executionMode === undefined ? {} : { executionMode: squad.executionMode })),
      ...(squad.contextMode === undefined ? {} : { contextMode: squad.contextMode }),
      ...(squad.leaderAgentId === '' ? {} : { leaderAgentId: squad.leaderAgentId }),
      triggerMode: squad.triggerMode,
      failurePolicy: squad.failurePolicy,
      ...(squad.maxConcurrency.trim() === '' ? {} : { maxConcurrency: Number(squad.maxConcurrency) }),
      ...(squad.memberTimeoutMs.trim() === '' ? {} : { memberTimeoutMs: Number(squad.memberTimeoutMs) }),
      ...(squad.tokenBudget.trim() === '' ? {} : { tokenBudget: Number(squad.tokenBudget) }),
    }
    const ok = await run(() => controller.mutate(
      squad.id ? 'squad/update' : 'squad/create',
      squad.id ? { id: squad.id, record } : { record },
    ))
    if (ok) setSquad(EMPTY_SQUAD)
  }

  const saveAgent = async (): Promise<void> => {
    const allow = csv(agent.allow)
    const deny = csv(agent.deny)
    const record = {
      name: agent.name.trim(),
      systemPrompt: agent.systemPrompt.trim(),
      provider: agent.provider,
      model: agent.model,
      ...(agent.maxTokens.trim() === '' ? {} : { maxTokens: Number(agent.maxTokens) }),
      ...(allow.length === 0 && deny.length === 0 ? {} : {
        toolScope: {
          ...(allow.length === 0 ? {} : { allow }),
          ...(deny.length === 0 ? {} : { deny }),
        },
      }),
      ...(agent.fallbackProvider === '' || agent.fallbackModel === '' ? {} : {
        fallbackProvider: agent.fallbackProvider,
        fallbackModel: agent.fallbackModel,
      }),
    }
    const ok = await run(() => controller.mutate(
      agent.id ? 'agent/update' : 'agent/create',
      agent.id ? { id: agent.id, record } : { record },
    ))
    if (ok) setAgent(defaultAgent(catalog.data))
  }

  const deleteItem = async (kind: 'agent' | 'squad', id: string, name: string): Promise<void> => {
    const message = zh ? `确定删除“${name}”吗？` : `Delete “${name}”?`
    if (!window.confirm(message)) return
    const ok = await run(() => controller.mutate(`${kind}/delete`, { id }))
    if (!ok) return
    if (kind === 'agent' && agent.id === id) setAgent(defaultAgent(controller.getSnapshot().data))
    if (kind === 'squad' && squad.id === id) setSquad(EMPTY_SQUAD)
  }

  const exportData = async (): Promise<void> => {
    await run(async () => {
      const doc = await controller.call<unknown>('export', {})
      const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `agent-team-gui-${new Date().toISOString().slice(0, 10)}.json`
      anchor.hidden = true
      document.body.append(anchor)
      anchor.click()
      // Keep the Blob URL alive until the browser has accepted the download.
      setTimeout(() => {
        anchor.remove()
        URL.revokeObjectURL(url)
      }, 1_000)
      setNotice(zh ? '配置已导出。' : 'Definitions exported.')
    })
  }

  const importData = async (file: File): Promise<void> => {
    await run(async () => {
      const doc: unknown = JSON.parse(await file.text())
      const summary = importSummary(doc, zh)
      const warning = importMode === 'replace'
        ? (zh ? '替换会删除当前未包含在文件中的成员和小队。继续吗？' : 'Replace removes agents and teams not present in the file. Continue?')
        : (zh ? '将按 ID 合并到现有配置。继续吗？' : 'The file will be merged by ID. Continue?')
      if (!window.confirm(`${summary}\n\n${warning}`)) return
      await controller.call('import', { doc, mode: importMode })
      await controller.load(true)
      setNotice(zh ? '配置已导入并通过校验。' : 'Definitions imported and validated.')
    })
  }

  const editSquad = (item: SquadView): void => {
    setSquad({
      id: item.id,
      name: item.name,
      collabNote: item.collabNote,
      members: [...item.members],
      fixedOrder: item.executionOrder !== undefined,
      executionOrder: item.executionOrder === undefined ? [] : [...item.executionOrder],
      ...(item.executionMode === undefined ? {} : { executionMode: item.executionMode }),
      ...(item.contextMode === undefined ? {} : { contextMode: item.contextMode }),
      leaderAgentId: item.leaderAgentId ?? '',
      triggerMode: item.triggerMode ?? 'guaranteed',
      failurePolicy: item.failurePolicy ?? 'continue',
      maxConcurrency: item.maxConcurrency?.toString() ?? '',
      memberTimeoutMs: item.memberTimeoutMs?.toString() ?? '',
      tokenBudget: item.tokenBudget?.toString() ?? '',
    })
    controller.call<Array<{ version: number; createdAt: number }>>('squad/versions', { id: item.id })
      .then(setVersions, reason => { setError(errorText(reason)) })
  }

  const editAgent = (item: AgentView): void => {
    setAgent({
      id: item.id,
      name: item.name,
      systemPrompt: item.systemPrompt,
      provider: item.provider,
      model: item.model,
      maxTokens: item.maxTokens?.toString() ?? '',
      allow: item.toolScope?.allow?.join(', ') ?? '',
      deny: item.toolScope?.deny?.join(', ') ?? '',
      fallbackProvider: item.fallbackProvider ?? '',
      fallbackModel: item.fallbackModel ?? '',
    })
  }

  const chooseMember = (id: string, checked: boolean): void => {
    if (checked) {
      setSquad(current => ({
        ...current,
        members: [...current.members, id],
        executionOrder: [...current.executionOrder, id],
      }))
      return
    }
    setSquad(current => ({
      ...current,
      members: current.members.filter(member => member !== id),
      executionOrder: current.executionOrder.filter(member => member !== id),
      leaderAgentId: current.leaderAgentId === id ? '' : current.leaderAgentId,
    }))
  }

  const moveMember = (id: string, delta: -1 | 1): void => {
    const order = [...orderedMembers]
    const from = order.indexOf(id)
    const to = from + delta
    if (from < 0 || to < 0 || to >= order.length) return
    const next = order[to]
    if (next === undefined) return
    order[to] = id
    order[from] = next
    setSquad(current => ({ ...current, executionOrder: order }))
  }

  const cloneSquad = async (item: SquadView): Promise<void> => {
    const { id: _id, ...record } = item
    await run(() => controller.mutate('squad/create', { record: { ...record, name: `${item.name} Copy` } }))
  }

  const restoreVersion = async (version: number): Promise<void> => {
    if (squad.id === '') return
    const id = squad.id
    const ok = await run(() => controller.mutate('squad/restore', { id, version }))
    if (!ok) return
    const restored = controller.getSnapshot().data.squads.find(item => item.id === id)
    if (restored !== undefined) editSquad(restored)
  }

  const diagnoseSquad = async (): Promise<void> => {
    if (squad.id === '') {
      setDiagnostic(zh ? '请先保存小队，再运行检查。' : 'Save the team before running diagnostics.')
      return
    }
    await run(async () => {
      const response = await controller.call<{ checks: Array<{ name: string; ok: boolean; message: string }> }>('squad/diagnose', { id: squad.id })
      setDiagnostic(response.checks.map(check => `${check.ok ? '✓' : '✕'} ${check.name}: ${check.message}`).join('\n'))
      setNotice(response.checks.every(check => check.ok) ? (zh ? '小队检查通过。' : 'Team checks passed.') : (zh ? '检查发现问题。' : 'Team checks found issues.'))
    })
  }

  const applyTemplate = async (kind: 'development' | 'review' | 'product'): Promise<void> => {
    const routes = catalog.data.models.flatMap(group => group.models.map(model => ({ provider: group.provider, model: model.id })))
    if (routes.length === 0) {
      setError(zh ? '请先在 Settings → Models 配置至少一个模型。' : 'Configure at least one model in Settings → Models first.')
      return
    }
    const templates = {
      development: {
        name: zh ? '全栈开发小队' : 'Full-stack delivery',
        note: 'The planner decomposes the request, the implementer makes the change, and the reviewer checks correctness and regressions.',
        roles: [
          ['Planner', 'Analyze the request, identify constraints, and produce an executable implementation plan with acceptance criteria.'],
          ['Implementer', 'Implement the requested change completely. Preserve existing behavior and verify the result.'],
          ['Reviewer', 'Review correctness, security, UX, regressions, and missing tests. Cite concrete evidence.'],
        ],
      },
      review: {
        name: zh ? '并行审查小队' : 'Parallel review',
        note: 'Run independent correctness, security, and test reviews, then preserve disagreements for the lead model.',
        roles: [
          ['Correctness', 'Review behavior and logic for correctness. Report only evidence-backed findings.'],
          ['Security', 'Review trust boundaries, secrets, permissions, injection, and destructive behavior.'],
          ['Test', 'Run or design focused tests and identify regression risk and missing coverage.'],
        ],
      },
      product: {
        name: zh ? '产品设计小队' : 'Product design',
        note: 'Balance user value, interaction quality, and implementation feasibility.',
        roles: [
          ['Product', 'Clarify the user problem, success metrics, priorities, and edge cases.'],
          ['UX', 'Design a clear interaction flow, information architecture, states, and accessible microcopy.'],
          ['Engineer', 'Assess feasibility, architecture, risks, and an incremental delivery plan.'],
        ],
      },
    } as const
    const template = templates[kind]
    await run(async () => {
      const ids: string[] = []
      for (let index = 0; index < template.roles.length; index += 1) {
        const role = template.roles[index]!
        const route = routes[index % routes.length]!
        const created = await controller.call<{ id: string }>('agent/create', { record: {
          name: role[0], systemPrompt: role[1], provider: route.provider, model: route.model,
        } })
        ids.push(created.id)
      }
      await controller.call('squad/create', { record: {
        name: template.name,
        members: ids,
        collabNote: template.note,
        leaderAgentId: ids[0],
        triggerMode: 'guaranteed',
        failurePolicy: 'retry-once',
        executionMode: kind === 'review' ? 'parallel' : 'serial',
        contextMode: kind === 'development' ? 'chain' : 'fork',
        maxConcurrency: 3,
      } })
      await controller.load(true)
    })
  }

  const noProvider = catalog.data.models.length === 0
  return (
    <div className="atg-page">
      <header className="atg-page-header">
        <div>
          <h2>{zh ? '小队' : 'Teams'}</h2>
          <p>{zh ? '组合不同模型与角色；在对话框开启小队模式后，普通消息会自动触发协作。' : 'Combine models and roles. Enable team mode in the composer to orchestrate normal prompts.'}</p>
        </div>
        <div className="atg-toolbar">
          <button type="button" className="atg-button ghost" disabled={busy} onClick={() => { void controller.load(true).catch(reason => { setError(errorText(reason)) }) }}>↻ {zh ? '刷新' : 'Refresh'}</button>
          <label className="atg-import-mode"><span className="sr-only">{zh ? '导入方式' : 'Import mode'}</span><select value={importMode} onChange={event => { setImportMode(event.currentTarget.value as 'merge' | 'replace') }}><option value="merge">{zh ? '合并导入' : 'Merge import'}</option><option value="replace">{zh ? '替换导入' : 'Replace import'}</option></select></label>
          <button type="button" className="atg-button ghost" disabled={busy} onClick={() => { fileInput.current?.click() }}>{zh ? '导入' : 'Import'}</button>
          <button type="button" className="atg-button ghost" disabled={busy} onClick={() => { void exportData() }}>{zh ? '导出' : 'Export'}</button>
          <input ref={fileInput} hidden type="file" accept=".json,application/json" onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            if (file !== undefined) void importData(file)
            event.currentTarget.value = ''
          }} />
        </div>
      </header>

      {(error || catalog.error) ? <div className="atg-alert" role="alert">{error || catalog.error}</div> : null}
      {notice ? <div className="atg-success" role="status">{notice}</div> : null}
      {catalog.status === 'loading' ? <div className="atg-loading">{zh ? '正在读取小队…' : 'Loading teams…'}</div> : null}

      {catalog.status === 'ready' && catalog.data.agents.length === 0 && catalog.data.squads.length === 0 ? <section className="atg-starter">
        <div><span className="atg-kicker">00</span><div><h3>{zh ? '用模板快速开始' : 'Start with a template'}</h3><p>{zh ? '自动使用已配置模型创建三个成员，之后仍可自由调整。' : 'Create three editable members using models you already configured.'}</p></div></div>
        <div className="atg-template-grid">
          <TemplateButton icon="⌘" title={zh ? '全栈开发' : 'Full-stack delivery'} description={zh ? '规划、实现、审查串行协作' : 'Plan, implement, and review in sequence'} disabled={busy} onClick={() => { void applyTemplate('development') }} />
          <TemplateButton icon="◫" title={zh ? '并行审查' : 'Parallel review'} description={zh ? '正确性、安全与测试并行检查' : 'Correctness, security, and tests in parallel'} disabled={busy} onClick={() => { void applyTemplate('review') }} />
          <TemplateButton icon="◇" title={zh ? '产品设计' : 'Product design'} description={zh ? '产品、UX 与工程可行性协作' : 'Product, UX, and engineering tradeoffs'} disabled={busy} onClick={() => { void applyTemplate('product') }} />
        </div>
      </section> : null}

      <section className="atg-section">
        <div className="atg-section-title">
          <div><span className="atg-kicker">01</span><h3>{zh ? '小队编排' : 'Team orchestration'}</h3></div>
          <button type="button" className="atg-button ghost" onClick={() => { setSquad(EMPTY_SQUAD) }}>＋ {zh ? '新建小队' : 'New team'}</button>
        </div>
        <div className="atg-workspace">
          <div className="atg-list" aria-label={zh ? '小队列表' : 'Team list'}>
            {catalog.data.squads.map(item => (
              <article key={item.id} className={`atg-list-card${squad.id === item.id ? ' is-active' : ''}`}>
                <button type="button" className="atg-list-main" onClick={() => { editSquad(item) }}>
                  <strong>{item.name}</strong>
                  <span>{item.members.length} {zh ? '名成员' : 'members'} · {item.executionOrder === undefined ? (zh ? '自动编排' : 'auto') : (zh ? '固定顺序' : 'fixed order')}</span>
                </button>
                <button type="button" className="atg-icon" aria-label={zh ? '复制小队' : 'Clone team'} title={zh ? '复制' : 'Clone'} disabled={busy} onClick={() => { void cloneSquad(item) }}>⧉</button>
                <button type="button" className="atg-icon danger" aria-label={zh ? '删除小队' : 'Delete team'} disabled={busy} onClick={() => { void deleteItem('squad', item.id, item.name) }}>×</button>
              </article>
            ))}
            {catalog.data.squads.length === 0 ? <Empty text={zh ? '还没有小队，从右侧创建第一个。' : 'No teams yet. Create the first one on the right.'} /> : null}
          </div>

          <div className="atg-editor">
            <div className="atg-editor-head"><strong>{squad.id ? (zh ? '编辑小队' : 'Edit team') : (zh ? '创建小队' : 'Create team')}</strong><span>{squad.members.length} {zh ? '名成员' : 'members'}</span></div>
            <Field label={zh ? '小队名称' : 'Team name'} value={squad.name} placeholder={zh ? '例如：产品交付组' : 'e.g. Product delivery'} onChange={value => { setSquad(current => ({ ...current, name: value })) }} />
            <TextField label={zh ? '协作说明' : 'Collaboration note'} value={squad.collabNote} placeholder={zh ? '告诉主模型何时使用这个小队，以及成员如何协作。' : 'Tell the lead model when and how this team collaborates.'} onChange={value => { setSquad(current => ({ ...current, collabNote: value })) }} />

            <div className="atg-field-label">{zh ? '选择成员与模型' : 'Members and models'}</div>
            <div className="atg-member-grid">
              {catalog.data.agents.map(item => (
                <label key={item.id} className={`atg-member-card${squad.members.includes(item.id) ? ' is-selected' : ''}`}>
                  <input type="checkbox" checked={squad.members.includes(item.id)} onChange={event => { chooseMember(item.id, event.currentTarget.checked) }} />
                  <span className="atg-avatar">{initials(item.name)}</span>
                  <span><strong>{item.name}</strong><small>{item.provider} / {item.model}</small></span>
                </label>
              ))}
              {catalog.data.agents.length === 0 ? <Empty text={zh ? '请先在下方创建成员模型。' : 'Create a member model below first.'} /> : null}
            </div>

            <label className="atg-order-toggle">
              <input type="checkbox" checked={squad.fixedOrder} onChange={event => {
                const fixedOrder = event.currentTarget.checked
                setSquad(current => ({
                  ...current,
                  fixedOrder,
                  executionOrder: normalizeOrder(current.members, current.executionOrder),
                }))
              }} />
              <span><strong>{zh ? '固定执行顺序' : 'Fixed execution order'}</strong><small>{zh ? '关闭时，由主 Agent 根据成员特性自动拆解和编排。' : 'When off, the Main Agent plans every member from their configured role.'}</small></span>
            </label>
            {squad.fixedOrder ? (
              <ol className="atg-order-list">
                {orderedMembers.map((id, index) => {
                  const member = catalog.data.agents.find(item => item.id === id)
                  return <li key={id}><span className="atg-order-number">{index + 1}</span><span><strong>{member?.name ?? id}</strong><small>{member === undefined ? '' : `${member.provider} / ${member.model}`}</small></span><span className="atg-order-actions"><button type="button" className="atg-icon" disabled={index === 0} onClick={() => { moveMember(id, -1) }}>↑</button><button type="button" className="atg-icon" disabled={index === orderedMembers.length - 1} onClick={() => { moveMember(id, 1) }}>↓</button></span></li>
                })}
              </ol>
            ) : null}
            <div className="atg-three">
              <label className="atg-field"><span>{zh ? '运行方式' : 'Execution'}</span><select value={squad.fixedOrder ? 'serial' : (squad.executionMode ?? 'serial')} disabled={squad.fixedOrder} onChange={event => { setSquad(current => ({ ...current, executionMode: event.currentTarget.value as 'serial' | 'parallel' })) }}><option value="serial">{zh ? '串行' : 'Serial'}</option><option value="parallel">{zh ? '并行' : 'Parallel'}</option></select></label>
              <label className="atg-field"><span>{zh ? '上下文' : 'Context'}</span><select value={squad.contextMode ?? 'spawn'} onChange={event => { setSquad(current => ({ ...current, contextMode: event.currentTarget.value as 'spawn' | 'fork' | 'chain' })) }}><option value="spawn">Spawn</option><option value="fork">Fork</option><option value="chain" disabled={(squad.executionMode ?? 'serial') === 'parallel'}>Chain</option></select></label>
              <label className="atg-field"><span>{zh ? '触发方式' : 'Trigger'}</span><select value={squad.triggerMode} onChange={event => { setSquad(current => ({ ...current, triggerMode: event.currentTarget.value as 'guaranteed' | 'model-tool' })) }}><option value="guaranteed">{zh ? '可靠自动运行' : 'Guaranteed'}</option><option value="model-tool">{zh ? '模型按需调用' : 'Model tool'}</option></select></label>
            </div>
            {!squad.fixedOrder ? <label className="atg-field"><span>{zh ? '备用规划队长（可选）' : 'Fallback planning lead (optional)'}</span><select value={squad.leaderAgentId} onChange={event => { setSquad(current => ({ ...current, leaderAgentId: event.currentTarget.value })) }}><option value="">{zh ? '不指定 — 普通对话默认由主 Agent 编排' : 'None — Main Agent plans normal sends'}</option>{orderedMembers.map(id => { const member = catalog.data.agents.find(item => item.id === id); return <option key={id} value={id}>{member?.name ?? id}</option> })}</select><small>{zh ? '仅供手动派单等没有主对话规划上下文的路径使用。' : 'Used only by manual dispatch paths without a main-conversation planning context.'}</small></label> : null}
            <details className="atg-details"><summary>{zh ? '可靠性、并发与 Token 预算' : 'Reliability, concurrency, and token budget'}</summary>
              <div className="atg-three"><label className="atg-field"><span>{zh ? '失败策略' : 'Failure policy'}</span><select value={squad.failurePolicy} onChange={event => { setSquad(current => ({ ...current, failurePolicy: event.currentTarget.value as 'continue' | 'stop' | 'retry-once' })) }}><option value="continue">{zh ? '继续其他成员' : 'Continue'}</option><option value="stop">{zh ? '立即停止' : 'Stop'}</option><option value="retry-once">{zh ? '回退模型重试一次' : 'Retry once'}</option></select></label><Field label={zh ? '最大并发' : 'Max concurrency'} value={squad.maxConcurrency} inputMode="numeric" placeholder={zh ? '默认：全部' : 'Default: all'} onChange={value => { setSquad(current => ({ ...current, maxConcurrency: value })) }} /><Field label={zh ? '成员超时 (ms)' : 'Member timeout (ms)'} value={squad.memberTimeoutMs} inputMode="numeric" placeholder="120000" onChange={value => { setSquad(current => ({ ...current, memberTimeoutMs: value })) }} /></div>
              <Field label={zh ? '本次小队 Token 软预算' : 'Team token soft budget'} value={squad.tokenBudget} inputMode="numeric" placeholder={zh ? '留空为不限制；达到后不再启动新成员' : 'Unlimited; stops starting new members after reached'} onChange={value => { setSquad(current => ({ ...current, tokenBudget: value })) }} />
            </details>
            {squad.id ? <details className="atg-details"><summary>{zh ? `版本历史（${versions.length}）` : `Version history (${versions.length})`}</summary><div className="atg-version-list">{versions.map(item => <div key={item.version}><span>v{item.version} · {new Date(item.createdAt).toLocaleString()}</span><button type="button" className="atg-button ghost" disabled={busy} onClick={() => { void restoreVersion(item.version) }}>{zh ? '恢复' : 'Restore'}</button></div>)}</div></details> : null}
            {diagnostic ? <pre className="atg-diagnostic">{diagnostic}</pre> : null}
            <div className="atg-actions">{squad.id ? <button type="button" className="atg-button ghost" disabled={busy} onClick={() => { void diagnoseSquad() }}>{zh ? '检查配置' : 'Check team'}</button> : null}<button type="button" className="atg-button ghost" onClick={() => { setSquad(EMPTY_SQUAD); setDiagnostic('') }}>{zh ? '取消' : 'Cancel'}</button><button type="button" className="atg-button primary" disabled={busy || squad.name.trim() === '' || squad.members.length === 0} onClick={() => { void saveSquad() }}>{busy ? '…' : (squad.id ? (zh ? '保存小队' : 'Save team') : (zh ? '创建小队' : 'Create team'))}</button></div>
          </div>
        </div>
      </section>

      <section className="atg-section">
        <div className="atg-section-title"><div><span className="atg-kicker">02</span><h3>{zh ? '成员模型' : 'Member models'}</h3></div><button type="button" className="atg-button ghost" onClick={() => { setAgent(defaultAgent(catalog.data)) }}>＋ {zh ? '新建成员' : 'New member'}</button></div>
        {noProvider ? <div className="atg-note">{zh ? '尚未发现可用模型，请先在 Settings → Models 配置 provider。' : 'No models found. Configure a provider in Settings → Models first.'}</div> : null}
        <div className="atg-workspace">
          <div className="atg-list">
            {catalog.data.agents.map(item => (
              <article key={item.id} className={`atg-list-card${agent.id === item.id ? ' is-active' : ''}`}>
                <button type="button" className="atg-list-main" onClick={() => { editAgent(item) }}><strong>{item.name}</strong><span>{item.provider} / {item.model}</span></button>
                <button type="button" className="atg-icon danger" aria-label={zh ? '删除成员' : 'Delete member'} disabled={busy} onClick={() => { void deleteItem('agent', item.id, item.name) }}>×</button>
              </article>
            ))}
            {catalog.data.agents.length === 0 ? <Empty text={zh ? '还没有成员模型。' : 'No member models yet.'} /> : null}
          </div>
          <div className="atg-editor">
            <div className="atg-editor-head"><strong>{agent.id ? (zh ? '编辑成员' : 'Edit member') : (zh ? '创建成员' : 'Create member')}</strong><span>{zh ? '凭据沿用全局模型设置' : 'Uses global model credentials'}</span></div>
            <div className="atg-two"><Field label={zh ? '成员名称' : 'Member name'} value={agent.name} placeholder={zh ? '例如：研究员' : 'e.g. Researcher'} onChange={value => { setAgent(current => ({ ...current, name: value })) }} /><Field label="Max tokens" value={agent.maxTokens} inputMode="numeric" placeholder={zh ? '可选' : 'Optional'} onChange={value => { setAgent(current => ({ ...current, maxTokens: value })) }} /></div>
            <TextField label={zh ? '角色说明 / System prompt' : 'Role / system prompt'} value={agent.systemPrompt} placeholder={zh ? '明确成员的专长、边界与输出格式。' : 'Define expertise, boundaries, and output format.'} onChange={value => { setAgent(current => ({ ...current, systemPrompt: value })) }} />
            <div className="atg-two">
              <label className="atg-field"><span>Provider</span><select value={agent.provider} onChange={event => {
                const provider = event.currentTarget.value
                const models = catalog.data.models.find(group => group.provider === provider)?.models ?? []
                setAgent(current => ({ ...current, provider, model: models[0]?.id ?? '' }))
              }}><option value="">—</option>{catalog.data.models.map(group => <option key={group.provider} value={group.provider}>{group.name} ({group.provider})</option>)}</select></label>
              <label className="atg-field"><span>{zh ? '模型' : 'Model'}</span><select value={agent.model} onChange={event => {
                const model = event.currentTarget.value
                setAgent(current => ({ ...current, model }))
              }}><option value="">—</option>{activeModels.map(model => <option key={model.id} value={model.id}>{model.name} ({model.id})</option>)}</select></label>
            </div>
            <details className="atg-details"><summary>{zh ? '回退模型' : 'Fallback model'}</summary><div className="atg-two"><label className="atg-field"><span>Provider</span><select value={agent.fallbackProvider} onChange={event => { const fallbackProvider = event.currentTarget.value; const models = catalog.data.models.find(group => group.provider === fallbackProvider)?.models ?? []; setAgent(current => ({ ...current, fallbackProvider, fallbackModel: models[0]?.id ?? '' })) }}><option value="">{zh ? '不配置' : 'None'}</option>{catalog.data.models.map(group => <option key={group.provider} value={group.provider}>{group.name} ({group.provider})</option>)}</select></label><label className="atg-field"><span>{zh ? '模型' : 'Model'}</span><select value={agent.fallbackModel} disabled={agent.fallbackProvider === ''} onChange={event => { setAgent(current => ({ ...current, fallbackModel: event.currentTarget.value })) }}><option value="">—</option>{(catalog.data.models.find(group => group.provider === agent.fallbackProvider)?.models ?? []).map(model => <option key={model.id} value={model.id}>{model.name} ({model.id})</option>)}</select></label></div></details>
            <details className="atg-details"><summary>{zh ? '工具权限' : 'Tool permissions'}</summary><p className="atg-help">{zh ? '“允许”形成白名单；“禁用”始终优先。未选择时继承默认工具。' : 'Allow creates a whitelist; deny always wins. Empty inherits the default tool set.'}</p><div className="atg-tool-grid">{catalog.data.tools.map(tool => { const allowed = csv(agent.allow).includes(tool.name); const denied = csv(agent.deny).includes(tool.name); return <div key={tool.name} className="atg-tool-row"><span title={tool.description}><strong>{tool.name}</strong><small>{tool.description}</small></span><button type="button" className={`atg-tool-state${allowed ? ' allow' : ''}`} onClick={() => { setAgent(current => ({ ...current, allow: toggleCsv(current.allow, tool.name), deny: denied ? toggleCsv(current.deny, tool.name) : current.deny })) }}>{zh ? '允许' : 'Allow'}</button><button type="button" className={`atg-tool-state${denied ? ' deny' : ''}`} onClick={() => { setAgent(current => ({ ...current, deny: toggleCsv(current.deny, tool.name), allow: allowed ? toggleCsv(current.allow, tool.name) : current.allow })) }}>{zh ? '禁用' : 'Deny'}</button></div> })}{catalog.data.tools.length === 0 ? <Empty text={zh ? '未发现工具目录。' : 'No tool catalog available.'} /> : null}</div></details>
            <div className="atg-actions"><button type="button" className="atg-button ghost" onClick={() => { setAgent(defaultAgent(catalog.data)) }}>{zh ? '取消' : 'Cancel'}</button><button type="button" className="atg-button primary" disabled={busy || agent.name.trim() === '' || agent.provider === '' || agent.model === ''} onClick={() => { void saveAgent() }}>{busy ? '…' : (agent.id ? (zh ? '保存成员' : 'Save member') : (zh ? '创建成员' : 'Create member'))}</button></div>
          </div>
        </div>
      </section>
    </div>
  )
}

function Field({ label, value, placeholder, inputMode, onChange }: { label: string; value: string; placeholder?: string; inputMode?: 'numeric'; onChange(value: string): void }): ReactNode {
  return <label className="atg-field"><span>{label}</span><input value={value} placeholder={placeholder} inputMode={inputMode} onChange={event => { onChange(event.currentTarget.value) }} /></label>
}

function TextField({ label, value, placeholder, onChange }: { label: string; value: string; placeholder?: string; onChange(value: string): void }): ReactNode {
  return <label className="atg-field"><span>{label}</span><textarea value={value} placeholder={placeholder} onChange={event => { onChange(event.currentTarget.value) }} /></label>
}

function Empty({ text }: { text: string }): ReactNode {
  return <div className="atg-empty">◇<span>{text}</span></div>
}

function TemplateButton({ icon, title, description, disabled, onClick }: { icon: string; title: string; description: string; disabled: boolean; onClick(): void }): ReactNode {
  return <button type="button" className="atg-template" disabled={disabled} onClick={onClick}><span>{icon}</span><strong>{title}</strong><small>{description}</small></button>
}

function defaultAgent(data: TeamSnapshot): AgentDraft {
  const provider = data.models[0]
  return {
    ...EMPTY_AGENT,
    provider: provider?.provider ?? '',
    model: provider?.models[0]?.id ?? '',
  }
}

function normalizeOrder(members: readonly string[], order: readonly string[]): string[] {
  const selected = new Set(members)
  const normalized = order.filter((id, index) => selected.has(id) && order.indexOf(id) === index)
  for (const id of members) if (!normalized.includes(id)) normalized.push(id)
  return normalized
}

function initials(name: string): string {
  return [...name.trim()].slice(0, 2).join('').toUpperCase() || 'AI'
}

function localeIsZh(): boolean {
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh')
}

function csv(value: string): string[] {
  return [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))]
}

function toggleCsv(value: string, item: string): string {
  const items = csv(value)
  return (items.includes(item) ? items.filter(current => current !== item) : [...items, item]).join(', ')
}

function importSummary(doc: unknown, zh: boolean): string {
  const value = doc !== null && typeof doc === 'object' ? doc as { agents?: unknown; squads?: unknown } : {}
  const agents = Array.isArray(value.agents) ? value.agents.length : 0
  const squads = Array.isArray(value.squads) ? value.squads.length : 0
  return zh ? `文件包含 ${agents} 名成员、${squads} 个小队。` : `The file contains ${agents} agents and ${squads} teams.`
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, Math.max(0, length - 1))}…`
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`
  return String(value)
}

function formatDuration(startedAt: number, endedAt?: number): string {
  const seconds = Math.max(0, Math.round(((endedAt ?? Date.now()) - startedAt) / 1_000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function contextLabel(mode: RunView['contextMode'], zh: boolean): string {
  if (mode === 'chain') return zh ? '链式上下文' : 'Chained context'
  if (mode === 'fork') return zh ? '继承对话' : 'Forked context'
  return zh ? '独立上下文' : 'Fresh context'
}

function statusLabel(status: RunMemberView['status'], zh: boolean): string {
  const labels = zh
    ? { pending: '等待', running: '运行中', completed: '完成', failed: '失败', cancelled: '已取消', skipped: '已跳过' }
    : { pending: 'Pending', running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', skipped: 'Skipped' }
  return labels[status]
}

function errorText(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason)
  return message.includes('unknown agent team endpoint') ? incompatibleHostMessage() : message
}

function incompatibleHostMessage(): string {
  return localeIsZh()
    ? 'Agent Team GUI 前后端版本不一致，请重启 DeepSeek Harness 后刷新页面。'
    : 'Agent Team GUI client/host versions do not match. Restart DeepSeek Harness, then refresh the page.'
}

/** 由入口一次性挂载，避免外部插件构建依赖 CSS Modules 转换器。 */
export const CLIENT_STYLES = `
.atg-page{display:grid;gap:20px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);padding:4px 0 30px}.atg-page *{box-sizing:border-box}.atg-page-header{display:flex;justify-content:space-between;align-items:flex-start;gap:18px}.atg-page h2{font-size:22px;line-height:30px;margin:0 0 4px}.atg-page-header p{max-width:580px;margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}.atg-toolbar,.atg-actions{display:flex;align-items:center;gap:8px}.atg-alert,.atg-note,.atg-loading{padding:10px 12px;border-radius:10px;font-size:12px;line-height:18px}.atg-alert{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger)}.atg-note,.atg-loading{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform)}.atg-section{display:grid;gap:12px}.atg-section-title{display:flex;align-items:center;justify-content:space-between;gap:12px}.atg-section-title>div{display:flex;align-items:center;gap:9px}.atg-section h3{font-size:15px;margin:0}.atg-kicker{display:grid;place-items:center;width:26px;height:26px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-tertiary);font-size:10px;font-weight:650}.atg-workspace{display:grid;grid-template-columns:minmax(180px,220px) minmax(0,1fr);gap:12px}.atg-list,.atg-editor{border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1)}.atg-list{display:flex;flex-direction:column;gap:5px;min-height:180px;padding:7px}.atg-list-card{display:flex;align-items:center;gap:5px;border-radius:9px}.atg-list-card:hover{background:var(--dsw-alias-interactive-bg-hover)}.atg-list-card.is-active{background:var(--dsw-specific-sidebar-nav-item-active)}.atg-list-main{min-width:0;flex:1;display:grid;gap:2px;padding:9px;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer}.atg-list-main strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.atg-list-main span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:11px}.atg-editor{display:grid;align-content:start;gap:12px;padding:16px}.atg-editor-head{display:flex;justify-content:space-between;align-items:baseline;gap:10px;padding-bottom:10px;border-bottom:1px solid var(--dsw-alias-border-l2)}.atg-editor-head strong{font-size:14px}.atg-editor-head span{color:var(--dsw-alias-label-tertiary);font-size:11px}.atg-field{display:grid;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px}.atg-field>span,.atg-field-label{font-weight:550}.atg-field input,.atg-field select,.atg-field textarea{width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;outline:none}.atg-field textarea{min-height:76px;resize:vertical;line-height:19px}.atg-field input:focus,.atg-field select:focus,.atg-field textarea:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent)}.atg-field input::placeholder,.atg-field textarea::placeholder{color:var(--dsw-alias-label-tertiary)}.atg-two{display:grid;grid-template-columns:1fr 1fr;gap:10px}.atg-member-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.atg-member-card{display:grid;grid-template-columns:auto 30px minmax(0,1fr);align-items:center;gap:8px;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;cursor:pointer}.atg-member-card:hover{background:var(--dsw-alias-interactive-bg-hover)}.atg-member-card.is-selected{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent)}.atg-member-card input{accent-color:var(--dsw-alias-brand-primary)}.atg-member-card>span:last-child{min-width:0;display:grid;gap:2px}.atg-member-card strong,.atg-member-card small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.atg-member-card strong{font-size:12px}.atg-member-card small{color:var(--dsw-alias-label-tertiary);font-size:10px}.atg-avatar{display:grid;place-items:center;width:30px;height:30px;border-radius:9px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:10px;font-weight:700}.atg-order-toggle{display:flex;align-items:flex-start;gap:9px;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;cursor:pointer}.atg-order-toggle input{margin-top:3px;accent-color:var(--dsw-alias-brand-primary)}.atg-order-toggle span{display:grid;gap:2px}.atg-order-toggle strong{font-size:12px}.atg-order-toggle small{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.atg-order-list{display:grid;gap:5px;margin:0;padding:0;list-style:none}.atg-order-list li{display:grid;grid-template-columns:25px minmax(0,1fr) auto;align-items:center;gap:8px;padding:7px 8px;border-radius:9px;background:var(--dsw-alias-bg-module-platform)}.atg-order-list li>span:nth-child(2){min-width:0;display:grid}.atg-order-list strong{font-size:12px}.atg-order-list small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:10px}.atg-order-number{display:grid;place-items:center;width:23px;height:23px;border-radius:7px;background:var(--dsw-alias-bg-layer-1);font-size:10px;font-weight:700}.atg-order-actions{display:flex;gap:3px}.atg-actions{justify-content:flex-end;padding-top:3px}.atg-button,.atg-icon{border:1px solid transparent;color:inherit;font:inherit;cursor:pointer}.atg-button{min-height:32px;border-radius:9px;padding:6px 11px;font-size:12px;font-weight:550}.atg-button.ghost{border-color:var(--dsw-alias-border-l2);background:transparent}.atg-button.ghost:hover,.atg-icon:hover{background:var(--dsw-alias-interactive-bg-hover)}.atg-button.primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}.atg-button.primary:hover{background:var(--dsw-alias-button-primary-hover)}.atg-button:disabled,.atg-icon:disabled{opacity:.45;cursor:not-allowed}.atg-icon{display:grid;place-items:center;width:27px;height:27px;border-radius:8px;background:transparent}.atg-icon.danger{color:var(--dsw-alias-state-error-primary)}.atg-details{border-top:1px solid var(--dsw-alias-border-l2);padding-top:10px}.atg-details summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px}.atg-details[open] summary{margin-bottom:10px}.atg-empty{grid-column:1/-1;display:grid;place-items:center;align-content:center;gap:8px;min-height:100px;padding:16px;color:var(--dsw-alias-label-tertiary);text-align:center;font-size:11px}.atg-composer{display:flex;align-items:center;gap:5px;max-width:210px;height:28px;padding:0 6px 0 10px;border:0;border-radius:24px;background:transparent;pointer-events:auto}.atg-composer:hover{background:var(--dsw-alias-interactive-bg-hover)}.atg-mode-dot{flex:none;width:6px;height:6px;border-radius:99px;background:var(--dsw-alias-label-dimmed)}.atg-mode-dot.is-on{background:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,transparent)}.atg-composer-select{min-width:0;max-width:125px;flex:1;padding:0 20px 0 0;border:0;border-radius:8px;background-color:transparent;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 4px center;background-size:12px 12px;color:var(--dsw-alias-label-secondary);font:500 13px/20px var(--dsw-font-family);outline:none;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;appearance:none}.atg-composer-select:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}.atg-switch{position:relative;flex:none;width:28px;height:16px;padding:0;border:0;border-radius:99px;background:var(--dsw-alias-border-l3);cursor:pointer;transition:background .15s}.atg-switch:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}.atg-switch span{position:absolute;left:2px;top:2px;width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-bg-layer-1);transition:transform .15s}.atg-switch.is-on{background:var(--dsw-alias-state-business-primary)}.atg-switch.is-on span{transform:translateX(12px)}.atg-switch:disabled{opacity:.45;cursor:not-allowed}.atg-composer-error{display:grid;place-items:center;flex:none;width:14px;height:14px;border-radius:50%;color:var(--dsw-alias-state-error-primary);font-size:10px;font-weight:800}@media(max-width:720px){.atg-page-header{display:grid}.atg-workspace{grid-template-columns:1fr}.atg-list{min-height:0;max-height:190px;overflow:auto}.atg-member-grid,.atg-two{grid-template-columns:1fr}.atg-toolbar{flex-wrap:wrap}}
.atg-composer-error{padding:0;border:0;background:transparent;font:800 10px/1 var(--dsw-font-family);cursor:help}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.atg-import-mode select{height:32px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:0 8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit}.atg-starter{display:grid;gap:13px;padding:16px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 26%,var(--dsw-alias-border-l2));border-radius:15px;background:linear-gradient(145deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,var(--dsw-alias-bg-layer-1)),var(--dsw-alias-bg-layer-1))}.atg-starter>div:first-child{display:flex;align-items:flex-start;gap:10px}.atg-starter h3,.atg-starter p{margin:0}.atg-starter p{margin-top:3px;color:var(--dsw-alias-label-tertiary);font-size:11px}.atg-template-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.atg-template{display:grid;grid-template-columns:32px 1fr;gap:1px 9px;align-items:center;padding:11px;border:1px solid var(--dsw-alias-border-l2);border-radius:11px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 82%,transparent);color:inherit;text-align:left;cursor:pointer}.atg-template:hover{border-color:var(--dsw-alias-brand-primary);transform:translateY(-1px)}.atg-template>span{grid-row:1/3;display:grid;place-items:center;width:32px;height:32px;border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-brand-primary);font-weight:700}.atg-template strong{font-size:12px}.atg-template small{overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:10px;white-space:nowrap;text-overflow:ellipsis}.atg-three{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.atg-help{margin:0 0 8px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.atg-version-list{display:grid;gap:5px}.atg-version-list>div{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 8px;border-radius:8px;background:var(--dsw-alias-bg-module-platform);font-size:11px}.atg-diagnostic{margin:0;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font:11px/18px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap}.atg-tool-grid{display:grid;gap:5px;max-height:260px;overflow:auto}.atg-tool-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:6px;padding:7px;border-radius:9px;background:var(--dsw-alias-bg-module-platform)}.atg-tool-row>span{min-width:0;display:grid}.atg-tool-row strong,.atg-tool-row small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.atg-tool-row strong{font-size:11px}.atg-tool-row small{color:var(--dsw-alias-label-tertiary);font-size:9px}.atg-tool-state{border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:4px 7px;background:transparent;color:var(--dsw-alias-label-tertiary);font:10px var(--dsw-font-family);cursor:pointer}.atg-tool-state.allow{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 9%,transparent)}.atg-tool-state.deny{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent)}
.atg-success{padding:9px 11px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-success-primary) 35%,transparent);border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent);color:var(--dsw-alias-state-success-primary);font-size:11px}
/* 对话入口 pill 与 host 工具行触发器（ModelSelect / PermissionSelect）同一套 token 与状态：无边框 pill、hover 用 interactive-bg-hover、键盘焦点用 border-l3 环；is-on 仅以 business 主色淡染标示，不再套彩色外框。 */ .atg-composer{max-width:330px;transition:background .15s}.atg-composer.is-on{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,transparent)}.atg-composer.is-on:hover{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent)}.atg-mode-label{flex:none;padding:1px 5px;border-radius:5px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-tertiary);font:650 9px/16px var(--dsw-font-family);text-transform:uppercase}.atg-composer.is-on .atg-mode-label{color:var(--dsw-alias-state-business-primary)}.atg-project-pin{flex:none;width:19px;height:19px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-dimmed);font-size:12px;cursor:pointer}.atg-project-pin:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}.atg-project-pin.is-on{color:#e6a400;text-shadow:0 0 8px color-mix(in srgb,#e6a400 45%,transparent)}
.atg-run-center{height:100%;display:grid;grid-template-rows:auto auto minmax(0,1fr);gap:12px;padding:18px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);overflow:hidden}.atg-run-header{display:flex;justify-content:space-between;align-items:flex-start;gap:14px}.atg-run-header h2{margin:0;font-size:19px}.atg-run-header p{margin:3px 0 0;color:var(--dsw-alias-label-tertiary);font-size:11px}.atg-run-list{display:grid;align-content:start;gap:8px;overflow:auto;padding:1px}.atg-run-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}.atg-run-card.status-running,.atg-run-card.status-planning{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,var(--dsw-alias-border-l2))}.atg-run-summary{width:100%;display:grid;grid-template-columns:auto minmax(0,1fr) 60px 62px 50px auto;align-items:center;gap:10px;padding:11px 13px;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer}.atg-run-summary:hover{background:var(--dsw-alias-interactive-bg-hover)}.atg-run-title{min-width:0;display:grid;gap:2px}.atg-run-title strong,.atg-run-title small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.atg-run-title strong{font-size:12px}.atg-run-title small{color:var(--dsw-alias-label-tertiary);font-size:10px}.atg-run-metric{display:grid;text-align:right}.atg-run-metric strong{font-size:12px}.atg-run-metric small,.atg-run-time{color:var(--dsw-alias-label-tertiary);font-size:9px}.atg-run-detail{display:grid;gap:11px;padding:12px;border-top:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-module-platform) 55%,transparent)}.atg-run-meta{display:flex;flex-wrap:wrap;gap:5px}.atg-run-meta span{padding:3px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary);font-size:9px}.atg-plan{padding:9px 10px;border-left:2px solid var(--dsw-alias-brand-primary);border-radius:0 8px 8px 0;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,transparent)}.atg-plan.has-warning{border-left-color:#e6a400}.atg-plan strong{font-size:11px}.atg-plan p{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px}.atg-plan small{display:block;margin-top:5px;color:#b87800;font-size:9px}.atg-token-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}.atg-token-grid>div{display:grid;gap:1px;padding:8px;border-radius:8px;background:var(--dsw-alias-bg-layer-1)}.atg-token-grid strong{font-size:13px}.atg-token-grid small{color:var(--dsw-alias-label-tertiary);font-size:9px}.atg-run-members{display:grid;gap:5px}.atg-run-member{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}.atg-run-member summary{display:grid;grid-template-columns:auto minmax(0,1fr) 62px 52px 20px;align-items:center;gap:8px;padding:8px;cursor:pointer;list-style:none}.atg-run-member summary::-webkit-details-marker{display:none}.atg-run-member summary>span:nth-child(2){min-width:0;display:grid}.atg-run-member summary strong,.atg-run-member summary small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.atg-run-member summary strong{font-size:11px}.atg-run-member summary small,.atg-run-member summary>span:nth-child(n+3){color:var(--dsw-alias-label-tertiary);font-size:9px;text-align:right}.atg-member-output{display:grid;gap:7px;padding:0 9px 9px}.atg-member-output pre{max-height:230px;overflow:auto;margin:0;padding:9px;border-radius:7px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font:10px/16px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap}.atg-member-output>small{color:var(--dsw-alias-label-tertiary);font-size:9px}.atg-status-dot{display:block;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-dimmed)}.atg-status-dot.status-running,.atg-status-dot.status-planning{background:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent)}.atg-status-dot.status-completed{background:var(--dsw-alias-state-success-primary)}.atg-status-dot.status-failed,.atg-status-dot.status-cancelled{background:var(--dsw-alias-state-error-primary)}.atg-button.danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);background:transparent;color:var(--dsw-alias-state-error-primary)}.atg-run-dock{display:flex;align-items:center;gap:7px;padding:6px 9px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,var(--dsw-alias-border-l2));border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-secondary);font:10px/16px var(--dsw-font-family)}.atg-run-dock strong{color:var(--dsw-alias-label-primary)}.atg-run-dock span:last-child{margin-left:auto}.atg-live-pulse{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-brand-primary);animation:atg-pulse 1.4s infinite}@keyframes atg-pulse{50%{opacity:.35;transform:scale(.78)}}
@media(max-width:720px){.atg-template-grid,.atg-three,.atg-token-grid{grid-template-columns:1fr}.atg-run-center{padding:10px}.atg-run-summary{grid-template-columns:auto minmax(0,1fr) 48px auto}.atg-run-summary .atg-run-metric:first-of-type,.atg-run-time{display:none}.atg-run-member summary{grid-template-columns:auto minmax(0,1fr) 50px}.atg-run-member summary>span:nth-child(4),.atg-run-member summary>span:nth-child(5){display:none}.atg-import-mode{display:none}}
`
