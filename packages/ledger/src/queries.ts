// Bounded read queries for agents (PRD section 8: getArchitecture, searchElements, expand, getElement).
// Every result is compact and capped; nothing here walks the whole graph by default.
import type { LikeC4Model } from '@likec4/core/model'
import type { ElementModel, RelationshipModel } from '@likec4/core/model'
import { IdentityRegistry, STABLE_ID_KEY } from './identity.js'
import type { Ledger } from './ledger.js'
import type { ParsedModelData } from './model.js'
import { META, flagsOfTags, isReservedMetadataKey, isReservedTag, type StatusFlag } from './reserved.js'

export interface Snapshot {
  model: LikeC4Model
  /** Detached parsed data behind `model`, for projecting on top of it. */
  parsedData: ParsedModelData
  registry: IdentityRegistry
  ledger: Ledger
  head: string | null
}

/**
 * Compact element row. `id` is the stable id, or `fqn:<fqn>` when the element has none. `pending`
 * lists status flags (intended, retiring, pending_update, pending_move, failed) and is absent when
 * the element exists exactly as shown.
 */
export interface ElementRow { id: string; fqn: string; kind: string; title: string; children?: number; pending?: StatusFlag[] }
export interface RelationshipRow { id: string; from: string; to: string; kind: string | null; title: string | null; pending?: StatusFlag[] }

const withPending = <T extends object>(row: T, tags: Iterable<string> | undefined): T & { pending?: StatusFlag[] } => {
  const pending = flagsOfTags(tags)
  return pending.length ? { ...row, pending } : row
}

export function elementRow(s: Snapshot, el: ElementModel, withChildren = false): ElementRow {
  const rec = s.registry.elementByFqn(el.id)
  const row: ElementRow = { id: rec?.stableId ?? `fqn:${el.id}`, fqn: el.id, kind: el.kind, title: el.title }
  if (withChildren) row.children = [...el.children()].length
  return withPending(row, el.tags)
}

function idOf(s: Snapshot, fqn: string): string {
  return s.registry.elementByFqn(fqn)?.stableId ?? `fqn:${fqn}`
}

export function relationshipRow(s: Snapshot, r: { id: string; source: { id: string }; target: { id: string }; kind?: string | null; title?: string | null; tags?: readonly string[] }): RelationshipRow {
  const rec = s.registry.relationshipByRelationId(r.id)
  return withPending({ id: rec?.stableId ?? `rel:${r.id}`, from: idOf(s, r.source.id), to: idOf(s, r.target.id), kind: r.kind ?? null, title: r.title ?? null }, r.tags)
}

/**
 * Detail tiers shared by every read. minimal = ElementRow. medium = minimal plus description, technology,
 * tags and status. full = ElementDetail. Reads that list many entities take a Detail option and default
 * to minimal; reads about one entity return full.
 */
export type Detail = 'minimal' | 'medium'

/** Medium detail: what an agent needs before relying on the entity. No relationships, children list or user metadata. */
export interface ElementMedium extends ElementRow {
  description: string | null
  technology: string | null
  tags: string[]
  /** Status metadata only (b4_status, b4_change, b4_pending); absent when the entity has none. Full detail carries these inside metadata instead. */
  status?: Record<string, string | string[]>
}

export function statusOf(el: ElementModel): Record<string, string | string[]> | undefined {
  const md = el.getMetadata() as Record<string, string | string[]>
  const keys = [META.status, META.change, META.pending].filter(k => k in md)
  return keys.length ? Object.fromEntries(keys.map(k => [k, md[k]!])) : undefined
}

export function elementMedium(s: Snapshot, el: ElementModel): ElementMedium {
  const status = statusOf(el)
  return {
    ...elementRow(s, el, true),
    description: el.description?.text ?? null,
    technology: el.technology ?? null,
    tags: [...el.tags],
    ...(status ? { status } : {}),
  }
}

