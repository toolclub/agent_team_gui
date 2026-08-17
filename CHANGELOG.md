# Changelog

## 0.4.1 — 2026-08-17

- Prevent recursive squad explosions by excluding delegated sessions from automatic mode, denying
  team/subagent tools inside members, and rejecting nested dispatches at the service boundary.
- Dispatch only the latest user message and deduplicate guaranteed dispatch by session/message trace.
- Stream official `tokenUsage` projection changes into active run/member rows, subtract fork seed
  usage, and show **Metering…** until a provider reports instead of displaying a false zero.
- Make the parent conversation's Main Agent the default dynamic workflow planner: it assigns every
  configured member exactly once according to role/model/tool capabilities, while fixed order remains
  an explicit override and planning failures fall back to differentiated role-scoped assignments.
- Rehydrate the persisted team catalog and per-conversation/project selection after every Web
  reconnect, with bounded cold-start retries so restarting DSH no longer requires re-saving a team.

## 0.4.0 — 2026-08-17

- Run the selected squad reliably from the host `agent/pre-step` path before the lead model answers.
- Add a conversation **Team runs** view and live run dock with durable progress, outputs, retry state,
  cancellation, timings, child IDs, and official provider-reported token usage buckets.
- Add optional planning leads, fixed/model-planned ordering, bounded parallelism, member timeouts,
  continue/stop/retry-once policies, fallback model routes, and soft token budgets.
- Add per-project team defaults with explicit per-conversation opt-out.
- Add quick-start templates, visual tool policies, team cloning, immutable revisions/restore, route
  diagnostics, and safer merge/replace import previews.
- Fix the composer switch being locked during Harness's normal `adjudicating` phase.
- Fix the Export action and add visible success/error feedback.
- Upgrade the browser/host RPC contract to revision 2 and add validated endpoints for runs,
  revisions, diagnostics, project defaults, import, and export.

## 0.1.0 — 2026-08-15

- Initial public preview with persistent agents/squads, Web Settings UI, per-conversation selection,
  serial/parallel dispatch, spawn/fork/chain context, import/export, and `dispatch_to_squad`.
