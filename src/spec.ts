import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentExportItem, AgentId, AgentRecord, AgentTeamExportDocument, DispatchId, ProjectSquadDefaultRecord, SessionSquadModeRecord, SquadExportItem, SquadId, SquadRecord, SquadRunRecord, SquadVersionRecord } from './types.ts'

/** Shared agent field validation; reused by the durable table and the export document. */
const agentFields = z.object({
  name: z.string().trim().min(1),
  systemPrompt: z.string(),
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  maxTokens: z.number().int().positive().optional(),
  toolScope: z.object({
    allow: z.array(z.string().min(1)).min(1).optional(),
    deny: z.array(z.string().min(1)).min(1).optional(),
  }).refine(scope => scope.allow !== undefined || scope.deny !== undefined, {
    message: 'toolScope must declare allow or deny',
  }).optional(),
  fallbackProvider: z.string().trim().min(1).optional(),
  fallbackModel: z.string().trim().min(1).optional(),
}).strict()

/** Durable agent validation, also applied before service writes. */
export const agentRecordSchema = agentFields as unknown as z.ZodType<AgentRecord>

/** Shared squad field validation; reused by the durable table and the export document. */
const squadFields = z.object({
  name: z.string().trim().min(1),
  members: z.array(z.string().min(1).transform(value => value as AgentId)),
  collabNote: z.string().optional(),
  executionOrder: z.array(z.string().min(1).transform(value => value as AgentId)).optional(),
  executionMode: z.enum(['serial', 'parallel']).optional(),
  contextMode: z.enum(['spawn', 'fork', 'chain']).optional(),
  leaderAgentId: z.string().min(1).transform(value => value as AgentId).optional(),
  triggerMode: z.enum(['guaranteed', 'model-tool']).optional(),
  failurePolicy: z.enum(['continue', 'stop', 'retry-once']).optional(),
  maxConcurrency: z.number().int().positive().max(32).optional(),
  memberTimeoutMs: z.number().int().min(1_000).max(3_600_000).optional(),
  tokenBudget: z.number().int().positive().optional(),
}).strict()

/** Durable squad validation, also applied before service writes. */
export const squadRecordSchema = squadFields as unknown as z.ZodType<SquadRecord>

/** One agent row of an import/export document; the durable fields plus its id. */
export const agentExportItemSchema = z.object({
  id: z.string().min(1),
  ...agentFields.shape,
}).strict() as unknown as z.ZodType<AgentExportItem>

/** One squad row of an import/export document; the durable fields plus its id. */
export const squadExportItemSchema = z.object({
  id: z.string().min(1),
  ...squadFields.shape,
}).strict() as unknown as z.ZodType<SquadExportItem>

/** Versioned document exchanged by export/import. Bump `version` on breaking shape changes. */
export const agentTeamExportSchema = z.object({
  format: z.literal('agent-team-gui/definitions'),
  version: z.literal(1),
  agents: z.array(agentExportItemSchema),
  squads: z.array(squadExportItemSchema),
}).strict() as unknown as z.ZodType<AgentTeamExportDocument>

/** Durable session-to-squad mode selection. */
export const sessionSquadModeSchema = z.object({
  squadId: z.string().min(1).transform(value => value as SquadId).optional(),
  disabled: z.boolean().optional(),
}).strict().refine(value => value.disabled === true || value.squadId !== undefined, {
  message: 'session mode must select a squad or explicitly disable project defaults',
}) as unknown as z.ZodType<SessionSquadModeRecord>

const usageSchema = z.object({
  uncachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  providerReported: z.boolean(),
}).strict()

const assignmentSchema = z.object({
  agentId: z.string().min(1).transform(value => value as AgentId),
  task: z.string(),
}).strict()

const planSchema = z.object({
  summary: z.string(),
  memberOrder: z.array(z.string().min(1).transform(value => value as AgentId)),
  assignments: z.array(assignmentSchema),
  leaderAgentId: z.string().min(1).transform(value => value as AgentId).optional(),
  usage: usageSchema.optional(),
  warning: z.string().optional(),
}).strict()

const runMemberSchema = z.object({
  agentId: z.string().min(1).transform(value => value as AgentId),
  agentName: z.string(),
  provider: z.string(),
  model: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled', 'skipped']),
  attempts: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative().optional(),
  endedAt: z.number().int().nonnegative().optional(),
  runId: z.string().optional(),
  childId: z.string().optional(),
  stopReason: z.string().optional(),
  output: z.array(z.unknown()),
  error: z.string().optional(),
  usage: usageSchema.optional(),
}).strict()

/** Durable run-center row; output blocks remain provider-neutral JSON. */
export const squadRunRecordSchema = z.object({
  id: z.string().min(1).transform(value => value as DispatchId),
  sessionId: z.string().min(1).transform(value => value as SessionId),
  sourceMessageId: z.string().optional(),
  projectKey: z.string().optional(),
  squadId: z.string().min(1).transform(value => value as SquadId),
  squadName: z.string(),
  task: z.string(),
  executionMode: z.enum(['serial', 'parallel']),
  contextMode: z.enum(['spawn', 'fork', 'chain']),
  status: z.enum(['planning', 'running', 'completed', 'partial', 'failed', 'cancelled']),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().optional(),
  members: z.array(runMemberSchema),
  usage: usageSchema,
  plan: planSchema.optional(),
  error: z.string().optional(),
}).strict() as unknown as z.ZodType<SquadRunRecord>

export const squadVersionRecordSchema = z.object({
  squadId: z.string().min(1).transform(value => value as SquadId),
  version: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
  record: squadFields,
}).strict() as unknown as z.ZodType<SquadVersionRecord>

export const projectSquadDefaultRecordSchema = z.object({
  projectKey: z.string().min(1),
  squadId: z.string().min(1).transform(value => value as SquadId),
  enabled: z.boolean(),
}).strict() as unknown as z.ZodType<ProjectSquadDefaultRecord>

/** One versioned domain containing both definition tables. */
export const agentTeamDomainSpec = defineDomain({
  name: 'agent_team_gui',
  // Adding a table is backward-compatible for both bundled backends. Keep v0:
  // storage-domain intentionally rejects version bumps and has no migration API.
  version: 0,
  tables: {
    agents: domainTable<AgentId, AgentRecord>(agentRecordSchema),
    squads: domainTable<SquadId, SquadRecord>(squadRecordSchema),
    session_modes: domainTable<SessionId, SessionSquadModeRecord>(sessionSquadModeSchema),
    runs: domainTable<DispatchId, SquadRunRecord>(squadRunRecordSchema),
    squad_versions: domainTable<string, SquadVersionRecord>(squadVersionRecordSchema),
    project_defaults: domainTable<string, ProjectSquadDefaultRecord>(projectSquadDefaultRecordSchema),
  },
})
