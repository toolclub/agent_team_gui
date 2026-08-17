export const REPOSITORY_ROOT: string
export const DEFAULT_API_VERSION: number

export function invariant(condition: unknown, message: string): asserts condition
export function envFlag(name: string, fallback?: boolean): boolean
export function positiveInteger(value: string | undefined, label: string, fallback: number): number
export function parseAgentTeamGitSpec(spec: string): string
export function isExpectedRestartHostDescribe404(input: {
  intentionalRestart: boolean
  baseUrl: string
  sourceUrl: string
  message: string
}): boolean
export function resolveRepositoryReleaseTarball(value: string): Promise<string>
export function sanitizedEnvironment(source?: NodeJS.ProcessEnv | Record<string, string | undefined>): Record<string, string | undefined>
export function createHermeticEnvironment(workspace: TemporaryWorkspace, source?: NodeJS.ProcessEnv | Record<string, string | undefined>): Promise<{
  env: Record<string, string | undefined>
  userHome: string
  dshHome: string
}>
export function readJson(path: string): Promise<unknown>

export class CommandRunner {
  constructor(options?: { cwd?: string; env?: NodeJS.ProcessEnv | Record<string, string | undefined> })
  run(command: string, args: string[], options?: { capture?: boolean; timeoutMs?: number }): Promise<{ stdout: string; stderr: string }>
}

export class TemporaryWorkspace {
  static create(prefix?: string): Promise<TemporaryWorkspace>
  constructor(root: string)
  readonly root: string
  readonly keep: boolean
  path(...segments: string[]): string
  directory(...segments: string[]): Promise<string>
  preserve(): void
  cleanup(): Promise<void>
}

export function packPlugin(destination: string, runner?: CommandRunner): Promise<string>
