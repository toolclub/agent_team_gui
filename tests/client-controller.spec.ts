import { describe, expect, it } from 'vitest'
import {
  AGENT_TEAM_RPC_API_VERSION,
  AgentTeamController,
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
})
