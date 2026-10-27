// Candidate projections (PRD 6.3, AR-07, AR-16): apply change-set operations to a copy of the
// baseline's parsed data and compute a fresh LikeC4Model. The baseline is never touched.
//
// Mechanics come from the Phase A spike: builder-style adds, data surgery for update/move/remove,
// computeParsedModelData for the compute step, explicit element style for visual distinction.
import type { LikeC4Model } from '@likec4/core/model'
import { IdentityRegistry } from './identity.js'
import { Ledger } from './ledger.js'
import { loadModel, modelFromParsedData, type ParsedModelData } from './model.js'
import { applyOperation, emptyDiff, WorkingIds, CANDIDATE_TAG, CANDIDATE_COLOR, type OperationDiff } from './operations.js'
import type { ChangeSet, Operation } from './schema.js'
import { validateChangeSet, type ValidationIssue } from './validate.js'

export { CANDIDATE_TAG, CANDIDATE_COLOR }

export interface ProjectionIssue extends ValidationIssue {
  changeId: string
}

export type ProjectionDiff = OperationDiff

export interface Projection {
  /** Parsed LikeC4 data with the operations applied. Feed to the DSL generator or renderers. */
  data: ParsedModelData
  model: LikeC4Model
  registry: IdentityRegistry
  /** Change sets in the order they were applied (dependencies first). */
  applied: string[]
  baseline: { source: 'worktree' | 'revision'; revision: string | null }
  highlighted: boolean
  diff: ProjectionDiff
  warnings: ProjectionIssue[]
}

export class ProjectionError extends Error {
  constructor(message: string, readonly issues: ProjectionIssue[]) {
    super(message)
    this.name = 'ProjectionError'
  }
}

export interface ProjectOptions {
  /** Git revision of the baseline. Default: working tree. */
  baselineRevision?: string
  /** Change sets to apply. Dependencies must be included or already promoted. */
  includeChanges: string[]
  /** Mark candidate additions and changes visually (amber, dashed border, tag "candidate"). Default true. */
  highlight?: boolean
  /** Reuse a loaded ledger (must match the baseline snapshot). */
  ledger?: Ledger
  /** Allow change sets that are already promoted (their operations are then applied twice). Default false. */
  allowPromoted?: boolean
}

/** Build a candidate projection from a model repository. */
export async function projectModel(repoDir: string, opts: ProjectOptions): Promise<Projection> {
  const ledger = opts.ledger ?? await Ledger.load(repoDir, opts.baselineRevision ? { revision: opts.baselineRevision } : {})
  const loaded = await loadModel(repoDir, opts.baselineRevision ? { revision: opts.baselineRevision } : {})

  const issues: ProjectionIssue[] = []
  const changeSets: ChangeSet[] = []
  for (const id of opts.includeChanges) {
    const rec = ledger.get(id)
    if (!rec) { issues.push({ severity: 'error', code: 'E_UNKNOWN_CHANGE', path: '/', message: `${id} is not in the ledger`, changeId: id }); continue }
    if (rec.changeSet.promotion && !opts.allowPromoted) {
      issues.push({ severity: 'error', code: 'E_ALREADY_PROMOTED', path: '/promotion', message: `${id} was promoted into the baseline at ${rec.changeSet.promotion.at}; it is already part of it`, changeId: id })
      continue
    }
    changeSets.push(rec.changeSet)
  }
  if (issues.length) throw new ProjectionError('projection rejected', issues)

  const order = orderByDependencies(changeSets, ledger, issues)
  if (issues.length) throw new ProjectionError('projection rejected', issues)

  return applyChangeSets(loaded.parsedData, order, {
    baseline: { source: loaded.source, revision: loaded.revision ?? ledger.snapshot.revision },
    highlight: opts.highlight ?? true,
    ledger,
  })
}

