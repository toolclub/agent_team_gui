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
}

export interface SquadView {
  id: string
  name: string
  members: string[]
  collabNote: string
  executionOrder?: string[]
  executionMode?: 'serial' | 'parallel'
  contextMode?: 'spawn' | 'fork' | 'chain'
}

interface ModelGroup {
  provider: string
  name: string
  models: Array<{ id: string; name: string }>
}

export interface TeamSnapshot {
  agents: AgentView[]
  squads: SquadView[]
  models: ModelGroup[]
}

interface ControllerSnapshot {
  status: 'idle' | 'loading' | 'ready' | 'error'
  data: TeamSnapshot
  error: string
}

export type AgentTeamRpc = <T>(endpoint: string, payload: unknown) => Promise<T>

const EMPTY_DATA: TeamSnapshot = { agents: [], squads: [], models: [] }

/** 两个 slot 共享的只读目录缓存；持久数据始终由 host service 持有。 */
export class AgentTeamController {
  private state: ControllerSnapshot = { status: 'idle', data: EMPTY_DATA, error: '' }
  private readonly listeners = new Set<() => void>()
  private pending: Promise<TeamSnapshot> | undefined

  constructor(readonly call: AgentTeamRpc) {}

  readonly getSnapshot = (): ControllerSnapshot => this.state
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  load(force = false): Promise<TeamSnapshot> {
    if (!force && this.state.status === 'ready') return Promise.resolve(this.state.data)
    if (this.pending !== undefined) return this.pending
    this.set({ ...this.state, status: 'loading', error: '' })
    const pending = this.call<TeamSnapshot>('snapshot', {}).then((data) => {
      this.set({ status: 'ready', data, error: '' })
      return data
    }, (reason: unknown) => {
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

interface ModeValue {
  sessionId: string
  squadId: string
  squadName: string
}

interface ModeResponse {
  mode: ModeValue | null
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
  const requestRef = useRef(0)

  useEffect(() => {
    void controller.load().catch(() => undefined)
  }, [controller])

  useEffect(() => {
    const request = ++requestRef.current
    setBusy(true)
    setError('')
    controller.call<ModeResponse>('mode/get', { sessionId }).then(({ mode }) => {
      if (request !== requestRef.current) return
      setEnabled(mode !== null)
      setSelected(mode?.squadId ?? '')
    }, (reason: unknown) => {
      if (request !== requestRef.current) return
      setError(errorText(reason))
    }).finally(() => {
      if (request === requestRef.current) setBusy(false)
    })
    return () => { requestRef.current += 1 }
  }, [controller, sessionId])

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

  const locked = busy || input.phase === 'adjudicating' || input.phase === 'submitting'
  const hasSquads = catalog.data.squads.length > 0
  return (
    <div className="atg-composer" title={error || (zh ? '开启后，普通消息会由主模型自动交给所选小队' : 'When enabled, normal prompts are orchestrated by the selected squad')}>
      <span className={`atg-mode-dot${enabled ? ' is-on' : ''}`} aria-hidden="true" />
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
      {error ? <span className="atg-composer-error" aria-label={error}>!</span> : null}
    </div>
  )
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
}

const EMPTY_AGENT: AgentDraft = {
  id: '', name: '', systemPrompt: '', provider: '', model: '', maxTokens: '', allow: '', deny: '',
}
const EMPTY_SQUAD: SquadDraft = {
  id: '', name: '', collabNote: '', members: [], fixedOrder: false, executionOrder: [],
}

/** Settings 的“小队”页面：小队与成员模型在同一处完成 CRUD。 */
export function TeamSettingsPage({ controller }: SettingsProps): ReactNode {
  const zh = localeIsZh()
  const catalog = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const [squad, setSquad] = useState<SquadDraft>(EMPTY_SQUAD)
  const [agent, setAgent] = useState<AgentDraft>(EMPTY_AGENT)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void controller.load().catch(() => undefined)
  }, [controller])

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
      anchor.click()
      URL.revokeObjectURL(url)
    })
  }

  const importData = async (file: File): Promise<void> => {
    await run(async () => {
      const doc: unknown = JSON.parse(await file.text())
      await controller.call('import', { doc, mode: 'merge' })
      await controller.load(true)
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
    })
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
      {catalog.status === 'loading' ? <div className="atg-loading">{zh ? '正在读取小队…' : 'Loading teams…'}</div> : null}

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
              <span><strong>{zh ? '固定执行顺序' : 'Fixed execution order'}</strong><small>{zh ? '关闭时，由主模型根据任务自动拆解和编排。' : 'When off, the lead model plans the work automatically.'}</small></span>
            </label>
            {squad.fixedOrder ? (
              <ol className="atg-order-list">
                {orderedMembers.map((id, index) => {
                  const member = catalog.data.agents.find(item => item.id === id)
                  return <li key={id}><span className="atg-order-number">{index + 1}</span><span><strong>{member?.name ?? id}</strong><small>{member === undefined ? '' : `${member.provider} / ${member.model}`}</small></span><span className="atg-order-actions"><button type="button" className="atg-icon" disabled={index === 0} onClick={() => { moveMember(id, -1) }}>↑</button><button type="button" className="atg-icon" disabled={index === orderedMembers.length - 1} onClick={() => { moveMember(id, 1) }}>↓</button></span></li>
                })}
              </ol>
            ) : null}
            <div className="atg-actions"><button type="button" className="atg-button ghost" onClick={() => { setSquad(EMPTY_SQUAD) }}>{zh ? '取消' : 'Cancel'}</button><button type="button" className="atg-button primary" disabled={busy || squad.name.trim() === '' || squad.members.length === 0} onClick={() => { void saveSquad() }}>{busy ? '…' : (squad.id ? (zh ? '保存小队' : 'Save team') : (zh ? '创建小队' : 'Create team'))}</button></div>
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
            <details className="atg-details"><summary>{zh ? '高级：工具范围' : 'Advanced: tool scope'}</summary><div className="atg-two"><Field label={zh ? '允许工具（逗号分隔）' : 'Allow tools (CSV)'} value={agent.allow} onChange={value => { setAgent(current => ({ ...current, allow: value })) }} /><Field label={zh ? '禁用工具（逗号分隔）' : 'Deny tools (CSV)'} value={agent.deny} onChange={value => { setAgent(current => ({ ...current, deny: value })) }} /></div></details>
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

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/** 由入口一次性挂载，避免外部插件构建依赖 CSS Modules 转换器。 */
export const CLIENT_STYLES = `
.atg-page{display:grid;gap:20px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);padding:4px 0 30px}.atg-page *{box-sizing:border-box}.atg-page-header{display:flex;justify-content:space-between;align-items:flex-start;gap:18px}.atg-page h2{font-size:22px;line-height:30px;margin:0 0 4px}.atg-page-header p{max-width:580px;margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}.atg-toolbar,.atg-actions{display:flex;align-items:center;gap:8px}.atg-alert,.atg-note,.atg-loading{padding:10px 12px;border-radius:10px;font-size:12px;line-height:18px}.atg-alert{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger)}.atg-note,.atg-loading{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform)}.atg-section{display:grid;gap:12px}.atg-section-title{display:flex;align-items:center;justify-content:space-between;gap:12px}.atg-section-title>div{display:flex;align-items:center;gap:9px}.atg-section h3{font-size:15px;margin:0}.atg-kicker{display:grid;place-items:center;width:26px;height:26px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-tertiary);font-size:10px;font-weight:650}.atg-workspace{display:grid;grid-template-columns:minmax(180px,220px) minmax(0,1fr);gap:12px}.atg-list,.atg-editor{border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1)}.atg-list{display:flex;flex-direction:column;gap:5px;min-height:180px;padding:7px}.atg-list-card{display:flex;align-items:center;gap:5px;border-radius:9px}.atg-list-card:hover{background:var(--dsw-alias-interactive-bg-hover)}.atg-list-card.is-active{background:var(--dsw-specific-sidebar-nav-item-active)}.atg-list-main{min-width:0;flex:1;display:grid;gap:2px;padding:9px;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer}.atg-list-main strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.atg-list-main span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:11px}.atg-editor{display:grid;align-content:start;gap:12px;padding:16px}.atg-editor-head{display:flex;justify-content:space-between;align-items:baseline;gap:10px;padding-bottom:10px;border-bottom:1px solid var(--dsw-alias-border-l2)}.atg-editor-head strong{font-size:14px}.atg-editor-head span{color:var(--dsw-alias-label-tertiary);font-size:11px}.atg-field{display:grid;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px}.atg-field>span,.atg-field-label{font-weight:550}.atg-field input,.atg-field select,.atg-field textarea{width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;outline:none}.atg-field textarea{min-height:76px;resize:vertical;line-height:19px}.atg-field input:focus,.atg-field select:focus,.atg-field textarea:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent)}.atg-field input::placeholder,.atg-field textarea::placeholder{color:var(--dsw-alias-label-tertiary)}.atg-two{display:grid;grid-template-columns:1fr 1fr;gap:10px}.atg-member-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.atg-member-card{display:grid;grid-template-columns:auto 30px minmax(0,1fr);align-items:center;gap:8px;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;cursor:pointer}.atg-member-card:hover{background:var(--dsw-alias-interactive-bg-hover)}.atg-member-card.is-selected{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent)}.atg-member-card input{accent-color:var(--dsw-alias-brand-primary)}.atg-member-card>span:last-child{min-width:0;display:grid;gap:2px}.atg-member-card strong,.atg-member-card small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.atg-member-card strong{font-size:12px}.atg-member-card small{color:var(--dsw-alias-label-tertiary);font-size:10px}.atg-avatar{display:grid;place-items:center;width:30px;height:30px;border-radius:9px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:10px;font-weight:700}.atg-order-toggle{display:flex;align-items:flex-start;gap:9px;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;cursor:pointer}.atg-order-toggle input{margin-top:3px;accent-color:var(--dsw-alias-brand-primary)}.atg-order-toggle span{display:grid;gap:2px}.atg-order-toggle strong{font-size:12px}.atg-order-toggle small{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.atg-order-list{display:grid;gap:5px;margin:0;padding:0;list-style:none}.atg-order-list li{display:grid;grid-template-columns:25px minmax(0,1fr) auto;align-items:center;gap:8px;padding:7px 8px;border-radius:9px;background:var(--dsw-alias-bg-module-platform)}.atg-order-list li>span:nth-child(2){min-width:0;display:grid}.atg-order-list strong{font-size:12px}.atg-order-list small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:10px}.atg-order-number{display:grid;place-items:center;width:23px;height:23px;border-radius:7px;background:var(--dsw-alias-bg-layer-1);font-size:10px;font-weight:700}.atg-order-actions{display:flex;gap:3px}.atg-actions{justify-content:flex-end;padding-top:3px}.atg-button,.atg-icon{border:1px solid transparent;color:inherit;font:inherit;cursor:pointer}.atg-button{min-height:32px;border-radius:9px;padding:6px 11px;font-size:12px;font-weight:550}.atg-button.ghost{border-color:var(--dsw-alias-border-l2);background:transparent}.atg-button.ghost:hover,.atg-icon:hover{background:var(--dsw-alias-interactive-bg-hover)}.atg-button.primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}.atg-button.primary:hover{background:var(--dsw-alias-button-primary-hover)}.atg-button:disabled,.atg-icon:disabled{opacity:.45;cursor:not-allowed}.atg-icon{display:grid;place-items:center;width:27px;height:27px;border-radius:8px;background:transparent}.atg-icon.danger{color:var(--dsw-alias-state-error-primary)}.atg-details{border-top:1px solid var(--dsw-alias-border-l2);padding-top:10px}.atg-details summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px}.atg-details[open] summary{margin-bottom:10px}.atg-empty{grid-column:1/-1;display:grid;place-items:center;align-content:center;gap:8px;min-height:100px;padding:16px;color:var(--dsw-alias-label-tertiary);text-align:center;font-size:11px}.atg-composer{display:flex;align-items:center;gap:5px;max-width:210px;height:28px;padding:2px 5px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1);pointer-events:auto}.atg-mode-dot{flex:none;width:6px;height:6px;border-radius:99px;background:var(--dsw-alias-label-dimmed)}.atg-mode-dot.is-on{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary) 13%,transparent)}.atg-composer-select{min-width:0;max-width:125px;flex:1;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:500 11px/18px var(--dsw-font-family);outline:none;text-overflow:ellipsis}.atg-switch{position:relative;flex:none;width:28px;height:16px;padding:0;border:0;border-radius:99px;background:var(--dsw-alias-border-l3);cursor:pointer;transition:background .15s}.atg-switch span{position:absolute;left:2px;top:2px;width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-bg-layer-1);transition:transform .15s}.atg-switch.is-on{background:var(--dsw-alias-state-success-primary)}.atg-switch.is-on span{transform:translateX(12px)}.atg-switch:disabled{opacity:.45;cursor:not-allowed}.atg-composer-error{display:grid;place-items:center;flex:none;width:14px;height:14px;border-radius:50%;color:var(--dsw-alias-state-error-primary);font-size:10px;font-weight:800}@media(max-width:720px){.atg-page-header{display:grid}.atg-workspace{grid-template-columns:1fr}.atg-list{min-height:0;max-height:190px;overflow:auto}.atg-member-grid,.atg-two{grid-template-columns:1fr}.atg-toolbar{flex-wrap:wrap}}
`
