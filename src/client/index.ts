/** agent_team_gui 的浏览器入口：在输入框旁加入派单按钮，并挂载管理面板。 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { AgentTeamDashboard, DispatchButton, DashboardController } from './AgentTeamDashboard.tsx'

/** 浏览器侧依赖；模块加载器会在这些服务就绪后调用 apply。 */
export const inject = ['slots', 'connection', 'sessions']

/** agent_team_gui 使用的独立 Connection RPC channel。 */
export const RPC_CHANNEL = '/agent-team-gui'

/** 将管理面板和输入框旁的派单入口贡献到 dsh 的既有 slot。 */
export function apply(ctx: ClientContext): void {
  const controller = new DashboardController()
  const connection = ctx.get('connection') as ConnectionHandle
  const call = async <T,>(endpoint: string, payload: unknown): Promise<T> => {
    const result = await connection.rpc.call(RPC_CHANNEL, endpoint, payload)
    if (!result.ok) {
      throw new Error(`${result.error.code}: ${result.error.message}`)
    }
    return result.value as T
  }

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'agent-team-gui-dashboard',
    order: 100,
    inject: () => ({ controller, call }),
  }, AgentTeamDashboard))

  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'agent-team-gui-dispatch',
    order: 100,
    inject: () => ({ controller }),
  }, DispatchButton))
}
