// Agent write path for the ledger (PRD section 8: proposeChangeSet, validateChangeSet).
// Writes only under changes/; never touches model/.
import { Git } from './git.js'
import { IdentityRegistry } from './identity.js'
import { Ledger } from './ledger.js'
import { loadModel, type LoadedModel } from './model.js'
import { applyChangeSets, orderByDependencies, ProjectionError, type ProjectionIssue } from './projection.js'
import { recordChangeSet, type RecordResult } from './provenance.js'
import { ChangeSet, normalizeChangeSetInput, type ChangeSet as ChangeSetT, type Disposition } from './schema.js'
import { validateChangeSet, type ValidationIssue, type ValidationResult } from './validate.js'

export interface ProposeOptions {
  actor: string
  /** Refuse unless HEAD is this commit, so the proposal was validated against the baseline it lands on. */
  expectedBaseRevision?: string
  /** Record as draft instead of proposed. */
  draft?: boolean
  date?: string
}

export interface ProposeResult {
  validation: ContextualValidation
  record: RecordResult
  changeSet: ChangeSetT
  /** True when a record with this id already existed and was revised. */
  revised: boolean
}

export class ProposalRejected extends Error {
  constructor(message: string, readonly validation: ValidationResult) {
    super(message)
    this.name = 'ProposalRejected'
  }
}

export interface ContextualValidation extends ValidationResult {
  /** Unpromoted change sets from depends_on (transitively) that were projected onto the baseline before validating. */
  projected: string[]
}

/**
 * Validate against the baseline with the change set's unpromoted dependencies projected on top, so
 * related change sets can be proposed and reviewed together before any of them is promoted.
 * Promotion still requires every dependency promoted first. When the dependencies do not project
 * cleanly, validation falls back to the bare baseline and says so.
 */
export async function validateInContext(loaded: Pick<LoadedModel, 'parsedData' | 'model'>, input: unknown, ledger: Ledger): Promise<ContextualValidation> {
  const registry = IdentityRegistry.fromModel(loaded.model)
  const pre = ChangeSet.safeParse(normalizeChangeSetInput(input).input)
  const deps = pre.success ? unpromotedDependencies(pre.data, ledger) : []
  if (!deps.length) return { ...validateChangeSet(input, { registry, ledger }), projected: [] }

  try {
    const issues: ProjectionIssue[] = []
    const order = orderByDependencies(deps, ledger, issues)
    if (issues.length) throw new ProjectionError('dependencies cannot be ordered', issues)
    const projection = await applyChangeSets(loaded.parsedData, order, { baseline: { source: 'worktree', revision: null }, highlight: false, ledger })
    return { ...validateChangeSet(input, { registry: projection.registry, ledger }), projected: projection.applied }
  } catch (e) {
    if (!(e instanceof ProjectionError)) throw e
    const result = validateChangeSet(input, { registry, ledger })
    const failing = [...new Set(e.issues.map(i => i.changeId).filter(Boolean))].join(', ')
    const warning: ValidationIssue = {
      severity: 'warning', code: 'W_DEPENDENCY_NOT_PROJECTED', path: '/depends_on',
      message: `unpromoted dependencies could not be projected onto the baseline (${failing}: ${e.issues[0]?.message ?? e.message}); validated against the baseline alone`,
    }
    return { ...result, issues: [warning, ...result.issues], projected: [] }
  }
}

/** Dependencies of `cs`, transitively, that are in the ledger and not yet promoted. */
function unpromotedDependencies(cs: ChangeSetT, ledger: Ledger): ChangeSetT[] {
  const out = new Map<string, ChangeSetT>()
  const visit = (ids: string[]) => {
    for (const id of ids) {
      if (id === cs.id || out.has(id)) continue
      const rec = ledger.get(id)
      if (!rec || rec.changeSet.promotion) continue
      out.set(id, rec.changeSet)
      visit(rec.changeSet.depends_on)
    }
  }
  visit(cs.depends_on)
  return [...out.values()]
}

