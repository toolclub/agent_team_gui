/** Stable public browser exports; implementation is split by responsibility. */
export {
  AGENT_TEAM_RPC_API_VERSION,
  EMPTY_DATA,
  type AgentTeamRpc,
  type AgentView,
  type InsightsView,
  type ModeResponse,
  type RunView,
  type SquadView,
  type TeamSnapshot,
  type TokenUsageView,
} from './contracts.ts'
export {
  AgentTeamController,
  isAuthoritativeModeResponse,
  refreshAgentTeamsOnReconnect,
} from './controller.ts'
export { TeamComposerControl } from './ComposerControl.tsx'
export { TeamRunCenter, TeamRunDock } from './RunCenter.tsx'
export { TeamSettingsPage } from './SettingsPage.tsx'
export { CLIENT_STYLES } from './styles.ts'
export {
  validateAgent,
  validateSquad,
  squadDraftOf,
  agentDraftOf,
  type AgentDraft,
  type SquadDraft,
} from './forms.ts'
export { planStages, completionRate, visibleRunFilter } from './view-models.ts'
