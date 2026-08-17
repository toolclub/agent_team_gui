import { isAbsolute, join } from 'node:path'
import {
  CommandRunner,
  createHermeticEnvironment,
  REPOSITORY_ROOT,
  TemporaryWorkspace,
  envFlag,
  invariant,
  readJson,
} from './common.mjs'

const manifest = await readJson(join(REPOSITORY_ROOT, 'package.json'))
const expectedVersion = process.env.EXPECTED_VERSION || manifest.version
invariant(manifest.version === expectedVersion, `expected package version ${expectedVersion}, got ${manifest.version}`)

if (process.env.EXPECTED_TAG) {
  invariant(process.env.EXPECTED_TAG === `v${manifest.version}`, `tag ${process.env.EXPECTED_TAG} does not match package v${manifest.version}`)
}

const workspace = await TemporaryWorkspace.create('dsh-agent-team-gui-preflight-')
if (envFlag('KEEP_SMOKE_HOME')) workspace.preserve()
process.stdout.write(`Preflight process workspace: ${workspace.root}${workspace.keep ? ' (preserved)' : ' (removed after success)'}\n`)
const { env } = await createHermeticEnvironment(workspace)
if (process.env.DSH_BIN) {
  invariant(isAbsolute(process.env.DSH_BIN), 'DSH_BIN must be an absolute executable path for preflight')
  env.DSH_BIN = process.env.DSH_BIN
}
for (const key of ['API_VERSION', 'SMOKE_TIMEOUT_MS', 'SMOKE_SCREENSHOT_DIR']) {
  if (process.env[key]) env[key] = process.env[key]
}
for (const key of ['KEEP_SMOKE_HOME', 'SMOKE_VERBOSE', 'RUN_SUPPLEMENTAL_DOCTOR', 'RUN_BROWSER_SMOKE']) {
  if (envFlag(key)) env[key] = '1'
}
const runner = new CommandRunner({ env })
const requireClean = envFlag('RELEASE_REQUIRE_CLEAN')
async function assertCleanWorktree(stage) {
  const status = await runner.run('git', ['status', '--short'], { capture: true })
  invariant(status.stdout.trim() === '', `release worktree must be clean ${stage}:\n${status.stdout}`)
}
try {
  if (requireClean) await assertCleanWorktree('before preflight')

  const stages = [
    ['pnpm', ['run', 'check:whitespace']],
    ['pnpm', ['install', '--frozen-lockfile', '--ignore-scripts']],
    ['pnpm', ['run', 'typecheck']],
    ['pnpm', ['run', 'test']],
    ['pnpm', ['run', 'build']],
    ['pnpm', ['run', 'audit:pack']],
    ['pnpm', ['run', 'smoke:install']],
  ]
  if (envFlag('RUN_SUPPLEMENTAL_DOCTOR')) stages.push(['pnpm', ['run', 'quality:doctor']])
  if (envFlag('RUN_BROWSER_SMOKE')) stages.push(['pnpm', ['run', 'smoke:browser']])

  for (const [command, args] of stages) await runner.run(command, args, { timeoutMs: 600_000 })
  if (requireClean) await assertCleanWorktree('after preflight')
  process.stdout.write(`Release preflight passed for dsh-agent-team-gui v${manifest.version}.\n`)
} catch (error) {
  workspace.preserve()
  throw error
} finally {
  await workspace.cleanup()
}