/** Topological order over depends_on restricted to the included set; dependencies outside it must be promoted. */
export function orderByDependencies(changeSets: ChangeSet[], ledger: Ledger, issues: ProjectionIssue[]): ChangeSet[] {
  const included = new Map(changeSets.map(c => [c.id, c]))
  const out: ChangeSet[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (cs: ChangeSet, stack: string[]) => {
    const s = state.get(cs.id)
    if (s === 'done') return
    if (s === 'visiting') {
      issues.push({ severity: 'error', code: 'E_DEPENDENCY_CYCLE', path: '/depends_on', message: `dependency cycle: ${[...stack, cs.id].join(' -> ')}`, changeId: cs.id })
      return
    }
    state.set(cs.id, 'visiting')
    for (const dep of cs.depends_on) {
      const inc = included.get(dep)
      if (inc) { visit(inc, [...stack, cs.id]); continue }
      const rec = ledger.get(dep)
      if (!rec) issues.push({ severity: 'error', code: 'E_UNKNOWN_DEPENDENCY', path: '/depends_on', message: `${cs.id} depends on ${dep}, which is not in the ledger`, changeId: cs.id })
      else if (!rec.changeSet.promotion) {
        issues.push({ severity: 'error', code: 'E_UNRESOLVED_DEPENDENCY', path: '/depends_on', message: `${cs.id} depends on ${dep}, which is neither included in this projection nor promoted to the baseline`, changeId: cs.id })
      } else if (rec.changeSet.disposition === 'rejected') {
        issues.push({ severity: 'error', code: 'E_REJECTED_DEPENDENCY', path: '/depends_on', message: `${cs.id} depends on ${dep}, which is rejected`, changeId: cs.id })
      }
    }
    state.set(cs.id, 'done')
    out.push(cs)
  }
  for (const cs of changeSets) visit(cs, [])
  return out
}

export interface ApplyOptions {
  baseline: Projection['baseline']
  highlight: boolean
  ledger?: Ledger
}

/**
 * Apply change sets in the given order to a copy of `baselineData`. Each change set is validated
 * against the state produced by the previous ones, so hard conflicts surface as validation errors;
 * overlapping writes between independent change sets are reported as E_CONFLICT.
 */
export async function applyChangeSets(baselineData: ParsedModelData, changeSets: ChangeSet[], opts: ApplyOptions): Promise<Projection> {
  const data = structuredClone(baselineData) as ParsedModelData
  const diff: ProjectionDiff = emptyDiff()
  const warnings: ProjectionIssue[] = []
  const errors: ProjectionIssue[] = []
  const applied: string[] = []
  const touched = new Map<string, { changeId: string; fields: Set<string> }[]>()

  let model = await modelFromParsedData(data)
  let registry = IdentityRegistry.fromModel(model)

  for (const cs of changeSets) {
    const v = validateChangeSet(cs, { registry, ledger: opts.ledger })
    for (const i of v.issues) (i.severity === 'error' ? errors : warnings).push({ ...i, changeId: cs.id })
    if (!v.ok) continue

    for (const c of detectConflicts(cs, touched, changeSets)) errors.push(c)
    if (errors.some(e => e.changeId === cs.id)) continue

    const ids = new WorkingIds(registry)
    for (const op of cs.operations) applyOperation(data, ids, op, cs.id, { highlight: opts.highlight }, diff)
    applied.push(cs.id)
    model = await modelFromParsedData(data)
    registry = IdentityRegistry.fromModel(model)
  }
  if (errors.length) throw new ProjectionError(`projection rejected:\n  ${errors.map(e => `${e.changeId} ${e.path}: ${e.message}`).join('\n  ')}`, errors)

  if (opts.highlight && (diff.added.length || diff.updated.length || diff.moved.length)) {
    data.specification.tags ??= {}
    data.specification.tags[CANDIDATE_TAG] ??= { color: CANDIDATE_COLOR }
    model = await modelFromParsedData(data)
    registry = IdentityRegistry.fromModel(model)
  }

  return { data, model, registry, applied, baseline: opts.baseline, highlighted: opts.highlight, diff, warnings }
}

function fieldsOf(op: Operation): string[] {
  switch (op.op) {
    case 'add_element': case 'add_relationship': return ['*']
    case 'remove_element': case 'remove_relationship': return ['*']
    case 'move_element': return ['parent', 'name']
    case 'update_element': case 'update_relationship': return Object.keys(op.set)
  }
}

function dependsTransitively(a: ChangeSet, bId: string, all: ChangeSet[]): boolean {
  const byId = new Map(all.map(c => [c.id, c]))
  const seen = new Set<string>()
  const stack = [...a.depends_on]
  while (stack.length) {
    const id = stack.pop()!
    if (id === bId) return true
    if (seen.has(id)) continue
    seen.add(id)
    stack.push(...(byId.get(id)?.depends_on ?? []))
  }
  return false
}

function detectConflicts(cs: ChangeSet, touched: Map<string, { changeId: string; fields: Set<string> }[]>, all: ChangeSet[]): ProjectionIssue[] {
  const out: ProjectionIssue[] = []
  cs.operations.forEach((op, i) => {
    const fields = new Set(fieldsOf(op))
    const prior = touched.get(op.id) ?? []
    for (const p of prior) {
      const overlap = fields.has('*') || p.fields.has('*') ? ['*'] : [...fields].filter(f => p.fields.has(f))
      if (!overlap.length) continue
      const ordered = dependsTransitively(cs, p.changeId, all)
      if (ordered) continue // explicit ordering: later change intentionally builds on the earlier one
      out.push({
        severity: 'error', code: 'E_CONFLICT', path: `/operations/${i}`, changeId: cs.id,
        message: `${cs.id} and ${p.changeId} both change ${op.id} (${overlap.join(', ')}) without a depends_on between them`,
      })
    }
    prior.push({ changeId: cs.id, fields })
    touched.set(op.id, prior)
    if (op.op === 'add_relationship') {
      // endpoints are not edited by a relationship; no conflict tracking for them
    }
  })
  return out
}
