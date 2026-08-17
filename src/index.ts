import { randomUUID } from 'node:crypto'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import { agentRecordSchema, agentTeamDomainSpec, agentTeamExportSchema, squadRecordSchema } from './spec.ts'
import { createDispatchToSquadTool } from './tools/dispatch-to-squad.ts'
import { registerAgentTeamRpc } from './rpc.ts'
import {
  AgentId,
  DispatchId,
  SquadId,
  type AgentExportItem,
  type AgentRecord,
  type AgentTokenUsage,
  type AgentTeamExportDocument,
  type AgentTeamImportMode,
  type AgentTeamImportResult,
  type SquadAssignment,
  type SquadDispatchRequest,
  type SquadDispatchResult,
  type SquadExportItem,
  type SquadMemberResult,
  type SquadRecord,
  type SessionSquadModeRecord,
  type SessionSquadModeView,
  type ProjectSquadDefaultRecord,
  type SquadExecutionPlan,
  type SquadRunMember,
  type SquadRunRecord,
  type SquadVersionRecord,
} from './types.ts'

export * from './types.ts'
export { agentExportItemSchema, agentRecordSchema, agentTeamDomainSpec, agentTeamExportSchema, sessionSquadModeSchema, squadExportItemSchema, squadRecordSchema } from './spec.ts'
export { createDispatchToSquadTool } from './tools/dispatch-to-squad.ts'
export { AGENT_TEAM_RPC_CHANNEL, createAgentTeamRpcHandler } from './rpc.ts'

/** Loader configuration for squad execution defaults. */
export interface Config {
  readonly defaultProvider: string
  readonly defaultExecutionMode: 'serial' | 'parallel'
  readonly defaultContextMode: 'spawn' | 'fork' | 'chain'
}

/** Stable errors for UI/RPC callers and model-facing tool failures. */
export class AgentTeamError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'AGENT_EXISTS'
      | 'AGENT_NOT_FOUND'
      | 'SQUAD_EXISTS'
      | 'SQUAD_NOT_FOUND'
      | 'INVALID_MEMBERS'
      | 'INVALID_ASSIGNMENTS'
      | 'INVALID_DISPATCH'
      | 'INVALID_IMPORT',
  ) {
    super(message)
    this.name = 'AgentTeamError'
  }
}

interface ResolvedMember {
  readonly id: AgentId
  readonly record: AgentRecord
  readonly task: string
}

/** The subset of the official system-prompt service used by this plugin. */
interface SystemPromptService {
  section(section: {
    readonly name: string
    readonly order: number
    readonly text: string | ((context: { readonly agent?: Agent }) => string)
  }): () => void
}

interface SessionProjectionService {
  snapshot(session: Agent['session']): { readonly values: Record<string, unknown> }
  onChanged?(listener: (
    session: Agent['session'],
    key: string,
    value: unknown,
    seq: number,
  ) => void): () => void
}

interface TokenUsageProjection {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

const ZERO_USAGE: AgentTokenUsage = {
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  providerReported: false,
}

/** Durable registry and orchestrator exposed as `ctx.agentTeamGui`. */
export class AgentTeamService extends Service {
  static inject = ['storageDomain', 'tools', 'subagents', 'llm', 'agents', 'systemPrompt', 'sessionProjections']

  static Config: z<Config> = z.object({
    defaultProvider: z.string().default('spawn'),
    defaultExecutionMode: z.union(['serial', 'parallel'] as const).default('serial'),
    defaultContextMode: z.union(['spawn', 'fork', 'chain'] as const).default('spawn'),
  })

