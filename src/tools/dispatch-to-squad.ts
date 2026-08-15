import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { AgentId } from '../types.ts'
import type { AgentTeamService } from '../index.ts'

/** Build the model-facing natural-language dispatch tool over the host service. */
export function createDispatchToSquadTool(service: AgentTeamService) {
  return defineTool({
    name: 'dispatch_to_squad',
    description: 'Dispatch a task to a configured agent squad. Use assignments when particular members should do different work.',
    parameters: {
      squadId: {
        type: 'string',
        required: true,
        description: 'Durable squad id or exact configured squad name (case-insensitive).',
      },
      task: {
        type: 'string',
        required: true,
        description: 'Shared task and desired final outcome.',
      },
      assignments: {
        type: 'array',
        description: 'Optional member-specific tasks. Every agentId must be a unique member of the squad.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            agentId: { type: 'string', required: true },
            task: { type: 'string', required: true },
          },
        },
      },
      executionMode: {
        type: 'string',
        enum: ['serial', 'parallel'],
        description: 'Member execution order. Defaults to the plugin setting.',
      },
      contextMode: {
        type: 'string',
        enum: ['spawn', 'fork', 'chain'],
        description: 'spawn starts fresh children; fork seeds parent history; chain passes each prior member result to the next serial member.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dispatchId: { type: 'string', required: true },
          squadId: { type: 'string', required: true },
          squadName: { type: 'string', required: true },
          task: { type: 'string', required: true },
          executionMode: { type: 'string', required: true, enum: ['serial', 'parallel'] },
          contextMode: { type: 'string', required: true, enum: ['spawn', 'fork', 'chain'] },
          status: { type: 'string', required: true, enum: ['completed', 'partial', 'failed'] },
          members: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                agentId: { type: 'string', required: true },
                agentName: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: ['completed', 'failed'] },
                runId: { type: 'string' },
                childId: { type: 'string' },
                stopReason: { type: 'string' },
                output: { type: 'array', required: true, items: { type: 'json' } },
                error: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Squad ${value.squadName} finished ${value.status}: ${value.members.filter(member => member.status === 'completed').length}/${value.members.length} members completed.`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.agent === undefined) {
        throw new Error('dispatch_to_squad requires a calling agent (exec.agent was undefined)')
      }
      const result = await service.dispatch({
        squadId: service.resolveSquadId(args.squadId),
        task: args.task,
        ...args.assignments === undefined ? {} : {
          assignments: args.assignments.map(item => ({ agentId: AgentId(item.agentId), task: item.task })),
        },
        ...args.executionMode === undefined ? {} : { executionMode: args.executionMode },
        ...args.contextMode === undefined ? {} : { contextMode: args.contextMode },
      }, exec.agent, exec.signal)
      return {
        ...result,
        members: result.members.map(member => ({
          ...member,
          output: member.output as unknown as JsonValue[],
        })),
      }
    },
  })
}
