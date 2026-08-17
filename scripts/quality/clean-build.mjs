import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { REPOSITORY_ROOT } from './common.mjs'

// `lib` is the package's generated-only output directory. Cleaning it before
// every build prevents removed source modules from surviving in a local pack.
const output = resolve(REPOSITORY_ROOT, 'lib')
await rm(output, { recursive: true, force: true })
