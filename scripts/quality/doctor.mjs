import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { CommandRunner, createHermeticEnvironment, REPOSITORY_ROOT, TemporaryWorkspace, envFlag, invariant } from './common.mjs'

invariant(
  envFlag('RUN_SUPPLEMENTAL_DOCTOR'),
  'The community doctor is opt-in because it is not an OS sandbox. Run only in a credential-free checkout with RUN_SUPPLEMENTAL_DOCTOR=1.',
)

const workspace = await TemporaryWorkspace.create('dsh-agent-team-gui-doctor-')
if (envFlag('KEEP_SMOKE_HOME')) workspace.preserve()
process.stdout.write(`Doctor workspace: ${workspace.root}${workspace.keep ? ' (preserved)' : ' (removed after success)'}\n`)
try {
  const reportDirectory = await workspace.directory('reports')
  const { env } = await createHermeticEnvironment(workspace)
  const runner = new CommandRunner({ env })
  const doctorCli = join(REPOSITORY_ROOT, 'node_modules', 'dsh-plugin-doctor', 'src', 'cli.js')
  await access(doctorCli).catch(() => {
    throw new Error('Pinned dsh-plugin-doctor@0.1.0 is not installed; run pnpm install --frozen-lockfile')
  })
  await runner.run(process.execPath, [
    doctorCli,
    'check',
    REPOSITORY_ROOT,
    '--no-isolate',
    '--allow-permission',
    'install-script',
    '--timeout',
    '120',
    '--report-dir',
    reportDirectory,
  ], { timeoutMs: 180_000 })
  process.stdout.write('Supplemental pinned doctor static audit passed without target lifecycle execution.\n')
} catch (error) {
  workspace.preserve()
  throw error
} finally {
  await workspace.cleanup()
}
