import type { InsightsBucket, PlanView, RunStatus, RunView, TokenUsageView } from './contracts.ts'
import type { MessageKey, Translate } from './i18n.ts'

export interface PlanStage {
  index: number
  agentIds: string[]
}

/** Stable topological layers for a plan timeline. Invalid edges degrade to display order. */
export function planStages(plan?: PlanView): PlanStage[] {
  if (plan === undefined || plan.assignments.length === 0) return []
  const ids = new Set(plan.assignments.map(item => item.agentId))
  const displayOrder = [...plan.memberOrder.filter(id => ids.has(id)), ...plan.assignments.map(item => item.agentId).filter(id => !plan.memberOrder.includes(id))]
  const remaining = new Map(plan.assignments.map(item => [item.agentId, new Set((item.dependsOn ?? []).filter(id => ids.has(id))) ]))
  const stages: PlanStage[] = []
  const emitted = new Set<string>()
  while (remaining.size > 0) {
    const ready = displayOrder.filter(id => remaining.has(id) && [...(remaining.get(id) ?? [])].every(dep => emitted.has(dep)))
    if (ready.length === 0) {
      return [...stages, ...displayOrder.filter(id => remaining.has(id)).map((id, offset) => ({ index: stages.length + offset, agentIds: [id] }))]
    }
    stages.push({ index: stages.length, agentIds: ready })
    for (const id of ready) { emitted.add(id); remaining.delete(id) }
  }
  return stages
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`
  return String(value)
}

export function formatDuration(startedAt: number, endedAt?: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round(((endedAt ?? now) - startedAt) / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

export function statusKey(status: RunStatus): MessageKey {
  const map: Record<RunStatus, MessageKey> = {
    planning: 'statusPlanning', queued: 'statusQueued', running: 'statusRunning', completed: 'statusCompleted',
    partial: 'statusPartial', failed: 'statusFailed', cancelled: 'statusCancelled', interrupted: 'statusInterrupted', skipped: 'statusSkipped',
  }
  return map[status]
}

export function isLive(status: RunStatus): boolean {
  return status === 'planning' || status === 'queued' || status === 'running'
}

export function isAttention(status: RunStatus): boolean {
  return status === 'failed' || status === 'partial' || status === 'interrupted'
}

export function usageShare(usage: TokenUsageView): number {
  const input = usage.uncachedInputTokens + usage.cacheReadTokens
  return input === 0 ? 0 : usage.cacheReadTokens / input
}

export function completionRate(runs: readonly RunView[]): number | null {
  const eligible = runs.filter(run => run.status === 'completed' || run.status === 'partial' || run.status === 'failed' || run.status === 'interrupted')
  if (eligible.length === 0) return null
  return eligible.filter(run => run.status === 'completed').length / eligible.length
}

export function describeBucket(bucket: InsightsBucket): string {
  if (typeof bucket.label === 'string') return bucket.label
  if (typeof bucket.name === 'string') return bucket.name
  if (typeof bucket.id === 'string') return bucket.id
  const provider = typeof bucket.provider === 'string' ? bucket.provider : ''
  const model = typeof bucket.model === 'string' ? bucket.model : ''
  return [provider, model].filter(Boolean).join(' / ') || '—'
}

export function downloadJson(documentValue: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(documentValue, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.hidden = true
  document.body.append(anchor)
  anchor.click()
  setTimeout(() => { anchor.remove(); URL.revokeObjectURL(url) }, 1_000)
}

export function visibleRunFilter(run: RunView, filter: 'all' | 'live' | 'attention' | 'done'): boolean {
  if (filter === 'all') return true
  if (filter === 'live') return isLive(run.status)
  if (filter === 'attention') return isAttention(run.status)
  return run.status === 'completed' || run.status === 'cancelled' || run.status === 'skipped'
}

export function tokenSummary(usage: TokenUsageView, t: Translate): string {
  return `${t('uncachedInput')} ${formatTokens(usage.uncachedInputTokens)} · ${t('cacheRead')} ${formatTokens(usage.cacheReadTokens)} · ${t('output')} ${formatTokens(usage.outputTokens)}`
}
