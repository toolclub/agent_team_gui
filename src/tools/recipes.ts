import { AgentId, SquadId, type AgentRecord, type AgentRouteRemap, type AgentTeamRecipeDocument, type RecipeConflict, type RecipeMissingRoute } from '../types.ts'
import { agentTeamRecipeSchema } from '../spec.ts'

export interface ExistingRecipeDefinitions {
  readonly agents: ReadonlyMap<string, AgentRecord>
  readonly squads: ReadonlyMap<string, { readonly name: string }>
}

/** Parse, remap, and cross-reference one untrusted recipe without writing storage. */
export function prepareRecipe(
  document: unknown,
  routeRemap: Readonly<Record<string, AgentRouteRemap>> = {},
): AgentTeamRecipeDocument {
  const parsed = agentTeamRecipeSchema.parse(document)
  const seen = new Set<string>()
  const agents = parsed.agents.map((agent) => {
    if (seen.has(agent.id)) throw new Error(`duplicate agent "${agent.id}" in recipe`)
    seen.add(agent.id)
    const remap = routeRemap[agent.id]
    if (remap === undefined) return agent
    if ((remap.fallbackProvider === undefined) !== (remap.fallbackModel === undefined)) {
      throw new Error(`route remap for "${agent.id}" must configure both fallback provider and model`)
    }
    return {
      ...agent,
      provider: remap.provider,
      model: remap.model,
      ...(remap.fallbackProvider === undefined ? {} : { fallbackProvider: remap.fallbackProvider }),
      ...(remap.fallbackModel === undefined ? {} : { fallbackModel: remap.fallbackModel }),
    }
  })
  const memberIds = new Set(parsed.squad.members)
  const missing = parsed.squad.members.filter(id => !seen.has(id))
  if (missing.length > 0) throw new Error(`recipe squad references missing agents: ${missing.join(', ')}`)
  const extras = agents.filter(agent => !memberIds.has(agent.id)).map(agent => agent.id)
  if (extras.length > 0) throw new Error(`recipe contains agents not used by its squad: ${extras.join(', ')}`)
  return { ...parsed, agents }
}

export function findRecipeConflicts(
  recipe: AgentTeamRecipeDocument,
  existing: ExistingRecipeDefinitions,
): RecipeConflict[] {
  const conflicts: RecipeConflict[] = []
  for (const item of recipe.agents) {
    const current = existing.agents.get(item.id)
    if (current !== undefined) conflicts.push({ kind: 'agent', id: item.id, existingName: current.name, incomingName: item.name })
  }
  const currentSquad = existing.squads.get(recipe.squad.id)
  if (currentSquad !== undefined) {
    conflicts.push({ kind: 'squad', id: recipe.squad.id, existingName: currentSquad.name, incomingName: recipe.squad.name })
  }
  return conflicts
}

export async function findMissingRecipeRoutes(
  recipe: AgentTeamRecipeDocument,
  resolve: (provider: string, model: string) => Promise<unknown>,
  signal?: AbortSignal,
): Promise<RecipeMissingRoute[]> {
  const throwIfCancelled = (): void => {
    if (signal?.aborted !== true) return
    if (signal.reason instanceof Error) throw signal.reason
    throw new Error(String(signal.reason ?? 'recipe route validation cancelled'))
  }
  const missing: RecipeMissingRoute[] = []
  for (const item of recipe.agents) {
    throwIfCancelled()
    try {
      await resolve(item.provider, item.model)
    } catch (error: unknown) {
      throwIfCancelled()
      missing.push({
        agentId: AgentId(item.id), kind: 'primary', provider: item.provider, model: item.model,
        message: error instanceof Error ? error.message : String(error),
      })
    }
    if (item.fallbackProvider !== undefined && item.fallbackModel !== undefined) {
      try {
        await resolve(item.fallbackProvider, item.fallbackModel)
      } catch (error: unknown) {
        throwIfCancelled()
        missing.push({
          agentId: AgentId(item.id), kind: 'fallback', provider: item.fallbackProvider, model: item.fallbackModel,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
  return missing
}

/** Copy policy mints a closed identity graph; no imported row can overwrite an existing definition. */
export function copyRecipeIds(
  recipe: AgentTeamRecipeDocument,
  createId: () => string,
): AgentTeamRecipeDocument {
  const mapping = new Map<string, AgentId>(recipe.agents.map(item => [String(item.id), AgentId(createId())]))
  const mapAgent = (id: string): AgentId => {
    const mapped = mapping.get(id)
    if (mapped === undefined) throw new Error(`recipe identity mapping is missing "${id}"`)
    return mapped
  }
  return {
    ...recipe,
    squad: {
      ...recipe.squad,
      id: SquadId(createId()),
      members: recipe.squad.members.map(mapAgent),
      ...(recipe.squad.executionOrder === undefined ? {} : { executionOrder: recipe.squad.executionOrder.map(mapAgent) }),
      ...(recipe.squad.leaderAgentId === undefined ? {} : { leaderAgentId: mapAgent(recipe.squad.leaderAgentId) }),
      ...(recipe.squad.qualityGate === undefined ? {} : {
        qualityGate: {
          ...recipe.squad.qualityGate,
          reviewerAgentId: mapAgent(recipe.squad.qualityGate.reviewerAgentId),
          repairAgentId: mapAgent(recipe.squad.qualityGate.repairAgentId),
        },
      }),
    },
    agents: recipe.agents.map(item => ({ ...item, id: mapAgent(item.id) })),
  }
}
