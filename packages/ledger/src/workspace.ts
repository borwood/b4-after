// The files b4-after writes under model/: generated DSL for specification and model, and generated
// views. Everything that writes a LikeC4 workspace (promotion, reconciliation, adoption, rendering)
// goes through here so the files are always produced and checked the same way.
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Ledger } from './ledger.js'
import { generateDSL, loadModel, MODEL_DIR, type LoadedModel, type ParsedModelData } from './model.js'
import { ensureReservedTags } from './status.js'
import { generateViews } from './views.js'

export const MODEL_FILE = 'model.c4'
export const VIEWS_FILE = 'views.c4'

/** File name to content. */
export type WorkspaceFiles = Record<string, string>

/** The generated views refer to the reserved status tags, so the specification always declares them. */
export async function workspaceFiles(data: ParsedModelData, ledger?: Ledger): Promise<WorkspaceFiles> {
  const copy = structuredClone(data) as ParsedModelData
  ensureReservedTags(copy)
  return { [MODEL_FILE]: await generateDSL(copy), [VIEWS_FILE]: generateViews(copy, ledger) }
}

/** The .c4 files currently in a directory. */
export async function readWorkspace(dir: string): Promise<WorkspaceFiles> {
  const out: WorkspaceFiles = {}
  let names: string[] = []
  try { names = await readdir(dir) } catch { return out }
  for (const name of names.filter(n => /\.c4$/i.test(n)).sort()) out[name] = await readFile(join(dir, name), 'utf8')
  return out
}

/** Write the files and remove any other .c4 file, so the generated files are the only source. */
export async function writeWorkspace(dir: string, files: WorkspaceFiles): Promise<void> {
  await mkdir(dir, { recursive: true })
  for (const name of Object.keys(await readWorkspace(dir))) if (!(name in files)) await rm(join(dir, name))
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content, 'utf8')
}

export function sameWorkspace(a: WorkspaceFiles, b: WorkspaceFiles): boolean {
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort()
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k])
}

/** Load the files as a model repository would see them (under model/), in a temporary directory. */
export async function loadWorkspaceFiles(files: WorkspaceFiles, opts: { throwIfInvalid?: boolean } = {}): Promise<LoadedModel> {
  const dir = await mkdtemp(join(tmpdir(), 'b4-after-ws-'))
  try {
    await writeWorkspace(join(dir, MODEL_DIR), files)
    return await loadModel(dir, { throwIfInvalid: opts.throwIfInvalid ?? false })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * LikeC4's parser lists every token it would have accepted, which can run to hundreds of kilobytes.
 * Keep what identifies the problem: the first few errors, each cut at the expected-token list.
 */
export function summarizeErrors(errors: string[], max = 5): string[] {
  const out = errors.slice(0, max).map(e => {
    const cut = e.indexOf('\nExpected')
    const line = (cut > 0 ? e.slice(0, cut) : e).replace(/\s+/g, ' ').trim()
    return line.length > 300 ? line.slice(0, 297) + '...' : line
  })
  if (errors.length > max) out.push(`... and ${errors.length - max} more`)
  return out
}

/** Generate the workspace for `data` and prove it loads with the real LikeC4 parser. */
export async function generateAndCheck(data: ParsedModelData, ledger?: Ledger): Promise<{ files: WorkspaceFiles; loaded: LoadedModel; errors: string[] }> {
  const files = await workspaceFiles(data, ledger)
  const loaded = await loadWorkspaceFiles(files)
  return { files, loaded, errors: loaded.errors }
}