  private agentsTable?: KvTable<AgentId, AgentRecord>
  private squadsTable?: KvTable<SquadId, SquadRecord>
  private sessionModesTable?: KvTable<SessionId, SessionSquadModeRecord>
  private runsTable?: KvTable<DispatchId, SquadRunRecord>
  private squadVersionsTable?: KvTable<string, SquadVersionRecord>
  private projectDefaultsTable?: KvTable<string, ProjectSquadDefaultRecord>
  private readonly activeRunControllers = new Map<DispatchId, AbortController>()
  /** Process-local first gate; weak agent keys avoid retaining closed sessions. */
  private readonly lastGuaranteedMessage = new WeakMap<Agent, string>()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'agentTeamGui')
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(agentTeamDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'agent_team_gui.domainClose')
    this.agentsTable = domain.table('agents')
    this.squadsTable = domain.table('squads')
    this.sessionModesTable = domain.table('session_modes')
    this.runsTable = domain.table('runs')
    this.squadVersionsTable = domain.table('squad_versions')
    this.projectDefaultsTable = domain.table('project_defaults')
    this.ctx.tools.register(createDispatchToSquadTool(this))
    const systemPrompt = this.ctx.get('systemPrompt') as SystemPromptService
    systemPrompt.section({
      name: 'agent-team:squad-mode',
      order: 118,
      text: context => this.squadModeGuidance(context.agent),
    })
    this.ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      // Squad children inherit the parent's cwd. Without this lineage gate a
      // project default recursively dispatches the same squad from every child.
      if (this.isDelegatedAgent(agent)) return decision
      const submitted = [...decision.messages].reverse()
        .find((message): message is UserMessage => message.source.kind === 'user')
      if (submitted === undefined) return decision
      const mode = this.getEffectiveSessionSquadMode(agent)
      if (mode === undefined) return decision
      const squad = this.squads().get(mode.squadId)
      if (squad === undefined || (squad.triggerMode ?? 'guaranteed') !== 'guaranteed') return decision
      const task = this.messageText(submitted)
      if (task.trim() === '') return decision
      if (!this.claimGuaranteedMessage(agent, submitted.id)) return decision
      let result: SquadDispatchResult
      try {
        result = await this.dispatch({ squadId: mode.squadId, task }, agent, signal, {
          sessionId: agent.id,
          sourceMessageId: submitted.id,
        })
      } catch (error: unknown) {
        this.ctx.logger.warn(`[agent-team-gui] guaranteed dispatch failed; allowing lead model to continue: ${this.errorText(error)}`)
        const failure = createUserMessage({
          content: [{ type: 'text', text: `The selected squad could not run: ${this.errorText(error)}. Continue answering the user directly and disclose the team failure briefly.` }],
          source: { kind: 'plugin', plugin: 'dsh-agent-team-gui', form: 'notice', summary: 'Squad dispatch failed' },
        })
        return { kind: 'enter' as const, messages: [...decision.messages, failure] }
      }
      const context = createUserMessage({
        content: [{ type: 'text', text: this.renderSquadContext(result) }],
        source: {
          kind: 'plugin',
          plugin: 'dsh-agent-team-gui',
          form: 'notice',
          summary: `${result.squadName}: ${result.status}, ${result.usage.totalTokens} tokens`,
        },
      })
      return { kind: 'enter' as const, messages: [...decision.messages, context] }
    })
    registerAgentTeamRpc(this.ctx, this)
    this.ctx.logger.info('[agent-team-gui] v0.4 registry, guaranteed conversation dispatch, run center and token usage ready')
  }

  private agents(): KvTable<AgentId, AgentRecord> {
    if (this.agentsTable === undefined) throw new Error('agent_team_gui is not initialized')
    return this.agentsTable
  }

  private squads(): KvTable<SquadId, SquadRecord> {
    if (this.squadsTable === undefined) throw new Error('agent_team_gui is not initialized')
    return this.squadsTable
  }

  private sessionModes(): KvTable<SessionId, SessionSquadModeRecord> {
    if (this.sessionModesTable === undefined) throw new Error('agent_team_gui is not initialized')
    return this.sessionModesTable
  }

  private runs(): KvTable<DispatchId, SquadRunRecord> {
    if (this.runsTable === undefined) throw new Error('agent_team_gui is not initialized')
    return this.runsTable
  }

  private squadVersions(): KvTable<string, SquadVersionRecord> {
    if (this.squadVersionsTable === undefined) throw new Error('agent_team_gui is not initialized')
    return this.squadVersionsTable
  }

  private projectDefaults(): KvTable<string, ProjectSquadDefaultRecord> {
    if (this.projectDefaultsTable === undefined) throw new Error('agent_team_gui is not initialized')
    return this.projectDefaultsTable
  }

  private async validateModelRoute(record: AgentRecord): Promise<void> {
    if ((record.fallbackProvider === undefined) !== (record.fallbackModel === undefined)) {
      throw new Error('fallbackProvider and fallbackModel must be configured together')
    }
    try {
      await this.ctx.llm.resolveModelInfo(record.provider, record.model)
      if (record.fallbackProvider !== undefined && record.fallbackModel !== undefined) {
        await this.ctx.llm.resolveModelInfo(record.fallbackProvider, record.fallbackModel)
      }
    } catch (error: unknown) {
      throw new Error(`invalid model route ${record.provider}/${record.model}: ${this.errorText(error)}`, { cause: error })
    }
  }

  /** Create an agent after validating its exact configured model route. */
  async createAgent(record: AgentRecord, id: AgentId = AgentId(randomUUID())): Promise<AgentId> {
    const parsed = agentRecordSchema.parse(record)
    if (this.agents().get(id) !== undefined) {
      throw new AgentTeamError(`agent "${id}" already exists`, 'AGENT_EXISTS')
    }
    await this.validateModelRoute(parsed)
    await this.agents().put(id, parsed)
    return id
  }

  /** Replace an existing agent after validating its exact configured model route. */
  async updateAgent(id: AgentId, record: AgentRecord): Promise<void> {
    if (this.agents().get(id) === undefined) {
      throw new AgentTeamError(`agent "${id}" does not exist`, 'AGENT_NOT_FOUND')
    }
    const parsed = agentRecordSchema.parse(record)
    await this.validateModelRoute(parsed)
    await this.agents().put(id, parsed)
  }

  /** Delete an agent and atomically remove it from each squad record that references it. */
  async deleteAgent(id: AgentId): Promise<boolean> {
    if (this.agents().get(id) === undefined) return false
    const affected = [...this.squads().entries()].filter(([, squad]) => squad.members.includes(id))
    for (const [squadId] of affected) {
      const updated = await this.squads().update(squadId, (squad) => {
        const { leaderAgentId, ...withoutLeader } = squad
        return {
          ...(leaderAgentId === id ? withoutLeader : squad),
          members: squad.members.filter(memberId => memberId !== id),
          ...(squad.executionOrder === undefined
            ? {}
            : { executionOrder: squad.executionOrder.filter(memberId => memberId !== id) }),
        }
      })
      await this.recordSquadVersion(squadId, updated)
    }
    return this.agents().delete(id)
  }

  /** Read one agent definition. */
  getAgent(id: AgentId): AgentRecord | undefined {
    return this.agents().get(id)
  }

  /** Snapshot all agent definitions in durable iteration order. */
  listAgents(): [AgentId, AgentRecord][] {
    return [...this.agents().entries()]
  }

  private validateSquadRecord(record: SquadRecord, knownAgents?: ReadonlySet<string>): void {
    const unique = new Set(record.members)
    if (unique.size !== record.members.length) {
      throw new AgentTeamError('squad members must be unique', 'INVALID_MEMBERS')
    }
    const missing = record.members.filter(id => knownAgents === undefined
      ? this.agents().get(id) === undefined
      : !knownAgents.has(id))
    if (missing.length > 0) {
      throw new AgentTeamError(`unknown squad members: ${missing.join(', ')}`, 'INVALID_MEMBERS')
    }
    if (record.executionOrder !== undefined) {
      const orderSet = new Set(record.executionOrder)
      const isCompletePermutation = record.executionOrder.length === record.members.length
        && orderSet.size === record.executionOrder.length
        && record.members.every(id => orderSet.has(id))
      if (!isCompletePermutation) {
        throw new AgentTeamError('executionOrder must contain every squad member exactly once', 'INVALID_MEMBERS')
      }
      if (record.executionMode === 'parallel') {
        throw new AgentTeamError('executionOrder requires serial execution', 'INVALID_DISPATCH')
      }
    }
    if (record.executionMode === 'parallel' && record.contextMode === 'chain') {
      throw new AgentTeamError('contextMode "chain" requires serial execution', 'INVALID_DISPATCH')
    }
    if (record.leaderAgentId !== undefined && !record.members.includes(record.leaderAgentId)) {
      throw new AgentTeamError('leaderAgentId must be one of the squad members', 'INVALID_MEMBERS')
    }
    if (record.executionMode === 'parallel' && record.contextMode === 'chain') {
      throw new AgentTeamError('contextMode "chain" requires serial execution', 'INVALID_DISPATCH')
    }
    if (record.executionOrder !== undefined && record.executionMode === 'parallel') {
      throw new AgentTeamError('fixed executionOrder requires serial execution', 'INVALID_DISPATCH')
    }
  }

  private async recordSquadVersion(squadId: SquadId, record: SquadRecord): Promise<void> {
    const versions = this.listSquadVersions(squadId)
    const version = (versions[0]?.version ?? 0) + 1
    const entry: SquadVersionRecord = { squadId, version, createdAt: Date.now(), record }
    await this.squadVersions().put(`${squadId}:${String(version).padStart(8, '0')}`, entry)
  }

  /** Create a squad after validating every member reference. */
  async createSquad(record: SquadRecord, id: SquadId = SquadId(randomUUID())): Promise<SquadId> {
    const parsed = squadRecordSchema.parse(record)
    if (this.squads().get(id) !== undefined) {
      throw new AgentTeamError(`squad "${id}" already exists`, 'SQUAD_EXISTS')
    }
    this.validateSquadRecord(parsed)
    await this.squads().put(id, parsed)
    await this.recordSquadVersion(id, parsed)
    return id
  }

  /** Replace an existing squad after validating every member reference. */
  async updateSquad(id: SquadId, record: SquadRecord): Promise<void> {
    if (this.squads().get(id) === undefined) {
      throw new AgentTeamError(`squad "${id}" does not exist`, 'SQUAD_NOT_FOUND')
    }
    const parsed = squadRecordSchema.parse(record)
    this.validateSquadRecord(parsed)
    await this.squads().put(id, parsed)
    await this.recordSquadVersion(id, parsed)
  }

  /** Delete a squad and disable it in every persisted session mode. */
  async deleteSquad(id: SquadId): Promise<boolean> {
    if (this.squads().get(id) === undefined) return false
    for (const [sessionId, mode] of this.sessionModes().entries()) {
      if (mode.squadId === id) await this.sessionModes().delete(sessionId)
    }
    for (const [projectKey, record] of this.projectDefaults().entries()) {
      if (record.squadId === id) await this.projectDefaults().delete(projectKey)
    }
    for (const [key, version] of this.squadVersions().entries()) {
      if (version.squadId === id) await this.squadVersions().delete(key)
    }
    return this.squads().delete(id)
  }

  /** Read one squad definition. */
  getSquad(id: SquadId): SquadRecord | undefined {
    return this.squads().get(id)
  }

  /** Snapshot all squad definitions in durable iteration order. */
  listSquads(): [SquadId, SquadRecord][] {
    return [...this.squads().entries()]
  }

  /** Non-mutating readiness checks used by the Settings diagnostics action. */
  async diagnoseSquad(id: SquadId): Promise<{ ok: boolean; checks: Array<{ name: string; ok: boolean; message: string }> }> {
    const squad = this.squads().get(id)
    if (squad === undefined) throw new AgentTeamError(`squad "${id}" does not exist`, 'SQUAD_NOT_FOUND')
    const checks: Array<{ name: string; ok: boolean; message: string }> = []
    const add = (name: string, ok: boolean, message: string): void => { checks.push({ name, ok, message }) }
    try {
      this.validateSquadRecord(squad)
      add('definition', true, `${squad.members.length} members; ${squad.executionMode ?? this.config.defaultExecutionMode}/${squad.contextMode ?? this.config.defaultContextMode}`)
    } catch (error: unknown) {
      add('definition', false, this.errorText(error))
    }
    for (const memberId of squad.members) {
      const member = this.agents().get(memberId)
      if (member === undefined) {
        add(String(memberId), false, 'missing agent definition')
        continue
      }
      try {
        await this.validateModelRoute(member)
        add(member.name, true, `${member.provider}/${member.model}${member.fallbackProvider === undefined ? '' : ` → ${member.fallbackProvider}/${member.fallbackModel}`}`)
      } catch (error: unknown) {
        add(member.name, false, this.errorText(error))
      }
    }
    return { ok: checks.every(check => check.ok), checks }
  }

  /** Immutable newest-first revision history for one squad. */
  listSquadVersions(squadId: SquadId): SquadVersionRecord[] {
    return [...this.squadVersions().entries()].map(([, record]) => record)
      .filter(version => version.squadId === squadId)
      .sort((left, right) => right.version - left.version)
  }

  /** Restore a prior revision while retaining the restore itself as a new revision. */
  async restoreSquadVersion(squadId: SquadId, version: number): Promise<void> {
    const found = this.listSquadVersions(squadId).find(item => item.version === version)
    if (found === undefined) throw new AgentTeamError(`squad version ${version} does not exist`, 'SQUAD_NOT_FOUND')
    await this.updateSquad(squadId, found.record)
  }

  /** Resolve the durable squad-mode selection for one Session. */
  getSessionSquadMode(sessionId: SessionId): SessionSquadModeView | undefined {
    const mode = this.sessionModes().get(sessionId)
    if (mode === undefined || mode.disabled === true || mode.squadId === undefined) return undefined
    const squad = this.squads().get(mode.squadId)
    if (squad === undefined) return undefined
    return { sessionId, squadId: mode.squadId, squadName: squad.name }
  }

  /** Enable a squad for normal conversation, or disable it when squadId is omitted. */
  async setSessionSquadMode(sessionId: SessionId, squadId?: SquadId): Promise<SessionSquadModeView | undefined> {
    if (squadId === undefined) {
      await this.sessionModes().put(sessionId, { disabled: true })
      return undefined
    }
    const squad = this.squads().get(squadId)
    if (squad === undefined) {
      throw new AgentTeamError(`squad "${squadId}" does not exist`, 'SQUAD_NOT_FOUND')
    }
    await this.sessionModes().put(sessionId, { squadId })
    return { sessionId, squadId, squadName: squad.name }
  }

  /** Workspace key used by project defaults without exposing arbitrary client paths. */
  projectKeyFor(agent: Agent): string | undefined {
    return agent.session.header.cwd
  }

  /** Resolve explicit session state first, then a durable workspace default. */
  getEffectiveSessionSquadMode(agent: Agent): SessionSquadModeView | undefined {
    if (this.isDelegatedAgent(agent)) return undefined
    const explicit = this.sessionModes().get(agent.id)
    if (explicit !== undefined) return this.getSessionSquadMode(agent.id)
    const projectKey = this.projectKeyFor(agent)
    if (projectKey === undefined) return undefined
    const project = this.projectDefaults().get(projectKey)
    if (project === undefined || !project.enabled) return undefined
    const squad = this.squads().get(project.squadId)
    return squad === undefined ? undefined : { sessionId: agent.id, squadId: project.squadId, squadName: squad.name }
  }

  /** Durable lineage is the authority: squad members can never auto-dispatch another squad. */
  private isDelegatedAgent(agent: Agent): boolean {
    const header = agent.session.header
    return header.origin === 'subagent'
      || header.parentSession !== undefined
      || (header.delegationDepth ?? 0) > 0
  }

  /** Claim one top-level user message exactly once, including across restarts. */
  private claimGuaranteedMessage(agent: Agent, messageId: string): boolean {
    const alreadyDurable = [...this.runs().entries()].some(([, run]) =>
      run.sessionId === agent.id && run.sourceMessageId === messageId)
    if (this.lastGuaranteedMessage.get(agent) === messageId || alreadyDurable) return false
    this.lastGuaranteedMessage.set(agent, messageId)
    return true
  }

  getProjectDefault(projectKey: string): ProjectSquadDefaultRecord | undefined {
    return this.projectDefaults().get(projectKey)
  }

  async setProjectDefault(projectKey: string, squadId?: SquadId): Promise<ProjectSquadDefaultRecord | undefined> {
    if (projectKey.trim() === '') throw new AgentTeamError('project key must not be empty', 'INVALID_DISPATCH')
    if (squadId === undefined) {
      await this.projectDefaults().delete(projectKey)
      return undefined
    }
    if (this.squads().get(squadId) === undefined) {
      throw new AgentTeamError(`squad "${squadId}" does not exist`, 'SQUAD_NOT_FOUND')
    }
    const record: ProjectSquadDefaultRecord = { projectKey, squadId, enabled: true }
    await this.projectDefaults().put(projectKey, record)
    return record
  }

  /**
   * Dynamic official system-prompt section for a live parent Agent. Harness
   * uses it to teach the main model how to synthesize the guaranteed host run
   * and, in legacy model-tool mode, how to call the explicit dispatch tool.
   */
  squadModeGuidance(agent: Agent | undefined): string {
    if (agent === undefined) return ''
    const mode = this.getEffectiveSessionSquadMode(agent)
    if (mode === undefined) return ''
    const squad = this.squads().get(mode.squadId)
    if (squad === undefined) return ''
    const order = squad.executionOrder === undefined
      ? 'No fixed member order is configured. The host uses your model route to plan one role-specific assignment and a complete memberOrder for every configured member.'
      : `Use this fixed serial member order: ${squad.executionOrder.join(' -> ')}.`
    const executionMode = squad.executionMode ?? (squad.executionOrder === undefined
      ? this.config.defaultExecutionMode
      : 'serial')
    const contextMode = squad.contextMode ?? this.config.defaultContextMode
    const guaranteed = (squad.triggerMode ?? 'guaranteed') === 'guaranteed'
    return [
      '<agent_team_squad_mode>',
      `Squad mode is enabled for this conversation. Active squad id: ${mode.squadId}.`,
      `Squad name: ${squad.name}. Members (id, name, model): ${squad.members.map((id) => {
        const record = this.agents().get(id)
        return record === undefined ? `${id} (missing)` : `${id} (${record.name}, ${record.provider}/${record.model})`
      }).join(', ') || '(none)'}.`,
      ...(squad.collabNote === undefined || squad.collabNote.length === 0
        ? []
        : [`Collaboration note: ${squad.collabNote}`]),
      order,
      `Default executionMode: ${executionMode}. Default contextMode: ${contextMode}.`,
      ...(guaranteed
        ? [
            'The host runs this squad before your request and injects one dsh-agent-team-gui notice containing the plan and member results.',
            'Do not call dispatch_to_squad again when that notice is present. Synthesize it into one final answer and name partial or failed members.',
          ]
        : [
            'For each new ordinary user request, call dispatch_to_squad exactly once before your final answer.',
            `Pass squadId exactly as "${mode.squadId}" and turn the current user request into a concrete shared task.`,
            'When there is no fixed order, pass memberOrder as a complete, unique permutation of all member ids; use assignments for member-specific tasks.',
            'After the tool result, synthesize the member outputs into one final answer for the user; explicitly mention partial or failed members when relevant.',
            'Do not call dispatch_to_squad again for the same user request after receiving its result.',
          ]),
      '</agent_team_squad_mode>',
    ].join('\n')
  }

  /** Dump every durable definition as a versioned, self-describing document. */
  async exportDefinitions(): Promise<AgentTeamExportDocument> {
    return {
      format: 'agent-team-gui/definitions',
      version: 1,
      agents: this.listAgents().map(([id, record]) => ({ id, ...record })),
      squads: this.listSquads().map(([id, record]) => ({ id, ...record })),
    }
  }

  /**
   * Apply a definition document to the durable store. The whole document is
   * validated first (shape, uniqueness, model routes, squad references), so a
   * failing import writes nothing. Durable writes themselves are not a single
   * transaction: a storage failure mid-import can leave a partial apply.
   */
  async importDefinitions(document: unknown, mode: AgentTeamImportMode = 'merge'): Promise<AgentTeamImportResult> {
    if (mode !== 'merge' && mode !== 'replace') {
      throw new AgentTeamError(`unknown import mode "${String(mode)}"`, 'INVALID_IMPORT')
    }
    const parsed = agentTeamExportSchema.parse(document)

    const seenAgents = new Set<string>()
    const agentsToWrite: Array<{ id: AgentId; record: AgentRecord }> = parsed.agents.map((item) => {
      if (seenAgents.has(item.id)) {
        throw new AgentTeamError(`duplicate agent "${item.id}" in import document`, 'INVALID_IMPORT')
      }
      seenAgents.add(item.id)
      const { id, ...recordFields } = item
      return { id: AgentId(id), record: agentRecordSchema.parse(recordFields) }
    })
    await Promise.all(agentsToWrite.map(item => this.validateModelRoute(item.record)))

    // Squads may only reference agents that will exist after the import.
    const knownAgents = new Set<string>(mode === 'replace'
      ? agentsToWrite.map(item => item.id)
      : [...this.listAgents().map(([id]) => id), ...agentsToWrite.map(item => item.id)])

    const seenSquads = new Set<string>()
    const squadsToWrite: Array<{ id: SquadId; record: SquadRecord }> = parsed.squads.map((item) => {
      if (seenSquads.has(item.id)) {
        throw new AgentTeamError(`duplicate squad "${item.id}" in import document`, 'INVALID_IMPORT')
      }
      seenSquads.add(item.id)
      const { id, ...recordFields } = item
      const record = squadRecordSchema.parse(recordFields)
      try {
        this.validateSquadRecord(record, knownAgents)
      } catch (error: unknown) {
        throw new AgentTeamError(
          `invalid import squad "${id}": ${this.errorText(error)}`,
          'INVALID_IMPORT',
        )
      }
      return { id: SquadId(id), record }
    })

    if (mode === 'replace') {
      for (const [id] of this.listAgents()) await this.agents().delete(id)
      for (const [id] of this.listSquads()) await this.squads().delete(id)
      const importedSquadIds = new Set(squadsToWrite.map(item => item.id))
      for (const [sessionId, sessionMode] of this.sessionModes().entries()) {
        if (sessionMode.squadId !== undefined && !importedSquadIds.has(sessionMode.squadId)) {
          await this.sessionModes().delete(sessionId)
        }
      }
      for (const [projectKey, project] of this.projectDefaults().entries()) {
        if (!importedSquadIds.has(project.squadId)) await this.projectDefaults().delete(projectKey)
      }
      for (const [key, version] of this.squadVersions().entries()) {
        if (!importedSquadIds.has(version.squadId)) await this.squadVersions().delete(key)
      }
    }
    for (const { id, record } of agentsToWrite) await this.agents().put(id, record)
    for (const { id, record } of squadsToWrite) {
      await this.squads().put(id, record)
      await this.recordSquadVersion(id, record)
    }
    return { agents: agentsToWrite.length, squads: squadsToWrite.length }
  }

  /** Resolve a model/user supplied durable id or unique configured squad name. */
  resolveSquadId(reference: string): SquadId {
    const trimmed = reference.trim()
    const directId = SquadId(trimmed)
    if (this.squads().get(directId) !== undefined) return directId
    const normalized = trimmed.toLocaleLowerCase()
    const matches = this.listSquads().filter(([, squad]) => squad.name.trim().toLocaleLowerCase() === normalized)
    if (matches.length === 1) return matches[0]![0]
    if (matches.length > 1) {
      throw new AgentTeamError(`squad name "${trimmed}" is ambiguous; use its durable id`, 'INVALID_DISPATCH')
    }
    throw new AgentTeamError(`squad "${trimmed}" does not exist`, 'SQUAD_NOT_FOUND')
  }

  /** Add one existing agent to a squad using storage-domain atomic update. */
  async addMemberToSquad(squadId: SquadId, agentId: AgentId): Promise<SquadRecord> {
    if (this.agents().get(agentId) === undefined) {
      throw new AgentTeamError(`agent "${agentId}" does not exist`, 'AGENT_NOT_FOUND')
    }
    if (this.squads().get(squadId) === undefined) {
      throw new AgentTeamError(`squad "${squadId}" does not exist`, 'SQUAD_NOT_FOUND')
    }
    const updated = await this.squads().update(squadId, squad => {
      if (squad.members.includes(agentId)) {
        throw new AgentTeamError(`agent "${agentId}" is already in squad "${squadId}"`, 'INVALID_MEMBERS')
      }
      return {
        ...squad,
        members: [...squad.members, agentId],
        ...(squad.executionOrder === undefined ? {} : { executionOrder: [...squad.executionOrder, agentId] }),
      }
    })
    await this.recordSquadVersion(squadId, updated)
    return updated
  }

  /** Remove one member from a squad using storage-domain atomic update. */
  async removeMemberFromSquad(squadId: SquadId, agentId: AgentId): Promise<SquadRecord> {
    if (this.squads().get(squadId) === undefined) {
      throw new AgentTeamError(`squad "${squadId}" does not exist`, 'SQUAD_NOT_FOUND')
    }
    const updated = await this.squads().update(squadId, (squad) => {
      const { leaderAgentId, ...withoutLeader } = squad
      return {
        ...(leaderAgentId === agentId ? withoutLeader : squad),
        members: squad.members.filter(memberId => memberId !== agentId),
        ...(squad.executionOrder === undefined
          ? {}
          : { executionOrder: squad.executionOrder.filter(memberId => memberId !== agentId) }),
      }
    })
    await this.recordSquadVersion(squadId, updated)
    return updated
  }

  private resolveMembers(
    squad: SquadRecord,
    assignments: readonly SquadAssignment[] | undefined,
    memberOrder: readonly AgentId[] | undefined,
  ): ResolvedMember[] {
    const assignmentByAgent = new Map<AgentId, string>()
    if (assignments !== undefined) {
      if (assignments.length === 0) {
        throw new AgentTeamError('assignments must be omitted instead of empty', 'INVALID_ASSIGNMENTS')
      }
      for (const assignment of assignments) {
        if (assignment.task.trim().length === 0) {
          throw new AgentTeamError(`assignment for "${assignment.agentId}" has an empty task`, 'INVALID_ASSIGNMENTS')
        }
        if (!squad.members.includes(assignment.agentId)) {
          throw new AgentTeamError(`assignment agent "${assignment.agentId}" is not a squad member`, 'INVALID_ASSIGNMENTS')
        }
        if (assignmentByAgent.has(assignment.agentId)) {
          throw new AgentTeamError(`assignment agent "${assignment.agentId}" appears more than once`, 'INVALID_ASSIGNMENTS')
        }
        assignmentByAgent.set(assignment.agentId, assignment.task)
      }
    }
    if (squad.executionOrder !== undefined && memberOrder !== undefined) {
      throw new AgentTeamError('memberOrder cannot override a squad executionOrder', 'INVALID_DISPATCH')
    }
    if (memberOrder !== undefined) {
      const orderSet = new Set(memberOrder)
      const isCompletePermutation = memberOrder.length === squad.members.length
        && orderSet.size === memberOrder.length
        && squad.members.every(id => orderSet.has(id))
      if (!isCompletePermutation) {
        throw new AgentTeamError('memberOrder must contain every squad member exactly once', 'INVALID_DISPATCH')
      }
    }
    const orderedIds = squad.executionOrder ?? memberOrder ?? squad.members
    return orderedIds.map((id) => {
      const record = this.agents().get(id)
      if (record === undefined) {
        throw new AgentTeamError(`squad references missing agent "${id}"`, 'AGENT_NOT_FOUND')
      }
      return { id, record, task: assignmentByAgent.get(id) ?? '' }
    })
  }

  private promptFor(squad: SquadRecord, member: ResolvedMember, sharedTask: string, chainText: string): string {
    const parts = [
      `Overall squad goal (context only):\n${sharedTask}`,
      member.task.length === 0
        ? 'Contribute only through your configured squad role. Do not take ownership of the other members\' work.'
        : `Your exclusive assignment:\n${member.task}\n\nComplete this assignment only. Do not perform or replace another member's assignment.`,
      'Do not call dispatch_to_squad and do not create or delegate to subagents. Return a concrete handoff for the main Agent to synthesize.',
      ...(squad.collabNote ?? '').length === 0 ? [] : [`Squad collaboration note:\n${squad.collabNote}`],
      ...chainText.length === 0 ? [] : [`Previous squad member result:\n${chainText}`],
    ]
    return parts.join('\n\n---\n\n')
  }

  private resultText(output: readonly ContentBlock[]): string {
    return output
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('')
  }

  private messageText(message: UserMessage): string {
    return message.content
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('\n')
  }

  private renderSquadContext(result: SquadDispatchResult): string {
    return [
      `The selected squad has already completed this user request. Do not dispatch it again.`,
      `Squad run result (canonical JSON):`,
      JSON.stringify(result),
      `Synthesize these results into the final answer. Preserve material disagreements and explicitly name failed or skipped work.`,
    ].join('\n\n')
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  private addUsage(...samples: Array<AgentTokenUsage | undefined>): AgentTokenUsage {
    const present = samples.filter((sample): sample is AgentTokenUsage => sample !== undefined)
    const buckets = present.reduce((total, sample) => ({
      uncachedInputTokens: total.uncachedInputTokens + sample.uncachedInputTokens,
      outputTokens: total.outputTokens + sample.outputTokens,
      cacheReadTokens: total.cacheReadTokens + sample.cacheReadTokens,
      cacheWriteTokens: total.cacheWriteTokens + sample.cacheWriteTokens,
    }), { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
    return {
      ...buckets,
      totalTokens: buckets.uncachedInputTokens + buckets.outputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens,
      providerReported: present.length > 0 && present.every(sample => sample.providerReported),
    }
  }

  private usageProjectionFor(run: SubagentRun): TokenUsageProjection | undefined {
    if (run.localAgent === undefined) return undefined
    try {
      const projections = this.ctx.get('sessionProjections') as SessionProjectionService
      const value = projections.snapshot(run.localAgent.session).values['tokenUsage'] as Partial<TokenUsageProjection> | undefined
      if (value === undefined) return undefined
      const uncachedInputTokens = value.uncachedInputTokens ?? 0
      const outputTokens = value.outputTokens ?? 0
      const cacheReadTokens = value.cacheReadTokens ?? 0
      const cacheWriteTokens = value.cacheWriteTokens ?? 0
      if (![uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens]
        .every(item => Number.isSafeInteger(item) && item >= 0)) return undefined
      return {
        uncachedInputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
      }
    } catch (error: unknown) {
      this.ctx.logger.warn(`[agent-team-gui] official tokenUsage read failed: ${this.errorText(error)}`)
      return undefined
    }
  }

  /** Provider-reported usage for this run only, excluding a fork seed baseline. */
  private usageFor(run: SubagentRun, baseline?: TokenUsageProjection): AgentTokenUsage | undefined {
    const current = this.usageProjectionFor(run)
    if (current === undefined) return undefined
    const buckets = {
      uncachedInputTokens: Math.max(0, current.uncachedInputTokens - (baseline?.uncachedInputTokens ?? 0)),
      outputTokens: Math.max(0, current.outputTokens - (baseline?.outputTokens ?? 0)),
      cacheReadTokens: Math.max(0, current.cacheReadTokens - (baseline?.cacheReadTokens ?? 0)),
      cacheWriteTokens: Math.max(0, current.cacheWriteTokens - (baseline?.cacheWriteTokens ?? 0)),
    }
    const totalTokens = buckets.uncachedInputTokens + buckets.outputTokens
      + buckets.cacheReadTokens + buckets.cacheWriteTokens
    // The official projection initializes at zero before a provider reports.
    // Absence is more accurate than presenting that state as "0 tokens".
    if (totalTokens === 0) return undefined
    return { ...buckets, totalTokens, providerReported: true }
  }

  /** Fork children begin with parent history; spawn children have no seed to subtract. */
  private usageBaselineFor(run: SubagentRun): TokenUsageProjection | undefined {
    if (run.localAgent === undefined) return undefined
    // Third-party providers are required to return a complete Agent, but keep
    // metering defensive so a malformed optional local handle cannot fail work.
    try {
      if ((run.localAgent.session.header.seedLength ?? 0) === 0) return undefined
    } catch {
      return undefined
    }
    return this.usageProjectionFor(run)
  }

  private async updateRun(id: DispatchId, update: (record: SquadRunRecord) => SquadRunRecord): Promise<void> {
    if (this.runs().get(id) !== undefined) await this.runs().update(id, update)
  }

  private async updateRunMember(
    dispatchId: DispatchId,
    agentId: AgentId,
    update: (record: SquadRunMember) => SquadRunMember,
  ): Promise<void> {
    await this.updateRun(dispatchId, run => {
      const members = run.members.map(member => member.agentId === agentId ? update(member) : member)
      return {
        ...run,
        members,
        usage: this.addUsage(run.plan?.usage, ...members.map(member => member.usage)),
      }
    })
  }

  /** Stream official token projection changes into the durable live run row. */
  private trackRunUsage(
    dispatchId: DispatchId,
    agentId: AgentId,
    run: SubagentRun,
    baseline: TokenUsageProjection | undefined,
  ): () => Promise<void> {
    if (run.localAgent === undefined) return async () => undefined
    let projections: SessionProjectionService
    try {
      projections = this.ctx.get('sessionProjections') as SessionProjectionService
    } catch {
      return async () => undefined
    }
    if (projections === undefined || projections.onChanged === undefined) return async () => undefined
    let lastSignature = ''
    let pending = Promise.resolve()
    const publish = (): void => {
      const usage = this.usageFor(run, baseline)
      if (usage === undefined) return
      const signature = `${usage.uncachedInputTokens}/${usage.outputTokens}/${usage.cacheReadTokens}/${usage.cacheWriteTokens}`
      if (signature === lastSignature) return
      lastSignature = signature
      pending = pending.then(async () => {
        await this.updateRunMember(dispatchId, agentId, member => ({ ...member, usage }))
      }).catch((error: unknown) => {
        this.ctx.logger.warn(`[agent-team-gui] live token update failed: ${this.errorText(error)}`)
      })
    }
    const dispose = projections.onChanged((session, key) => {
      if (session === run.localAgent?.session && key === 'tokenUsage') publish()
    })
    publish()
    return async () => {
      dispose()
      publish()
      await pending
    }
  }

  private async settleRun(
    member: ResolvedMember,
    run: SubagentRun,
    attempts: number,
    startedAt: number,
    baseline?: TokenUsageProjection,
  ): Promise<SquadMemberResult> {
    let result: SubagentResult | undefined
    let executionError: unknown
    try {
      result = await run.result
    } catch (error: unknown) {
      executionError = error
    }
    const usage = this.usageFor(run, baseline)
    let disposalError: unknown
    try {
      await run.dispose()
    } catch (error: unknown) {
      disposalError = error
    }
    const errors: string[] = []
    if (executionError !== undefined) errors.push(`run failed: ${this.errorText(executionError)}`)
    if (result !== undefined && result.stopReason !== 'completed') {
      errors.push(`run ended with stop reason ${result.stopReason}`)
    }
    if (disposalError !== undefined) errors.push(`run cleanup failed: ${this.errorText(disposalError)}`)
    return {
      agentId: member.id,
      agentName: member.record.name,
      status: errors.length === 0 ? 'completed' : 'failed',
      runId: run.id,
      ...run.localAgent === undefined ? {} : { childId: run.localAgent.id },
      ...result === undefined ? {} : { stopReason: result.stopReason },
      output: result?.output ?? [],
      attempts,
      startedAt,
      endedAt: Date.now(),
      ...usage === undefined ? {} : { usage },
      ...errors.length === 0 ? {} : { error: errors.join('; ') },
    }
  }

  private async runMember(
    provider: string,
    squad: SquadRecord,
    member: ResolvedMember,
    sharedTask: string,
    chainText: string,
    parent: Agent,
    signal: AbortSignal,
    dispatchId: DispatchId,
    attempt: number,
    route?: { readonly provider: string; readonly model: string },
  ): Promise<SquadMemberResult> {
    const prompt = this.promptFor(squad, member, sharedTask, chainText)
    const startedAt = Date.now()
    const selectedRoute = route ?? { provider: member.record.provider, model: member.record.model }
    await this.updateRunMember(dispatchId, member.id, current => ({
      ...current,
      provider: selectedRoute.provider,
      model: selectedRoute.model,
      status: 'running',
      attempts: attempt,
      startedAt,
    }))
    this.ctx.logger.info(`[agent-team-gui] starting ${squad.name}/${member.record.name}`)
    const timeout = new AbortController()
    const timer = squad.memberTimeoutMs === undefined
      ? undefined
      : setTimeout(() => timeout.abort(new Error(`member timed out after ${squad.memberTimeoutMs}ms`)), squad.memberTimeoutMs)
    const memberSignal = squad.memberTimeoutMs === undefined ? signal : AbortSignal.any([signal, timeout.signal])
    const childToolScope = this.childToolScope(member.record, provider)
    try {
      const run = await this.ctx.subagents.start(provider, {
        label: `${squad.name}/${member.record.name}`,
        prompt: [{ type: 'text', text: prompt }],
        parent,
        signal: memberSignal,
        agentOptions: {
          provider: selectedRoute.provider,
          model: selectedRoute.model,
          ...member.record.maxTokens === undefined ? {} : { maxTokens: member.record.maxTokens },
        },
        ...childToolScope === undefined ? {} : { toolFilter: childToolScope },
        ...member.record.systemPrompt.length === 0 ? {} : { persona: member.record.systemPrompt },
      })
      const baseline = this.usageBaselineFor(run)
      const stopUsageTracking = this.trackRunUsage(dispatchId, member.id, run, baseline)
      let settled: SquadMemberResult
      try {
        settled = await this.settleRun(member, run, attempt, startedAt, baseline)
      } finally {
        await stopUsageTracking()
      }
      await this.updateRunMember(dispatchId, member.id, current => ({
        ...current,
        status: settled.status,
        attempts: settled.attempts,
        ...(settled.endedAt === undefined ? {} : { endedAt: settled.endedAt }),
        ...(settled.runId === undefined ? {} : { runId: settled.runId }),
        ...(settled.childId === undefined ? {} : { childId: settled.childId }),
        ...(settled.stopReason === undefined ? {} : { stopReason: settled.stopReason }),
        output: settled.output,
        ...(settled.error === undefined ? {} : { error: settled.error }),
        ...(settled.usage === undefined ? {} : { usage: settled.usage }),
      }))
      this.ctx.logger.info(`[agent-team-gui] finished ${squad.name}/${member.record.name}: ${settled.status}`)
      return settled
    } catch (error: unknown) {
      const message = this.errorText(error)
      this.ctx.logger.warn(`[agent-team-gui] failed ${squad.name}/${member.record.name}: ${message}`)
      const failed: SquadMemberResult = {
        agentId: member.id,
        agentName: member.record.name,
        status: 'failed',
        output: [],
        attempts: attempt,
        startedAt,
        endedAt: Date.now(),
        error: `start failed: ${message}`,
      }
      await this.updateRunMember(dispatchId, member.id, current => ({
        ...current,
        status: signal.aborted ? 'cancelled' : 'failed',
        attempts: attempt,
        ...(failed.endedAt === undefined ? {} : { endedAt: failed.endedAt }),
        ...(failed.error === undefined ? {} : { error: failed.error }),
      }))
      return failed
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** Preserve configured restrictions while hard-denying recursive team/delegation tools when present. */
  private childToolScope(record: AgentRecord, provider: string): AgentRecord['toolScope'] | undefined {
    const runtime = this.ctx.subagents as unknown as {
      getProvider?(name: string): { readonly capabilities: { readonly toolFilter: boolean } } | undefined
    }
    if (runtime.getProvider?.(provider)?.capabilities.toolFilter === false) return record.toolScope
    const known = new Set(this.ctx.tools.schemas().map(tool => tool.name))
    const deny = new Set(record.toolScope?.deny ?? [])
    for (const name of ['dispatch_to_squad', 'subagent']) {
      if (known.has(name)) deny.add(name)
    }
    const allow = record.toolScope?.allow
    if (allow === undefined && deny.size === 0) return undefined
    return {
      ...(allow === undefined ? {} : { allow: [...allow] }),
      ...(deny.size === 0 ? {} : { deny: [...deny] }),
    }
  }

  private async runMemberWithPolicy(
    provider: string,
    squad: SquadRecord,
    member: ResolvedMember,
    sharedTask: string,
    chainText: string,
    parent: Agent,
    signal: AbortSignal,
    dispatchId: DispatchId,
  ): Promise<SquadMemberResult> {
    const first = await this.runMember(provider, squad, member, sharedTask, chainText, parent, signal, dispatchId, 1)
    if (first.status === 'completed' || signal.aborted || (squad.failurePolicy ?? 'continue') !== 'retry-once') return first
    const fallback = member.record.fallbackProvider !== undefined && member.record.fallbackModel !== undefined
      ? { provider: member.record.fallbackProvider, model: member.record.fallbackModel }
      : undefined
    const second = await this.runMember(provider, squad, member, sharedTask, chainText, parent, signal, dispatchId, 2, fallback)
    const combined = {
      ...second,
      attempts: 2,
      usage: this.addUsage(first.usage, second.usage),
      ...second.status === 'completed' ? {} : { error: [first.error, second.error].filter(Boolean).join('; ') },
    }
    await this.updateRunMember(dispatchId, member.id, current => ({
      ...current,
      usage: combined.usage,
      ...combined.error === undefined ? {} : { error: combined.error },
    }))
    return combined
  }

  private async createAutomaticPlan(
    squad: SquadRecord,
    task: string,
    parent: Agent,
    signal: AbortSignal,
    useMainAgent: boolean,
  ): Promise<SquadExecutionPlan | undefined> {
    if (squad.executionOrder !== undefined) return undefined
    const leader = squad.leaderAgentId === undefined ? undefined : this.agents().get(squad.leaderAgentId)
    if (!useMainAgent && leader === undefined) return undefined
    // A forked planning child inherits the parent Agent's conversation and,
    // unless explicitly overridden, the same provider/model route. It has no
    // execution tools and exists only to enforce a structured plan contract.
    const provider = useMainAgent ? 'fork' : (squad.contextMode === 'fork' ? 'fork' : this.config.defaultProvider)
    const planner = useMainAgent ? 'main-agent' as const : 'squad-leader' as const
    const plannerProvider = useMainAgent ? parent.options.provider : leader?.provider
    const plannerModel = useMainAgent ? parent.options.model : leader?.model
    const plannerAgentOptions = {
      ...(plannerProvider === undefined ? {} : { provider: plannerProvider }),
      ...(plannerModel === undefined ? {} : { model: plannerModel }),
      ...(useMainAgent
        ? (parent.options.maxTokens === undefined ? {} : { maxTokens: parent.options.maxTokens })
        : (leader?.maxTokens === undefined ? {} : { maxTokens: leader.maxTokens })),
    }
    const memberIds = squad.members.map(String)
    const outputSchema = {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        summary: { type: 'string' as const },
        memberOrder: { type: 'array' as const, items: { type: 'string' as const, enum: memberIds } },
        assignments: {
          type: 'array' as const,
          items: {
            type: 'object' as const,
            additionalProperties: false,
            properties: { agentId: { type: 'string' as const, enum: memberIds }, task: { type: 'string' as const } },
            required: ['agentId', 'task'],
          },
        },
      },
      required: ['summary', 'memberOrder', 'assignments'],
    }
    let run: SubagentRun | undefined
    let baseline: TokenUsageProjection | undefined
    const runtime = this.ctx.subagents as unknown as {
      getProvider?(name: string): { readonly capabilities: { readonly toolFilter: boolean } } | undefined
    }
    const plannerToolScope = runtime.getProvider?.(provider)?.capabilities.toolFilter === false
      ? undefined
      : { allow: [] as string[] }
    try {
      run = await this.ctx.subagents.start(provider, {
        label: `${squad.name}/${useMainAgent ? 'Main workflow planner' : 'Squad leader planner'}`,
        parent,
        signal,
        prompt: [{ type: 'text', text: [
          `Create an execution plan for this user request. Do not do the work yourself:\n${task}`,
          `You must use all ${squad.members.length} configured members exactly once. Their stable identities and capabilities are:\n${squad.members.map((id) => {
            const record = this.agents().get(id)
            const allow = record?.toolScope?.allow?.join(', ') ?? 'all tools except denied tools'
            const deny = record?.toolScope?.deny?.join(', ') ?? 'none configured'
            return [
              `- id=${id}; name=${record?.name ?? 'missing'}; model=${record?.provider ?? 'missing'}/${record?.model ?? 'missing'}`,
              `  role=${record?.systemPrompt?.trim() || 'No role description configured.'}`,
              `  tools: allow=${allow}; deny=${deny}`,
            ].join('\n')
          }).join('\n')}`,
          ...(squad.collabNote ?? '').trim().length === 0 ? [] : [`Team collaboration rule:\n${squad.collabNote}`],
          [
            'Return every member exactly once in memberOrder and exactly one non-empty, concrete assignment for every member.',
            'Match each assignment to that member\'s role and capabilities. Split ownership so members do not all solve the entire request.',
            'Order dependencies deliberately: for example, design/research before implementation and review after the artifact exists.',
            'The main Agent will synthesize the member handoffs, so assignments should name the expected deliverable and boundaries.',
          ].join(' '),
        ].join('\n\n') }],
        outputSchema,
        ...Object.keys(plannerAgentOptions).length === 0 ? {} : { agentOptions: plannerAgentOptions },
        ...plannerToolScope === undefined ? {} : { toolFilter: plannerToolScope },
        persona: useMainAgent
          ? 'You are the main Agent\'s workflow planner. Produce only a concise, executable division of work. Do not execute the task, call tools, dispatch teams, or create subagents.'
          : `${leader?.systemPrompt ?? ''}\nYou are the fallback squad leader planner. Produce only a concise executable division of work. Do not execute the task, call tools, dispatch teams, or create subagents.`,
      })
      baseline = this.usageBaselineFor(run)
      const result = await run.result
      const usage = this.usageFor(run, baseline)
      const structured = result.structured as { summary?: unknown; memberOrder?: unknown; assignments?: unknown } | undefined
      if (result.stopReason !== 'completed' || structured === undefined
        || typeof structured.summary !== 'string' || !Array.isArray(structured.memberOrder)
        || !Array.isArray(structured.assignments)) throw new Error(`planner ended without a valid plan (${result.stopReason})`)
      const order = structured.memberOrder.map(String).map(AgentId)
      const orderSet = new Set(order)
      if (order.length !== squad.members.length || orderSet.size !== order.length || !squad.members.every(id => orderSet.has(id))) {
        throw new Error('planner memberOrder is not a complete squad permutation')
      }
      const assignments = structured.assignments.map((raw) => {
        const value = raw as { agentId?: unknown; task?: unknown }
        if (typeof value.agentId !== 'string' || typeof value.task !== 'string' || value.task.trim().length === 0) {
          throw new Error('planner assignment is invalid or empty')
        }
        return { agentId: AgentId(value.agentId), task: value.task.trim() }
      })
      const assignmentIds = assignments.map(item => item.agentId)
      if (assignments.length !== squad.members.length || new Set(assignmentIds).size !== assignmentIds.length
        || !squad.members.every(id => assignmentIds.includes(id))) {
        throw new Error('planner assignments must cover every squad member exactly once')
      }
      return {
        summary: structured.summary,
        memberOrder: order,
        assignments,
        planner,
        ...(plannerProvider === undefined ? {} : { plannerProvider }),
        ...(plannerModel === undefined ? {} : { plannerModel }),
        ...planner === 'squad-leader' && squad.leaderAgentId !== undefined
          ? { leaderAgentId: squad.leaderAgentId }
          : {},
        ...usage === undefined ? {} : { usage },
      }
    } catch (error: unknown) {
      const assignments = squad.members.map((agentId) => {
        const record = this.agents().get(agentId)
        const name = record?.name ?? String(agentId)
        const role = record?.systemPrompt.trim() || `Act as ${name}.`
        return {
          agentId,
          task: `Produce the ${name} contribution required for the squad goal. Stay strictly within this role: ${role} Deliver a focused handoff to the main Agent and do not take over other members' responsibilities.`,
        }
      })
      return {
        summary: 'Dynamic planning failed; using the configured member order with one role-scoped assignment per member.',
        memberOrder: [...squad.members],
        assignments,
        planner,
        ...(plannerProvider === undefined ? {} : { plannerProvider }),
        ...(plannerModel === undefined ? {} : { plannerModel }),
        ...planner === 'squad-leader' && squad.leaderAgentId !== undefined
          ? { leaderAgentId: squad.leaderAgentId }
          : {},
        warning: this.errorText(error),
        ...run === undefined || this.usageFor(run, baseline) === undefined ? {} : { usage: this.usageFor(run, baseline)! },
      }
    } finally {
      if (run !== undefined) await run.dispose().catch(() => undefined)
    }
  }

  /**
   * Dispatch through the existing subagent providers. Parent `tool/call` and
   * `tool/result` records contain this complete result, while each returned
   * child id points to the provider-owned child Session and its descriptor.
   */
  async dispatch(
    request: SquadDispatchRequest,
    parent: Agent,
    signal: AbortSignal,
    trace: { readonly sessionId?: SessionId; readonly sourceMessageId?: string } = {},
  ): Promise<SquadDispatchResult> {
    if (this.isDelegatedAgent(parent)) {
      throw new AgentTeamError('nested squad dispatch is blocked for delegated child sessions', 'INVALID_DISPATCH')
    }
    if (request.task.trim().length === 0) {
      throw new AgentTeamError('dispatch task must not be empty', 'INVALID_DISPATCH')
    }
    const squad = this.squads().get(request.squadId)
    if (squad === undefined) {
      throw new AgentTeamError(`squad "${request.squadId}" does not exist`, 'SQUAD_NOT_FOUND')
    }
    if (squad.members.length === 0) {
      throw new AgentTeamError(`squad "${request.squadId}" has no members`, 'INVALID_DISPATCH')
    }
    const executionMode = request.executionMode
      ?? squad.executionMode
      ?? (squad.executionOrder === undefined ? this.config.defaultExecutionMode : 'serial')
    const contextMode = request.contextMode ?? squad.contextMode ?? this.config.defaultContextMode
    if (squad.executionOrder !== undefined && executionMode === 'parallel') {
      throw new AgentTeamError('a squad with executionOrder requires serial execution', 'INVALID_DISPATCH')
    }
    if (executionMode === 'parallel' && contextMode === 'chain') {
      throw new AgentTeamError('contextMode "chain" requires serial execution', 'INVALID_DISPATCH')
    }
    // Reject malformed caller overrides before creating a durable run record.
    if (request.assignments !== undefined || request.memberOrder !== undefined) {
      this.resolveMembers(squad, request.assignments, request.memberOrder)
    }
    const dispatchId = DispatchId(randomUUID())
    const startedAt = Date.now()
    const controller = new AbortController()
    this.activeRunControllers.set(dispatchId, controller)
    const runSignal = AbortSignal.any([signal, controller.signal])
    const shouldPlan = squad.executionOrder === undefined
      && request.memberOrder === undefined
      && request.assignments === undefined
      && (trace.sourceMessageId !== undefined || squad.leaderAgentId !== undefined)
    const initial: SquadRunRecord = {
      id: dispatchId,
      sessionId: trace.sessionId ?? parent.id,
      ...trace.sourceMessageId === undefined ? {} : { sourceMessageId: trace.sourceMessageId },
      ...parent.session.header.cwd === undefined ? {} : { projectKey: parent.session.header.cwd },
      squadId: request.squadId,
      squadName: squad.name,
      task: request.task,
      executionMode,
      contextMode,
      status: shouldPlan ? 'planning' : 'running',
      startedAt,
      members: squad.members.map((id) => {
        const record = this.agents().get(id)
        return {
          agentId: id,
          agentName: record?.name ?? String(id),
          provider: record?.provider ?? '',
          model: record?.model ?? '',
          status: 'pending' as const,
          attempts: 0,
          output: [],
        }
      }),
      usage: { ...ZERO_USAGE },
    }
    await this.runs().put(dispatchId, initial)
    const plan = shouldPlan
      ? await this.createAutomaticPlan(squad, request.task, parent, runSignal, trace.sourceMessageId !== undefined)
      : undefined
    await this.updateRun(dispatchId, run => ({
      ...run,
      status: 'running',
      ...plan === undefined ? {} : { plan, usage: this.addUsage(plan.usage) },
    }))
    const members = this.resolveMembers(
      squad,
      request.assignments ?? (plan !== undefined && plan.assignments.length > 0 ? plan.assignments : undefined),
      request.memberOrder ?? plan?.memberOrder,
    )
    const provider = contextMode === 'fork' ? 'fork' : this.config.defaultProvider
    let results: SquadMemberResult[]
    try {
      results = []
      if (executionMode === 'parallel') {
        const concurrency = Math.min(squad.maxConcurrency ?? members.length, members.length)
        for (let offset = 0; offset < members.length; offset += concurrency) {
          const batch = members.slice(offset, offset + concurrency)
          results.push(...await Promise.all(batch.map(member =>
            this.runMemberWithPolicy(provider, squad, member, request.task, '', parent, runSignal, dispatchId))))
          const used = this.addUsage(plan?.usage, ...results.map(result => result.usage))
          if (runSignal.aborted || ((squad.failurePolicy ?? 'continue') === 'stop' && results.some(item => item.status === 'failed'))
            || (squad.tokenBudget !== undefined && used.totalTokens >= squad.tokenBudget)) break
        }
      } else {
        let chainText = ''
        for (const member of members) {
          if (runSignal.aborted) break
          const result = await this.runMemberWithPolicy(provider, squad, member, request.task, chainText, parent, runSignal, dispatchId)
          results.push(result)
          if (contextMode === 'chain') chainText = this.resultText(result.output)
          const used = this.addUsage(plan?.usage, ...results.map(item => item.usage))
          if (((squad.failurePolicy ?? 'continue') === 'stop' && result.status === 'failed')
            || (squad.tokenBudget !== undefined && used.totalTokens >= squad.tokenBudget)) break
        }
      }
      const executed = new Set(results.map(result => result.agentId))
      for (const member of members.filter(item => !executed.has(item.id))) {
        await this.updateRunMember(dispatchId, member.id, current => ({
          ...current,
          status: runSignal.aborted ? 'cancelled' : 'skipped',
          endedAt: Date.now(),
          error: runSignal.aborted ? 'run cancelled before this member started' : 'skipped by failure or token-budget policy',
        }))
      }
      const completed = results.filter(result => result.status === 'completed').length
      const endedAt = Date.now()
      const usage = this.addUsage(plan?.usage, ...results.map(result => result.usage))
      const status = runSignal.aborted ? 'failed'
        : completed === members.length ? 'completed'
          : completed === 0 ? 'failed' : 'partial'
      const result: SquadDispatchResult = {
        dispatchId,
        squadId: request.squadId,
        squadName: squad.name,
        task: request.task,
        executionMode,
        contextMode,
        status,
        members: results,
        usage,
        startedAt,
        endedAt,
        ...plan === undefined ? {} : { plan },
      }
      await this.updateRun(dispatchId, run => ({
        ...run,
        status: runSignal.aborted ? 'cancelled' : status,
        endedAt,
        usage,
        ...plan === undefined ? {} : { plan },
      }))
      return result
    } finally {
      this.activeRunControllers.delete(dispatchId)
    }
  }

  /** Newest-first durable run history, optionally scoped to one parent session. */
  listRuns(sessionId?: SessionId, limit = 50): SquadRunRecord[] {
    return [...this.runs().entries()].map(([, run]) => run)
      .filter(run => sessionId === undefined || run.sessionId === sessionId)
      .sort((left, right) => right.startedAt - left.startedAt)
      .slice(0, Math.max(1, Math.min(limit, 200)))
  }

  getRun(id: DispatchId): SquadRunRecord | undefined {
    return this.runs().get(id)
  }

  cancelRun(id: DispatchId): boolean {
    const controller = this.activeRunControllers.get(id)
    if (controller === undefined) return false
    controller.abort(new Error('cancelled from Agent Team GUI'))
    return true
  }
}

export default AgentTeamService

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentTeamGui: AgentTeamService
  }
}
