import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AgentView, RecipeConflictView, RecipeMissingRouteView, RecipePreview, TeamSnapshot } from './contracts.ts'
import type { AgentTeamController } from './controller.ts'
import { errorText } from './controller.ts'
import type { Translate } from './i18n.ts'
import { downloadJson } from './view-models.ts'

export interface RecipesWorkspaceProps {
  controller: AgentTeamController
  data: TeamSnapshot
  busy: boolean
  t: Translate
  run(action: () => Promise<void>): Promise<boolean>
  setNotice(value: string): void
}

interface MissingRoute {
  agentId: string
  kind: 'primary' | 'fallback'
  label: string
}

interface RouteRemap {
  provider: string
  model: string
  fallbackProvider?: string
  fallbackModel?: string
}

interface DefinitionImportPreview {
  valid: true
  definitionRevision: number
  mode: 'merge' | 'replace'
  incoming: { agents: number; squads: number }
  conflicts: { agentIds: string[]; squadIds: string[] }
  deletions: { agents: number; squads: number; sessionModes: number; nextModes: number; projectDefaults: number; squadVersions: number }
  affectedSquads?: Array<{ squadId: string; squadName: string; agentIds: string[] }>
}

const MEBIBYTE = 1_024 * 1_024
const RECIPE_MAX_BYTES = 4 * MEBIBYTE
const DEFINITION_MAX_BYTES = 16 * MEBIBYTE

