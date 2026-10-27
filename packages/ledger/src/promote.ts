// Baseline promotion (PRD 6.3 [O], section 9 [P]): apply an accepted change set to the committed
// model and record the promotion on the change set, in one commit. Policy is explicit and narrow;
// the write is verified by reloading the regenerated model before anything is committed.
//
// The baseline must stay faithful to what exists. Additions and moves are applied at once and
// marked intended or pending; updates and removals of existing entities are deferred until
// evidence verifies them (see status.ts). The model files are machine-generated (workspace.ts).
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Git } from './git.js'
import { IdentityRegistry } from './identity.js'
import { Ledger, changeSetPath, serializeChangeSet, CHANGES_DIR } from './ledger.js'
import { loadModel, modelFromParsedData, MODEL_DIR } from './model.js'
import { applyChangeSets, ProjectionError, type Projection, type ProjectionIssue } from './projection.js'
import { commitMessageFor } from './provenance.js'
import type { ChangeSet, Disposition, Implementation, Operation } from './schema.js'
import { finalizeBaseline, intendedIds, markDeferred, markMoves, planPromotion, type AppliedOperation, type PromotionPlan } from './status.js'
import { generateAndCheck, summarizeErrors, writeWorkspace } from './workspace.js'

export interface PromotionPolicy {
  /** Dispositions eligible for promotion. Default ['accepted']. */
  dispositions?: Disposition[]
  /** If set, derived implementation must be one of these. Default: no constraint (PRD: accepted does not mean implemented; promotion records declared architecture). */
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
  /** Stable ids removed from the baseline by this promotion: verified or inferred removals, and removals of entities that were only intended. */
  removed: string[]
  /** Operations recorded as pending on their targets, to be applied once verified. */
  deferred: { entityId: string; op: Operation['op'] }[]
  /** Earlier deferred operations that were verified in the meantime and applied by this promotion. */
  reconciled: AppliedOperation[]
  warnings: string[]
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
  if (policy.implementations && !policy.implementations.includes(rec.implementation)) {
    throw new PromotionRefused(`${changeId} implementation is ${rec.implementation}; policy requires one of: ${policy.implementations.join(', ')}`)
  }
  for (const dep of cs.depends_on) {
    const d = ledger.get(dep)
    if (!d) throw new PromotionRefused(`${changeId} depends on ${dep}, which is not in the ledger`)
    if (!d.changeSet.promotion) throw new PromotionRefused(`${changeId} depends on ${dep}, which is not promoted yet`)
  }

  // Apply on the committed baseline, without highlight. Validation failures leave the repo untouched.
  const loaded = await loadModel(repoDir)
  const baseline = { source: 'worktree' as const, revision: head }
  const warnings: string[] = []
  const intended = intendedIds(loaded.parsedData, IdentityRegistry.fromModel(loaded.model))
  let plan = planPromotion(cs, rec.verification, intended)
  let projection: Projection
  try {
    projection = await applyChangeSets(loaded.parsedData, [{ ...cs, operations: plan.immediate }], { baseline, highlight: false, ledger })
  } catch (e) {
    if (!(e instanceof ProjectionError) || !plan.deferred.length) throw refused(changeId, e)
    // Deferring left the change set inconsistent (e.g. a name freed by a deferred removal is reused):
    // apply everything now and say so, rather than refuse an accepted change.
    warnings.push(`could not defer ${describe(plan.deferred)}: applied immediately although unverified (${e.issues.map(i => i.message).join('; ')})`)
    plan = { immediate: cs.operations, deferred: [] }
    try {
      projection = await applyChangeSets(loaded.parsedData, [cs], { baseline, highlight: false, ledger })
    } catch (e2) { throw refused(changeId, e2) }
  }

  const promoted: ChangeSet = { ...cs, promotion: { at: opts.date ?? new Date().toISOString(), baseline: head, actor: opts.actor } }
  const data = projection.data
  markDeferred(data, projection.registry, cs.id, plan.deferred)
  markMoves(data, projection.diff.moved, cs, rec.verification, intended)
  const final = await finalizeBaseline(data, ledger, { promoting: promoted })
  warnings.push(...final.warnings)

  // Verify the regenerated workspace loads and every stable id survived, before writing into the repo.
  const check = await generateAndCheck(data, ledger)
  if (check.errors.length) throw new PromotionRefused(`regenerated model is invalid; baseline left unchanged:\n  ${summarizeErrors(check.errors).join('\n  ')}`)
  const expected = stableIds(IdentityRegistry.fromModel(await modelFromParsedData(data)))
  const survivors = new Set(stableIds(IdentityRegistry.fromModel(check.loaded.model)))
  const lost = expected.filter(id => !survivors.has(id))
  if (lost.length) throw new PromotionRefused(`stable ids lost in regeneration; baseline left unchanged: ${lost.join(', ')}`)

  // Write model + promotion record, commit atomically; restore on any failure.
  const modelDir = join(repoDir, MODEL_DIR)
  const recordPath = changeSetPath(cs.id)
  try {
    await writeWorkspace(modelDir, check.files)
    await writeFile(join(repoDir, recordPath), serializeChangeSet(promoted), 'utf8')
    await git.exec(['add', '-A', '--', MODEL_DIR, recordPath])
    const message = commitMessageFor(promoted, {
      actor: opts.actor,
      implementation: rec.implementation,
      subject: `promote ${cs.id}: ${cs.title}`,
      body: [`Promoted-From: ${head}`, ...(plan.deferred.length ? [`Deferred: ${describe(plan.deferred)}`] : [])].join('\n'),
    })
    const sha = await git.commit(message, { date: opts.date })
    return {
      changeId: cs.id, sha, baseline: head, modelFile: join(modelDir, 'model.c4'),
      added: projection.diff.added.map(a => a.entityId),
      removed: projection.diff.removed.map(r => r.entityId),
      deferred: plan.deferred.map(op => ({ entityId: op.id, op: op.op })),
      reconciled: final.applied,
      warnings,
    }
  } catch (e) {
    await git.exec(['reset', '-q', '--', MODEL_DIR, recordPath]).catch(() => {})
    await git.exec(['checkout', '-q', '--', MODEL_DIR, recordPath]).catch(() => {})
    await git.exec(['clean', '-fdq', '--', MODEL_DIR]).catch(() => {})
    throw e
  }
}

function refused(changeId: string, e: unknown): unknown {
  if (e instanceof ProjectionError) return new PromotionRefused(`${changeId} does not apply cleanly to the baseline:\n  ${e.issues.map(i => `${i.path}: ${i.message}`).join('\n  ')}`, e.issues)
  return e
}

const describe = (ops: Operation[]) => ops.map(op => `${op.op} ${op.id}`).join(', ')
const stableIds = (reg: IdentityRegistry) => [...reg.elements(), ...reg.relationships()].map(r => r.stableId)

export type { PromotionPlan }
