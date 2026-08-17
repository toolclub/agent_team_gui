/** Web UI 与 host service 之间的 loopback-only Connection RPC 适配层。 */

import type { Context } from '@deepseek-ai/cordis'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { SessionId } from '@deepseek-ai/dsh-session'
import { z, ZodError } from 'zod'
import type { AgentTeamService } from './index.ts'
import { AgentTeamError } from './index.ts'
import { AgentId, DispatchId, SquadId } from './types.ts'

/** 与浏览器入口共享的 RPC channel。 */
export const AGENT_TEAM_RPC_CHANNEL = '/agent-team-gui'
/** Browser/host contract revision. A snapshot handshake prevents mixed-version UIs. */
export const AGENT_TEAM_RPC_API_VERSION = 2

const emptySchema = z.object({}).strict()
const idSchema = z.string().min(1)
const agentInputSchema = z.object({
  name: z.string().trim().min(1),
  systemPrompt: z.string(),
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  maxTokens: z.number().int().positive().optional(),
  toolScope: z.object({
    allow: z.array(z.string().min(1)).min(1).optional(),
    deny: z.array(z.string().min(1)).min(1).optional(),
  }).refine(value => value.allow !== undefined || value.deny !== undefined).optional(),
  fallbackProvider: z.string().trim().min(1).optional(),
  fallbackModel: z.string().trim().min(1).optional(),
}).strict()
const squadInputSchema = z.object({
  name: z.string().trim().min(1),
  members: z.array(idSchema),
  collabNote: z.string().optional(),
  executionOrder: z.array(idSchema).optional(),
  executionMode: z.enum(['serial', 'parallel']).optional(),
  contextMode: z.enum(['spawn', 'fork', 'chain']).optional(),
  leaderAgentId: idSchema.optional(),
  triggerMode: z.enum(['guaranteed', 'model-tool']).optional(),
  failurePolicy: z.enum(['continue', 'stop', 'retry-once']).optional(),
  maxConcurrency: z.number().int().positive().max(32).optional(),
  memberTimeoutMs: z.number().int().min(1_000).max(3_600_000).optional(),
  tokenBudget: z.number().int().positive().optional(),
}).strict()
const assignmentSchema = z.object({ agentId: idSchema, task: z.string().min(1) }).strict()
const dispatchInputSchema = z.object({
  sessionId: idSchema,
  squadId: idSchema,
  task: z.string().trim().min(1),
  assignments: z.array(assignmentSchema).min(1).optional(),
  memberOrder: z.array(idSchema).min(1).optional(),
  executionMode: z.enum(['serial', 'parallel']).optional(),
  contextMode: z.enum(['spawn', 'fork', 'chain']).optional(),
}).strict()

type AgentInput = z.infer<typeof agentInputSchema>
type SquadInput = z.infer<typeof squadInputSchema>

function agentRecord(input: AgentInput) {
  return {
    name: input.name,
    systemPrompt: input.systemPrompt,
    provider: input.provider,
    model: input.model,
    ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
    ...(input.toolScope === undefined ? {} : {
      toolScope: {
        ...(input.toolScope.allow === undefined ? {} : { allow: input.toolScope.allow }),
        ...(input.toolScope.deny === undefined ? {} : { deny: input.toolScope.deny }),
      },
    }),
    ...(input.fallbackProvider === undefined ? {} : { fallbackProvider: input.fallbackProvider }),
    ...(input.fallbackModel === undefined ? {} : { fallbackModel: input.fallbackModel }),
  }
}

function squadRecord(input: SquadInput) {
  return {
    name: input.name,
    members: input.members.map(AgentId),
    ...(input.collabNote === undefined ? {} : { collabNote: input.collabNote }),
    ...(input.executionOrder === undefined ? {} : { executionOrder: input.executionOrder.map(AgentId) }),
    ...(input.executionMode === undefined ? {} : { executionMode: input.executionMode }),
    ...(input.contextMode === undefined ? {} : { contextMode: input.contextMode }),
    ...(input.leaderAgentId === undefined ? {} : { leaderAgentId: AgentId(input.leaderAgentId) }),
    ...(input.triggerMode === undefined ? {} : { triggerMode: input.triggerMode }),
    ...(input.failurePolicy === undefined ? {} : { failurePolicy: input.failurePolicy }),
    ...(input.maxConcurrency === undefined ? {} : { maxConcurrency: input.maxConcurrency }),
    ...(input.memberTimeoutMs === undefined ? {} : { memberTimeoutMs: input.memberTimeoutMs }),
    ...(input.tokenBudget === undefined ? {} : { tokenBudget: input.tokenBudget }),
  }
}

