/** agent 与 squad 的可视化 CRUD，以及当前会话的直接派单面板。 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react'

interface AgentView {
  id: string
  name: string
  systemPrompt: string
  provider: string
  model: string
  maxTokens?: number
  toolScope?: { allow?: string[]; deny?: string[] }
}

interface SquadView {
  id: string
  name: string
  members: string[]
  collabNote: string
}

interface ModelGroup {
  provider: string
  name: string
  models: Array<{ id: string; name: string }>
}

interface DashboardSnapshot {
  agents: AgentView[]
  squads: SquadView[]
  models: ModelGroup[]
}

interface MemberResult {
  agentId: string
  agentName: string
  status: 'completed' | 'failed'
  runId?: string
  childId?: string
  stopReason?: string
  output?: unknown
  error?: string
}

interface DispatchResult {
  squadId: string
  status: 'completed' | 'partial' | 'failed'
  members: MemberResult[]
}

interface OpenState {
  open: boolean
  task: string
  sessionId?: string
  clearDraft?: () => void
}

/** 两个 slot 共用的轻量状态，不进入持久化；持久数据始终在 host service。 */
export class DashboardController {
  private state: OpenState = { open: false, task: '' }
  private readonly listeners = new Set<() => void>()

  readonly getSnapshot = (): OpenState => this.state
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  open(task = '', sessionId?: string, clearDraft?: () => void): void {
    this.state = { open: true, task, ...(sessionId === undefined ? {} : { sessionId }), ...(clearDraft === undefined ? {} : { clearDraft }) }
    this.publish()
  }

  close(): void {
    this.state = { ...this.state, open: false }
    this.publish()
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }
}

interface DispatchButtonProps {
  controller: DashboardController
  sessionId: string
  input: { draft: string }
  inputActions: { setDraft(text: string): void }
}

/** 对话输入框右侧的小队派单入口；打开面板时携带当前草稿和会话。 */
export function DispatchButton({ controller, sessionId, input, inputActions }: DispatchButtonProps): ReactNode {
  const zh = localeIsZh()
  return (
    <button
      type="button"
      title={zh ? '派给小队' : 'Dispatch to squad'}
      aria-label={zh ? '派给小队' : 'Dispatch to squad'}
      style={styles.compactButton}
      onClick={() => { controller.open(input.draft, sessionId, () => { inputActions.setDraft('') }) }}
    >
      {zh ? '小队' : 'Squad'}
    </button>
  )
}

interface DashboardProps {
  controller: DashboardController
  call<T>(endpoint: string, payload: unknown): Promise<T>
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
}

interface SquadDraft {
  id: string
  name: string
  collabNote: string
  members: string[]
}

const EMPTY_AGENT: AgentDraft = {
  id: '', name: '', systemPrompt: '', provider: '', model: '', maxTokens: '', allow: '', deny: '',
}
const EMPTY_SQUAD: SquadDraft = { id: '', name: '', collabNote: '', members: [] }

