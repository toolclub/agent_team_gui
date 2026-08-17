# Security policy

## Supported versions

Security fixes are made on the latest tagged release. Maintainers may also patch the immediately
preceding minor release when a safe backport is practical. Git-installed development revisions are
not a stable support channel.

## Reporting a vulnerability

Please do not publish an exploit, credential, private prompt, conversation export, or filesystem
contents in a public issue.

Use GitHub's private vulnerability reporting for this repository when it is available. Include:

- the affected version or exact commit;
- the DeepSeek Harness and Node.js versions;
- the smallest safe reproduction;
- expected and observed behaviour;
- the security impact and whether credentials or user data were exposed; and
- any suggested mitigation.

If private reporting is unavailable, open a public issue containing only the title “Private security
report requested” and non-sensitive contact information. A maintainer will establish a private
channel before asking for reproduction details.

You can expect acknowledgement within seven days. We will coordinate validation, a fix, release
timing, and credit with the reporter. Please allow a reasonable remediation window before public
disclosure.

## Security boundaries

- Provider credentials belong to DeepSeek Harness providers and must never be stored in an agent,
  team, recipe, backup, run export, log, screenshot, or test fixture.
- The plugin's browser RPC channel is loopback-only. Do not expose a Web profile to untrusted
  networks without an authentication and reverse-proxy boundary appropriate for the host.
- Imported recipes are data, not executable code. They must be validated and previewed before any
  write. v0.5 accepts reviewed local JSON only; URL fetching is disabled rather than exposing an
  incompletely protected server-side request surface.
- Delegated members must not receive team-dispatch or unrestricted subagent-spawning tools.
- Release artifacts are checked for credentials, unexpected files, and unresolved client runtime
  dependencies before publication.
- Supplemental community audit tools are never allowed to inspect a developer's credential-bearing
  environment by default. They run only in an explicit credential-free CI/opt-in boundary with the
  minimum reviewed permissions; the local package/runtime gates remain authoritative.
