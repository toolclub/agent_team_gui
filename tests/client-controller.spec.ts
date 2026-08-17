import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_TEAM_RPC_API_VERSION,
  AgentTeamController,
  refreshAgentTeamsOnReconnect,
  type TeamSnapshot,
} from '../src/client/AgentTeamDashboard.tsx'

const emptySnapshot = (apiVersion = AGENT_TEAM_RPC_API_VERSION): TeamSnapshot => ({
  apiVersion,
  agents: [],
  squads: [],
  models: [],
  tools: [],
})

describe('AgentTeamController RPC compatibility', () => {
  it('accepts the matching browser/host contract revision', async () => {
    const controller = new AgentTeamController(async <T,>() => emptySnapshot() as T)

    await expect(controller.load()).resolves.toEqual(emptySnapshot())
    expect(controller.getSnapshot().status).toBe('ready')
  })

  it('rejects a stale host before enabling unsupported controls', async () => {
    const controller = new AgentTeamController(async <T,>() => emptySnapshot(0) as T)

    await expect(controller.load()).rejects.toThrow(/Restart DeepSeek Harness/)
    expect(controller.getSnapshot()).toMatchObject({
      status: 'error',
      data: emptySnapshot(),
    })
  })

  it('queues a real forced refresh behind an in-flight cold-start request', async () => {
    let rejectFirst: ((reason: Error) => void) | undefined
    let calls = 0
    const restored = { ...emptySnapshot(), squads: [{ id: 'saved', name: 'Saved team', members: [], collabNote: '' }] }
    const controller = new AgentTeamController(async <T,>() => {
      calls += 1
      if (calls === 1) {
        return await new Promise<T>((_resolve, reject) => { rejectFirst = reject })
      }
      return restored as T
    })

    const initial = controller.load()
    const forced = controller.load(true)
    expect(calls).toBe(1)
    rejectFirst?.(new Error('host is still starting'))

    await expect(initial).rejects.toThrow('host is still starting')
    await expect(forced).resolves.toEqual(restored)
    expect(calls).toBe(2)
    expect(controller.getSnapshot()).toMatchObject({ status: 'ready', data: restored, revision: 1 })
  })

  it('refreshes persisted teams after each completed connection handshake', async () => {
    let connected: object | undefined
    let listener = (): void => {}
    let calls = 0
    const controller = new AgentTeamController(async <T,>() => {
      calls += 1
      return emptySnapshot() as T
    })
    const dispose = refreshAgentTeamsOnReconnect(controller, {
      getSnapshot: () => connected,
      subscribe: (next) => {
        listener = next
        return () => { listener = (): void => {} }
      },
    })

    expect(calls).toBe(0)
    connected = {}
    listener()
    await vi.waitFor(() => { expect(controller.getSnapshot().revision).toBe(1) })
    expect(calls).toBe(1)

    connected = undefined
    listener()
    await Promise.resolve()
    expect(calls).toBe(1)

    connected = {}
    listener()
    await vi.waitFor(() => { expect(controller.getSnapshot().revision).toBe(2) })
    expect(calls).toBe(2)
    dispose()
  })
})
