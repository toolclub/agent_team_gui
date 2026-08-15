import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentRuntime, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { describe, expect, it, vi } from 'vitest'
import AgentTeamService, { AgentTeamError } from '../src/index.ts'
import { AgentId, SquadId } from '../src/types.ts'
import type { AgentRecord, SquadRecord } from '../src/types.ts'

class MemoryTable<K extends string, V> implements KvTable<K, V> {
  private readonly values = new Map<K, V>()

  get size(): number {
    return this.values.size
  }

  get(key: K): V | undefined {
    return this.values.get(key)
  }

  entries(): IterableIterator<[K, V]> {
    return new Map(this.values).entries()
  }

  keys(): IterableIterator<K> {
    return new Map(this.values).keys()
  }

  async put(key: K, value: V): Promise<void> {
    this.values.set(key, value)
  }

  async delete(key: K): Promise<boolean> {
    return this.values.delete(key)
  }

  async update(key: K, transform: (current: V) => V): Promise<V> {
    const current = this.values.get(key)
    if (current === undefined) throw new Error(`missing key ${key}`)
    const next = transform(current)
    this.values.set(key, next)
    return next
  }
}

const researcherId = AgentId('researcher')
const writerId = AgentId('writer')
const reviewerId = AgentId('reviewer')
const squadId = SquadId('delivery')

const agent = (name: string, model = name.toLowerCase()): AgentRecord => ({
  name,
  systemPrompt: `You are ${name}.`,
  provider: 'configured',
  model,
})

interface FixtureOptions {
  readonly start?: (provider: string, request: SubagentStartRequest) => ReturnType<SubagentRuntime['start']>
  readonly resolveModelInfo?: LlmRuntime['resolveModelInfo']
}

function fixture(options: FixtureOptions = {}) {
  const ctx = new Context()
  const starts: { provider: string; request: SubagentStartRequest }[] = []
  const subagents = {
    start: options.start ?? (async (provider: string, request: SubagentStartRequest) => {
      starts.push({ provider, request })
      const id = SessionId(`child-${starts.length}`)
      return {
        id,
        localAgent: undefined,
        result: Promise.resolve({
          output: [{ type: 'text' as const, text: request.label ?? '' }],
          stopReason: 'completed' as const,
        }),
        async dispose() {},
      }
    }),
  }
  const llm = {
    resolveModelInfo: options.resolveModelInfo ?? vi.fn(async (provider: string, model: string) => ({
      provider,
      id: model,
      name: model,
    })),
  }
  ctx.provide('subagents', subagents)
  ctx.provide('llm', llm)
  const service = new AgentTeamService(ctx, {
    defaultProvider: 'spawn',
    defaultExecutionMode: 'serial',
    defaultContextMode: 'spawn',
  })
  const agents = new MemoryTable<AgentId, AgentRecord>()
  const squads = new MemoryTable<SquadId, SquadRecord>()
  Object.assign(service, { agentsTable: agents, squadsTable: squads })
  const parent = { id: SessionId('parent') } as unknown as Agent
  return { service, agents, squads, starts, parent }
}

async function populate() {
  const state = fixture()
  await state.agents.put(researcherId, agent('Researcher'))
  await state.agents.put(writerId, agent('Writer'))
  await state.agents.put(reviewerId, agent('Reviewer'))
  await state.squads.put(squadId, {
    name: 'Delivery',
    members: [researcherId, writerId, reviewerId],
    collabNote: 'Return concrete evidence.',
  })
  return state
}

describe('AgentTeamService CRUD', () => {
  it('validates model routes and squad references before durable writes', async () => {
    const resolveModelInfo = vi.fn(async () => { throw new Error('route is not configured') })
    const { service } = fixture({ resolveModelInfo: resolveModelInfo as unknown as LlmRuntime['resolveModelInfo'] })

    await expect(service.createAgent(agent('Unknown'), AgentId('unknown')))
      .rejects.toThrow('invalid model route configured/unknown: route is not configured')
    expect(service.listAgents()).toEqual([])

    const valid = fixture()
    await valid.service.createAgent(agent('Researcher'), researcherId)
    await expect(valid.service.createSquad({ name: 'Bad', members: [researcherId, researcherId] }, SquadId('bad')))
      .rejects.toMatchObject({ code: 'INVALID_MEMBERS' })
    await expect(valid.service.createSquad({ name: 'Missing', members: [AgentId('missing')] }, SquadId('missing')))
      .rejects.toMatchObject({ code: 'INVALID_MEMBERS' })
  })

  it('removes a deleted agent from every squad with atomic table updates', async () => {
    const { service } = await populate()
    await service.createSquad({ name: 'Second', members: [writerId] }, SquadId('second'))

    await expect(service.deleteAgent(writerId)).resolves.toBe(true)
    expect(service.getSquad(squadId)?.members).toEqual([researcherId, reviewerId])
    expect(service.getSquad(SquadId('second'))?.members).toEqual([])
    expect(service.getAgent(writerId)).toBeUndefined()
  })

  it('resolves a unique squad by durable id or exact name for natural-language dispatch', async () => {
    const { service } = await populate()
    expect(service.resolveSquadId('delivery')).toBe(squadId)
    expect(service.resolveSquadId('  DELIVERY  ')).toBe(squadId)
    await service.createSquad({ name: 'Delivery', members: [researcherId] }, SquadId('delivery-duplicate'))
    expect(() => service.resolveSquadId('Delivery')).toThrow('ambiguous')
  })
})

