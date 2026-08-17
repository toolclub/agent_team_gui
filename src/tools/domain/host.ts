/** Runtime defaults shared by the Cordis composition root and application services. */
export interface AgentTeamConfig {
  readonly defaultProvider: string
  readonly defaultExecutionMode: 'serial' | 'parallel'
  readonly defaultContextMode: 'spawn' | 'fork' | 'chain'
  /** Maximum settled runs retained automatically; 0 or omission disables count pruning. */
  readonly historyMaxRuns?: number
  /** Maximum settled-run age in days; 0 or omission disables age pruning. */
  readonly historyMaxAgeDays?: number
  /** Maximum immutable versions per squad; 0 or omission disables version pruning. */
  readonly versionMaxPerSquad?: number
}

/** Stable domain errors consumed by model tools, RPC, and the Web client. */
export class AgentTeamError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'AGENT_EXISTS'
      | 'AGENT_NOT_FOUND'
      | 'SQUAD_EXISTS'
      | 'SQUAD_NOT_FOUND'
      | 'INVALID_MEMBERS'
      | 'INVALID_ASSIGNMENTS'
      | 'INVALID_DISPATCH'
      | 'INVALID_IMPORT',
  ) {
    super(message)
    this.name = 'AgentTeamError'
  }
}