/** Portable recipe and definition-backup workflows, isolated from the catalog editors. */
export function RecipesWorkspace({ controller, data, busy, t, run, setNotice }: RecipesWorkspaceProps): ReactNode {
  const [selectedSquad, setSelectedSquad] = useState(data.squads[0]?.id ?? '')
  const [recipeText, setRecipeText] = useState('')
  const [recipeDoc, setRecipeDoc] = useState<unknown>(null)
  const [preview, setPreview] = useState<RecipePreview | null>(null)
  const [policy, setPolicy] = useState<'merge' | 'copy'>('copy')
  const [routeRemap, setRouteRemap] = useState<Record<string, RouteRemap>>({})
  const [url, setUrl] = useState('')
  const [backupMode, setBackupMode] = useState<'merge' | 'replace'>('merge')
  const [localError, setLocalError] = useState('')
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewFingerprint, setPreviewFingerprint] = useState('')
  const [backupDoc, setBackupDoc] = useState<unknown>(null)
  const [backupPreview, setBackupPreview] = useState<DefinitionImportPreview | null>(null)
  const [backupError, setBackupError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const backupRef = useRef<HTMLInputElement>(null)
  const previewGeneration = useRef(0)
  const backupGeneration = useRef(0)
  const missing = useMemo(() => normalizeMissingRoutes(preview?.missingRoutes ?? [], preview?.agents ?? [], t), [preview?.agents, preview?.missingRoutes, t])

  useEffect(() => {
    if (selectedSquad !== '' && data.squads.some(item => item.id === selectedSquad)) return
    setSelectedSquad(data.squads[0]?.id ?? '')
  }, [data.squads, selectedSquad])

  const previewRecipe = async (document: unknown, routes = routeRemap, nextPolicy = policy): Promise<void> => {
    const generation = ++previewGeneration.current
    const fingerprint = recipeFingerprint(document, routes, nextPolicy)
    setLocalError(''); setRecipeDoc(document); setPreviewBusy(true)
    try {
      const response = await controller.recipes.preview(document, routes)
      if (generation !== previewGeneration.current) return
      setPreview(response); setPreviewFingerprint(fingerprint)
    } catch (reason) {
      if (generation !== previewGeneration.current) return
      setPreview(null); setPreviewFingerprint(''); setLocalError(errorText(reason, t))
    } finally {
      if (generation === previewGeneration.current) setPreviewBusy(false)
    }
  }

  const parseAndPreview = async (text: string): Promise<void> => {
    if (utf8ByteLength(text) > RECIPE_MAX_BYTES) {
      previewGeneration.current += 1
      setRecipeDoc(null); setPreview(null); setPreviewFingerprint(''); setPreviewBusy(false)
      setLocalError(t('recipeTooLarge'))
      return
    }
    try {
      await previewRecipe(JSON.parse(text))
    } catch (reason) {
      previewGeneration.current += 1
      setRecipeDoc(null); setPreview(null); setPreviewFingerprint(''); setPreviewBusy(false)
      setLocalError(reason instanceof SyntaxError ? t('invalidJson') : errorText(reason, t))
    }
  }

  const readRecipe = async (file: File): Promise<void> => {
    if (file.size > RECIPE_MAX_BYTES) {
      previewGeneration.current += 1
      setRecipeDoc(null); setPreview(null); setPreviewFingerprint(''); setPreviewBusy(false)
      setLocalError(t('recipeTooLarge'))
      return
    }
    try {
      const text = await file.text()
      if (utf8ByteLength(text) > RECIPE_MAX_BYTES) {
        previewGeneration.current += 1
        setRecipeDoc(null); setPreview(null); setPreviewFingerprint(''); setPreviewBusy(false)
        setLocalError(t('recipeTooLarge'))
        return
      }
      setRecipeText(text)
      await parseAndPreview(text)
    } catch (reason) {
      previewGeneration.current += 1
      setRecipeDoc(null); setPreview(null); setPreviewFingerprint(''); setPreviewBusy(false)
      setLocalError(t('fileReadFailed', { message: errorText(reason, t) }))
    }
  }

  const exportRecipe = async (): Promise<void> => {
    if (selectedSquad === '') return
    await run(async () => downloadJson(await controller.recipes.export(selectedSquad), `agent-team-recipe-${selectedSquad}.json`))
  }

  const applyRecipe = async (): Promise<void> => {
    if (recipeDoc === null || preview?.valid !== true || previewFingerprint !== recipeFingerprint(recipeDoc, routeRemap, policy)) {
      setLocalError(t('staleRecipePreview'))
      return
    }
    const expectedRevision = preview.definitionRevision
    await run(async () => {
      try {
        await controller.recipes.import(recipeDoc, policy, routeRemap, expectedRevision)
      } catch (reason) {
        if (isStalePreviewFailure(reason)) {
          previewGeneration.current += 1
          setPreview(null); setPreviewFingerprint(''); setLocalError(t('staleRecipePreview'))
          return
        }
        throw reason
      }
      await controller.load(true)
      setNotice(t('validRecipe'))
      setPreview(null); setRecipeDoc(null); setRecipeText(''); setRouteRemap({}); setPreviewFingerprint('')
    })
  }

  const remapRoute = (agentId: string, kind: 'primary' | 'fallback', route: { provider: string; model: string }): void => {
    const original = preview?.agents?.find(agent => agent.id === agentId)
    const current = routeRemap[agentId] ?? routeFromAgent(original)
    const mapped = kind === 'primary'
      ? { ...current, provider: route.provider, model: route.model }
      : { ...current, fallbackProvider: route.provider, fallbackModel: route.model }
    const next = { ...routeRemap, [agentId]: mapped }
    setRouteRemap(next)
    if (recipeDoc === null) return
    void previewRecipe(recipeDoc, next)
  }

  const fetchRecipe = async (): Promise<void> => {
    if (data.capabilities?.remoteRecipeFetch !== true || !url.startsWith('https://')) return
    await run(async () => {
      const response = await controller.recipes.fetchPreview(url)
      setPreview(response)
      setRecipeDoc(response.doc ?? null)
      setPreviewFingerprint(response.doc === undefined ? '' : recipeFingerprint(response.doc, routeRemap, policy))
    })
  }

  const exportBackup = async (): Promise<void> => {
    await run(async () => downloadJson(await controller.call('export', {}), `agent-team-backup-${new Date().toISOString().slice(0, 10)}.json`))
  }

  const previewBackup = async (document: unknown, mode: 'merge' | 'replace'): Promise<void> => {
    const generation = ++backupGeneration.current
    setBackupDoc(document); setBackupPreview(null); setBackupError('')
    try {
      const response = await controller.call<unknown>('import/preview', { doc: document, mode })
      if (!isDefinitionImportPreview(response)) throw new Error(t('incompatibleHost'))
      if (generation === backupGeneration.current) setBackupPreview(response)
    } catch (reason) {
      if (generation === backupGeneration.current) setBackupError(errorText(reason, t))
    }
  }

  const readBackup = async (file: File): Promise<void> => {
    if (file.size > DEFINITION_MAX_BYTES) {
      backupGeneration.current += 1
      setBackupDoc(null); setBackupPreview(null); setBackupError(t('definitionTooLarge'))
      return
    }
    try {
      const text = await file.text()
      if (utf8ByteLength(text) > DEFINITION_MAX_BYTES) {
        backupGeneration.current += 1
        setBackupDoc(null); setBackupPreview(null); setBackupError(t('definitionTooLarge'))
        return
      }
      await previewBackup(JSON.parse(text), backupMode)
    }
    catch (reason) {
      setBackupDoc(null); setBackupPreview(null)
      setBackupError(reason instanceof SyntaxError ? t('invalidJson') : t('fileReadFailed', { message: errorText(reason, t) }))
    }
  }

  const cancelBackup = (): void => {
    backupGeneration.current += 1
    setBackupDoc(null); setBackupPreview(null); setBackupError('')
  }

  const importBackup = async (): Promise<void> => {
    if (backupDoc === null || backupPreview === null || backupPreview.mode !== backupMode) return
    if (backupMode === 'replace' && !window.confirm(t('replaceBackupConfirm'))) return
    const expectedRevision = backupPreview.definitionRevision
    await run(async () => {
      try {
        await controller.call('import', { doc: backupDoc, mode: backupMode, expectedRevision })
      } catch (reason) {
        if (isStalePreviewFailure(reason)) {
          backupGeneration.current += 1
          setBackupPreview(null); setBackupError(t('staleDefinitionPreview'))
          return
        }
        throw reason
      }
      await controller.load(true)
      setNotice(t('definitionBackupApplied'))
      cancelBackup()
    })
  }

  return <div className="atg-data-page" data-testid="agent-team-recipes">
    <section className="atg-data-card">
      <header><div><h3>{t('recipeTitle')}</h3><p>{t('recipeHint')}</p></div></header>
      <div className="atg-two">
        <RecipeSelect label={t('teams')} value={selectedSquad} options={data.squads.map(item => [item.id, item.name])} onChange={setSelectedSquad} />
        <div className="atg-field"><span>{t('export')}</span><button type="button" className="atg-button ghost" disabled={busy || selectedSquad === ''} onClick={() => { void exportRecipe() }}>{t('export')} JSON</button></div>
      </div>
      <label className="atg-field"><span>{t('recipeJson')}</span><textarea value={recipeText} onChange={event => { setRecipeText(event.currentTarget.value) }} placeholder="{ ... }" /></label>
      <div className="atg-toolbar">
        <button type="button" className="atg-button ghost" onClick={() => { fileRef.current?.click() }}>{t('recipeFile')}</button>
        <button type="button" className="atg-button primary" disabled={previewBusy || recipeText.trim() === ''} onClick={() => { void parseAndPreview(recipeText) }}>{previewBusy ? t('loading') : t('preview')}</button>
        <input ref={fileRef} hidden type="file" accept="application/json,.json" onChange={event => {
          const file = event.currentTarget.files?.[0]
          if (file !== undefined) void readRecipe(file)
          event.currentTarget.value = ''
        }} />
      </div>
      {localError !== '' && <div className="atg-alert" role="alert">{localError}</div>}
      {data.capabilities?.remoteRecipeFetch === true && <div className="atg-two">
        <RecipeField id="recipe-url" label={t('recipeUrl')} value={url} placeholder="https://github.com/…/recipe.json" onChange={setUrl} />
        <div className="atg-field"><span>{t('preview')}</span><button type="button" className="atg-button ghost" disabled={!url.startsWith('https://')} onClick={() => { void fetchRecipe() }}>{t('fetchPreview')}</button></div>
      </div>}
      {preview !== null && <div className={`atg-recipe-preview${preview.valid ? ' is-valid' : ' is-invalid'}`}>
        <header><strong>{preview.valid ? t('validRecipe') : t('invalidRecipe')}</strong><span>{preview.squad?.name ?? ''}</span></header>
        <RecipeConflictList values={preview.conflicts} t={t} />
        <MissingRouteList values={preview.missingRoutes} agents={preview.agents ?? []} t={t} />
        {policy === 'merge' && (preview.affectedSquads ?? []).length > 0 && <div className="atg-warning" role="alert">{t('recipeAffectedTeams', { names: (preview.affectedSquads ?? []).map(item => item.squadName).join(', ') })}</div>}
        {missing.map(item => {
          const route = routeRemap[item.agentId] ?? routeFromAgent(preview.agents?.find(agent => agent.id === item.agentId))
          const provider = item.kind === 'primary' ? route.provider : route.fallbackProvider ?? ''
          const model = item.kind === 'primary' ? route.model : route.fallbackModel ?? ''
          return <div className="atg-route-remap" key={`${item.agentId}:${item.kind}`}>
            <strong>{item.label}</strong>
            <RecipeSelect label={t('provider')} value={provider} options={data.models.map(group => [group.provider, group.name])} onChange={nextProvider => {
              const nextModel = data.models.find(group => group.provider === nextProvider)?.models[0]?.id ?? ''
              remapRoute(item.agentId, item.kind, { provider: nextProvider, model: nextModel })
            }} />
            <RecipeSelect label={t('model')} value={model} options={(data.models.find(group => group.provider === provider)?.models ?? []).map(item => [item.id, item.name])} onChange={nextModel => {
              remapRoute(item.agentId, item.kind, { provider, model: nextModel })
            }} />
          </div>
        })}
        <div className="atg-two">
          <RecipeSelect label={t('mergePolicy')} value={policy} options={[["copy", t('copyPolicy')], ['merge', t('merge')]]} onChange={value => {
            const next = value as 'merge' | 'copy'; setPolicy(next)
            if (recipeDoc !== null) void previewRecipe(recipeDoc, routeRemap, next)
          }} />
          <button type="button" className="atg-button primary atg-align-end" disabled={previewBusy || !preview.valid || previewFingerprint !== (recipeDoc === null ? '' : recipeFingerprint(recipeDoc, routeRemap, policy)) || missing.some(item => !routeReady(item, routeRemap[item.agentId]))} onClick={() => { void applyRecipe() }}>{t('applyRecipe')}</button>
        </div>
      </div>}
    </section>
    <section className="atg-data-card">
      <header><div><h3>{t('backup')}</h3><p>{t('backupHint')}</p></div></header>
      <div className="atg-toolbar">
        <RecipeSelect label={t('mergePolicy')} value={backupMode} options={[["merge", t('mergeImport')], ['replace', t('replaceImport')]]} onChange={value => {
          const next = value as 'merge' | 'replace'; setBackupMode(next)
          if (backupDoc !== null) void previewBackup(backupDoc, next)
        }} />
        <button type="button" className="atg-button ghost" onClick={() => { void exportBackup() }}>{t('export')}</button>
        <button type="button" className="atg-button ghost" onClick={() => { backupRef.current?.click() }}>{t('import')}</button>
        <input ref={backupRef} hidden type="file" accept="application/json,.json" onChange={event => {
          const file = event.currentTarget.files?.[0]
          if (file !== undefined) void readBackup(file)
          event.currentTarget.value = ''
        }} />
      </div>
      {backupError !== '' && <div className="atg-alert" role="alert">{backupError}</div>}
      {backupDoc !== null && backupPreview === null && backupError === '' && <div className="atg-loading">{t('loading')}</div>}
      {backupPreview !== null && <div className={`atg-backup-preview${backupMode === 'replace' ? ' is-danger' : ''}`}>
        <strong>{t('definitionCounts', { agents: backupPreview.incoming.agents, squads: backupPreview.incoming.squads })}</strong>
        <span>{t('definitionConflicts', { agents: backupPreview.conflicts.agentIds.length, squads: backupPreview.conflicts.squadIds.length })}</span>
        {(backupPreview.affectedSquads ?? []).length > 0 && <div className="atg-warning" role="alert">{t('definitionAffectedTeams', { names: (backupPreview.affectedSquads ?? []).map(item => item.squadName).join(', ') })}</div>}
        {backupMode === 'replace' && <div className="atg-warning" role="alert">{t('definitionDeletions', {
          agents: backupPreview.deletions.agents, squads: backupPreview.deletions.squads,
          modes: backupPreview.deletions.sessionModes + backupPreview.deletions.nextModes,
          projects: backupPreview.deletions.projectDefaults, versions: backupPreview.deletions.squadVersions,
        })}</div>}
        <div className="atg-actions"><button type="button" className="atg-button ghost" onClick={cancelBackup}>{t('cancel')}</button><button type="button" className={`atg-button ${backupMode === 'replace' ? 'danger' : 'primary'}`} disabled={busy} onClick={() => { void importBackup() }}>{t('applyDefinitionBackup')}</button></div>
      </div>}
    </section>
    <section className="atg-data-card"><header><div><h3>{t('retention')}</h3><p>{t('retentionHint')}</p></div></header></section>
  </div>
}