/** The row for a list entry at the requested detail. */
export function elementAt(s: Snapshot, el: ElementModel, detail: Detail = 'minimal'): ElementRow | ElementMedium {
  return detail === 'medium' ? elementMedium(s, el) : elementRow(s, el, true)
}

/** A relationship that reaches the element through a descendant: `via` is that descendant, so the edge can be read and followed. */
export interface NestedRelationshipRow extends RelationshipRow { via: { id: string; fqn: string } }

export interface RelationshipDetail extends RelationshipRow {
  description: string | null
  technology: string | null
  tags: string[]
  views: string[]
}

export function relationshipDetail(s: Snapshot, r: RelationshipModel): RelationshipDetail {
  return { ...relationshipRow(s, r), description: r.description?.text ?? null, technology: r.technology ?? null, tags: [...r.tags], views: [...r.views()].map(v => v.id) }
}

/** Resolve a stable id, `fqn:` prefixed FQN, or bare FQN to an element. */
export function resolveElement(s: Snapshot, entity: string): ElementModel | null {
  const key = entity.startsWith('fqn:') ? entity.slice(4) : entity
  const rec = s.registry.resolve(key)
  const fqn = rec?.type === 'element' ? rec.fqn : key
  try { return s.model.element(fqn) } catch { return null }
}

export interface Overview {
  head: string | null
  model: { elements: number; relationships: number; views: number; kinds: Record<string, number>; relationshipKinds: string[]; tags: string[] }
  roots: (ElementRow | ElementMedium)[]
  rootsTruncated: boolean
  ledger: { changeSets: number; byDisposition: Record<string, number>; promoted: number; open: string[]; openTruncated: boolean }
  identity: { withoutStableId: number }
}

export function overview(s: Snapshot, opts: { maxRoots?: number; maxOpen?: number; detail?: Detail } = {}): Overview {
  const maxRoots = opts.maxRoots ?? 20
  const maxOpen = opts.maxOpen ?? 10
  const kinds: Record<string, number> = {}
  let elements = 0
  for (const el of s.model.elements()) { elements++; kinds[el.kind] = (kinds[el.kind] ?? 0) + 1 }
  const spec = s.model.$data.specification as { relationships?: Record<string, unknown>; tags?: Record<string, unknown> }
  const roots = [...s.model.roots()]
  const byDisposition: Record<string, number> = {}
  let promoted = 0
  const open: string[] = []
  for (const r of s.ledger.all()) {
    byDisposition[r.changeSet.disposition] = (byDisposition[r.changeSet.disposition] ?? 0) + 1
    if (r.changeSet.promotion) promoted++
    else if (['proposed', 'accepted'].includes(r.changeSet.disposition)) open.push(r.changeSet.id)
  }
  return {
    head: s.head,
    model: {
      elements, relationships: [...s.model.relationships()].length, views: [...s.model.views()].length,
      kinds, relationshipKinds: Object.keys(spec.relationships ?? {}), tags: Object.keys(spec.tags ?? {}).filter(t => !isReservedTag(t)),
    },
    roots: roots.slice(0, maxRoots).map(el => elementAt(s, el, opts.detail)),
    rootsTruncated: roots.length > maxRoots,
    ledger: { changeSets: s.ledger.records.size, byDisposition, promoted, open: open.slice(0, maxOpen), openTruncated: open.length > maxOpen },
    identity: { withoutStableId: s.registry.problems.filter(p => p.code === 'MISSING_STABLE_ID').length },
  }
}

export interface SearchOptions {
  query: string
  kinds?: string[]
  tags?: string[]
  /** Keep only entities whose metadata has every key with that value (a list value matches when it contains it). */
  metadata?: Record<string, string>
  limit?: number
  detail?: Detail
}
export interface SearchResult { elements: (ElementRow | ElementMedium)[]; relationships: RelationshipRow[]; truncated: boolean }

