import { randomUUID } from 'node:crypto'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
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
  type AgentTeamExportDocument,
  type AgentTeamImportMode,
  type AgentTeamImportResult,
  type SquadAssignment,
  type SquadDispatchRequest,
  type SquadDispatchResult,
  type SquadExportItem,
  type SquadMemberResult,
  type SquadRecord,
} from './types.ts'

export * from './types.ts'
export { agentExportItemSchema, agentRecordSchema, agentTeamDomainSpec, agentTeamExportSchema, squadExportItemSchema, squadRecordSchema } from './spec.ts'
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

/** Durable registry and orchestrator exposed as `ctx.agentTeamGui`. */
export class AgentTeamService extends Service {
  static inject = ['storageDomain', 'tools', 'subagents', 'llm', 'agents']

  static Config: z<Config> = z.object({
    defaultProvider: z.string().default('spawn'),
    defaultExecutionMode: z.union(['serial', 'parallel'] as const).default('serial'),
    defaultContextMode: z.union(['spawn', 'fork', 'chain'] as const).default('spawn'),
  })

  private agentsTable?: KvTable<AgentId, AgentRecord>
  private squadsTable?: KvTable<SquadId, SquadRecord>

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'agentTeamGui')
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(agentTeamDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'agent_team_gui.domainClose')
    this.agentsTable = domain.table('agents')
    this.squadsTable = domain.table('squads')
    this.ctx.tools.register(createDispatchToSquadTool(this))
    registerAgentTeamRpc(this.ctx, this)
    this.ctx.logger.info('[agent-team-gui] durable registry and dispatch_to_squad ready')
  }

  private agents(): KvTable<AgentId, AgentRecord> {
    if (this.agentsTable === undefined) throw new Error('agent_team_gui is not initialized')
    return this.agentsTable
  }

  private squads(): KvTable<SquadId, SquadRecord> {
    if (this.squadsTable === undefined) throw new Error('agent_team_gui is not initialized')
    return this.squadsTable
  }

  private async validateModelRoute(record: AgentRecord): Promise<void> {
    try {
      await this.ctx.llm.resolveModelInfo(record.provider, record.model)
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
      await this.squads().update(squadId, squad => ({
        ...squad,
        members: squad.members.filter(memberId => memberId !== id),
      }))
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

  private validateSquadMembers(members: readonly AgentId[]): void {
    const unique = new Set(members)
    if (unique.size !== members.length) {
      throw new AgentTeamError('squad members must be unique', 'INVALID_MEMBERS')
    }
    const missing = members.filter(id => this.agents().get(id) === undefined)
    if (missing.length > 0) {
      throw new AgentTeamError(`unknown squad members: ${missing.join(', ')}`, 'INVALID_MEMBERS')
    }
  }

  /** Create a squad after validating every member reference. */
  async createSquad(record: SquadRecord, id: SquadId = SquadId(randomUUID())): Promise<SquadId> {
    const parsed = squadRecordSchema.parse(record)
    if (this.squads().get(id) !== undefined) {
      throw new AgentTeamError(`squad "${id}" already exists`, 'SQUAD_EXISTS')
    }
    this.validateSquadMembers(parsed.members)
    await this.squads().put(id, parsed)
    return id
  }

  /** Replace an existing squad after validating every member reference. */
  async updateSquad(id: SquadId, record: SquadRecord): Promise<void> {
    if (this.squads().get(id) === undefined) {
      throw new AgentTeamError(`squad "${id}" does not exist`, 'SQUAD_NOT_FOUND')
    }
    const parsed = squadRecordSchema.parse(record)
    this.validateSquadMembers(parsed.members)
    await this.squads().put(id, parsed)
  }

  /** Delete a squad. */
  async deleteSquad(id: SquadId): Promise<boolean> {
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
      const missing = record.members.filter(memberId => !knownAgents.has(memberId))
      if (missing.length > 0) {
        throw new AgentTeamError(
          `import squad "${id}" references unknown agents: ${missing.join(', ')}`,
          'INVALID_IMPORT',
        )
      }
      return { id: SquadId(id), record }
    })

    if (mode === 'replace') {
      for (const [id] of this.listAgents()) await this.agents().delete(id)
      for (const [id] of this.listSquads()) await this.squads().delete(id)
    }
    for (const { id, record } of agentsToWrite) await this.agents().put(id, record)
    for (const { id, record } of squadsToWrite) await this.squads().put(id, record)
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
    return this.squads().update(squadId, squad => {
      if (squad.members.includes(agentId)) {
        throw new AgentTeamError(`agent "${agentId}" is already in squad "${squadId}"`, 'INVALID_MEMBERS')
      }
      return { ...squad, members: [...squad.members, agentId] }
    })
  }

  /** Remove one member from a squad using storage-domain atomic update. */
  async removeMemberFromSquad(squadId: SquadId, agentId: AgentId): Promise<SquadRecord> {
    if (this.squads().get(squadId) === undefined) {
      throw new AgentTeamError(`squad "${squadId}" does not exist`, 'SQUAD_NOT_FOUND')
    }
    return this.squads().update(squadId, squad => ({
      ...squad,
      members: squad.members.filter(memberId => memberId !== agentId),
    }))
  }

  private resolveMembers(squad: SquadRecord, assignments: readonly SquadAssignment[] | undefined): ResolvedMember[] {
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
    return squad.members.map((id) => {
      const record = this.agents().get(id)
      if (record === undefined) {
        throw new AgentTeamError(`squad references missing agent "${id}"`, 'AGENT_NOT_FOUND')
      }
      return { id, record, task: assignmentByAgent.get(id) ?? '' }
    })
  }

  private promptFor(squad: SquadRecord, member: ResolvedMember, sharedTask: string, chainText: string): string {
    const parts = [
      `Squad task:\n${sharedTask}`,
      ...member.task.length === 0 ? [] : [`Your assigned part:\n${member.task}`],
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

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  private async settleRun(member: ResolvedMember, run: SubagentRun): Promise<SquadMemberResult> {
    let result: SubagentResult | undefined
    let executionError: unknown
    try {
      result = await run.result
    } catch (error: unknown) {
      executionError = error
    }
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
  ): Promise<SquadMemberResult> {
    const prompt = this.promptFor(squad, member, sharedTask, chainText)
    this.ctx.logger.info(`[agent-team-gui] starting ${squad.name}/${member.record.name}`)
    try {
      const run = await this.ctx.subagents.start(provider, {
        label: `${squad.name}/${member.record.name}`,
        prompt: [{ type: 'text', text: prompt }],
        parent,
        signal,
        agentOptions: {
          provider: member.record.provider,
          model: member.record.model,
          ...member.record.maxTokens === undefined ? {} : { maxTokens: member.record.maxTokens },
        },
        ...member.record.toolScope === undefined ? {} : { toolFilter: member.record.toolScope },
        ...member.record.systemPrompt.length === 0 ? {} : { persona: member.record.systemPrompt },
      })
      const settled = await this.settleRun(member, run)
      this.ctx.logger.info(`[agent-team-gui] finished ${squad.name}/${member.record.name}: ${settled.status}`)
      return settled
    } catch (error: unknown) {
      const message = this.errorText(error)
      this.ctx.logger.warn(`[agent-team-gui] failed ${squad.name}/${member.record.name}: ${message}`)
      return {
        agentId: member.id,
        agentName: member.record.name,
        status: 'failed',
        output: [],
        error: `start failed: ${message}`,
      }
    }
  }

  /**
   * Dispatch through the existing subagent providers. Parent `tool/call` and
   * `tool/result` records contain this complete result, while each returned
   * child id points to the provider-owned child Session and its descriptor.
   */
  async dispatch(request: SquadDispatchRequest, parent: Agent, signal: AbortSignal): Promise<SquadDispatchResult> {
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
    const executionMode = request.executionMode ?? this.config.defaultExecutionMode
    const contextMode = request.contextMode ?? this.config.defaultContextMode
    if (executionMode === 'parallel' && contextMode === 'chain') {
      throw new AgentTeamError('contextMode "chain" requires serial execution', 'INVALID_DISPATCH')
    }
    const members = this.resolveMembers(squad, request.assignments)
    const provider = contextMode === 'fork' ? 'fork' : this.config.defaultProvider
    let results: SquadMemberResult[]
    if (executionMode === 'parallel') {
      results = await Promise.all(members.map(member =>
        this.runMember(provider, squad, member, request.task, '', parent, signal)))
    } else {
      results = []
      let chainText = ''
      for (const member of members) {
        const result = await this.runMember(provider, squad, member, request.task, chainText, parent, signal)
        results.push(result)
        if (contextMode === 'chain') chainText = this.resultText(result.output)
      }
    }
    const completed = results.filter(result => result.status === 'completed').length
    return {
      dispatchId: DispatchId(randomUUID()),
      squadId: request.squadId,
      squadName: squad.name,
      task: request.task,
      executionMode,
      contextMode,
      status: completed === results.length ? 'completed' : completed === 0 ? 'failed' : 'partial',
      members: results,
    }
  }
}

export default AgentTeamService

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentTeamGui: AgentTeamService
  }
}