function RecipeField({ id, label, value, placeholder, onChange }: { id: string; label: string; value: string; placeholder?: string; onChange(value: string): void }): ReactNode {
  return <label className="atg-field" htmlFor={id}><span>{label}</span><input id={id} value={value} placeholder={placeholder} onChange={event => { onChange(event.currentTarget.value) }} /></label>
}

function RecipeSelect({ label, value, options, onChange }: { label: string; value: string; options: Array<[string, string]>; onChange(value: string): void }): ReactNode {
  return <label className="atg-field"><span>{label}</span><select value={value} onChange={event => { onChange(event.currentTarget.value) }}>{options.map(option => <option key={option[0]} value={option[0]}>{option[1]}</option>)}</select></label>
}

function RecipeConflictList({ values, t }: { values: RecipeConflictView[]; t: Translate }): ReactNode {
  if (values.length === 0) return null
  return <section className="atg-preview-list atg-structured-preview" aria-label={t('conflicts')}><strong>{t('conflicts')}</strong><ul>{values.map(value => <li key={`${value.kind}:${value.id}`}><div><span>{t(value.kind === 'agent' ? 'conflictMember' : 'conflictTeam')}</span><strong>{value.incomingName}</strong></div><small>{t('conflictNameChange', { existing: value.existingName, incoming: value.incomingName })}</small></li>)}</ul></section>
}