type Metadata = Record<string, string | string[]>
/** User metadata as searchable text: each value, and key=value. Identity and status keys are left out. */
function metadataText(md: Metadata): string[] {
  return Object.entries(md)
    .filter(([k]) => k !== STABLE_ID_KEY && !isReservedMetadataKey(k))
    .flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).flatMap(x => [x, `${k}=${x}`]))
}
function hasMetadata(md: Metadata, wanted: Record<string, string>): boolean {
  return Object.entries(wanted).every(([k, v]) => { const cur = md[k]; return Array.isArray(cur) ? cur.includes(v) : cur === v })
}

export function search(s: Snapshot, opts: SearchOptions): SearchResult {
  const q = opts.query.trim().toLowerCase()
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 50))
  const kinds = opts.kinds?.length ? new Set(opts.kinds) : null
  const tags = opts.tags?.length ? opts.tags : null
  const meta = opts.metadata && Object.keys(opts.metadata).length ? opts.metadata : null
  const scored: { score: number; el: ElementModel }[] = []
  for (const el of s.model.elements()) {
    if (kinds && !kinds.has(el.kind)) continue
    if (tags && !tags.every(t => el.isTagged(t))) continue
    const md = el.getMetadata() as Metadata
    if (meta && !hasMetadata(md, meta)) continue
    const sid = s.registry.elementByFqn(el.id)?.stableId ?? ''
    const hay = [sid, el.id, el.title, el.kind, ...el.tags, ...metadataText(md)].map(x => x.toLowerCase())
    let score = 0
    if (!q) score = 1
    else if (sid.toLowerCase() === q || el.id.toLowerCase() === q) score = 100
    else if (el.id.toLowerCase().endsWith('.' + q) || el.title.toLowerCase() === q) score = 80
    else if (hay.some(h => h.startsWith(q))) score = 50
    else if (hay.some(h => h.includes(q))) score = 20
    if (score) scored.push({ score, el })
  }
  scored.sort((a, b) => b.score - a.score || a.el.id.localeCompare(b.el.id))
  const relationships: RelationshipRow[] = []
  if ((q || meta) && !kinds && !tags) {
    for (const r of s.model.relationships()) {
      const md = r.getMetadata() as Metadata
      if (meta && !hasMetadata(md, meta)) continue
      const sid = s.registry.relationshipByRelationId(r.id)?.stableId ?? ''
      const hay = [sid, r.title ?? '', ...metadataText(md)].map(x => x.toLowerCase())
      if (!q || hay.some(h => h.includes(q))) relationships.push(relationshipRow(s, r))
      if (relationships.length >= limit) break
    }
  }
  return { elements: scored.slice(0, limit).map(x => elementAt(s, x.el, opts.detail)), relationships, truncated: scored.length > limit }
}

export interface ExpandOptions { entity: string; depth?: number; relationships?: 'direct' | 'none'; maxNodes?: number; detail?: Detail }
export interface ExpandResult {
  entity: (ElementRow | ElementMedium) & { parent: string | null }
  descendants: ((ElementRow | ElementMedium) & { depth: number; parent: string })[]
  relationships: RelationshipRow[]
  truncated: boolean
}

export function expand(s: Snapshot, opts: ExpandOptions): ExpandResult | null {
  const root = resolveElement(s, opts.entity)
  if (!root) return null
  const depth = Math.max(0, Math.min(opts.depth ?? 1, 5))
  const maxNodes = Math.max(1, Math.min(opts.maxNodes ?? 50, 200))
  const descendants: ExpandResult['descendants'] = []
  let truncated = false
  const walk = (el: ElementModel, d: number) => {
    if (d > depth) return
    for (const c of el.children()) {
      if (descendants.length >= maxNodes) { truncated = true; return }
      descendants.push({ ...elementAt(s, c, opts.detail), depth: d, parent: idOf(s, el.id) })
      walk(c, d + 1)
    }
  }
  walk(root, 1)
  const included = new Set([root.id, ...descendants.map(d => d.fqn)])
  const relationships: RelationshipRow[] = []
  if ((opts.relationships ?? 'direct') === 'direct') {
    for (const r of s.model.relationships()) {
      if (included.has(r.source.id) || included.has(r.target.id)) relationships.push(relationshipRow(s, r))
    }
  }
  return {
    entity: { ...elementAt(s, root, opts.detail), parent: root.parent ? idOf(s, root.parent.id) : null },
    descendants, relationships, truncated,
  }
}

