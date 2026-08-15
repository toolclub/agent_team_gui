# dsh-agent-team-gui

[English](README.md) | [简体中文](README-zh.md)

`dsh-agent-team-gui` is an experimental agent-and-squad orchestration bundle for
[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness). It stores reusable agent
definitions, groups them into squads, and lets the model dispatch work through the
`dispatch_to_squad` tool. Each member can use a different existing dsh model route and a different
tool allow/deny list. API keys remain in dsh's provider and credentials configuration; this plugin
never stores them.

> [!WARNING]
> Both dsh and this plugin are developer previews. The plugin targets dsh `>=0.1.0-rc.5 <0.2.0`
> and requires Node.js 22.19 or later. dsh can make breaking changes before a stable release; pin
> both dsh and this plugin when reproducibility matters.

## Status and architecture

```text
User conversation
       |
       v
dispatch_to_squad (model tool)
       |
       +-- serial / parallel execution
       +-- spawn / fork / chain context
       |
       +--> Agent A --> configured dsh provider/model
       +--> Agent B --> configured dsh provider/model
       `--> Agent C --> configured dsh provider/model
              |
              `--> aggregated result + append-only session events

Agent and squad definitions --> dsh storage-domain --> JSON backend

dsh Web composer "Squad" button --> client dashboard --> loopback Connection RPC --> host service
```

The package contains a Web client, loopback-only Connection RPC, host service, durable registry,
and model-facing dispatch tool. The composer-side **Squad** button opens the **Agent Teams** panel,
where you can manage definitions and dispatch into the currently open conversation. Provider and
model choices are read from dsh's existing model configuration.

Current capabilities:

- Durable agent and squad records through dsh `storage-domain`.
- Web forms to create, edit, and delete agents and squads, including a configured-model picker.
- A composer-side squad button and direct dispatch panel for the current conversation.
- Per-agent `{ provider, model, maxTokens? }` route and tool restrictions; no API-key storage.
- Model-callable `dispatch_to_squad` with optional explicit per-agent assignments.
- Serial or parallel execution and `spawn`, `fork`, or serial-only `chain` context modes.
- Explicit per-member success/failure results. One member failure does not silently cancel the
  remaining squad.
- Complete dispatch input/output in the parent session's append-only `tool/call` and `tool/result`
  records, with child session/run IDs in each member result.

## Prerequisites

- The dsh **Web profile**, version `>=0.1.0-rc.5 <0.2.0`. This bundle is not a headless
  or bare-profile bundle.
- Node.js 22.19 or later.
- pnpm on `PATH`. The Git-install notes below apply to pnpm 10 and later.
- At least one provider/model route configured in dsh. Configure credentials through dsh Settings
  or its credentials mechanism, never in this plugin's records.

The commands below assume the installed `dsh` executable. When running dsh itself from a source
checkout, replace `dsh ...` with `pnpm --dir /path/to/deepseek-harness dsh ...` after building that
checkout.

## Install from a local directory

Run each command from the directory that contains `agent_team_gui`.

1. Install the plugin's development dependencies:

   ```sh
   pnpm --dir ./agent_team_gui install
   ```

   Expected: pnpm finishes successfully and creates or updates `agent_team_gui/node_modules`.

2. Build the checkout before linking it into a profile:

   ```sh
   pnpm --dir ./agent_team_gui run build
   ```

   Expected: the command exits with status 0 and produces the runtime entry under
   `agent_team_gui/lib/`.

3. Add the local bundle to the Web profile:

   ```sh
   dsh plugin --profile web add -w ./agent_team_gui
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

   Expected: dsh starts normally and a visible **Squad** button appears beside the conversation
   composer. When info-level host logging is enabled, the log also contains
   `[agent-team-gui] durable registry and dispatch_to_squad ready`.

## Install from a tarball

A built tarball contains compiled output and therefore needs no install-script allowance.

1. Install dependencies and build:

   ```sh
   pnpm --dir ./agent_team_gui install
   pnpm --dir ./agent_team_gui run build
   ```

   Expected: both commands exit with status 0 and `agent_team_gui/lib/` exists.

2. Create the tarball:

   ```sh
   pnpm --dir ./agent_team_gui pack
   ```

   Expected: pnpm prints the generated archive name, normally
   `dsh-agent-team-gui-0.1.0.tgz`. Use the exact path printed by your pnpm version below.

3. Install that archive:

   ```sh
   dsh plugin --profile web add -w ./agent_team_gui/dsh-agent-team-gui-0.1.0.tgz
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