const snapshotSchema = z.object({
  apiVersion: z.literal(AGENT_TEAM_RPC_API_VERSION),
  agents: z.array(z.object({ id: z.string(), ...agentInputSchema.shape })),
  squads: z.array(z.object({
    id: z.string(), name: z.string(), members: z.array(z.string()), collabNote: z.string(),
    executionOrder: z.array(z.string()).optional(),
    executionMode: z.enum(['serial', 'parallel']).optional(),
    contextMode: z.enum(['spawn', 'fork', 'chain']).optional(),
    leaderAgentId: z.string().optional(),
    triggerMode: z.enum(['guaranteed', 'model-tool']).optional(),
    failurePolicy: z.enum(['continue', 'stop', 'retry-once']).optional(),
    maxConcurrency: z.number().optional(),
    memberTimeoutMs: z.number().optional(),
    tokenBudget: z.number().optional(),
  })),
  models: z.array(z.object({
    provider: z.string(),
    name: z.string(),
    models: z.array(z.object({ id: z.string(), name: z.string() })),
  })),
  tools: z.array(z.object({ name: z.string(), description: z.string() })),
})

function success<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}

function failure(error: unknown, signal: AbortSignal): RpcResult<never> {
  if (signal.aborted) {
    return { ok: false, error: { code: 'cancelled', message: 'agent team request was cancelled', details: {} } }
  }
  if (error instanceof ZodError) {
    return {
      ok: false,
      error: { code: 'bad-request', message: error.issues.map(issue => issue.message).join('; '), details: { issues: error.issues } },
    }
  }
  if (error instanceof AgentTeamError) {
    return {
      ok: false,
      error: { code: 'bad-request', message: `${error.code}: ${error.message}`, details: { issues: [] } },
    }
  }
  return {
    ok: false,
    error: { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} },
  }
}

async function readSnapshot(ctx: Context, service: AgentTeamService) {
  const models = await Promise.all(ctx.llm.listProviders().map(async (provider) => {
    try {
      return {
        provider: provider.id,
        name: provider.name,
        models: (await ctx.llm.listModels(provider.id)).map(model => ({ id: model.id, name: model.name })),
      }
    } catch (error: unknown) {
      ctx.logger.warn(`[agent-team-gui] model catalog failed for ${provider.id}: ${error instanceof Error ? error.message : String(error)}`)
      return { provider: provider.id, name: provider.name, models: [] }
    }
  }))
  return snapshotSchema.parse({
    apiVersion: AGENT_TEAM_RPC_API_VERSION,
    agents: service.listAgents().map(([id, record]) => ({ id, ...record })),
    squads: service.listSquads().map(([id, record]) => ({ id, ...record, collabNote: record.collabNote ?? '' })),
    models,
    tools: ctx.tools.schemas().map(tool => ({ name: tool.name, description: tool.description })),
  })
}