function MissingRouteList({ values, agents, t }: { values: RecipeMissingRouteView[]; agents: AgentView[]; t: Translate }): ReactNode {
  if (values.length === 0) return null
  return <section className="atg-preview-list atg-structured-preview" aria-label={t('missingRoutes')}><strong>{t('missingRoutes')}</strong><ul>{values.map(value => {
    const name = agents.find(agent => agent.id === value.agentId)?.name ?? t('unknownMember')
    const reason = conciseReason(value.message)
    return <li key={`${value.agentId}:${value.kind}:${value.provider}:${value.model}`}><div><strong>{name}</strong><span>{t(value.kind === 'primary' ? 'primaryRoute' : 'fallbackRoute')}</span></div><code>{value.provider || '—'} / {value.model || '—'}</code><small>{t('routeUnavailableReason', { message: reason })}</small>{reason !== value.message.trim() && <details><summary>{t('technicalDetails')}</summary><pre>{value.message}</pre></details>}</li>
  })}</ul></section>
}

function conciseReason(value: string): string {
  const firstLine = value.trim().split(/\r?\n/, 1)[0] ?? ''
  return firstLine.length > 160 ? `${firstLine.slice(0, 157)}…` : firstLine
}

function normalizeMissingRoutes(values: RecipeMissingRouteView[], agents: AgentView[], t: Translate): MissingRoute[] {
  return values.map(value => ({
    agentId: value.agentId,
    kind: value.kind,
    label: `${agents.find(agent => agent.id === value.agentId)?.name ?? value.agentId} · ${t(value.kind === 'primary' ? 'primaryRoute' : 'fallbackRoute')}`,
  }))
}