/** Full detail: medium (status folded into metadata) plus parent, metadata, children, relationships, views and change sets. */
export interface ElementDetail extends Omit<ElementMedium, 'children' | 'status'> {
  parent: string | null
  metadata: Record<string, string | string[]>
  children: ElementRow[]
  /** Relationships whose endpoint is this element itself. */
  incoming: RelationshipRow[]
  outgoing: RelationshipRow[]
  /** Relationships that cross this element's boundary through a descendant (never ones internal to the subtree). Capped. */
  nestedIncoming: NestedRelationshipRow[]
  nestedOutgoing: NestedRelationshipRow[]
  nestedTruncated: boolean
  views: string[]
  /** Change sets touching the element or an attached relationship: counts, plus the ids of the open ones (proposed or accepted, not promoted). History is story's job. */
  changeSets: ChangeSetSummary
}

export interface ChangeSetSummary {
  total: number
  promoted: number
  byDisposition: Record<string, number>
  /** Proposed or accepted and not yet promoted: pending intent on the entity. Sorted by id, capped. */
  open: string[]
  openTruncated: boolean
}

export function summarizeChangeSets(s: Snapshot, ids: Iterable<string>, maxOpen = 20): ChangeSetSummary {
  const out: ChangeSetSummary = { total: 0, promoted: 0, byDisposition: {}, open: [], openTruncated: false }
  const open: string[] = []
  for (const id of [...ids].sort()) {
    const r = s.ledger.get(id)
    if (!r) continue
    out.total++
    out.byDisposition[r.changeSet.disposition] = (out.byDisposition[r.changeSet.disposition] ?? 0) + 1
    if (r.changeSet.promotion) out.promoted++
    else if (r.changeSet.disposition === 'proposed' || r.changeSet.disposition === 'accepted') open.push(id)
  }
  out.open = open.slice(0, maxOpen)
  out.openTruncated = open.length > maxOpen
  return out
}

const MAX_NESTED = 50

export function elementDetail(s: Snapshot, entity: string): ElementDetail | null {
  const el = resolveElement(s, entity)
  if (!el) return null
  const { status, ...medium } = elementMedium(s, el)
  void status
  const sid = s.registry.elementByFqn(el.id)?.stableId
  // Change sets touching the element itself or any relationship attached to it or its subtree (same rule as storyOf).
  const attached = [...el.incoming(), ...el.outgoing()].map(r => s.registry.relationshipByRelationId(r.id)?.stableId).filter((x): x is string => !!x)
  const via = (d: ElementModel) => ({ id: idOf(s, d.id), fqn: d.id })
  const nestedIn = [...el.incoming('to-descendants')]
  const nestedOut = [...el.outgoing('from-descendants')]
  return {
    ...medium,
    parent: el.parent ? idOf(s, el.parent.id) : null,
    metadata: el.getMetadata() as Record<string, string | string[]>,
    children: [...el.children()].map(c => elementRow(s, c, true)),
    incoming: [...el.incoming('direct')].map(r => relationshipRow(s, r)),
    outgoing: [...el.outgoing('direct')].map(r => relationshipRow(s, r)),
    nestedIncoming: nestedIn.slice(0, MAX_NESTED).map(r => ({ ...relationshipRow(s, r), via: via(r.target) })),
    nestedOutgoing: nestedOut.slice(0, MAX_NESTED).map(r => ({ ...relationshipRow(s, r), via: via(r.source) })),
    nestedTruncated: nestedIn.length > MAX_NESTED || nestedOut.length > MAX_NESTED,
    views: [...el.views()].map(v => v.id),
    changeSets: summarizeChangeSets(s, s.ledger.changeIdsFor([...(sid ? [sid] : []), ...attached])),
  }
}
