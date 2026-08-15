import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { AgentExportItem, AgentId, AgentRecord, AgentTeamExportDocument, SquadExportItem, SquadId, SquadRecord } from './types.ts'

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
}).strict()

/** Durable agent validation, also applied before service writes. */
export const agentRecordSchema = agentFields as unknown as z.ZodType<AgentRecord>

/** Shared squad field validation; reused by the durable table and the export document. */
const squadFields = z.object({
  name: z.string().trim().min(1),
  members: z.array(z.string().min(1).transform(value => value as AgentId)),
  collabNote: z.string().optional(),
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

/** One versioned domain containing both definition tables. */
export const agentTeamDomainSpec = defineDomain({
  name: 'agent_team_gui',
  version: 0,
  tables: {
    agents: domainTable<AgentId, AgentRecord>(agentRecordSchema),
    squads: domainTable<SquadId, SquadRecord>(squadRecordSchema),
  },
})
