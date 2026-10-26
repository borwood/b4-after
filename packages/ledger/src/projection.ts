// Candidate projections (PRD 6.3, AR-07, AR-16): apply change-set operations to a copy of the
// baseline's parsed data and compute a fresh LikeC4Model. The baseline is never touched.
//
// Mechanics come from the Phase A spike: builder-style adds, data surgery for update/move/remove,
// computeParsedModelData for the compute step, explicit element style for visual distinction.
import type { LikeC4Model } from '@likec4/core/model'
import { IdentityRegistry, STABLE_ID_KEY } from './identity.js'
import { Ledger } from './ledger.js'
import { loadModel, modelFromParsedData, type ParsedModelData } from './model.js'
import type { ChangeSet, Operation } from './schema.js'
import { validateChangeSet, type ValidationIssue } from './validate.js'

export const CANDIDATE_TAG = 'candidate'
export const CANDIDATE_COLOR = '#d97706'

export interface ProjectionIssue extends ValidationIssue {
  changeId: string
}

export interface ProjectionDiff {
  added: { entityId: string; type: 'element' | 'relationship'; fqn?: string; changeId: string }[]
  updated: { entityId: string; type: 'element' | 'relationship'; fqn?: string; changeId: string }[]
  moved: { entityId: string; from: string; to: string; changeId: string }[]
  /** Includes entities removed by cascade (descendants and attached relationships of a removed element), marked `cascade: true`. */
  removed: { entityId: string; type: 'element' | 'relationship'; fqn?: string; changeId: string; cascade?: true }[]
}

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
function orderByDependencies(changeSets: ChangeSet[], ledger: Ledger, issues: ProjectionIssue[]): ChangeSet[] {
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
  const diff: ProjectionDiff = { added: [], updated: [], moved: [], removed: [] }
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
    for (const op of cs.operations) applyOperation(data, ids, op, cs.id, opts.highlight, diff)
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

// ---------------------------------------------------------------------------------------------
// Operation application on parsed data

/**
 * Stable-id resolution while a change set is in flight: the registry reflects the state before the
 * change set, so adds, moves and removes made by earlier operations are layered on top.
 */
class WorkingIds {
  private elementOverrides = new Map<string, string | null>()
  private relationOverrides = new Map<string, string | null>()
  constructor(private readonly reg: IdentityRegistry) {}

  elementFqn(id: string): string {
    const o = this.elementOverrides.get(id)
    if (o !== undefined) { if (o === null) throw new Error(`element ${id} was removed earlier in this change set`); return o }
    const r = this.reg.element(id)
    if (!r) throw new Error(`element ${id} not found`)
    return r.fqn
  }
  relationId(id: string): string {
    const o = this.relationOverrides.get(id)
    if (o !== undefined) { if (o === null) throw new Error(`relationship ${id} was removed earlier in this change set`); return o }
    const r = this.reg.relationship(id)
    if (!r) throw new Error(`relationship ${id} not found`)
    return r.relationId
  }
  /** True when an earlier element removal in this change set already cascaded the relationship away. */
  relationRemoved(id: string): boolean { return this.relationOverrides.get(id) === null }
  addElement(id: string, fqn: string) { this.elementOverrides.set(id, fqn) }
  addRelation(id: string, relationId: string) { this.relationOverrides.set(id, relationId) }
  moveSubtree(from: string, to: string) {
    for (const r of this.reg.elements()) if (isUnder(r.fqn, from) && !this.elementOverrides.has(r.stableId)) this.elementOverrides.set(r.stableId, r.fqn)
    for (const [id, fqn] of this.elementOverrides) if (fqn && isUnder(fqn, from)) this.elementOverrides.set(id, remapFqn(fqn, from, to))
  }
  removeSubtree(root: string) {
    for (const r of this.reg.elements()) if (isUnder(r.fqn, root) && !this.elementOverrides.has(r.stableId)) this.elementOverrides.set(r.stableId, null)
    for (const [id, fqn] of this.elementOverrides) if (fqn && isUnder(fqn, root)) this.elementOverrides.set(id, null)
    for (const r of this.reg.relationships()) if (isUnder(r.fromFqn, root) || isUnder(r.toFqn, root)) this.relationOverrides.set(r.stableId, null)
  }
  removeRelation(id: string) { this.relationOverrides.set(id, null) }
}

function applyOperation(data: ParsedModelData, ids: WorkingIds, op: Operation, changeId: string, highlight: boolean, diff: ProjectionDiff) {
  switch (op.op) {
    case 'add_element': {
      const parentFqn = op.parent ? ids.elementFqn(op.parent) : null
      const fqn = parentFqn ? `${parentFqn}.${op.name}` : op.name
      const el: Record<string, any> = {
        id: fqn,
        kind: op.kind,
        title: op.title ?? op.name,
        style: {},
        metadata: { ...(op.metadata ?? {}), [STABLE_ID_KEY]: op.id },
      }
      if (op.description) el.description = { txt: op.description }
      if (op.technology) el.technology = op.technology
      const tags = [...(op.tags ?? [])]
      if (highlight) { el.style = { color: 'amber', border: 'dashed' }; tags.push(CANDIDATE_TAG) }
      if (tags.length) el.tags = tags
      data.elements[fqn] = el
      ids.addElement(op.id, fqn)
      diff.added.push({ entityId: op.id, type: 'element', fqn, changeId })
      break
    }
    case 'update_element': {
      const fqn = ids.elementFqn(op.id)
      const el = data.elements[fqn]
      patchProps(el, op.set)
      if (highlight) { el.style = { ...(el.style ?? {}), border: 'dashed' }; el.tags = uniq([...(el.tags ?? []), CANDIDATE_TAG]) }
      diff.updated.push({ entityId: op.id, type: 'element', fqn, changeId })
      break
    }
    case 'move_element': {
      const from = ids.elementFqn(op.id)
      const name = op.name ?? from.slice(from.lastIndexOf('.') + 1)
      const parentFqn = op.parent ? ids.elementFqn(op.parent) : null
      const to = parentFqn ? `${parentFqn}.${name}` : name
      if (from !== to) { renameSubtree(data, from, to); ids.moveSubtree(from, to) }
      if (highlight) {
        const el = data.elements[to]
        el.style = { ...(el.style ?? {}), border: 'dashed' }
        el.tags = uniq([...(el.tags ?? []), CANDIDATE_TAG])
      }
      diff.moved.push({ entityId: op.id, from, to, changeId })
      break
    }
    case 'remove_element': {
      const fqn = ids.elementFqn(op.id)
      diff.removed.push({ entityId: op.id, type: 'element', fqn, changeId })
      for (const [f, el] of Object.entries<any>(data.elements)) {
        if (f !== fqn && isUnder(f, fqn) && el.metadata?.[STABLE_ID_KEY]) diff.removed.push({ entityId: el.metadata[STABLE_ID_KEY], type: 'element', fqn: f, changeId, cascade: true })
      }
      for (const rel of Object.values<any>(data.relations)) {
        if ((isUnder(rel.source?.model ?? '', fqn) || isUnder(rel.target?.model ?? '', fqn)) && rel.metadata?.[STABLE_ID_KEY]) {
          diff.removed.push({ entityId: rel.metadata[STABLE_ID_KEY], type: 'relationship', changeId, cascade: true })
        }
      }
      removeSubtree(data, fqn)
      ids.removeSubtree(fqn)
      break
    }
    case 'add_relationship': {
      const rel: Record<string, any> = {
        id: op.id,
        source: { model: ids.elementFqn(op.from) },
        target: { model: ids.elementFqn(op.to) },
        metadata: { ...(op.metadata ?? {}), [STABLE_ID_KEY]: op.id },
      }
      if (op.kind) rel.kind = op.kind
      if (op.title) rel.title = op.title
      if (op.description) rel.description = { txt: op.description }
      if (op.technology) rel.technology = op.technology
      const tags = [...(op.tags ?? [])]
      if (highlight) { rel.color = 'amber'; tags.push(CANDIDATE_TAG) }
      if (tags.length) rel.tags = tags
      data.relations[op.id] = rel
      ids.addRelation(op.id, op.id)
      diff.added.push({ entityId: op.id, type: 'relationship', changeId })
      break
    }
    case 'update_relationship': {
      const rel = data.relations[ids.relationId(op.id)]
      patchProps(rel, op.set)
      if (highlight) { rel.color = 'amber'; rel.tags = uniq([...(rel.tags ?? []), CANDIDATE_TAG]) }
      diff.updated.push({ entityId: op.id, type: 'relationship', changeId })
      break
    }
    case 'remove_relationship': {
      if (ids.relationRemoved(op.id)) break // already gone with its endpoint; validation reports this as a warning
      delete data.relations[ids.relationId(op.id)]
      ids.removeRelation(op.id)
      diff.removed.push({ entityId: op.id, type: 'relationship', changeId })
      break
    }
  }
}

/** Merge semantics for update operations (the LikeC4 builder replaces; we patch). */
function patchProps(target: Record<string, any>, set: { title?: string; description?: string | null; technology?: string | null; tags?: string[]; metadata?: Record<string, string> }) {
  if (set.title !== undefined) target.title = set.title
  if (set.description !== undefined) {
    if (set.description === null) delete target.description
    else target.description = { txt: set.description }
  }
  if (set.technology !== undefined) {
    if (set.technology === null) delete target.technology
    else target.technology = set.technology
  }
  if (set.tags !== undefined) {
    if (set.tags.length) target.tags = [...set.tags]
    else delete target.tags
  }
  if (set.metadata !== undefined) target.metadata = { ...(target.metadata ?? {}), ...set.metadata }
}

function uniq<T>(xs: T[]): T[] { return [...new Set(xs)] }

const isUnder = (fqn: string, root: string) => fqn === root || fqn.startsWith(root + '.')
const remapFqn = (fqn: string, from: string, to: string) => fqn === from ? to : fqn.startsWith(from + '.') ? to + fqn.slice(from.length) : fqn

function renameSubtree(data: ParsedModelData, from: string, to: string) {
  const elements: Record<string, any> = {}
  for (const [fqn, el] of Object.entries<any>(data.elements)) {
    const nf = remapFqn(fqn, from, to)
    elements[nf] = nf === fqn ? el : { ...el, id: nf }
  }
  data.elements = elements
  for (const rel of Object.values<any>(data.relations)) {
    if (rel.source?.model) rel.source = { ...rel.source, model: remapFqn(rel.source.model, from, to) }
    if (rel.target?.model) rel.target = { ...rel.target, model: remapFqn(rel.target.model, from, to) }
  }
  rewriteViews(data, fqn => remapFqn(fqn, from, to))
}

function removeSubtree(data: ParsedModelData, root: string) {
  for (const fqn of Object.keys(data.elements)) if (isUnder(fqn, root)) delete data.elements[fqn]
  for (const [id, rel] of Object.entries<any>(data.relations)) {
    if (isUnder(rel.source?.model ?? '', root) || isUnder(rel.target?.model ?? '', root)) delete data.relations[id]
  }
  rewriteViews(data, fqn => (isUnder(fqn, root) ? null : fqn))
}

/**
 * Rewrite model references inside view definitions. `map` returns the new FQN, or null to drop
 * whatever predicate mentions it. Views scoped to a dropped element are removed entirely.
 */
function rewriteViews(data: ParsedModelData, map: (fqn: string) => string | null) {
  for (const [viewId, view] of Object.entries<any>(data.views ?? {})) {
    if (typeof view.viewOf === 'string') {
      const m = map(view.viewOf)
      if (m === null) { delete data.views[viewId]; continue }
      view.viewOf = m
    }
    if (!Array.isArray(view.rules)) continue
    view.rules = view.rules
      .map((rule: any) => rewriteRule(rule, map))
      .filter((rule: any) => rule !== null)
  }
}

function rewriteRule(rule: any, map: (fqn: string) => string | null): any | null {
  const out: any = { ...rule }
  for (const key of ['include', 'exclude', 'targets']) {
    if (!Array.isArray(rule[key])) continue
    const kept: any[] = []
    for (const item of rule[key]) {
      const r = rewriteRefs(item, map)
      if (r !== null) kept.push(r)
    }
    if (kept.length === 0 && (key === 'include' || key === 'exclude' || key === 'targets')) return null
    out[key] = kept
  }
  return out
}

/** Deep-walk a predicate; remap every `{ model: fqn }` ref. Returns null if any ref maps to null. */
function rewriteRefs(value: any, map: (fqn: string) => string | null): any | null {
  if (Array.isArray(value)) {
    const out = []
    for (const v of value) { const r = rewriteRefs(v, map); if (r === null) return null; out.push(r) }
    return out
  }
  if (value && typeof value === 'object') {
    const out: any = {}
    for (const [k, v] of Object.entries(value)) {
      if (k === 'model' && typeof v === 'string') {
        const m = map(v)
        if (m === null) return null
        out[k] = m
      } else {
        const r = rewriteRefs(v, map)
        if (r === null) return null
        out[k] = r
      }
    }
    return out
  }
  return value
}
