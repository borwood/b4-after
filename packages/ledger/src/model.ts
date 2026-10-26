// Load the declared baseline (LikeC4 model) from a model-data repository, either from the working
// tree or as committed at a git revision. The returned model is a computed LikeC4Model.
//
// Phase A finding: likec4.computedModel() returns one shared, mutable instance. We dispose the
// LikeC4 services right after extracting the model so nothing else can reach them.
import { LikeC4 } from 'likec4'
import type { LikeC4Model } from '@likec4/core/model'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Git } from './git.js'

export const MODEL_DIR = 'model'

export interface LoadedModel {
  model: LikeC4Model
  /** Where the model came from. */
  source: 'worktree' | 'revision'
  revision: string | null
  errors: string[]
}

export interface LoadModelOptions {
  /** Git revision (sha, tag, branch) to read the model from. Omit for the working tree. */
  revision?: string
  /** Subdirectory holding the LikeC4 sources. Default "model". */
  modelDir?: string
  /** Throw on LikeC4 validation errors (default true, per AR-15). */
  throwIfInvalid?: boolean
}

export async function loadModel(repoDir: string, opts: LoadModelOptions = {}): Promise<LoadedModel> {
  const modelDir = opts.modelDir ?? MODEL_DIR
  if (!opts.revision) {
    return readWorkspace(join(repoDir, modelDir), 'worktree', null, opts.throwIfInvalid ?? true)
  }
  const git = new Git(repoDir)
  const sha = await git.revParse(opts.revision)
  const files = await git.lsTree(sha, modelDir)
  if (files.length === 0) throw new Error(`no files under ${modelDir}/ at revision ${opts.revision}`)
  const tmp = await mkdtemp(join(tmpdir(), 'like-b4-model-'))
  try {
    for (const f of files) {
      const content = await git.show(sha, f)
      const target = join(tmp, f.slice(modelDir.length + 1))
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content, 'utf8')
    }
    return await readWorkspace(tmp, 'revision', sha, opts.throwIfInvalid ?? true)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

async function readWorkspace(dir: string, source: LoadedModel['source'], revision: string | null, throwIfInvalid: boolean): Promise<LoadedModel> {
  const likec4 = await LikeC4.fromWorkspace(dir, { logger: false, printErrors: false, throwIfInvalid: false })
  try {
    const errors = likec4.getErrors().map(e => `${e.sourceFsPath}:${e.line} ${e.message}`)
    if (errors.length && throwIfInvalid) {
      throw new Error(`invalid LikeC4 model (${source}${revision ? ' ' + revision.slice(0, 7) : ''}):\n  ${errors.join('\n  ')}`)
    }
    const model = await likec4.computedModel()
    return { model, source, revision, errors }
  } finally {
    await likec4.dispose()
  }
}