/** Validate a change set against the current baseline (with unpromoted dependencies projected) and ledger, then record it as proposed (or draft). */
export async function proposeChangeSet(repoDir: string, input: unknown, opts: ProposeOptions): Promise<ProposeResult> {
  const git = new Git(repoDir)
  const head = await git.headSha()
  if (opts.expectedBaseRevision !== undefined && head !== opts.expectedBaseRevision) {
    throw new Error(`repository moved: expected base ${opts.expectedBaseRevision}, HEAD is ${head}`)
  }

  const ledger = await Ledger.load(repoDir)
  const loaded = await loadModel(repoDir)

  const pre = ChangeSet.safeParse(normalizeChangeSetInput(input).input)
  if (!pre.success) {
    const validation = await validateInContext(loaded, input, ledger)
    throw new ProposalRejected(`proposal rejected:\n  ${validation.issues.map(i => `${i.path}: ${i.message}`).join('\n  ')}`, validation)
  }
  const existing = ledger.get(pre.data.id)
  if (existing?.changeSet.promotion) {
    throw new Error(`${pre.data.id} is promoted into the baseline and can no longer be revised; propose a new change set that depends on it`)
  }
  if (pre.data.promotion) throw new Error('a proposal may not carry a promotion record')

  const target: Disposition = opts.draft ? 'draft' : 'proposed'
  if (!['draft', 'proposed'].includes(pre.data.disposition)) {
    throw new Error(`a proposal must be draft or proposed, not ${pre.data.disposition}; use setDisposition for governance transitions`)
  }
  const cs: ChangeSetT = { ...pre.data, disposition: target }

  const validation = await validateInContext(loaded, cs, ledger)
  if (!validation.ok) {
    throw new ProposalRejected(`proposal rejected:\n  ${validation.issues.filter(i => i.severity === 'error').map(i => `${i.path}: ${i.message}`).join('\n  ')}`, validation)
  }

  const record = await recordChangeSet(repoDir, cs, { actor: opts.actor, expectedHead: head ?? undefined, date: opts.date, implementation: existing?.implementation })
  return { validation, record, changeSet: cs, revised: !!existing }
}

/** Allowed disposition transitions before promotion (PRD 6.1 [P]; governance is still open). */
export const DISPOSITION_TRANSITIONS: Record<Disposition, Disposition[]> = {
  draft: ['proposed', 'superseded'],
  proposed: ['accepted', 'rejected', 'draft', 'superseded'],
  accepted: ['rejected', 'superseded'],
  rejected: ['proposed', 'superseded'],
  superseded: [],
}

export interface DispositionOptions {
  actor: string
  expectedHead?: string
  /** Required when moving to superseded: the change set that replaces this one. */
  supersededBy?: string
  date?: string
}

/** Governance transition recorded as its own commit. Promoted change sets are frozen. */
export async function setDisposition(repoDir: string, changeId: string, to: Disposition, opts: DispositionOptions): Promise<RecordResult> {
  const ledger = await Ledger.load(repoDir)
  const rec = ledger.get(changeId)
  if (!rec) throw new Error(`${changeId} is not in the ledger`)
  const cs = rec.changeSet
  if (cs.promotion) throw new Error(`${changeId} is promoted; its disposition is frozen at ${cs.disposition}`)
  if (!DISPOSITION_TRANSITIONS[cs.disposition].includes(to)) {
    throw new Error(`${changeId}: ${cs.disposition} -> ${to} is not an allowed transition (allowed: ${DISPOSITION_TRANSITIONS[cs.disposition].join(', ') || 'none'})`)
  }
  if (to === 'superseded') {
    if (!opts.supersededBy) throw new Error('superseding requires supersededBy')
    const by = ledger.get(opts.supersededBy)
    if (!by) throw new Error(`${opts.supersededBy} is not in the ledger`)
    if (!by.changeSet.supersedes.includes(changeId)) {
      throw new Error(`${opts.supersededBy} does not declare "supersedes: [${changeId}]"; record that first`)
    }
  }
  const next: ChangeSetT = { ...cs, disposition: to }
  return recordChangeSet(repoDir, next, {
    actor: opts.actor,
    expectedHead: opts.expectedHead,
    date: opts.date,
    implementation: rec.implementation,
    subject: `${to === 'superseded' ? 'supersede' : to === 'accepted' ? 'accept' : to === 'rejected' ? 'reject' : to === 'proposed' ? 'propose' : 'draft'} ${cs.id}: ${cs.title}`,
    body: to === 'superseded' ? `Superseded-By: ${opts.supersededBy}` : undefined,
  })
}