> Follow the README at https://github.com/toolclub/agent_team_gui and install the plugin into the
> DeepSeek Harness web profile; resolve and pin the current main commit SHA, configure pnpm
> `allowBuilds` as documented, and verify with `dsh --profile web --dump-config`.

1. Pin and install a reviewed commit:

   ```sh
   dsh plugin --profile web add -w github:toolclub/agent_team_gui#<commit-sha>
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
   dsh plugin --profile web add -w github:toolclub/agent_team_gui#<commit-sha>
   ```

   Expected: pnpm is allowed to run `prepare`, builds the package, and reports it as added.

4. Verify the bundle layer:

   ```sh
   dsh --profile web --dump-config
   ```

   Expected: the dump contains the `dsh-agent-team-gui` layer and `agent-team-gui` row.

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

Squad records contain `name`, an optional collaboration note, and an ordered list of agent IDs. An
agent may appear in multiple squads. The **Agent Teams** panel edits these records through a
loopback-only host RPC. The plugin stores route names only; it does not store or copy provider
secrets.

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
`addMemberToSquad`, `removeMemberFromSquad`, and a programmatic `dispatch` method. Exact TypeScript
signatures are exported by the package declarations.

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

### Conversation-side button dispatch

1. Start `dsh --profile web`, open a conversation, and select **Squad** beside the composer.
2. In **Agent Teams**, create the agents. Choose each provider/model from the routes already
   configured in dsh Settings; optionally enter max tokens and comma-separated allowed/denied
   tools.
3. Create a squad, select its members, and optionally add a collaboration note.
4. In **Dispatch current task**, choose the squad, execution mode, and context mode; enter
   the task and select **Dispatch**.

```text
User types: Inspect this change and prepare a release recommendation.
User selects: Release review squad -> Parallel -> Dispatch

Panel: [the client requests a host dispatch using the current live conversation as parent]
Panel: completed — Reviewer: completed; Test agent: completed
```

The direct result is shown in the overlay; button dispatch does not synthesize an assistant chat
message.

## Observability and failure behavior

The parent session's ordinary `tool/call` and `tool/result` events retain the request and complete
aggregated result. Every member result includes the provider-owned child session/run IDs when a
child started, so its trajectory can be inspected through dsh's existing subagent/session views.
The host log also records member start/finish/failure. Results distinguish complete, partial, and
failed members. A member failure is aggregated with its error and does not silently stop unrelated
members. The plugin contributes no long-lived subprocess; Cordis owns tool/listener cleanup, and
the storage domain is closed when the plugin unloads.

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
- There is no separate shell CLI/YAML record editor; use the Web panel or in-process service API.
- No custom `squad/*` session event types: the current out-of-tree API cannot register them in
  dsh's known-event catalog. Observability relies on standard tool events, child sessions, and host
  logs.
- The storage domain is version 0; developer-preview releases may reject or require migration of
  older on-disk data.
- Model route names are validated by dsh when children run; a removed/misspelled provider or model
  produces an explicit member failure.
- `chain` mode is serial only. Large fan-outs do not yet use the workflow engine's concurrency
  controls.
- dsh APIs are pre-stable, so compatibility is intentionally bounded to `>=0.1.0-rc.5 <0.2.0`.

## Roadmap

- Add import/export, bulk editing, and richer per-agent assignment controls in the Web panel.
- Add import/export and schema migrations for durable definitions.
- Add bounded concurrency and richer trajectory projections for large squads.

## Contributing

1. Open an issue describing the behavior and dsh version.
2. Install dependencies with `pnpm install` and build with `pnpm run build`.
3. Add focused tests and run `pnpm test`, `pnpm run typecheck`, and `pnpm pack` as applicable.
4. Keep RPC loopback-scoped, never store API keys, and use only dsh APIs verified in the matching
   source version.
5. Submit a focused pull request with an English commit message.

## License

Released under the [MIT License](LICENSE).
