// Applying one change-set operation to LikeC4 parsed data. Shared by candidate projections,
// promotion, and reconciliation, so every path mutates the model the same way.
//
// Mechanics come from the Phase A spike: builder-style adds, data surgery for update/move/remove.
import { STABLE_ID_KEY, type IdentityRegistry } from './identity.js'
import type { ParsedModelData } from './model.js'
import { isReservedTag } from './reserved.js'
import type { Operation } from './schema.js'

export const CANDIDATE_TAG = 'candidate'
export const CANDIDATE_COLOR = '#d97706'

export interface OperationDiff {
  added: { entityId: string; type: 'element' | 'relationship'; fqn?: string; changeId: string }[]
  updated: { entityId: string; type: 'element' | 'relationship'; fqn?: string; changeId: string }[]
  moved: { entityId: string; from: string; to: string; changeId: string }[]
  /** Includes entities removed by cascade (descendants and attached relationships of a removed element), marked `cascade: true`. */
  removed: { entityId: string; type: 'element' | 'relationship'; fqn?: string; changeId: string; cascade?: true }[]
}

export const emptyDiff = (): OperationDiff => ({ added: [], updated: [], moved: [], removed: [] })

export interface ApplyOperationOptions {
  /** Mark candidate additions and changes visually (amber, dashed border, tag "candidate"). */
  highlight: boolean
}

/**
 * Stable-id resolution while a change set is in flight: the registry reflects the state before the
 * change set, so adds, moves and removes made by earlier operations are layered on top.
 */
export class WorkingIds {
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

export function applyOperation(data: ParsedModelData, ids: WorkingIds, op: Operation, changeId: string, opts: ApplyOperationOptions, diff: OperationDiff) {
  const highlight = opts.highlight
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

export interface PropertyPatch {
  title?: string
  description?: string | null
  technology?: string | null
  tags?: string[]
  metadata?: Record<string, string>
}

/**
 * Merge semantics for update operations (the LikeC4 builder replaces; we patch). Tags are replaced
 * as a set, except that reserved status tags are never an agent's to remove.
 */
export function patchProps(target: Record<string, any>, set: PropertyPatch) {
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
    const reserved = (target.tags ?? []).filter(isReservedTag)
    const tags = uniq([...set.tags, ...reserved])
    if (tags.length) target.tags = tags
    else delete target.tags
  }
  if (set.metadata !== undefined) target.metadata = { ...(target.metadata ?? {}), ...set.metadata }
}

export function uniq<T>(xs: T[]): T[] { return [...new Set(xs)] }

export const isUnder = (fqn: string, root: string) => fqn === root || fqn.startsWith(root + '.')
export const remapFqn = (fqn: string, from: string, to: string) => fqn === from ? to : fqn.startsWith(from + '.') ? to + fqn.slice(from.length) : fqn

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
    if (kept.length === 0) return null
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
