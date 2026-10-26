// Baseline promotion (PRD 6.3 [O], section 9 [P]): apply an accepted change set to the committed
// model and record the promotion on the change set, in one commit. Policy is explicit and narrow;
// the write is verified by reloading the regenerated model before anything is committed.
//
// Decision (Phase C): the baseline is machine-generated DSL in model/model.c4. Promotion
// regenerates that file from parsed data. Other .c4 files under model/ are removed on the first
// promotion so the generated file is the only source.
import { readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Git } from './git.js'
import { IdentityRegistry } from './identity.js'
import { Ledger, changeSetPath, serializeChangeSet, CHANGES_DIR } from './ledger.js'
import { loadModel, roundTripCheck, MODEL_DIR } from './model.js'
import { applyChangeSets, ProjectionError, type ProjectionIssue } from './projection.js'
import { commitMessageFor } from './provenance.js'
import type { ChangeSet, Disposition, Implementation } from './schema.js'

export interface PromotionPolicy {
  /** Dispositions eligible for promotion. Default ['accepted']. */
  dispositions?: Disposition[]
  /** If set, implementation must be one of these. Default: no constraint (PRD: accepted does not mean implemented; promotion records declared architecture). */
  implementations?: Implementation[]
}

export interface PromoteOptions {
  actor: string
  expectedHead?: string
  policy?: PromotionPolicy
  date?: string
}

export interface PromoteResult {
  changeId: string
  sha: string
  baseline: string
  modelFile: string
  /** Stable ids now present in the baseline that were added by this change set. */
  added: string[]
  removed: string[]
}

export class PromotionRefused extends Error {
  constructor(message: string, readonly issues: ProjectionIssue[] = []) {
    super(message)
    this.name = 'PromotionRefused'
  }
}

export async function promoteChangeSet(repoDir: string, changeId: string, opts: PromoteOptions): Promise<PromoteResult> {
  const git = new Git(repoDir)
  if (!(await Git.isRepo(repoDir))) throw new PromotionRefused(`${repoDir} is not a git repository`)
  const head = await git.headSha()
  if (!head) throw new PromotionRefused('repository has no commits')
  if (opts.expectedHead !== undefined && head !== opts.expectedHead) {
    throw new PromotionRefused(`repository moved: expected HEAD ${opts.expectedHead}, found ${head}`)
  }
  const dirty = (await git.exec(['status', '--porcelain', '--', MODEL_DIR, CHANGES_DIR])).trim()
  if (dirty) throw new PromotionRefused(`uncommitted changes under ${MODEL_DIR}/ or ${CHANGES_DIR}/ must be committed or discarded first:\n${dirty}`)

  const ledger = await Ledger.load(repoDir)
  const rec = ledger.get(changeId)
  if (!rec) throw new PromotionRefused(`${changeId} is not in the ledger`)
  const cs = rec.changeSet
  if (rec.unrecorded) throw new PromotionRefused(`${changeId} is not committed yet`)
  if (cs.promotion) throw new PromotionRefused(`${changeId} was already promoted at ${cs.promotion.at} (baseline ${cs.promotion.baseline.slice(0, 7)})`)

  const policy = opts.policy ?? {}
  const dispositions = policy.dispositions ?? ['accepted']
  if (!dispositions.includes(cs.disposition)) {
    throw new PromotionRefused(`${changeId} is ${cs.disposition}; promotion requires one of: ${dispositions.join(', ')}`)
  }
  if (policy.implementations && !policy.implementations.includes(cs.implementation)) {
    throw new PromotionRefused(`${changeId} implementation is ${cs.implementation}; policy requires one of: ${policy.implementations.join(', ')}`)
  }
  for (const dep of cs.depends_on) {
    const d = ledger.get(dep)
    if (!d) throw new PromotionRefused(`${changeId} depends on ${dep}, which is not in the ledger`)
    if (!d.changeSet.promotion) throw new PromotionRefused(`${changeId} depends on ${dep}, which is not promoted yet`)
  }

  // Apply on the committed baseline, without highlight. Validation failures leave the repo untouched.
  const loaded = await loadModel(repoDir)
  let projection
  try {
    projection = await applyChangeSets(loaded.parsedData, [cs], { baseline: { source: 'worktree', revision: head }, highlight: false, ledger })
  } catch (e) {
    if (e instanceof ProjectionError) throw new PromotionRefused(`${changeId} does not apply cleanly to the baseline:\n  ${e.issues.map(i => `${i.path}: ${i.message}`).join('\n  ')}`, e.issues)
    throw e
  }

  // Verify the regenerated DSL loads and every stable id survived, before writing into the repo.
  const { dsl, errors } = await roundTripCheck(projection.data)
  if (errors.length) throw new PromotionRefused(`regenerated model is invalid; baseline left unchanged:\n  ${errors.join('\n  ')}`)
  const expectedIds = new Set([...projection.registry.elements(), ...projection.registry.relationships()].map(r => r.stableId))
  const reloaded = IdentityRegistry.fromModel((await loadModelFromDsl(dsl)).model)
  const survivors = new Set([...reloaded.elements(), ...reloaded.relationships()].map(r => r.stableId))
  const lost = [...expectedIds].filter(id => !survivors.has(id))
  if (lost.length) throw new PromotionRefused(`stable ids lost in regeneration; baseline left unchanged: ${lost.join(', ')}`)

  // Write model + promotion record, commit atomically; restore on any failure.
  const modelDir = join(repoDir, MODEL_DIR)
  const modelFile = join(modelDir, 'model.c4')
  const promoted: ChangeSet = { ...cs, promotion: { at: opts.date ?? new Date().toISOString(), baseline: head, actor: opts.actor } }
  const recordPath = changeSetPath(cs.id)
  try {
    await mkdir(modelDir, { recursive: true })
    for (const f of await readdir(modelDir)) if (/\.c4$/i.test(f) && f !== 'model.c4') await rm(join(modelDir, f))
    await writeFile(modelFile, dsl, 'utf8')
    await writeFile(join(repoDir, recordPath), serializeChangeSet(promoted), 'utf8')
    await git.exec(['add', '-A', '--', MODEL_DIR, recordPath])
    const message = commitMessageFor(promoted, {
      actor: opts.actor,
      subject: `promote ${cs.id}: ${cs.title}`,
      body: `Promoted-From: ${head}`,
    })
    const sha = await git.commit(message, { date: opts.date })
    return {
      changeId: cs.id, sha, baseline: head, modelFile,
      added: projection.diff.added.map(a => a.entityId),
      removed: projection.diff.removed.map(r => r.entityId),
    }
  } catch (e) {
    await git.exec(['reset', '-q', '--', MODEL_DIR, recordPath]).catch(() => {})
    await git.exec(['checkout', '-q', '--', MODEL_DIR, recordPath]).catch(() => {})
    await git.exec(['clean', '-fdq', '--', MODEL_DIR]).catch(() => {})
    throw e
  }
}

async function loadModelFromDsl(dsl: string) {
  const { mkdtemp, writeFile: wf, rm: rmr } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const dir = await mkdtemp(join(tmpdir(), 'b4-after-promote-'))
  try {
    await mkdir(join(dir, MODEL_DIR), { recursive: true })
    await wf(join(dir, MODEL_DIR, 'model.c4'), dsl, 'utf8')
    return await loadModel(dir)
  } finally {
    await rmr(dir, { recursive: true, force: true })
  }
}
