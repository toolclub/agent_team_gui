import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Durable identifier owned by an agent definition. */
export type AgentId = Branded<'AgentTeamAgentId'>

/** Brand an external or generated string as an agent identifier. */
export function AgentId(value: string): AgentId {
  return value as AgentId
}

/** Durable identifier owned by a squad definition. */
export type SquadId = Branded<'AgentTeamSquadId'>

/** Brand an external or generated string as a squad identifier. */
export function SquadId(value: string): SquadId {
  return value as SquadId
}

/** Correlates one squad dispatch with its member outcomes. */
export type DispatchId = Branded<'AgentTeamDispatchId'>

/** Brand a generated string as a dispatch identifier. */
export function DispatchId(value: string): DispatchId {
  return value as DispatchId
}

/** Per-child tool visibility passed to the existing subagent runtime. */
export interface AgentToolScope {
  readonly allow?: string[]
  readonly deny?: string[]
}

/** Durable agent definition. Model routes contain no credential material. */
export interface AgentRecord {
  readonly name: string
  readonly systemPrompt: string
  readonly provider: string
  readonly model: string
  readonly maxTokens?: number
  readonly toolScope?: AgentToolScope
}

/** Durable squad definition. One agent may appear in several squads. */
export interface SquadRecord {
  readonly name: string
  readonly members: AgentId[]
  readonly collabNote?: string
  /** Complete fixed serial order. Omission lets dispatch assignments choose order. */
  readonly executionOrder?: AgentId[]
  /** Squad-specific default; plugin config is used when omitted. */
  readonly executionMode?: 'serial' | 'parallel'
  /** Squad-specific default; plugin config is used when omitted. */
  readonly contextMode?: 'spawn' | 'fork' | 'chain'
}

/** Durable per-session selection that enables normal-conversation squad mode. */
export interface SessionSquadModeRecord {
  readonly squadId: SquadId
}

/** Resolved session mode returned to host/RPC callers. */
export interface SessionSquadModeView {
  readonly sessionId: SessionId
  readonly squadId: SquadId
  readonly squadName: string
}

/** One model-selected member assignment. Omitted members receive the shared task. */
export interface SquadAssignment {
  readonly agentId: AgentId
  readonly task: string
}

/** User- or model-facing request resolved by {@link AgentTeamService.dispatch}. */
export interface SquadDispatchRequest {
  readonly squadId: SquadId
  readonly task: string
  readonly assignments?: readonly SquadAssignment[]
  /** Complete per-dispatch permutation used only when the squad has no fixed order. */
  readonly memberOrder?: readonly AgentId[]
  readonly executionMode?: 'serial' | 'parallel'
  readonly contextMode?: 'spawn' | 'fork' | 'chain'
}

/** One traceable member result recorded inside the parent tool result. */
export interface SquadMemberResult {
  readonly agentId: AgentId
  readonly agentName: string
  readonly status: 'completed' | 'failed'
  readonly runId?: string
  readonly childId?: string
  readonly stopReason?: string
  readonly output: ContentBlock[]
  readonly error?: string
}

/** Canonical squad result; it is lossless JSON when materialized by the tool registry. */
export interface SquadDispatchResult {
  readonly dispatchId: DispatchId
  readonly squadId: SquadId
  readonly squadName: string
  readonly task: string
  readonly executionMode: 'serial' | 'parallel'
  readonly contextMode: 'spawn' | 'fork' | 'chain'
  readonly status: 'completed' | 'partial' | 'failed'
  readonly members: SquadMemberResult[]
}

/** One agent row inside an exported definition document. */
export interface AgentExportItem {
  readonly id: AgentId
  readonly name: string
  readonly systemPrompt: string
  readonly provider: string
  readonly model: string
  readonly maxTokens?: number
  readonly toolScope?: AgentToolScope
}

/** One squad row inside an exported definition document. */
export interface SquadExportItem {
  readonly id: SquadId
  readonly name: string
  readonly members: AgentId[]
  readonly collabNote?: string
  readonly executionOrder?: AgentId[]
  readonly executionMode?: 'serial' | 'parallel'
  readonly contextMode?: 'spawn' | 'fork' | 'chain'
}

/** Versioned, self-describing dump of every durable agent/squad definition. */
export interface AgentTeamExportDocument {
  readonly format: 'agent-team-gui/definitions'
  readonly version: 1
  readonly agents: AgentExportItem[]
  readonly squads: SquadExportItem[]
}

/** How an imported document is applied to the existing durable store. */
export type AgentTeamImportMode = 'merge' | 'replace'

/** Count of rows actually written by one import call. */
export interface AgentTeamImportResult {
  readonly agents: number
  readonly squads: number
}
