/** Web UI 与 host service 之间的 loopback-only Connection RPC 适配层。 */

import type { Context } from '@deepseek-ai/cordis'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { SessionId } from '@deepseek-ai/dsh-session'
import { z, ZodError } from 'zod'
import type { AgentTeamService } from './index.ts'
import { AgentTeamError } from './index.ts'
import { AgentId, SquadId } from './types.ts'

/** 与浏览器入口共享的 RPC channel。 */
export const AGENT_TEAM_RPC_CHANNEL = '/agent-team-gui'

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
}).strict()
const squadInputSchema = z.object({
  name: z.string().trim().min(1),
  members: z.array(idSchema),
  collabNote: z.string().optional(),
}).strict()
const assignmentSchema = z.object({ agentId: idSchema, task: z.string().min(1) }).strict()
const dispatchInputSchema = z.object({
  sessionId: idSchema,
  squadId: idSchema,
  task: z.string().trim().min(1),
  assignments: z.array(assignmentSchema).min(1).optional(),
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
  }
}

function squadRecord(input: SquadInput) {
  return {
    name: input.name,
    members: input.members.map(AgentId),
    ...(input.collabNote === undefined ? {} : { collabNote: input.collabNote }),
  }
}

const snapshotSchema = z.object({
  agents: z.array(z.object({ id: z.string(), ...agentInputSchema.shape })),
  squads: z.array(z.object({
    id: z.string(), name: z.string(), members: z.array(z.string()), collabNote: z.string(),
  })),
  models: z.array(z.object({
    provider: z.string(),
    name: z.string(),
    models: z.array(z.object({ id: z.string(), name: z.string() })),
  })),
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
    agents: service.listAgents().map(([id, record]) => ({ id, ...record })),
    squads: service.listSquads().map(([id, record]) => ({ id, ...record, collabNote: record.collabNote ?? '' })),
    models,
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
            ...payload.executionMode === undefined ? {} : { executionMode: payload.executionMode },
            ...payload.contextMode === undefined ? {} : { contextMode: payload.contextMode },
          }, parent, signal))
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
