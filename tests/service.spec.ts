import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import AgentTeamService, { AgentTeamError } from '../src/index.ts'
import { AgentId, SquadId } from '../src/types.ts'
import { agent, createService, populate, researcherId, reviewerId, squadId, writerId } from './helpers.ts'

describe('AgentTeamService CRUD', () => {
  it('validates model routes and squad references before durable writes', async () => {
    const resolveModelInfo = vi.fn(async () => { throw new Error('route is not configured') })
    const { service } = createService({ resolveModelInfo: resolveModelInfo as unknown as LlmRuntime['resolveModelInfo'] })

    await expect(service.createAgent(agent('Unknown'), AgentId('unknown')))
      .rejects.toThrow('invalid model route configured/unknown: route is not configured')
    expect(service.listAgents()).toEqual([])

    const valid = createService()
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
    const state = createService({
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
    const state = createService({
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