function routeFromAgent(agent: AgentView | undefined): RouteRemap {
  return {
    provider: agent?.provider ?? '',
    model: agent?.model ?? '',
    ...(agent?.fallbackProvider === undefined ? {} : { fallbackProvider: agent.fallbackProvider }),
    ...(agent?.fallbackModel === undefined ? {} : { fallbackModel: agent.fallbackModel }),
  }
}

function routeReady(missing: MissingRoute, route: RouteRemap | undefined): boolean {
  if (route === undefined) return false
  return missing.kind === 'primary'
    ? route.provider !== '' && route.model !== ''
    : route.fallbackProvider !== undefined && route.fallbackProvider !== '' && route.fallbackModel !== undefined && route.fallbackModel !== ''
}

function recipeFingerprint(document: unknown, routes: Record<string, RouteRemap>, policy: 'merge' | 'copy'): string {
  const normalizedRoutes = Object.fromEntries(Object.entries(routes).sort(([left], [right]) => left.localeCompare(right)))
  return JSON.stringify({ document, routes: normalizedRoutes, policy })
}

function isDefinitionImportPreview(value: unknown): value is DefinitionImportPreview {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record.valid !== true || (record.mode !== 'merge' && record.mode !== 'replace')) return false
  const incoming = record.incoming as Record<string, unknown> | undefined
  const conflicts = record.conflicts as Record<string, unknown> | undefined
  const deletions = record.deletions as Record<string, unknown> | undefined
  return isRevision(record.definitionRevision)
    && typeof incoming?.agents === 'number' && typeof incoming.squads === 'number'
    && Array.isArray(conflicts?.agentIds) && Array.isArray(conflicts.squadIds)
    && typeof deletions?.agents === 'number' && typeof deletions.squads === 'number'
    && typeof deletions.sessionModes === 'number' && typeof deletions.nextModes === 'number'
    && typeof deletions.projectDefaults === 'number' && typeof deletions.squadVersions === 'number'
    && (record.affectedSquads === undefined || Array.isArray(record.affectedSquads))
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function isStalePreviewFailure(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : String(reason)
  return /stale (?:recipe|import) preview/i.test(message)
}
