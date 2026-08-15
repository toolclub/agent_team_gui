# agent_team_gui dsh Plugin — Completed Implementation Plan

## Completion status (2026-08-15)

P1–P5 are implemented and verified. The package now ships the durable host service, model-facing
`dispatch_to_squad` tool, serial/parallel orchestration, loopback-only Connection RPC, Web CRUD and
composer UI, self-contained Git `prepare`, declarations, bilingual documentation, and bundle patch.

Resolved research decisions supersede any earlier proposal below:

- The bundle is Web-profile-only and inserts only the unique `agent-team-gui` row. Loader `insert`
  does not deduplicate IDs; Web already owns storage, Connection, and client-module rows.
- Browser CRUD/dispatch uses a dedicated `/agent-team-gui` Connection RPC channel with Zod boundary
  validation and loopback authority. Model catalogs come from the host `ctx.llm` service.
- One active host row is sufficient for `ClientModuleRegistry` to discover this package's
  `dsh.client`/`./client` entry; a second browser roster row would start the host plugin twice.
- The published client preset is not exported. `tsdown.config.ts` therefore implements the verified
  ModuleLoader closure contract locally and produces both `lib/index.js` and `lib/client.js`.
- Out-of-tree custom Session event registration is not currently supported. Observability uses the
  parent's standard `tool/call`/`tool/result`, native child sessions/descriptors, run IDs, and host
  logs; no unsafe `squad/*` events are appended.
- Validation completed: 7 tests, Host/Client/test TypeScript checks, build, pack contents, absolute
  dev overlay boot, tarball install into an isolated Web profile, RPC snapshot, and browser CRUD.

## 1. API Confirmation Summary

All APIs below were verified against the actual codebase at `/Users/leizihao/workspace/code/deepseek_harness_plugins/deepseek-harness`. Each citation is a real file:line.

**Plugin lifecycle (Report 1)**
- Service base class: `vendor/cordis/src/service.ts:11` — abstract, `constructor(ctx, name)` auto-registers via `ctx.reflect.provide`; `[Service.init]` is the async post-construction method.
- Class plugin form: default-export a Service subclass with `static inject` and `static Config`; constructor calls `super(ctx, 'serviceName')`. Confirmed: `packages/workspace/workspace/src/index.ts:92,114-116`, `packages/feedback/message-feedback/src/index.ts:150-151,167-169`.
- `ctx.effect(execute, label?)` returns disposer, runs in reverse on unload: `vendor/cordis/src/fiber.ts:415`.
- `ctx.inject(deps, callback)` conditional re-injection: `vendor/cordis/src/registry.ts:176`.
- `ctx.on(name, listener)` auto-cleanup event registration: `vendor/cordis/src/events.ts:288`.
- `ctx.emit/parallel/serial/bail/waterfall`: `vendor/cordis/src/events.ts:44-108`.
- `ctx.provide(name, value)` / `ctx.get(name)`: `vendor/cordis/src/reflect.ts:16-46`. CLAUDE.md rule: optional services use `ctx.get(name)`, declared injections use `ctx.<name>`.
- Context augmentation via `declare module '@deepseek-ai/cordis'`: confirmed across `packages/core/tools/src/index.ts:137-140`, `packages/subagent/subagent/src/index.ts:129-132`.

**Tool development (Report 2)**
- `defineTool(options)`: `packages/core/tools/src/schema.ts:545` — typed tool factory.
- `DefineToolOptions<S,O>`: `packages/core/tools/src/schema.ts:483` — name, description, parameters, output.schema, output.render, execute, presentCall/presentResult optional.
- `ToolRunContext` (exec): `packages/core/tools/src/index.ts:404` — `exec.agent`, `exec.signal`, `exec.deferContext()`, `exec.concludeTurn()`.
- `ctx.tools.register(definition)`: `packages/core/tools/src/index.ts:1037` — returns disposer.
- `ctx.tools.restrict({allow?, deny?})`: `packages/core/tools/src/index.ts:1071` — per-agent tool filtering, must be called from `agent.ctx`.
- `ctx.tools.guard(guard)`: `packages/core/tools/src/index.ts:1110` — monotonic final denial.
- `tools/pre-execute` waterfall: `packages/core/tools/src/index.ts:152` — allow/deny/ask.
- Schemastery Config: `import z from '@deepseek-ai/schemastery'`; `export const Config: z<Config> = z.object({...})`.

**Config layering & bundles (Report 3)**
- `dsh.bundle` manifest field: `packages/bundle/base/package.json:36` — `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`. This is the ONLY recognized bundle field (`packages/boot/app-boot/src/profile.ts:42-45`).
- `reconcilePlugins`: `apps/cli/src/plugin.ts:59` — auto-appends dsh.bundle-declaring packages to `dsh.profile.bundles` after `pnpm` succeeds.
- Layer priority: `apps/cli/src/profile-boot.ts:122-129` — `[...bundlePatches, ...profile.patches, ...homePatches, ...overlays]`. Later layers win per row.
- `PatchOptions`: `vendor/include/src/index.ts:145` — `id` targets existing row (whole-config replace), `insert` adds new rows.
- Profile templates: `packages/boot/app-boot/src/profile.ts:114-125` — web=[dsh-base,dsh-web-app], headless=[dsh-base,dsh-headless], other=[dsh-base].

