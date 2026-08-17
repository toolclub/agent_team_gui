import { CommandRunner, invariant } from './common.mjs'

const runner = new CommandRunner()
const fullSha = /^[0-9a-f]{40}$/
const safeBranch = /^[0-9A-Za-z._/-]+$/

async function check(...args) {
  await runner.run('git', args, { capture: true })
}

const baseBranch = process.env.GITHUB_BASE_REF
const before = process.env.QUALITY_DIFF_BASE || process.env.GITHUB_EVENT_BEFORE

if (baseBranch) {
  invariant(safeBranch.test(baseBranch) && !baseBranch.includes('..'), 'GITHUB_BASE_REF is not a safe branch name')
  await check('diff', '--check', `origin/${baseBranch}...HEAD`)
} else if (before && fullSha.test(before) && !/^0+$/.test(before)) {
  await check('diff', '--check', `${before}...HEAD`)
} else {
  // Local/tag/first-push fallback: validate the checked-out commit as well as
  // staged and unstaged work. Unlike a bare `git diff --check` in CI, this is
  // meaningful after changes have already been committed.
  await check('show', '--check', '--format=', 'HEAD')
}
await check('diff', '--check')
await check('diff', '--cached', '--check')

process.stdout.write('Git whitespace check passed for the relevant commit range and worktree.\n')
