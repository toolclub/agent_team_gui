/** agent_team_gui 浏览器入口：Settings 小队页 + 输入区小队模式。 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  AgentTeamController,
  CLIENT_STYLES,
  TeamComposerControl,
  TeamRunCenter,
  TeamRunDock,
  TeamSettingsPage,
} from './AgentTeamDashboard.tsx'

/** 浏览器侧依赖；模块加载器会在这些服务就绪后调用 apply。 */
export const inject = ['slots', 'connection']

/** agent_team_gui 使用的独立 Connection RPC channel。 */
export const RPC_CHANNEL = '/agent-team-gui'

/** 将管理页和会话模式控件贡献到 dsh 的既有 additive slots。 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  const call = async <T,>(endpoint: string, payload: unknown): Promise<T> => {
    const result = await connection.rpc.call(RPC_CHANNEL, endpoint, payload)
    if (!result.ok) {
      throw new Error(`${result.error.code}: ${result.error.message}`)
    }
    return result.value as T
  }
  const controller = new AgentTeamController(call)

  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.agentTeamGui = 'true'
    style.textContent = CLIENT_STYLES
    document.head.append(style)
    return () => { style.remove() }
  }, 'agent-team-gui: theme-token styles')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'agent-teams',
    order: 25,
    label: () => localeIsZh() ? '小队' : 'Teams',
    inject: () => ({ controller }),
  }, TeamSettingsPage))

  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'agent-team-gui-mode',
    order: 80,
    inject: () => ({ controller }),
  }, TeamComposerControl))

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'agent-team-run-dock',
    order: 15,
    inject: () => ({ controller }),
  }, TeamRunDock))

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'agent-team-runs',
    order: 20,
    label: () => localeIsZh() ? '小队运行' : 'Team runs',
    inject: () => ({ controller }),
  }, TeamRunCenter))
}

function localeIsZh(): boolean {
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh')
}
