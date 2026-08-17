## What changed

Describe the user problem and the resulting behaviour. Keep unrelated refactors in a separate PR.

## Verification

- [ ] `pnpm run check:whitespace`
- [ ] `pnpm run typecheck`
- [ ] `pnpm run test`
- [ ] `pnpm run build`
- [ ] `pnpm run audit:pack`
- [ ] Relevant isolated DSH/browser smoke completed
- [ ] New or changed behaviour has regression tests

## Product review

- [ ] Existing v0.4 records, exports, and documented install commands remain compatible, or the migration is documented and tested.
- [ ] Long-running work is observable, cancellable, restart-safe, and bounded.
- [ ] Token values are described as provider-reported usage, not invented monetary cost.
- [ ] Errors are actionable and accessible; keyboard, narrow viewport, light/dark theme, and zh/en behaviour were considered.
- [ ] README and screenshots were updated for visible changes, or are not applicable.

## Security and privacy

- [ ] No credentials, personal paths, private prompts, or proprietary outputs are included.
- [ ] New RPC inputs are schema-validated and preserve the loopback/trust boundary.
- [ ] New tools, remote fetches, filesystem writes, and dependencies are called out below.

Security/dependency notes:

<!-- Explain new authority or write "None". -->

Screenshots or recordings:

<!-- Required for visible UI changes. Use representative, sanitized data. -->