/** 管理 agent/squad，并在当前会话中直接启动小队编排。 */
export function AgentTeamDashboard({ controller, call }: DashboardProps): ReactNode {
  const panel = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const sessionId = panel.sessionId
  const zh = localeIsZh()
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>({ agents: [], squads: [], models: [] })
  const [agent, setAgent] = useState<AgentDraft>(EMPTY_AGENT)
  const [squad, setSquad] = useState<SquadDraft>(EMPTY_SQUAD)
  const [selectedSquad, setSelectedSquad] = useState('')
  const [task, setTask] = useState('')
  const [executionMode, setExecutionMode] = useState<'serial' | 'parallel'>('parallel')
  const [contextMode, setContextMode] = useState<'spawn' | 'fork' | 'chain'>('spawn')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [dispatchResult, setDispatchResult] = useState<DispatchResult | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const refresh = async (): Promise<void> => {
    const next = await call<DashboardSnapshot>('snapshot', {})
    setSnapshot(next)
    setSelectedSquad(current => current || next.squads[0]?.id || '')
    setAgent((current) => {
      const firstProvider = next.models[0]
      return current.provider || firstProvider === undefined
        ? current
        : { ...current, provider: firstProvider.provider, model: firstProvider.models[0]?.id ?? '' }
    })
  }

  useEffect(() => {
    if (!panel.open) return
    setTask(panel.task)
    setError('')
    void refresh().catch(reason => { setError(errorText(reason)) })
  }, [panel.open, panel.task])

  const activeModels = useMemo(
    () => snapshot.models.find(group => group.provider === agent.provider)?.models ?? [],
    [agent.provider, snapshot.models],
  )

  if (!panel.open) return null

  const mutate = async (endpoint: string, payload: unknown): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await call(endpoint, payload)
      await refresh()
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(false)
    }
  }

  const exportData = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const doc = await call<unknown>('export', {})
      const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `agent-team-gui-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(false)
    }
  }

  const importFile = async (file: File): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const doc: unknown = JSON.parse(await file.text())
      await call<unknown>('import', { doc, mode: 'merge' })
      await refresh()
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(false)
    }
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
    }
    await mutate(agent.id ? 'agent/update' : 'agent/create', agent.id ? { id: agent.id, record } : { record })
    setAgent(EMPTY_AGENT)
  }

  const saveSquad = async (): Promise<void> => {
    const record = { name: squad.name.trim(), collabNote: squad.collabNote.trim(), members: squad.members }
    await mutate(squad.id ? 'squad/update' : 'squad/create', squad.id ? { id: squad.id, record } : { record })
    setSquad(EMPTY_SQUAD)
  }

  const dispatch = async (): Promise<void> => {
    if (sessionId === undefined) {
      setError(zh ? '请先打开一个会话。' : 'Open a session first.')
      return
    }
    setBusy(true)
    setError('')
    setDispatchResult(null)
    try {
      const result = await call<DispatchResult>('dispatch', {
        sessionId,
        squadId: selectedSquad,
        task,
        executionMode,
        contextMode,
      })
      setDispatchResult(result)
      panel.clearDraft?.()
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={styles.backdrop} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) controller.close()
    }}>
      <section style={styles.panel} role="dialog" aria-modal="true" aria-label={zh ? 'Agent 小队' : 'Agent Teams'}>
        <header style={styles.header}>
          <div>
            <strong style={styles.title}>{zh ? 'Agent 小队' : 'Agent Teams'}</strong>
            <span style={styles.subtitle}>{zh ? '模型路由来自 dsh Settings，不保存 API key' : 'Model routes come from dsh Settings; API keys are never stored'}</span>
          </div>
          <div style={styles.headerActions}>
            <button type="button" style={styles.secondary} disabled={busy} onClick={() => { void exportData() }}>{zh ? '导出' : 'Export'}</button>
            <button type="button" style={styles.secondary} disabled={busy} onClick={() => { fileInputRef.current?.click() }}>{zh ? '导入' : 'Import'}</button>
            <button type="button" style={styles.close} onClick={() => { controller.close() }}>×</button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={event => {
              const file = event.currentTarget.files?.[0]
              if (file !== undefined) void importFile(file)
              event.currentTarget.value = ''
            }}
          />
        </header>

        {error ? <p role="alert" style={styles.error}>{error}</p> : null}

        <div style={styles.grid}>
          <section style={styles.card}>
            <h3 style={styles.cardTitle}>{zh ? 'Agents' : 'Agents'}</h3>
            <div style={styles.list}>
              {snapshot.agents.map(item => (
                <div key={item.id} style={styles.listRow}>
                  <button type="button" style={styles.rowMain} onClick={() => {
                    setAgent({
                      id: item.id, name: item.name, systemPrompt: item.systemPrompt,
                      provider: item.provider, model: item.model, maxTokens: item.maxTokens?.toString() ?? '',
                      allow: item.toolScope?.allow?.join(', ') ?? '', deny: item.toolScope?.deny?.join(', ') ?? '',
                    })
                  }}>
                    <strong>{item.name}</strong><small>{item.provider} / {item.model}</small>
                  </button>
                  <button type="button" style={styles.danger} disabled={busy} onClick={() => { void mutate('agent/delete', { id: item.id }) }}>×</button>
                </div>
              ))}
              {snapshot.agents.length === 0 ? <small style={styles.muted}>{zh ? '还没有 agent' : 'No agents yet'}</small> : null}
            </div>
            <Field label={zh ? '名称' : 'Name'} value={agent.name} onChange={value => { setAgent({ ...agent, name: value }) }} />
            <label style={styles.field}><span>{zh ? '角色描述 / System prompt' : 'Role / system prompt'}</span><textarea style={styles.textarea} value={agent.systemPrompt} onChange={event => { setAgent({ ...agent, systemPrompt: event.currentTarget.value }) }} /></label>
            <label style={styles.field}><span>{zh ? 'Provider 路由' : 'Provider route'}</span><select style={styles.input} value={agent.provider} onChange={event => {
              const provider = event.currentTarget.value
              const models = snapshot.models.find(group => group.provider === provider)?.models ?? []
              setAgent({ ...agent, provider, model: models[0]?.id ?? '' })
            }}><option value="">—</option>{snapshot.models.map(group => <option key={group.provider} value={group.provider}>{group.name} ({group.provider})</option>)}</select></label>
            <label style={styles.field}><span>{zh ? '模型' : 'Model'}</span><select style={styles.input} value={agent.model} onChange={event => { setAgent({ ...agent, model: event.currentTarget.value }) }}><option value="">—</option>{activeModels.map(model => <option key={model.id} value={model.id}>{model.name} ({model.id})</option>)}</select></label>
            <Field label="Max tokens" value={agent.maxTokens} onChange={value => { setAgent({ ...agent, maxTokens: value }) }} />
            <Field label={zh ? '允许工具（逗号分隔）' : 'Allowed tools (CSV)'} value={agent.allow} onChange={value => { setAgent({ ...agent, allow: value }) }} />
            <Field label={zh ? '禁用工具（逗号分隔）' : 'Denied tools (CSV)'} value={agent.deny} onChange={value => { setAgent({ ...agent, deny: value }) }} />
            <div style={styles.actions}><button type="button" style={styles.secondary} onClick={() => { setAgent(EMPTY_AGENT) }}>{zh ? '清空' : 'Clear'}</button><button type="button" style={styles.primary} disabled={busy || !agent.name || !agent.provider || !agent.model} onClick={() => { void saveAgent() }}>{agent.id ? (zh ? '保存' : 'Save') : (zh ? '创建' : 'Create')}</button></div>
          </section>

          <section style={styles.card}>
            <h3 style={styles.cardTitle}>{zh ? '小队' : 'Squads'}</h3>
            <div style={styles.list}>
              {snapshot.squads.map(item => (
                <div key={item.id} style={styles.listRow}>
                  <button type="button" style={styles.rowMain} onClick={() => { setSquad({ id: item.id, name: item.name, collabNote: item.collabNote, members: [...item.members] }) }}><strong>{item.name}</strong><small>{item.members.length} {zh ? '名成员' : 'members'}</small></button>
                  <button type="button" style={styles.danger} disabled={busy} onClick={() => { void mutate('squad/delete', { id: item.id }) }}>×</button>
                </div>
              ))}
              {snapshot.squads.length === 0 ? <small style={styles.muted}>{zh ? '还没有小队' : 'No squads yet'}</small> : null}
            </div>
            <Field label={zh ? '名称' : 'Name'} value={squad.name} onChange={value => { setSquad({ ...squad, name: value }) }} />
            <label style={styles.field}><span>{zh ? '协作说明' : 'Collaboration note'}</span><textarea style={styles.textarea} value={squad.collabNote} onChange={event => { setSquad({ ...squad, collabNote: event.currentTarget.value }) }} /></label>
            <fieldset style={styles.memberFieldset}><legend>{zh ? '成员（agent 可加入多个小队）' : 'Members (agents may join multiple squads)'}</legend>{snapshot.agents.map(item => <label key={item.id} style={styles.check}><input type="checkbox" checked={squad.members.includes(item.id)} onChange={event => { setSquad({ ...squad, members: event.currentTarget.checked ? [...squad.members, item.id] : squad.members.filter(id => id !== item.id) }) }} /> {item.name}</label>)}</fieldset>
            <div style={styles.actions}><button type="button" style={styles.secondary} onClick={() => { setSquad(EMPTY_SQUAD) }}>{zh ? '清空' : 'Clear'}</button><button type="button" style={styles.primary} disabled={busy || !squad.name || squad.members.length === 0} onClick={() => { void saveSquad() }}>{squad.id ? (zh ? '保存' : 'Save') : (zh ? '创建' : 'Create')}</button></div>
          </section>
        </div>

        <section style={{ ...styles.card, ...styles.dispatchCard }}>
          <h3 style={styles.cardTitle}>{zh ? '派发当前任务' : 'Dispatch current task'}</h3>
          <div style={styles.dispatchControls}>
            <label style={styles.field}><span>{zh ? '小队' : 'Squad'}</span><select style={styles.input} value={selectedSquad} onChange={event => { setSelectedSquad(event.currentTarget.value) }}>{snapshot.squads.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label style={styles.field}><span>{zh ? '执行' : 'Execution'}</span><select style={styles.input} value={executionMode} onChange={event => { setExecutionMode(event.currentTarget.value as 'serial' | 'parallel') }}><option value="parallel">parallel</option><option value="serial">serial</option></select></label>
            <label style={styles.field}><span>{zh ? '上下文' : 'Context'}</span><select style={styles.input} value={contextMode} onChange={event => { setContextMode(event.currentTarget.value as 'spawn' | 'fork' | 'chain') }}><option value="spawn">spawn</option><option value="fork">fork</option><option value="chain">chain</option></select></label>
          </div>
          <label style={styles.field}><span>{zh ? '任务' : 'Task'}</span><textarea style={{ ...styles.textarea, minHeight: 86 }} value={task} onChange={event => { setTask(event.currentTarget.value) }} /></label>
          <div style={styles.actions}><small style={styles.muted}>{sessionId ? `${zh ? '会话' : 'Session'}: ${sessionId}` : (zh ? '未打开会话' : 'No open session')}</small><button type="button" style={styles.primary} disabled={busy || !selectedSquad || !task.trim() || !sessionId || (executionMode === 'parallel' && contextMode === 'chain')} onClick={() => { void dispatch() }}>{busy ? '…' : (zh ? '派单' : 'Dispatch')}</button></div>
          {executionMode === 'parallel' && contextMode === 'chain' ? <small style={styles.error}>{zh ? 'chain 只支持串行执行。' : 'chain context requires serial execution.'}</small> : null}
          {dispatchResult ? <div style={styles.result}><strong>{dispatchResult.status}</strong>{dispatchResult.members.map(member => <div key={member.agentId} style={styles.resultRow}><span>{member.status === 'completed' ? '✓' : '⚠'} {member.agentName}</span><small>{member.error ?? member.stopReason ?? member.runId ?? ''}</small></div>)}</div> : null}
        </section>
      </section>
    </div>
  )
}

function Field({ label, value, onChange }: { label: string; value: string; onChange(value: string): void }): ReactNode {
  return <label style={styles.field}><span>{label}</span><input style={styles.input} value={value} onChange={event => { onChange(event.currentTarget.value) }} /></label>
}

function localeIsZh(): boolean {
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh')
}

function csv(value: string): string[] {
  return [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))]
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

const styles = {
  backdrop: { position: 'fixed', inset: 0, zIndex: 80, display: 'grid', placeItems: 'center', padding: 20, background: 'rgba(8, 12, 20, .58)', pointerEvents: 'auto' },
  panel: { width: 'min(1080px, 96vw)', maxHeight: '92vh', overflow: 'auto', border: '1px solid color-mix(in srgb, currentColor 16%, transparent)', borderRadius: 18, padding: 18, color: 'var(--text-primary, #e9eef8)', background: 'var(--background-primary, #111722)', boxShadow: '0 24px 90px rgba(0,0,0,.45)' },
  header: { display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', marginBottom: 14 },
  headerActions: { display: 'flex', gap: 8, alignItems: 'center' },
  title: { display: 'block', fontSize: 22 },
  subtitle: { display: 'block', marginTop: 4, color: 'var(--text-secondary, #9aa8bd)', fontSize: 12 },
  close: { border: 0, background: 'transparent', color: 'inherit', fontSize: 26, cursor: 'pointer' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(310px, 1fr))', gap: 14 },
  card: { minWidth: 0, padding: 14, border: '1px solid color-mix(in srgb, currentColor 14%, transparent)', borderRadius: 14, background: 'color-mix(in srgb, var(--background-primary, #111722) 92%, white 8%)' },
  cardTitle: { margin: '0 0 12px', fontSize: 15 },
  list: { display: 'grid', gap: 6, maxHeight: 150, overflow: 'auto', marginBottom: 12 },
  listRow: { display: 'flex', gap: 6, alignItems: 'stretch' },
  rowMain: { flex: 1, minWidth: 0, display: 'grid', gap: 2, padding: '8px 10px', textAlign: 'left', border: 0, borderRadius: 9, color: 'inherit', background: 'rgba(127,145,180,.1)', cursor: 'pointer' },
  field: { display: 'grid', gap: 5, marginTop: 10, color: 'var(--text-secondary, #a9b5c7)', fontSize: 12 },
  input: { width: '100%', boxSizing: 'border-box', border: '1px solid rgba(145,160,190,.28)', borderRadius: 8, padding: '8px 9px', color: 'inherit', background: 'rgba(4,8,14,.28)', outline: 'none' },
  textarea: { width: '100%', minHeight: 64, resize: 'vertical', boxSizing: 'border-box', border: '1px solid rgba(145,160,190,.28)', borderRadius: 8, padding: '8px 9px', color: 'inherit', background: 'rgba(4,8,14,.28)', outline: 'none', font: 'inherit' },
  memberFieldset: { marginTop: 10, border: '1px solid rgba(145,160,190,.2)', borderRadius: 8, display: 'flex', flexWrap: 'wrap', gap: 10, color: 'var(--text-secondary, #a9b5c7)', fontSize: 12 },
  check: { whiteSpace: 'nowrap' },
  actions: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 12 },
  primary: { border: 0, borderRadius: 8, padding: '8px 14px', color: '#fff', background: '#4361ee', cursor: 'pointer' },
  secondary: { border: '1px solid rgba(145,160,190,.28)', borderRadius: 8, padding: '7px 12px', color: 'inherit', background: 'transparent', cursor: 'pointer' },
  danger: { width: 34, border: 0, borderRadius: 8, color: '#ff8894', background: 'rgba(255,90,105,.08)', cursor: 'pointer' },
  compactButton: { pointerEvents: 'auto', border: '1px solid rgba(110,130,170,.3)', borderRadius: 7, padding: '3px 8px', color: 'inherit', background: 'transparent', cursor: 'pointer', fontSize: 12 },
  dispatchCard: { marginTop: 14 },
  dispatchControls: { display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10 },
  muted: { color: 'var(--text-secondary, #8492a8)', overflow: 'hidden', textOverflow: 'ellipsis' },
  error: { margin: '8px 0', color: '#ff8894', fontSize: 12 },
  result: { display: 'grid', gap: 7, marginTop: 12, padding: 10, borderRadius: 9, background: 'rgba(70,100,160,.1)' },
  resultRow: { display: 'flex', justifyContent: 'space-between', gap: 12 },
} satisfies Record<string, CSSProperties>