describe('AgentTeamService dispatch', () => {
  it('chains serial output, preserves child ids, and continues after member failures', async () => {
    const requests: SubagentStartRequest[] = []
    let call = 0
    const state = fixture({
      start: async (_provider, request) => {
        requests.push(request)
        call += 1
        if (call === 3) throw new Error('provider unavailable')
        const id = SessionId(`child-${call}`)
        return {
          id,
          localAgent: { id } as unknown as Agent,
          result: Promise.resolve(call === 1
            ? { output: [{ type: 'text', text: 'research evidence' }], stopReason: 'completed' }
            : { output: [{ type: 'text', text: 'partial draft' }], stopReason: 'max-tokens' }),
          async dispose() {},
        }
      },
    })
    await state.agents.put(researcherId, agent('Researcher'))
    await state.agents.put(writerId, agent('Writer'))
    await state.agents.put(reviewerId, agent('Reviewer'))
    await state.squads.put(squadId, { name: 'Delivery', members: [researcherId, writerId, reviewerId] })

    const result = await state.service.dispatch({
      squadId,
      task: 'Ship the report',
      executionMode: 'serial',
      contextMode: 'chain',
      assignments: [{ agentId: writerId, task: 'Write the final prose' }],
    }, state.parent, new AbortController().signal)

    expect(requests).toHaveLength(3)
    expect(requests[1]?.prompt[0]).toMatchObject({ text: expect.stringContaining('research evidence') })
    expect(requests[1]?.prompt[0]).toMatchObject({ text: expect.stringContaining('Write the final prose') })
    expect(result.status).toBe('partial')
    expect(result.members).toMatchObject([
      { status: 'completed', runId: 'child-1', childId: 'child-1', stopReason: 'completed' },
      { status: 'failed', runId: 'child-2', stopReason: 'max-tokens', error: expect.stringContaining('max-tokens') },
      { status: 'failed', error: 'start failed: provider unavailable' },
    ])
  })

  it('rejects ambiguous dispatch inputs before starting children', async () => {
    const { service, starts, parent, squads } = await populate()
    const signal = new AbortController().signal

    await expect(service.dispatch({ squadId, task: 'x', executionMode: 'parallel', contextMode: 'chain' }, parent, signal))
      .rejects.toMatchObject({ code: 'INVALID_DISPATCH' })
    await expect(service.dispatch({
      squadId,
      task: 'x',
      assignments: [
        { agentId: researcherId, task: 'one' },
        { agentId: researcherId, task: 'two' },
      ],
    }, parent, signal)).rejects.toMatchObject({ code: 'INVALID_ASSIGNMENTS' })
    await expect(service.dispatch({
      squadId,
      task: 'x',
      assignments: [{ agentId: AgentId('outsider'), task: 'one' }],
    }, parent, signal)).rejects.toMatchObject({ code: 'INVALID_ASSIGNMENTS' })
    await squads.put(SquadId('empty'), { name: 'Empty', members: [] })
    await expect(service.dispatch({ squadId: SquadId('empty'), task: 'x' }, parent, signal))
      .rejects.toMatchObject({ code: 'INVALID_DISPATCH' })
    expect(starts).toEqual([])
  })

  it('reports cleanup failure without replacing other member outcomes', async () => {
    const state = fixture({
      start: async () => ({
        id: SessionId('cleanup-child'),
        localAgent: undefined,
        result: Promise.resolve({ output: [{ type: 'text', text: 'answer' }], stopReason: 'completed' }),
        async dispose() { throw new Error('cleanup broke') },
      }),
    })
    await state.agents.put(researcherId, agent('Researcher'))
    await state.squads.put(squadId, { name: 'Delivery', members: [researcherId] })

    const result = await state.service.dispatch({ squadId, task: 'x' }, state.parent, new AbortController().signal)
    expect(result.status).toBe('failed')
    expect(result.members[0]).toMatchObject({
      runId: 'cleanup-child',
      output: [{ type: 'text', text: 'answer' }],
      error: 'run cleanup failed: cleanup broke',
    })
  })
})

it('exposes stable typed errors to RPC callers', () => {
  expect(new AgentTeamError('bad', 'INVALID_DISPATCH')).toMatchObject({
    name: 'AgentTeamError',
    code: 'INVALID_DISPATCH',
  })
})
