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

/** LikeC4's parsed (pre-compute) model data. Projections operate on this and the DSL generator consumes it. */
export type ParsedModelData = Record<string, any>

export interface LoadedModel {
  model: LikeC4Model
  /** Detached copy of the parsed data; safe to mutate. */
  parsedData: ParsedModelData
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
    const parsedData = structuredClone((await likec4.parsedModel()).$data) as ParsedModelData
    return { model, parsedData, source, revision, errors }
  } finally {
    await likec4.dispose()
  }
}

/** Compute a LikeC4Model from parsed data without touching any shared instance. */
export async function modelFromParsedData(data: ParsedModelData): Promise<LikeC4Model> {
  const { LikeC4Model } = await import('@likec4/core/model')
  const { computeParsedModelData } = await import('@likec4/core/compute-view')
  return LikeC4Model.create(computeParsedModelData(structuredClone(data) as any)) as unknown as LikeC4Model
}

/** Theme colour names the DSL accepts verbatim. */
const THEME_COLORS = new Set(['amber', 'blue', 'gray', 'slate', 'green', 'indigo', 'muted', 'primary', 'red', 'secondary', 'sky'])
/** Radix palette names LikeC4 assigns to tags declared without a colour; the generator emits them but the parser rejects them (Phase A finding). */
const RADIX_HEX: Record<string, string> = {
  tomato: '#E54D2E', grass: '#46A758', ruby: '#E54666', orange: '#F76B15', pink: '#D6409F', teal: '#12A594',
  purple: '#8E4EC6', crimson: '#E93D82', lime: '#BDEE63', yellow: '#FFE629', violet: '#6E56CF',
}

/** Make parsed data safe for the DSL generator. Returns a copy. */
export function sanitizeForGeneration(data: ParsedModelData): ParsedModelData {
  const out = structuredClone(data) as ParsedModelData
  for (const tag of Object.values<any>(out.specification?.tags ?? {})) {
    const c = tag?.color
    if (typeof c === 'string' && !c.startsWith('#') && !THEME_COLORS.has(c)) tag.color = RADIX_HEX[c] ?? '#64748b'
  }
  return out
}

/** Generate DSL from parsed data (never from computed data: computed views carry nodes, not rules). */
export async function generateDSL(data: ParsedModelData): Promise<string> {
  const { generate } = await import('likec4/generators/likec4')
  return generate(sanitizeForGeneration(data) as any)
}

/** Validate parsed data by generating DSL and loading it with the real LikeC4 parser. Returns the DSL. */
export async function roundTripCheck(data: ParsedModelData): Promise<{ dsl: string; errors: string[] }> {
  const dsl = await generateDSL(data)
  const tmp = await mkdtemp(join(tmpdir(), 'like-b4-check-'))
  try {
    await writeFile(join(tmp, 'model.c4'), dsl, 'utf8')
    const loaded = await readWorkspace(tmp, 'worktree', null, false)
    return { dsl, errors: loaded.errors }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}
