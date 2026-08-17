# dsh-agent-team-gui

[English](README.md) | [简体中文](README-zh.md)

[![GitHub stars](https://img.shields.io/github/stars/toolclub/dsh-agent-team-gui?style=flat-square)](https://github.com/toolclub/dsh-agent-team-gui/stargazers)
[![GitHub release](https://img.shields.io/github/v/release/toolclub/dsh-agent-team-gui?include_prereleases&style=flat-square)](https://github.com/toolclub/dsh-agent-team-gui/releases)
[![MIT license](https://img.shields.io/github/license/toolclub/dsh-agent-team-gui?style=flat-square)](LICENSE)

**Persistent multi-model agent squads for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**
Give every member its own model and tool policy, save reusable teams in Settings, then select a
squad beside the composer and keep chatting normally.

![Manage persistent multi-model squads in DeepSeek Harness Settings](assets/team-settings-v0.4.jpg)

## 60-second install

```sh
dsh plugin --profile web add -w github:toolclub/dsh-agent-team-gui#v0.4.1
dsh --profile web
```

Then open **Settings → Teams**, create a squad, select it beside the conversation composer, and
turn on **Squad mode**. The plugin uses your existing dsh model routes and credential store; it
never stores API keys.

| What you get | Why it matters |
| --- | --- |
| One provider/model and tool policy per agent | Mix a strong planner, fast implementer, and strict reviewer in one squad |
| Global persistent agents and squads | Build a team once, then reuse it across projects and conversations |
| Fixed or Main-Agent-planned execution order | Pin a repeatable workflow, or let the conversation's Main Agent assign every member for each task |
| Serial/parallel execution with spawn/fork/chain context | Match collaboration topology to the task instead of forcing one pattern |
| Live run center plus official token usage | Inspect plans, outputs, retries, failures, and each member's real provider-reported tokens |

![Enable a saved squad directly in a DeepSeek Harness conversation](assets/squad-mode-v0.4.jpg)

![Inspect member progress and provider-reported token usage](assets/team-runs-v0.4.jpg)

If this workflow is useful, a [GitHub Star](https://github.com/toolclub/dsh-agent-team-gui) helps
other DeepSeek Harness users discover it. Bug reports and real squad recipes are equally welcome.

> [!WARNING]
> Both dsh and this plugin are developer previews. The plugin targets dsh `>=0.1.0-rc.5 <0.2.0`
> and requires Node.js 22.19 or later. dsh can make breaking changes before a stable release; pin
> both dsh and this plugin when reproducibility matters.

## Key distinction

A squad does not have to share one model configuration. Every agent can independently select an
existing dsh provider/model route, `maxTokens`, and tool allow/deny policy. Save those agents as
global reusable definitions in Settings, combine them into persistent squads, and select a squad
per conversation. When squad collaboration is enabled, an ordinary Send enters the collaboration
flow: the squad follows its optional fixed member order, or lets the Main Agent dynamically plan a
role-specific assignment for every configured member and their execution order when no order is pinned.

## Status and architecture

```text
Settings --> global agent/squad definitions --+
Conversation --> per-session squad mode -------+--> dsh storage-domain --> JSON backend
                                              |
Conversation squad selector + collaboration toggle
                                              |
ordinary Send --> fixed member order, if set --+
              `-> Main Agent plans every member otherwise
                                              |
                  Agent A / Agent B / Agent C
                                              |
             assistant response + traceable child sessions

Natural-language request --> dispatch_to_squad (model tool) --> same squad runtime
```

The package contains a Web client, loopback-only Connection RPC, host service, durable registry,
and model-facing dispatch tool. **Settings → Teams** manages global definitions. Each
conversation gets a squad selector and collaboration toggle; after selecting a squad and enabling
collaboration, the user sends through the ordinary composer rather than a separate dispatch form.
Provider and model choices are read from dsh's existing model configuration.

Current capabilities:

- Durable agents, squads, immutable squad revisions, run history, per-session selection, and optional
  per-project defaults through dsh `storage-domain`.
- Settings forms, quick-start templates, safe merge/replace import preview, cloning, revision restore,
  and a model-route diagnostic for global agents and squads.
- Per-conversation selector and toggle. In the default **Guaranteed** mode, ordinary Send runs the
  squad at the host boundary before the lead model answers; it no longer depends on the model
  deciding to call a tool. A legacy model-tool mode remains available.
- Optional fixed order; otherwise the conversation's Main Agent is the default workflow planner and
  produces a complete, role-specific assignment and order for every configured member. Invalid plans
  safely fall back to one differentiated role-scoped assignment per member. The optional planning
  lead is retained only as a fallback for manual dispatch paths without main-conversation context.
- Per-agent primary and fallback `{ provider, model, maxTokens? }` routes plus visual tool
  allow/deny policies; no API-key storage.
- Model-callable `dispatch_to_squad` with optional explicit per-agent assignments.
- Serial or bounded-parallel execution; `spawn`, `fork`, or serial-only `chain` context; member
  timeout, continue/stop/retry-once policy, fallback routes, cancellation, and a soft token budget.
- A per-conversation **Team runs** view and live composer dock with the plan, member progress,
  outputs, retries, timings, child IDs, and official dsh `tokenUsage` buckets. Monetary prices are
  intentionally not guessed because Harness providers do not expose a stable price table.

## Prerequisites

- The dsh **Web profile**, version `>=0.1.0-rc.5 <0.2.0`. This bundle is not a headless
  or bare-profile bundle.
- Node.js 22.19 or later.
- pnpm on `PATH`. The Git-install notes below apply to pnpm 10 and later.
- At least one provider/model route configured in dsh. Configure credentials through dsh Settings
  or its credentials mechanism, never in this plugin's records.

The commands below assume an installed `dsh` executable. Cloning the DeepSeek Harness source does
**not** install that executable globally. From the Harness repository root, verify the source CLI
with:

```sh
pnpm dsh --version
```

When running from another directory, replace every `dsh ...` below with
`pnpm --dir /absolute/path/to/deepseek-harness dsh ...`.

## Install from a local directory

Run each command from the directory that contains `dsh-agent-team-gui`.

1. Install the plugin's development dependencies:

   ```sh
   pnpm --dir ./dsh-agent-team-gui install
   ```

   Expected: pnpm finishes successfully and creates or updates `dsh-agent-team-gui/node_modules`.

2. Build the checkout before linking it into a profile:

   ```sh
   pnpm --dir ./dsh-agent-team-gui run build
   ```

   Expected: the command exits with status 0 and produces the runtime entry under
   `dsh-agent-team-gui/lib/`.

3. Add the local bundle to the Web profile:

   ```sh
   dsh plugin --profile web add -w ./dsh-agent-team-gui
   ```

   Expected: pnpm reports `dsh-agent-team-gui` as added. dsh must not print the warning that the
   package "declares no dsh.bundle".

4. Inspect the composed configuration without booting it:

   ```sh
   dsh --profile web --dump-config
   ```

   Expected: output contains a `dsh-agent-team-gui` bundle layer and an `agent-team-gui` row.

5. Start the profile:

   ```sh
   dsh --profile web
   ```

   Expected: dsh starts normally, **Settings → Teams** is available, and conversations show
   the squad selector and collaboration toggle. When info-level host logging is enabled, the log
   also contains
   `[agent-team-gui] v0.4 registry, guaranteed conversation dispatch, run center and token usage ready`.

## Install from a tarball

A built tarball contains compiled output and therefore needs no install-script allowance.

1. Install dependencies and build:

   ```sh
   pnpm --dir ./dsh-agent-team-gui install
   pnpm --dir ./dsh-agent-team-gui run build
   ```

   Expected: both commands exit with status 0 and `dsh-agent-team-gui/lib/` exists.

2. Create the tarball:

   ```sh
   pnpm --dir ./dsh-agent-team-gui pack
   ```

   Expected: pnpm prints the generated archive name, normally
   `dsh-agent-team-gui-0.4.1.tgz`. Use the exact path printed by your pnpm version below.

3. Install that archive:

   ```sh
   dsh plugin --profile web add -w ./dsh-agent-team-gui/dsh-agent-team-gui-0.4.1.tgz
   ```

   Expected: pnpm reports `dsh-agent-team-gui` as added without an `allowBuilds` prompt. If `pack`
   printed the archive elsewhere, substitute that exact path.

4. Verify the layer:

   ```sh
   dsh --profile web --dump-config
   ```

   Expected: the dump contains the `dsh-agent-team-gui` layer and `agent-team-gui` row.

## Install from GitHub

Git dependencies contain source rather than prebuilt release artifacts. This repository therefore
ships a self-contained `prepare` path that builds its runtime entry without assuming a sibling dsh
monorepo checkout.

You can also send this single sentence to a DeepSeek Harness agent that has terminal access:

> Follow the README at https://github.com/toolclub/dsh-agent-team-gui and install the plugin into the
> DeepSeek Harness web profile; resolve and pin the current main commit SHA, configure pnpm
> `allowBuilds` as documented, and verify with `dsh --profile web --dump-config`.

1. Pin and install a reviewed commit:

   ```sh
   dsh plugin --profile web add -w github:toolclub/dsh-agent-team-gui#<commit-sha>
   ```

   Expected with pnpm 10 or later on the first attempt: installation may fail because pnpm blocks
   the Git dependency's `prepare` script. pnpm prints the **exact package key**, and dsh prints the
   profile directory whose `pnpm-workspace.yaml` must be changed.

2. Add exactly the key pnpm printed to that profile's workspace file. With the default dsh home,
   edit `~/.dsh/profiles/web/pnpm-workspace.yaml` (or
   `$DSH_HOME/profiles/web/pnpm-workspace.yaml` when `DSH_HOME` is set):

   ```yaml
   allowBuilds:
     dsh-agent-team-gui: true
   ```

   Expected: the YAML now preserves any existing workspace settings and contains the printed key
   under `allowBuilds`. Do not guess the key if pnpm printed a different one.

3. Re-run the same pinned install:

   ```sh
   dsh plugin --profile web add -w github:toolclub/dsh-agent-team-gui#<commit-sha>
   ```

   Expected: pnpm is allowed to run `prepare`, builds the package, and reports it as added.

4. Verify the bundle layer:

   ```sh
   dsh --profile web --dump-config
   ```

   Expected: the dump contains the `dsh-agent-team-gui` layer and `agent-team-gui` row.

5. Restart any running dsh Web process, then refresh the browser. Installing or updating replaces
   files on disk but cannot replace an already loaded host module. The UI performs an RPC revision
   handshake and shows an explicit restart message if client and host revisions do not match.

> [!CAUTION]
> `allowBuilds` authorizes that package to execute code on your machine during installation. This
> code runs outside every dsh agent sandbox. Allow only packages whose source you trust, review the
> selected revision, and pin `github:owner/repo#<sha>` so later pushes cannot silently change what
> executes. A built tarball avoids this build permission.

## Configuration

The bundle inserts this host row:

```yaml
- id: agent-team-gui
  name: dsh-agent-team-gui
  config:
    defaultProvider: spawn
    defaultExecutionMode: serial
    defaultContextMode: spawn
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `defaultProvider` | `string` | `spawn` | Registered dsh subagent provider used unless dispatch/context selection chooses another one. |
| `defaultExecutionMode` | `serial \| parallel` | `serial` | Default member scheduling. |
| `defaultContextMode` | `spawn \| fork \| chain` | `spawn` | `spawn` starts fresh children; `fork` includes the parent's completed-turn prefix; `chain` passes each serial member's text to the next. |

To override it for one profile, edit `$DSH_HOME/profiles/<name>/cordis.patch.yml`:

```yaml
- id: agent-team-gui
  config:
    defaultProvider: fork
    defaultExecutionMode: parallel
    defaultContextMode: fork
```

dsh patch rows replace the complete `config` object; they are not deep-merged. Restate every field
you need whenever overriding the row. `chain` is valid only with serial execution.

Agent records contain:

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Display name. |
| `systemPrompt` | yes | Role/persona passed to the child agent. |
| `provider` | yes | Existing dsh provider route name. |
| `model` | yes | Existing model id for that provider. |
| `maxTokens` | no | Per-agent token cap. |
| `toolScope.allow` / `toolScope.deny` | no | dsh tool-name restrictions applied to that child. |

Squad records contain:

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Global display name used by Settings and conversation selectors. |
| `members` | yes | Unique agent IDs available to the squad. |
| `collabNote` | no | Collaboration guidance included in member prompts. |
| `executionOrder` | no | Fixed complete ordering of every member. Omit it for Main Agent dynamic planning. |
| `executionMode` | no | Squad default: `serial` or `parallel`; falls back to plugin config. |
| `contextMode` | no | Squad default: `spawn`, `fork`, or serial-only `chain`; falls back to plugin config. |

Squad records contain `name`, an optional collaboration note, a member list, optional
`executionOrder`, and optional `executionMode`/`contextMode` defaults. An agent may appear in
multiple squads. **Settings → Teams** edits these global records through a loopback-only host RPC.
A fixed `executionOrder` must contain every member exactly once. With no fixed order, normal
conversation sends use the parent Agent's provider/model route to plan one assignment per member and
a complete `memberOrder`. The plugin stores route
names only; it does not store or copy provider secrets.

### In-process service API

Plugin authors can also use the same registry in-process:

```ts
const agentId = await ctx.agentTeamGui.createAgent({
  name: 'Reviewer',
  systemPrompt: 'Review for correctness and cite concrete evidence.',
  provider: 'your-configured-provider',
  model: 'your-configured-model',
  toolScope: { allow: ['bash', 'str_replace_editor'] },
})

const squad = await ctx.agentTeamGui.createSquad({
  name: 'Release review',
  collabNote: 'Run independent checks, then consolidate findings.',
  members: [agentId],
})
```

The service also exposes get/list/update/delete methods for both record types,
`addMemberToSquad`, `removeMemberFromSquad`, `exportDefinitions`/`importDefinitions`, and a
programmatic `dispatch` method. Exact TypeScript signatures are exported by the package
declarations.

## Usage examples

### Natural-language dispatch (available after a squad exists)

```text
User: Give the release-review squad this task: inspect the patch for regressions.
      Have the reviewer check correctness and the test agent run focused tests in parallel.

Assistant: [calls dispatch_to_squad with squadId, task,
            assignments=[...], executionMode="parallel", contextMode="spawn"]

Assistant: The squad completed with two member results. The reviewer found ..., and the focused
           tests .... Any failed member is listed explicitly instead of being omitted.
```

The model selects `dispatch_to_squad`; the plugin does not parse the user's text with regular
expressions. `squadId` accepts either the durable ID or an exact squad name (case-insensitive); if
names are duplicated, use the durable ID. Tool arguments are `squadId`, `task`, optional
`assignments: [{ agentId, task }]`, optional `executionMode`, and optional `contextMode`.
`memberOrder` is also optional when the squad has no fixed `executionOrder`; when supplied, it must
be a complete, duplicate-free ordering of all squad members. A fixed squad order cannot be
overridden per call. The tool renders the complete canonical JSON result—including each member's
`runId`, `childId`, status, error, stop reason, and output—so the lead model can produce the final
summary.

### Conversation collaboration toggle

1. Start `dsh --profile web` and open **Settings → Teams**.
2. Create the agents. Choose each primary and optional fallback provider/model from routes already
   configured in dsh; optionally set max tokens and visual tool permissions. Or start from one of
   the development, review, and product templates.
3. Create a global squad, select its members, and optionally pin a fixed member order. Without a
   fixed order, the Main Agent automatically generates assignments and order for each request. The
   optional fallback planning lead is only for manual-dispatch paths. Configure
   serial/parallel context, retry/stop behavior, timeout, concurrency, and a soft token budget.
4. Open any conversation, select **Release review** in its squad selector, and enable squad
   collaboration.
5. Type the task in the normal composer and select **Send**. Disable the toggle to return that
   conversation to ordinary single-agent sends.

```text
User types: Inspect this change and prepare a release recommendation.
Conversation control: Release review squad -> Collaboration on
User selects: Send

Assistant: [the selected squad collaborates using the current conversation as parent]
Assistant: The release-review squad recommends ... Reviewer: ... Test agent: ...
```

The selected squad is conversation-scoped and durable. The star beside the selector optionally
makes it the default for every conversation rooted in the same project directory; a conversation
can still opt out. Global definitions, modes, revisions, and run history survive restart. Deleting a
selected squad cleans affected session and project defaults. Sending needs no second task box or
Dispatch button. In default Guaranteed mode, the host runs the team during dsh's official
`agent/pre-step` waterfall and appends the canonical squad result before the lead model generates
the normal assistant response. If orchestration itself fails, the lead model is still allowed to
answer and receives a visible failure notice.

### Export and import definitions

**Settings → Teams** can dump and restore the durable definitions as a JSON document.

- **Export** downloads `agent-team-gui-<date>.json` containing `{ "format":
  "agent-team-gui/definitions", "version": 1, "agents": [...], "squads": [...] }` — every record with
  its durable id, plus model routes (never API keys).
- **Import** first previews agent/team counts and lets the user choose **merge** or **replace**.
  Merge upserts document rows by
  id, keeps existing rows the document does not mention, and lets a squad
  reference an agent that already exists in the store. The whole document is validated first — shape,
  duplicate ids, model routes, and squad member references — so a rejected import writes nothing.
  (The durable writes themselves are not a single transaction: a storage failure mid-import can leave
  a partial apply.)

The same operations are available in-process as `exportDefinitions()` and
`importDefinitions(document, mode)`; `mode` is `merge` (default) or `replace`. `replace` makes the
document the entire store, and then a squad may only reference agents present in the document.

## Observability and failure behavior

Every execution creates a durable run record before planning starts. **Team runs** shows the plan,
live member state, full text outputs, attempts, errors, duration, and provider-owned child/run IDs;
active runs can be cancelled. Token totals reuse dsh's official `tokenUsage` session projection and
keep uncached input, cache read, cache write, and output buckets separate. The plugin reports tokens
instead of inventing currency amounts because Harness does not currently expose a stable provider
price table. Before a provider emits its first usage sample, the UI says **Metering…** rather than
showing a misleading zero. Squad children are lineage-gated and cannot recursively dispatch another
squad or subagent tree. Model-tool calls also retain the complete canonical JSON in standard durable
`tool/result` text. The host log records member lifecycle. Cordis owns listener/tool cleanup, and
the storage domain closes when the plugin unloads.

## Uninstall

The general form is `dsh plugin --profile <name> remove <pkg>`. For this Web bundle:

```sh
dsh plugin --profile web remove dsh-agent-team-gui
```

Expected: pnpm removes the dependency and dsh removes `dsh-agent-team-gui` from the profile's bundle
list. Durable records under the dsh storage backend are not automatically deleted.

## Known limitations

- Web profile only; the bundle depends on dsh Web's storage, Connection RPC, and browser module
  services and does not support a headless or bare custom profile.
- There is no separate shell CLI/YAML record editor; use Settings or the in-process service API.
- No custom `squad/*` session event types: the current out-of-tree API cannot register them in
  dsh's known-event catalog. Observability relies on standard tool events, child sessions, and host
  logs.
- The storage domain is version 0. v0.4 adds tables compatibly, but future developer-preview
  releases may still require explicit migrations.
- Routes are validated on save/import and can be rechecked from Settings. A route removed later is
  recorded as an explicit member failure; retry-once can use that member's fallback route.
- Default Guaranteed mode is host-driven. The optional **Model tool** trigger remains best-effort
  because Harness exposes no `toolChoice` control.
- The token budget is a soft boundary: a member already running cannot be stopped at the exact token
  threshold; it prevents later members/batches from starting.
- Token cost is reported in tokens, not money, until Harness exposes stable per-provider pricing.
- dsh APIs are pre-stable, so compatibility is intentionally bounded to `>=0.1.0-rc.5 <0.2.0`.

## Roadmap

- Schema migrations once the upstream storage contract stabilizes.
- Optional provider price adapters if Harness publishes a canonical pricing interface.
- Shareable community template packs and aggregated project-level run analytics.

## Contributing

The concise Chinese walkthrough [从零开发一个 DeepSeek Harness 插件](docs/developing-a-deepseek-harness-plugin.zh-CN.md)
explains `apply`, class-based Service plugins, profile/bundle wiring, local verification, and GitHub
installation with links to the official Harness documentation. Release details are in the
[changelog](CHANGELOG.md).

1. Open an issue describing the behavior and dsh version.
2. Install dependencies with `pnpm install` and build with `pnpm run build`.
3. Add focused tests and run `pnpm test`, `pnpm run typecheck`, and `pnpm pack` as applicable.
4. Keep RPC loopback-scoped, never store API keys, and use only dsh APIs verified in the matching
   source version.
5. Submit a focused pull request with an English commit message.

## License

Released under the [MIT License](LICENSE).
