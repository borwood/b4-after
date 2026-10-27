// Reconciliation: bring the committed model in line with the evidence. Deferred updates and
// removals whose change sets are now verified get applied; every entity's status tags, metadata
// and visuals are refreshed; the generated views follow. Idempotent: nothing is committed when
// the regenerated files equal the committed ones. Runs after evidence is recorded, and on demand
// (for example to adopt a model written before statuses existed).
import { join } from 'node:path'
import { Git } from './git.js'
import { IdentityRegistry } from './identity.js'
import { Ledger } from './ledger.js'
import { loadModel, modelFromParsedData, MODEL_DIR, type ParsedModelData } from './model.js'
import { finalizeBaseline, type AppliedOperation, type StatusCount } from './status.js'
import { generateAndCheck, readWorkspace, sameWorkspace, summarizeErrors, writeWorkspace } from './workspace.js'

export interface ReconcileOptions {
  actor: string
  expectedHead?: string
  date?: string
}

export interface ReconcileResult {
  /** False when the committed model already matched the evidence; nothing was written. */
  changed: boolean
  /** The commit that holds the reconciled model, or the unchanged HEAD. */
  sha: string
  /** HEAD the reconciliation was computed against. */
  baseline: string
  applied: AppliedOperation[]
  warnings: string[]
  counts: StatusCount
}

export class ReconcileRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReconcileRefused'
  }
}

export async function reconcileBaseline(repoDir: string, opts: ReconcileOptions): Promise<ReconcileResult> {
  const git = new Git(repoDir)
  if (!(await Git.isRepo(repoDir))) throw new ReconcileRefused(`${repoDir} is not a git repository`)
  const head = await git.headSha()
  if (!head) throw new ReconcileRefused('repository has no commits')
  if (opts.expectedHead !== undefined && head !== opts.expectedHead) {
    throw new ReconcileRefused(`repository moved: expected HEAD ${opts.expectedHead}, found ${head}`)
  }
  const dirty = (await git.exec(['status', '--porcelain', '--', MODEL_DIR])).trim()
  if (dirty) throw new ReconcileRefused(`uncommitted changes under ${MODEL_DIR}/ must be committed or discarded first:\n${dirty}`)

  const ledger = await Ledger.load(repoDir)
  const loaded = await loadModel(repoDir)
  const data = structuredClone(loaded.parsedData) as ParsedModelData
  const final = await finalizeBaseline(data, ledger)

  const check = await generateAndCheck(data, ledger)
  if (check.errors.length) throw new ReconcileRefused(`reconciled model is invalid; baseline left unchanged:\n  ${summarizeErrors(check.errors).join('\n  ')}`)
  const modelDir = join(repoDir, MODEL_DIR)
  const base = { baseline: head, applied: final.applied, warnings: final.warnings, counts: final.statuses.counts }
  if (sameWorkspace(await readWorkspace(modelDir), check.files)) return { changed: false, sha: head, ...base }

  const expected = stableIds(IdentityRegistry.fromModel(await modelFromParsedData(data)))
  const survivors = new Set(stableIds(IdentityRegistry.fromModel(check.loaded.model)))
  const lost = expected.filter(id => !survivors.has(id))
  if (lost.length) throw new ReconcileRefused(`stable ids lost in regeneration; baseline left unchanged: ${lost.join(', ')}`)

  try {
    await writeWorkspace(modelDir, check.files)
    await git.exec(['add', '-A', '--', MODEL_DIR])
    const applied = final.applied.map(a => `Applied: ${a.changeId} ${a.op} ${a.entityId}`)
    const message = [
      `reconcile baseline: ${final.applied.length} verified operation${final.applied.length === 1 ? '' : 's'} applied`,
      [...applied, `Reconciled-From: ${head}`, `Actor: ${opts.actor}`].join('\n'),
    ].join('\n\n') + '\n'
    const sha = await git.commit(message, { date: opts.date })
    return { changed: true, sha, ...base }
  } catch (e) {
    await git.exec(['reset', '-q', '--', MODEL_DIR]).catch(() => {})
    await git.exec(['checkout', '-q', '--', MODEL_DIR]).catch(() => {})
    await git.exec(['clean', '-fdq', '--', MODEL_DIR]).catch(() => {})
    throw e
  }
}

const stableIds = (reg: IdentityRegistry) => [...reg.elements(), ...reg.relationships()].map(r => r.stableId)