/** 创建逐 endpoint 校验的 RPC handler；所有失败使用 dsh 已有闭合 RpcError。 */
export function createAgentTeamRpcHandler(ctx: Context, service: AgentTeamService): ConnectionRpcHandler {
  return async (endpoint, rawPayload, signal) => {
    try {
      switch (endpoint) {
        case 'snapshot': {
          emptySchema.parse(rawPayload)
          return success(await readSnapshot(ctx, service))
        }
        case 'agent/create': {
          const payload = z.object({ record: agentInputSchema }).strict().parse(rawPayload)
          return success({ id: await service.createAgent(agentRecord(payload.record)) })
        }
        case 'agent/update': {
          const payload = z.object({ id: idSchema, record: agentInputSchema }).strict().parse(rawPayload)
          await service.updateAgent(AgentId(payload.id), agentRecord(payload.record))
          return success({ updated: true })
        }
        case 'agent/delete': {
          const payload = z.object({ id: idSchema }).strict().parse(rawPayload)
          return success({ deleted: await service.deleteAgent(AgentId(payload.id)) })
        }
        case 'squad/create': {
          const payload = z.object({ record: squadInputSchema }).strict().parse(rawPayload)
          return success({ id: await service.createSquad(squadRecord(payload.record)) })
        }
        case 'squad/update': {
          const payload = z.object({ id: idSchema, record: squadInputSchema }).strict().parse(rawPayload)
          await service.updateSquad(SquadId(payload.id), squadRecord(payload.record))
          return success({ updated: true })
        }
        case 'squad/delete': {
          const payload = z.object({ id: idSchema }).strict().parse(rawPayload)
          return success({ deleted: await service.deleteSquad(SquadId(payload.id)) })
        }
        case 'squad/versions': {
          const payload = z.object({ id: idSchema }).strict().parse(rawPayload)
          return success(service.listSquadVersions(SquadId(payload.id)))
        }
        case 'squad/restore': {
          const payload = z.object({ id: idSchema, version: z.number().int().positive() }).strict().parse(rawPayload)
          await service.restoreSquadVersion(SquadId(payload.id), payload.version)
          return success({ restored: true })
        }
        case 'squad/diagnose': {
          const payload = z.object({ id: idSchema }).strict().parse(rawPayload)
          return success(await service.diagnoseSquad(SquadId(payload.id)))
        }
        case 'mode/get': {
          const payload = z.object({ sessionId: idSchema }).strict().parse(rawPayload)
          const parent = ctx.agents.get(SessionId(payload.sessionId))
          const projectKey = parent === undefined ? undefined : service.projectKeyFor(parent)
          return success({
            mode: parent === undefined
              ? service.getSessionSquadMode(SessionId(payload.sessionId)) ?? null
              : service.getEffectiveSessionSquadMode(parent) ?? null,
            projectKey: projectKey ?? null,
            projectDefault: projectKey === undefined ? null : service.getProjectDefault(projectKey) ?? null,
          })
        }
        case 'project/default-set': {
          const payload = z.object({ sessionId: idSchema, squadId: idSchema.nullable() }).strict().parse(rawPayload)
          const parent = ctx.agents.get(SessionId(payload.sessionId))
          if (parent === undefined) {
            return { ok: false, error: { code: 'session-not-found', message: `no live parent agent for session ${payload.sessionId}`, details: { sessionId: SessionId(payload.sessionId) } } }
          }
          const projectKey = service.projectKeyFor(parent)
          if (projectKey === undefined) return success({ projectKey: null, projectDefault: null })
          return success({
            projectKey,
            projectDefault: await service.setProjectDefault(projectKey, payload.squadId === null ? undefined : SquadId(payload.squadId)) ?? null,
          })
        }
        case 'mode/set': {
          const payload = z.object({ sessionId: idSchema, squadId: idSchema.nullable() }).strict().parse(rawPayload)
          return success({
            mode: await service.setSessionSquadMode(
              SessionId(payload.sessionId),
              payload.squadId === null ? undefined : SquadId(payload.squadId),
            ) ?? null,
          })
        }
        case 'export': {
          emptySchema.parse(rawPayload)
          return success(await service.exportDefinitions())
        }
        case 'import': {
          const payload = z.object({
            doc: z.unknown(),
            mode: z.enum(['merge', 'replace']).optional(),
          }).strict().parse(rawPayload)
          return success(await service.importDefinitions(payload.doc, payload.mode ?? 'merge'))
        }
        case 'dispatch': {
          const payload = dispatchInputSchema.parse(rawPayload)
          const parent = ctx.agents.get(SessionId(payload.sessionId))
          if (parent === undefined) {
            return {
              ok: false,
              error: {
                code: 'session-not-found',
                message: `no live parent agent for session ${payload.sessionId}`,
                details: { sessionId: SessionId(payload.sessionId) },
              },
            }
          }
          return success(await service.dispatch({
            squadId: SquadId(payload.squadId),
            task: payload.task,
            ...payload.assignments === undefined ? {} : {
              assignments: payload.assignments.map(item => ({ agentId: AgentId(item.agentId), task: item.task })),
            },
            ...payload.memberOrder === undefined ? {} : { memberOrder: payload.memberOrder.map(AgentId) },
            ...payload.executionMode === undefined ? {} : { executionMode: payload.executionMode },
            ...payload.contextMode === undefined ? {} : { contextMode: payload.contextMode },
          }, parent, signal, { sessionId: SessionId(payload.sessionId) }))
        }
        case 'run/list': {
          const payload = z.object({ sessionId: idSchema.optional(), limit: z.number().int().positive().max(200).optional() }).strict().parse(rawPayload)
          return success({ runs: service.listRuns(payload.sessionId === undefined ? undefined : SessionId(payload.sessionId), payload.limit ?? 50) })
        }
        case 'run/get': {
          const payload = z.object({ id: idSchema }).strict().parse(rawPayload)
          return success({ run: service.getRun(DispatchId(payload.id)) ?? null })
        }
        case 'run/cancel': {
          const payload = z.object({ id: idSchema }).strict().parse(rawPayload)
          return success({ cancelled: service.cancelRun(DispatchId(payload.id)) })
        }
        default:
          return {
            ok: false,
            error: { code: 'bad-request', message: `unknown agent team endpoint ${endpoint}`, details: { issues: [] } },
          }
      }
    } catch (error: unknown) {
      return failure(error, signal)
    }
  }
}

/** Connection 是 Web 可选服务；headless 仍可加载 host service 与模型工具。 */
export function registerAgentTeamRpc(ctx: Context, service: AgentTeamService): void {
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.connection.rpc.handle(
      AGENT_TEAM_RPC_CHANNEL,
      createAgentTeamRpcHandler(connectionCtx, service),
      { authority: 'loopback' },
    )
  })
}