**Subagent/workflow orchestration (Report 4)**
- `SubagentRuntime extends Service`: `packages/subagent/subagent/src/index.ts:171` — `start(name, request)`, `startContinuable(spec)`, `followup()`, `reportFrom()`, `listChildren()`, `listDescendants()`.
- `SubagentStartRequest`: `packages/subagent/subagent/src/types.ts:100` — `prompt`, `parent` (Agent), `signal`, `agentOptions?`, `toolFilter?`, `persona?`, `outputSchema?`, `maxDepth?`.
- `SubagentRun`: `packages/subagent/subagent/src/types.ts:249` — `result: Promise<SubagentResult>`, `dispose(): Promise<void>`.
- `SubagentResult`: `packages/subagent/subagent/src/types.ts:219` — `output: ContentBlock[]`, `structured?`, `stopReason`.
- `subagent/start` and `subagent/end` lifecycle events: `packages/subagent/subagent/src/index.ts:157`.
- Spawn provider (`inheritsParentContext=false`): `packages/subagent/subagent-spawn-in-process/src/index.ts:41`.
- Fork provider (`inheritsParentContext=true`, seeds child with parent's completed-turn prefix): `packages/subagent/subagent-fork-in-process/src/index.ts:61`.
- tool-subagent template (function plugin): `packages/subagent/tool-subagent/src/index.ts:22-23,267,297,369-430` — builds SubagentStartRequest, calls `ctx.subagents.start(provider, request)`, awaits `run.result`, disposes. Foreground path at lines 425-429.
- `resolveChildAgentOptions`: `packages/subagent/subagent/src/child-agent.ts:68` — child inherits parent's provider/model unless overridden by `agentOptions`.
- `applyChildComposition`: `packages/subagent/subagent/src/child-agent.ts:163` — applies persona, toolFilter to child scope.
- Workflow engine (alternative for high-scale fan-out): `ctx.workflowEngine.start(request)` at `packages/workflow/workflow-worker-thread/src/index.ts:143`; combinators `agent()`, `parallel()`, `pipeline()` at `packages/workflow/workflow-worker-thread/src/runtime.ts:100`.

**Web UI extension (Report 5)**
- `ctx.slots.register(options, component)`: `packages/client/runtime/src/client/slots.ts:464-471` + `packages/client/ui-slots/src/index.ts:741`.
- `ctx.slots.inject(key, callback)`: `packages/client/runtime/src/client/slots.ts:143-205` — waits for slot declaration before registering.
- `shell.overlay` slot: `packages/client/ui-layout/src/client/index.ts:73-84` — `{ kind: 'list'; scope: 'root' }`, additive frame-wide floating layer. "A fresh id is added beside the shipped entries instead of replacing them."
- `ctx.conversationEvents.register(definition)`: `docs/cookbook/adding-a-conversation-node.md:188` — keyed `conversation.chat.node` for per-message Chat rows.
- `dsh.client` package.json declaration: `packages/client/modules/src/index.ts:109-159` — `dsh.client: { platform: 'web', inject: [...] }` + `exports['./client']`. Confirmed in `packages/client/ui-jobs/package.json` (dsh.client with inject array, exports./client).
- ClientModuleRegistry auto-scan: `packages/client/modules/src/index.ts:184-249` — scans loader entries for dsh.client packages, composes `window.__DSH_BOOT__`, serves `/plugins/<id>/client.js`.
- Client plugin entry: `export const inject = [...]; export function apply(ctx: ClientContext): void`. Confirmed: `packages/client/ui-jobs/src/client/index.ts` (inject=['sessions','slots','locale'], apply registers via `ctx.slots.inject`).
- tsdown.client.ts shared preset: `packages/client/tsdown.client.ts:1-80` — emits `window.__ModuleLoader__.load({id, factory})` closure; externals via loader module table; CSS Modules via lightningcss. NOT exported as a package (monorepo-internal).

**LLM model routes (Report 6)**
- Model route = two strings: `AgentOptions { provider?, model?, maxTokens? }`: `packages/core/agent/src/runtime-types.ts:24`.
- `LlmCallConfig { provider, model, ... }`: `packages/llm/llm/src/call-config.ts:23`.
- API keys owned by credentials seam: `packages/credentials/credentials/src/index.ts:73` (`resolve(ref)`); `packages/llm/llm-deepseek/src/index.ts:225` (stores `apiKeyEnv` reference, not key value).
- `ctx.llm.listProviders()`: `packages/llm/llm/src/index.ts:419`; `listConfigurableProviders()`: `:490`; `listModels(provider)`: `:581`; `resolveModelInfo(provider, model)`: `:619`.
- Default model: `ctx.get('agentDefaultModel')?.currentSelection()`: `packages/core/agent-default-model/src/index.ts:88`.
- `installModelSelection(agentCtx, selectionRef)`: `packages/core/agent/src/model-selection.ts:39` — live per-agent model switching.
- `ctx.settings.register(ns, schema)`: `packages/settings/settings/src/index.ts:435`; `installSettingsSection()`: `:863`.

**Persistence (Report 7)**
- `ctx.storageDomain.open(spec)`: `packages/storage/storage-domain/src/index.ts:100` — async, returns Domain handle.
- `defineDomain(spec)`: `packages/storage/storage-domain/src/spec.ts:79` — validates name (UNIT_NAME_RE), version, table names at module load.
- `domainTable<K,V>(schema)`: `packages/storage/storage-domain/src/spec.ts:63` — zod-validated KV table declaration.
- `Domain.table(name)`: `packages/storage/storage-domain/src/domain.ts:108` — stable typed table handle.
- `KvTable`: `get(key)` sync (domain.ts:48), `put(key, value)` durable (domain.ts:72), `delete(key)` (domain.ts:80), `update(key, fn)` atomic RMW (domain.ts:89), `entries()` snapshot iterator (domain.ts:55), `size` (domain.ts:64).
- `Domain.close()`: `packages/storage/storage-domain/src/domain.ts:118` — reject writes, drain, release.
- `domain/changed` event: `packages/storage/storage-domain/src/events.ts:46`.
- Canonical Service pattern: `packages/workspace/workspace/src/index.ts:92-140` (static inject=['storageDomain','sessionPersistence'], [Service.init] opens domain, caches table+global, registers close disposer via ctx.effect). Also `packages/feedback/message-feedback/src/index.ts:150-181`.
- Backends: storage-json (`packages/storage/storage-json/src/index.ts:104`) and storage-sqlite (`packages/storage/storage-sqlite/src/index.ts:158`). Plugin depends on storage-domain only; operator wires backend.
- Storage wiring in web-app bundle: `packages/bundle/web-app/cordis.patch.yml:51-62` (storage + storage-json + storage-domain).

---

## 2. UI Feasibility Verdict

**Verdict: feasible-via-client-plugin-slots.**

Third-party Web UI extension IS supported via a real, documented mechanism — NOT fabrication. The path is a dual-faced cordis plugin:
- **Host half**: Service class + tool registration + persistence (composed into the host plane via cordis.patch.yml).
- **Browser half**: package.json declares `dsh.client: { platform: 'web', inject: [...] }` and `exports['./client']`; built with the shared `tsdown.client.ts` preset (or matching its `window.__ModuleLoader__.load({id, factory})` closure contract). ClientModuleRegistry (`packages/client/modules/src/index.ts:184-249`) auto-scans it into `window.__DSH_BOOT__` and serves `/plugins/<id>/client.js`.
- **UI contribution**: the final interaction contributes global CRUD through `settings.section` and
  per-conversation mode controls through `conversation.input.right`, both registered only after
  their declarations with `ctx.slots.inject(...)`. The verified `shell.overlay` slot remains an
  available third-party surface but is not used by the revised Settings/composer design. Do NOT
  register into `root` (single slot — shadows AppFrame).

**Degraded path**: The host half (Service + tool + persistence, no `dsh.client` declaration) is independently shippable and independently useful. The browser half can be added later by declaring `dsh.client`, adding the roster row, and building the client bundle. The slot system degrades gracefully — a slot with no registrations renders empty. Do NOT self-serve a separate frontend on another port (forbidden by `packages/bundle/web-app/src/index.ts:95-106`).

---

## 3. Plugin Form Decision

**Decision: CLASS FORM (Service subclass, default export).**

Rationale: `ctx.storageDomain.open(spec)` is async (`packages/storage/storage-domain/src/index.ts:100`). Function plugins' `apply()` is synchronous (returns void) — confirmed in `packages/todo/tool-todo/src/index.ts` and `packages/subagent/tool-subagent/src/index.ts:267`. Async domain initialization requires `[Service.init]`, the async post-construction method on Service (`vendor/cordis/src/service.ts:11`). The workspace (`packages/workspace/workspace/src/index.ts:92,119-124`) and message-feedback (`packages/feedback/message-feedback/src/index.ts:150-151,173-181`) plugins are real shipped examples of this exact pattern.

The class form also gives a typed `ctx.agentTeamGui` service (via `declare module` Context augmentation), which the browser half and other plugins can call programmatically. Tools are registered in `[Service.init]` via `this.ctx.tools.register(defineTool({...}))` — the disposer is auto-cleaned by the Service's fiber. The tool-subagent package (function form) proves the tool registration pattern; we replicate it inside `[Service.init]` instead of `apply()`.

**NEVER mix forms** (postmortem 0001, cited in `packages/CLAUDE.md`): the class form uses `default export` with `static inject`/`static Config` and NO named `name`/`inject`/`Config`/`apply` exports. The browser half is a separate entry point (`exports['./client']`) with its own named `inject`/`apply` — this is the client-plugin form, not the host-plugin form, so there is no conflict.

---

## 4. FR-4 Orchestration Design

### Execution Order: Serial and Parallel via direct `ctx.subagents.start()`

**Serial**: sequential `for`-loop of `ctx.subagents.start()` + `await run.result` + `await run.dispose()`:
```
for (const req of requests) {
  const run = await ctx.subagents.start(providerName, req)
  const result = await run.result
  await run.dispose()
  // pass result.output into next req.prompt if contextMode === 'chain'
}
```

**Parallel**: `Promise.all` over `ctx.subagents.start()` calls:
```
const runs = await Promise.all(requests.map(req => ctx.subagents.start(providerName, req)))
const results = await Promise.all(runs.map(async r => {
  const result = await r.result; await r.dispose(); return result
}))
```

### Context Passing Between Agents

Three modes, selected per-dispatch:
- **`spawn`** (default): `inheritsParentContext=false` — fresh child, zero parent context (`packages/subagent/subagent-spawn-in-process/src/index.ts:41`).
- **`fork`**: `inheritsParentContext=true` — child seeded with parent's completed-turn prefix (events up to last `turn/end`) via `completedTurnPrefix(request.parent)` (`packages/subagent/subagent-fork-in-process/src/index.ts:61`).
- **`chain`** (serial only): previous `SubagentResult.output` text is prepended to the next member's prompt. No shared-memory context between siblings — the dispatch logic is the orchestrator.

### Result Aggregation

Each `SubagentResult` (`packages/subagent/subagent/src/types.ts:219`) carries `output: ContentBlock[]` and `stopReason`. The tool's `execute()` collects all results into a canonical JSON value:
```
{ dispatchId, squadId, squadName, task, executionMode, contextMode,
  status: 'completed'|'partial'|'failed',
  members: [{ agentId, agentName, runId?, childId?, status, error?, stopReason?, output }] }
```
This value is validated against the tool's `output.schema` and rendered as complete canonical JSON
text. The durable `tool/result` therefore retains the full member results; the execution-local
canonical value alone would not be persisted.

### Rationale: Direct `ctx.subagents.start()` over `ctx.workflowEngine.start()`

1. **Proven pattern**: tool-subagent (`packages/subagent/tool-subagent/src/index.ts:425-429`) already does exactly this — builds `SubagentStartRequest`, calls `ctx.subagents.start(provider, request)`, awaits `run.result`, disposes. We replicate the proven path.
2. **No worker-thread dependency**: `ctx.workflowEngine.start()` (`packages/workflow/workflow-worker-thread/src/index.ts:143`) spawns a worker thread per run and expects a JS script string using `agent()`/`parallel()`/`pipeline()` combinators. The squad definition comes from storage-domain records (structured data), not a JS script — the workflow engine's script-body contract does not fit a squad-definition UI.
3. **Simpler concurrency**: For N<=10 squad members, `Promise.all` is sufficient. The workflow engine's `maxConcurrentAgents` FIFO slot acquisition (`packages/workflow/workflow-worker-thread/src/runtime.ts:227`) is overkill for typical squad sizes.
4. **Lifecycle events for free**: `subagent/start` and `subagent/end` events (`packages/subagent/subagent/src/index.ts:157`) are already emitted by SubagentRuntime, giving FR-5 observability without extra wiring.
5. **Upgrade path**: If high-scale fan-out (N>20, multi-stage pipelines) is needed later, `ctx.workflowEngine.start()` with `parallel()`/`pipeline()` can be adopted without changing the squad definition schema — the `SubagentStartRequest` shape is identical either way.

### Reuse over Rebuilding

The plugin COMPOSES existing services:
- `ctx.subagents` (SubagentRuntime) for dispatch — NOT a custom agent runner.
- `spawn`/`fork` providers (already registered by `subagent-spawn-in-process`/`subagent-fork-in-process`) — NOT a custom SubagentProvider.
- `ctx.storageDomain` for persistence — NOT a custom storage layer.
- `defineTool()` + `ctx.tools.register()` for the model-facing tool — NOT a custom tool registry.
- `ctx.slots.register()` for UI — NOT a self-served frontend.

---

## 5. File-by-File Build Plan

### Package Layout

```
dsh-agent-team-gui/
├── package.json                     # dsh.bundle.patch + dsh.client + exports map
├── cordis.patch.yml                 # inserts the single Web-profile host row
├── tsconfig.json                    # standalone shared compiler settings
├── tsconfig.host.json               # host/RPC declarations
├── tsconfig.client.json             # browser declarations
├── tsdown.config.ts                 # self-contained host + ModuleLoader client bundles
├── src/
│   ├── index.ts                     # HOST HALF: Service class default export + Context augmentation
│   ├── rpc.ts                       # loopback Connection RPC with Zod boundaries
│   ├── spec.ts                      # DomainSpec: defineDomain + domainTable + zod schemas
│   ├── types.ts                     # records, branded ids, and dispatch result types
│   ├── tools/
│   │   └── dispatch-to-squad.ts     # defineTool for dispatch_to_squad
│   └── client/
│       ├── index.ts                 # BROWSER HALF: Settings page + conversation input controls
│       └── AgentTeamDashboard.tsx   # Settings CRUD + conversation squad selection/toggle
├── tests/service.spec.ts            # CRUD, resolution, orchestration and failure tests
├── README.md
├── README-zh.md
└── LICENSE
```

### Phase P1: Minimal Plugin Skeleton That Loads

**Goal**: A class-form plugin that loads under `dsh --profile <name> --dump-config` and boots without errors.

#### `package.json`
```json
{
  "name": "@deepseek-ai/dsh-agent-team-gui",
  "version": "0.0.0",
  "type": "module",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-locale"]
    }
  },
  "dependencies": {
    "@deepseek-ai/cordis": "workspace:^",
    "@deepseek-ai/schemastery": "workspace:^",
    "@deepseek-ai/dsh-tools": "workspace:^",
    "@deepseek-ai/dsh-agent": "workspace:^",
    "@deepseek-ai/dsh-subagent": "workspace:^",
    "@deepseek-ai/dsh-storage-domain": "workspace:^",
    "@deepseek-ai/dsh-session": "workspace:^",
    "@deepseek-ai/dsh-llm": "workspace:^",
    "zod": "^3.23.0"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "workspace:^"
  }
}
```
Key: `dsh.bundle.patch` is the ONLY recognized bundle field (`packages/boot/app-boot/src/profile.ts:42-45`). `dsh.client` enables browser-half scanning (`packages/client/modules/src/index.ts:109-159`). `exports['./client']` is required for the Node half to serve the browser bundle.

#### `cordis.patch.yml`
```yaml
# agent_team_gui bundle patch — composes over dsh-base
- insert:
    # ── storage wiring (self-contained for minimal/headless profiles) ──
    - id: storage
      name: '@deepseek-ai/dsh-storage'
    - id: storage-json
      name: '@deepseek-ai/dsh-storage-json'
      config:
        root: !!js dshHomePath('storages')
    - id: storage-domain
      name: '@deepseek-ai/dsh-storage-domain'
      config:
        backend: json

    # ── subagent providers (required for dispatch) ──
    - id: subagents
      name: '@deepseek-ai/dsh-subagent'
    - id: subagent-spawn
      name: '@deepseek-ai/dsh-subagent-spawn-in-process'
      config:
        providerName: spawn
    - id: subagent-fork
      name: '@deepseek-ai/dsh-subagent-fork-in-process'
      config:
        providerName: fork

    # ── agent_team_gui host plugin ──
    - id: agent-team-gui
      name: '@deepseek-ai/dsh-agent-team-gui'
      config:
        defaultProvider: spawn
        defaultExecutionMode: serial
        defaultContextMode: spawn
```
Confirmed: Loader `insert` appends, and duplicate IDs fail during group update. The final patch is
Web-only and inserts only `agent-team-gui`; storage, subagent, Connection, and module services come
from the shipped Web profile.

#### `tsconfig.json`
Extends `tsconfig.base.json` (or `tsconfig.base.client.json` for dual-entry). `rootDir: src`, `outDir: lib/types`. References each workspace dependency. Registers in exactly one aggregate tsconfig (per `packages/CLAUDE.md`).

#### `src/index.ts` (P1 stub)
```typescript
import { Service, Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export interface Config {
  defaultProvider: string
  defaultExecutionMode: 'serial' | 'parallel'
  defaultContextMode: 'spawn' | 'fork' | 'chain'
}

export class AgentTeamService extends Service {
  static inject = ['storageDomain', 'tools', 'subagents']
  static Config: z<Config> = z.object({
    defaultProvider: z.string().default('spawn'),
    defaultExecutionMode: z.enum(['serial', 'parallel']).default('serial'),
    defaultContextMode: z.enum(['spawn', 'fork', 'chain']).default('spawn'),
  })

  constructor(ctx: Context, config: Config) {
    super(ctx, 'agentTeamGui')
  }

  protected async [Service.init](): Promise<void> {
    // P1: just log that we loaded
  }
}

export default AgentTeamService

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentTeamGui: AgentTeamService
  }
}
```

### Phase P2: Agent/Squad Data Model + Service + Persistence

**Goal**: Durable CRUD for agents and squads that survives restart.

#### `src/types.ts`
Defines branded id types (`AgentId`, `SquadId`, `DispatchId`), records, requests, and aggregate member
results. It deliberately does not merge custom session events because no out-of-tree registration
surface exists for the known-event catalog.

```typescript
import type { Branded } from '@deepseek-ai/dsh-brand'

export type AgentId = Branded<'AgentId'>
export type SquadId = Branded<'SquadId'>

export interface AgentRecord {
  name: string
  systemPrompt: string
  provider: string        // model route provider (e.g. 'deepseek-official')
  model: string           // model id (e.g. 'deepseek-v4-pro')
  maxTokens?: number
  toolScope?: { allow?: string[]; deny?: string[] }
}

export interface SquadRecord {
  name: string
  members: AgentId[]
  collabNote: string
}
```

The `provider`/`model` fields are just two strings — no API key material. Keys are owned by the credentials seam (`packages/credentials/credentials/src/index.ts:73`, `packages/llm/llm-deepseek/src/index.ts:225`).

#### `src/spec.ts`
```typescript
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  AgentId,
  SquadId,
  AgentRecord,
  SessionSquadModeRecord,
  SquadRecord,
} from './types.ts'

const agentRecordSchema = z.object({
  name: z.string(),
  systemPrompt: z.string(),
  provider: z.string(),
  model: z.string(),
  maxTokens: z.number().optional(),
  toolScope: z.object({ allow: z.array(z.string()).optional(), deny: z.array(z.string()).optional() }).optional(),
})

const squadRecordSchema = z.object({
  name: z.string(),
  members: z.array(z.string()),
  collabNote: z.string().optional(),
  executionOrder: z.array(z.string()).optional(),
  executionMode: z.enum(['serial', 'parallel']).optional(),
  contextMode: z.enum(['spawn', 'fork', 'chain']).optional(),
})

const sessionSquadModeSchema = z.object({
  squadId: z.string(),
})

export const agentTeamDomainSpec = defineDomain({
  name: 'agent_team_gui',   // must match /^[a-z][a-z0-9_]*/, doubles as backend unit name
  version: 0,
  tables: {
    agents: domainTable<AgentId, AgentRecord>(agentRecordSchema),
    squads: domainTable<SquadId, SquadRecord>(squadRecordSchema),
    session_modes: domainTable<SessionId, SessionSquadModeRecord>(sessionSquadModeSchema),
  },
})
```
Mirrors `packages/workspace/workspace/src/index.ts:119-124` and `packages/feedback/message-feedback/src/index.ts:173-181`. One domain owns three tables: global agent definitions, global squad definitions, and each session's enabled squad mode. Adding `session_modes` is backward-compatible for the bundled storage backends, so the domain remains at version 0 (storage-domain currently exposes no migration API).

#### Observability decision

No `src/events.ts` is shipped. Current dsh rejects unknown out-of-tree event types during persisted
session replay and exposes no external known-event registration seam. The registered model tool
already gives the parent session durable `tool/call` and `tool/result` records containing the full
request and aggregate result; each native child owns its normal subagent descriptor/session history,
and the service logs member start, finish, and failure.

#### `src/index.ts` (P2 full)
Extends P1 stub. In `[Service.init]`:
1. `const domain = await this.ctx.storageDomain.open(agentTeamDomainSpec)` (async, `storage-domain/src/index.ts:100`)
2. `this.ctx.effect(() => () => domain.close(), 'agent_team_gui.domainClose')` (disposer, `fiber.ts:415`)
3. `this.agents = domain.table('agents')` (`domain.ts:108`)
4. `this.squads = domain.table('squads')`
5. `this.sessionModes = domain.table('session_modes')`

CRUD methods on the service:
- `createAgent(id, record)` → `this.agents.put(id, record)` (`domain.ts:72`)
- `updateAgent(id, record)` → `this.agents.put(id, record)` (overwrite semantics, full-record replace)
- `deleteAgent(id)` → `this.agents.delete(id)` (`domain.ts:80`)
- `getAgent(id)` → `this.agents.get(id)` sync (`domain.ts:48`)
- `listAgents()` → `Array.from(this.agents.entries())` (`domain.ts:55`)
- Same for squads; `addMemberToSquad(squadId, agentId)` → `this.squads.update(squadId, s => ({ ...s, members: [...s.members, agentId] }))` (`domain.ts:89`, atomic RMW)

Optional: register a session projection via `ctx.inject(['sessionProjections'], ...)` for derived squad state (FR-5). Follow tool-todo's conditional injection pattern.

### Phase P3: dispatch_to_squad Tool + Orchestration

**Goal**: Model-facing tool that dispatches a task to a squad with serial/parallel execution, context passing, and result aggregation.

#### `src/tools/dispatch-to-squad.ts`
Uses `defineTool()` (`packages/core/tools/src/schema.ts:545`), following `packages/subagent/tool-subagent/src/index.ts:297-430` as the template.

**Parameters** (ParameterSchemaSpec, `packages/core/tools/src/schema.ts:103`):
```typescript
parameters: {
  squadId: { type: 'string', required: true, description: 'The squad to dispatch to' },
  task: { type: 'string', required: true, description: 'The task for all squad members' },
  executionMode: { type: 'string', enum: ['serial', 'parallel'], required: true, description: 'Execution order' },
  contextMode: { type: 'string', enum: ['spawn', 'fork', 'chain'], required: true, description: 'Context passing mode' },
}
```

**Output schema** (ValueSchemaSpec, `packages/core/tools/src/schema.ts:85`):
The output schema covers the full dispatch and every member's run/child identifiers, status,
error, stop reason, and output. `output.render()` serializes that entire canonical value to JSON
text instead of presenting only a summary, because the successful execution-local value is not a
durable session event.

**execute(args, exec)** (`packages/core/tools/src/index.ts:404` for ToolRunContext):
1. `const parent = exec.agent` — required (throw if undefined, per tool-subagent line 370-373).
2. `const squad = this.squads.get(args.squadId)` — load squad definition from storage.
3. For each `memberId` in `squad.members`, look up `AgentRecord`, build `SubagentStartRequest` (`packages/subagent/subagent/src/types.ts:100`):
   ```typescript
   const request: SubagentStartRequest = {
     label: `${squad.name}/${agent.name}`,
     prompt: [{ type: 'text', text: args.task }],
     parent,
     signal: exec.signal,
     agentOptions: { provider: agent.provider, model: agent.model, ...(agent.maxTokens ? { maxTokens: agent.maxTokens } : {}) },
     ...(agent.toolScope ? { toolFilter: agent.toolScope } : {}),
     ...(agent.systemPrompt ? { persona: agent.systemPrompt } : {}),
   }
   ```
4. **Serial**: start and settle one member at a time; `chain` passes the prior member's text output
   into the next prompt.
5. **Parallel**: settle all member executions through `Promise.all`, while converting each start,
   execution, stop-reason, and cleanup failure into that member's explicit result.
6. **Aggregate** results into the canonical output value with dispatch/run/child IDs and status.
7. Return the aggregate. The ToolRuntime records it in the parent's standard `tool/result` event.

**Provider selection**: `providerName = args.contextMode === 'fork' ? 'fork' : 'spawn'`. The `fork` provider seeds the child with the parent's completed-turn prefix (`subagent-fork-in-process/src/index.ts:61`); `spawn` starts fresh (`subagent-spawn-in-process/src/index.ts:41`). For `chain` mode, use `spawn` and pass results manually.

**Registration**: In `[Service.init]`, after opening the domain:
```typescript
this.ctx.effect(() => {
  const dispose = this.ctx.tools.register(defineTool({ ... }))
  return () => dispose()
}, 'agent_team_gui.toolDispatch')
```
Or simply `this.ctx.tools.register(defineTool({...}))` — the disposer is auto-cleaned by the Service's fiber (same as how `ctx.on()` auto-cleans). The `ctx.effect()` wrapper is more explicit and matches CLAUDE.md's "every contribution goes through ctx.effect()" rule.

**Authorization** (optional): Use `ctx.on('tools/pre-execute', ...)` waterfall (`packages/core/tools/src/index.ts:152`) to check `exec.agent` authorization and return `{kind:'deny', reason}` for unauthorized callers. For a hard invariant, use `ctx.tools.guard()` (`:1110`).

### Phase P4: UI (Browser Half) + Bundle/Profile Wiring

**Revised interaction goal (implemented and runtime-verified)**: Agent and squad
definitions are global, durable resources managed under Settings. A conversation selects one squad
and explicitly toggles collaboration on or off. With collaboration enabled, the ordinary composer
Send path activates the selected session mode and instructs the lead model to use the squad, with
the result returned through the normal conversation flow; there is no second task box or separate
Dispatch button. A squad may pin a fixed member order. If it does not, the model plans member
assignments and execution order for that request. The model-facing
`dispatch_to_squad` tool remains the natural-language path.

#### `src/client/index.ts`
```typescript
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { TeamComposerControl, TeamSettingsPage } from './AgentTeamDashboard.tsx'

export const inject = ['slots', 'connection']

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'agent-teams',
    label: () => 'Teams',
  }, TeamSettingsPage))

  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'agent-team-gui-mode',
  }, TeamComposerControl))
}
```
Both contributions wait for the shipped slot declaration through `ctx.slots.inject()` before
registering.

#### `src/client/AgentTeamDashboard.tsx`
React component that:
- Contributes global agent/squad CRUD under Settings.
- Contributes a per-conversation squad selector and collaboration toggle near the composer.
- Uses ordinary Send as the collaboration trigger instead of owning another task box/button.
- Lets a squad pin a fixed member order; an unset order delegates assignments/order to the model.
- Model picker: calls the dedicated host Connection RPC, which enumerates
  `ctx.llm.listProviders()` + `ctx.llm.listModels(provider)`; the browser never accesses host
  services directly.

The dedicated `/agent-team-gui` Connection RPC with loopback authority remains the verified
Settings CRUD/snapshot seam and now provides `mode/get`/`mode/set` per session. The host reads
storage and `ctx.llm`; browser code never imports a host service or calls a bare unvalidated
endpoint. An enabled mode contributes a dynamic system prompt that asks the lead model to call
`dispatch_to_squad` exactly once, choose `memberOrder` when the squad has no fixed
`executionOrder`, and summarize the aggregate in the normal assistant response. This is
best-effort model instruction because the current GenerateOptions surface has no `toolChoice`
control. Runtime verification confirmed the Settings page, persistent member/squad CRUD,
fixed-order reordering, per-conversation selector/toggle, and mode restoration after reload.

#### `tsdown.config.ts`
Confirmed: the shared dsh preset is monorepo-internal, so the package carries a self-contained
adaptation that emits the verified `window.__ModuleLoader__.load({id, factory})` closure and keeps
only the platform module table external. The UI uses inline styles, so no CSS module transformer is
needed.

#### Browser discovery
Confirmed by isolated-profile/browser testing: ClientModuleRegistry scans the package named by the
single active host row and loads its `dsh.client`/`./client` entry. No second roster row is present.
The full browser half ships in P4; there is no degraded host-only release mode for this Web bundle.

### Phase P5: README + LICENSE

#### `README.md`
- Package description: agent team GUI plugin for dsh — manage global persistent squads in Settings,
  select/toggle a squad per conversation, and collaborate through ordinary Send.
- Installation: `dsh plugin --profile <name> add @deepseek-ai/dsh-agent-team-gui` (or `add .` from a built checkout).
- If git-hosted with a `prepare` script: document the `allowBuilds` key copy step for `pnpm-workspace.yaml` (per `reference/README.md:51`).
- Configuration: `cordis.patch.yml` config fields (`defaultProvider`, `defaultExecutionMode`, `defaultContextMode`).
- Model routes: explain that `{ provider, model }` are just route strings; API keys are owned by the credentials seam (`packages/llm/llm-deepseek/src/index.ts:225`).
- Storage: the plugin uses `storage-domain` with a `agent_team_gui` domain; the profile must wire storage + a backend + storage-domain (the plugin's `cordis.patch.yml` inserts these rows for minimal profiles).
- Known Limitations: Web profile only, pre-release storage version 0, no custom out-of-tree session
  event types, serial-only chain, and unbounded `Promise.all` for large fan-outs.

#### `LICENSE`
Match the dsh repo's license (check `LICENSE` file at repo root).

---

## 6. FR-to-API Mapping

### FR-1: Each agent picks a model the user configured (no API keys stored); available tool range per agent
- **Model route storage**: `AgentRecord { provider: string, model: string }` — stored in storage-domain `agents` table via `KvTable.put()` (`storage-domain/src/domain.ts:72`). The route is just two strings (`AgentOptions` at `runtime-types.ts:24`, `LlmCallConfig` at `call-config.ts:23`).
- **No API keys**: keys owned by credentials seam (`credentials/src/index.ts:73` `resolve(ref)`); llm-deepseek stores `apiKeyEnv` reference, not key value (`llm-deepseek/src/index.ts:225`). The plugin stores only provider+model strings — key-free by construction.
- **Model picker UI**: `ctx.llm.listProviders()` (`llm/src/index.ts:419`), `ctx.llm.listConfigurableProviders()` (`:490`), `ctx.llm.listModels(provider)` (`:581`), `ctx.llm.resolveModelInfo(provider, model)` (`:619`). These run on the host; browser calls via RPC.
- **Default model seed**: `ctx.get('agentDefaultModel')?.currentSelection()` (`agent-default-model/src/index.ts:88`).
- **Per-agent route at dispatch**: `SubagentStartRequest.agentOptions = { provider, model, maxTokens }` (`subagent/src/types.ts:119`); `resolveChildAgentOptions` inherits parent route and applies overrides (`subagent/src/child-agent.ts:68`).
- **Tool range per agent**: `SubagentStartRequest.toolFilter` (`subagent/src/types.ts:100`, ToolRestriction `{allow?,deny?}`); applied via `applyChildComposition` (`subagent/src/child-agent.ts:163`) and `ctx.tools.restrict()` (`tools/src/index.ts:1071`).

### FR-2: Persist agent/squad definitions and per-session squad modes across restart
- `ctx.storageDomain.open(spec)` (`storage-domain/src/index.ts:100`) — async, in `[Service.init]`.
- `defineDomain({ name:'agent_team_gui', version:0, tables:{agents,squads,session_modes} })` (`spec.ts`).
- `domainTable<K,V>(zodSchema)` (`spec.ts:63`).
- `Domain.table('agents')` / `.table('squads')` / `.table('session_modes')` (`domain.ts:108`).
- CRUD: `put(key, value)` (`domain.ts:72`), `get(key)` sync (`domain.ts:48`), `delete(key)` (`domain.ts:80`), `update(key, fn)` atomic RMW (`domain.ts:89`), `entries()` (`domain.ts:55`).
- `mode/get` and `mode/set` resolve the current selection from `SessionId` to `SquadId`; deleting a squad and replace-mode import remove dangling session selections.
- `Domain.close()` via `ctx.effect(() => () => domain.close())` (`domain.ts:118`, `fiber.ts:415`).
- Pattern: `packages/workspace/workspace/src/index.ts:92,119-124`, `packages/feedback/message-feedback/src/index.ts:150-151,173-181`.
- Storage wiring: `packages/bundle/web-app/cordis.patch.yml:51-62` (storage + storage-json + storage-domain).

### FR-3: Dispatch tasks to a squad of agents
- `ctx.subagents.start(providerName, request)` (`subagent/src/index.ts:171`).
- `SubagentStartRequest` (`subagent/src/types.ts:100`): `prompt`, `parent=exec.agent`, `signal=exec.signal`, `agentOptions`, `toolFilter`, `persona`.
- `SubagentRun` (`subagent/src/types.ts:249`): `await run.result`, `await run.dispose()`.
- `SubagentResult` (`subagent/src/types.ts:219`): `output: ContentBlock[]`, `stopReason`.
- `defineTool()` + `ctx.tools.register()` (`tools/src/schema.ts:545`, `tools/src/index.ts:1037`).
- Providers: `spawn` (`subagent-spawn-in-process/src/index.ts:41`), `fork` (`subagent-fork-in-process/src/index.ts:61`).
- Template: `packages/subagent/tool-subagent/src/index.ts:369-430`.

### FR-4: Serial/parallel execution order, context passing, result aggregation
- **Serial**: for-loop of `ctx.subagents.start()` + `await run.result` + `await run.dispose()` (sequential awaits, no separate API — proven by tool-subagent).
- **Parallel**: `Promise.all` over `ctx.subagents.start()` calls.
- **Context passing**: `fork` provider seeds child with parent's completed-turn prefix (`subagent-fork-in-process/src/index.ts:61`, `inheritsParentContext=true`); `spawn` starts fresh (`subagent-spawn-in-process/src/index.ts:41`, `inheritsParentContext=false`); `chain` mode passes `SubagentResult.output` text into next member's prompt.
- **Result aggregation**: collect `SubagentResult.output` from each `run.result`; combine into canonical JSON value matching `output.schema`.
- **Alternative (future)**: `ctx.workflowEngine.start()` with `parallel()`/`pipeline()` (`workflow-worker-thread/src/runtime.ts:100`) for high-scale fan-out.

### FR-5: Observability (logging, replay, UI)
- **Session logging**: ToolRuntime automatically appends the parent's standard `tool/call` and
  `tool/result`, including the full aggregate.
- **No custom events**: external event types cannot join the closed known-event catalog safely.
- **Native lifecycle**: subagent providers own child sessions/descriptors; aggregate rows retain
  provider run IDs and child IDs where available.
- **Child session inspection**: `ctx.subagents.listChildren(parentSessionId)` / `listDescendants(rootSessionId)` (`subagent/src/index.ts:339`); `ctx.sessions.get(childId)` for a child's `Session.events` / `deriveMessages()` (`session/src/index.ts:559`).
- **Session events**: `ctx.on('session/event', ...)` (`session/src/index.ts:43`) — real-time append feed.
- **Derived state (optional)**: `ctx.sessionProjections.register(definition)` (`session-projection/src/index.ts:171`) — init/apply/view pure functions folded over session events.
- **Storage updates**: `ctx.on('domain/changed', ...)` (`storage-domain/src/events.ts:46`) — refresh UI cache after put/delete.
- **UI**: `ctx.slots.inject('settings.section', ...)` owns global CRUD and
  `ctx.slots.inject('conversation.input.right', ...)` owns the session selector/toggle; both use the
  runtime slot registration contract (`runtime/src/client/slots.ts:143-205,464-471`).
- **Per-message chat node (optional)**: `ctx.conversationEvents.register(definition)` + keyed `ctx.slots.register({name:'conversation.chat.node', key}, Component)` (`docs/cookbook/adding-a-conversation-node.md:188`).

---

## 7. Resolved confirmation list

All P0 confirmations are resolved in the completion status above: duplicate IDs fail; dedicated
Connection RPC is the supported third-party data seam; the client build contract must be adapted
locally; the active host row discovers the out-of-tree browser entry; and custom out-of-tree
session events are not safe. No `TODO(confirm)` remains.
