import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { AgentId, AgentRecord, SquadId, SquadRecord } from './types.ts'

/** Durable agent validation, also applied before service writes. */
export const agentRecordSchema = z.object({
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
}).strict() as unknown as z.ZodType<AgentRecord>

/** Durable squad validation, also applied before service writes. */
export const squadRecordSchema = z.object({
  name: z.string().trim().min(1),
  members: z.array(z.string().min(1).transform(value => value as AgentId)),
  collabNote: z.string().optional(),
}).strict() as unknown as z.ZodType<SquadRecord>

/** One versioned domain containing both definition tables. */
export const agentTeamDomainSpec = defineDomain({
  name: 'agent_team_gui',
  version: 0,
  tables: {
    agents: domainTable<AgentId, AgentRecord>(agentRecordSchema),
    squads: domainTable<SquadId, SquadRecord>(squadRecordSchema),
  },
})
