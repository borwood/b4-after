// locate: one bounded read that grounds an agent around an entity (PRD section 8 follow-up).
// Full detail on the focus, medium detail on what it relates to, then each container up to the root
// with its peers split into connected (medium) and the rest (minimal). Nothing here walks the whole
// graph: every list is capped and says when it was cut.
import type { ElementModel, RelationshipModel } from '@likec4/core/model'
import { elementDetail, elementRow, relationshipRow, resolveElement, type ElementDetail, type ElementRow, type RelationshipRow, type Snapshot } from './queries.js'
import { META } from './reserved.js'

export interface LocateOptions {
  entity: string
  /** Cap on peers listed per level (connected and other separately) and on related entities. Default 25, max 100. */
  maxPeers?: number
  /** Cap on relationship rows listed per connected entity. Default 10, max 50. */
  maxRelationships?: number
}

/** Minimal row plus what an agent needs before relying on the entity: description, technology, tags, status, and the edges that connect it here. */
export interface ElementMedium extends ElementRow {
  description: string | null
  technology: string | null
  tags: string[]
  /** Status metadata only (b4_status, b4_change), never user metadata. */
  status?: Record<string, string | string[]>
  relationships: RelationshipRow[]
  relationshipsTruncated: boolean
}

export interface RelatedEntity extends ElementMedium {
  /** Nearest container shared with the focus (null when they share only the model root). Related entities are ordered by this, nearest first. */
  under: string | null
  /** Containers between `under` and this entity, outermost first, so it can be placed against the chain. */
  path: ElementRow[]
}

/** Full detail without the children list: the level below (focus or previous container, with its peers) already lists them. */
export type ContainerDetail = Omit<ElementDetail, 'children'> & { children: number }

export interface LocateLevel {
  container: ContainerDetail | null
  /** Peers of the entity below this container (or of the root, when container is null), connected to that entity's subtree. */
  connected: ElementMedium[]
  connectedTruncated: boolean
  other: ElementRow[]
  otherTruncated: boolean
}

export interface LocateResult {
  /** Present when the id named a relationship: the relationship in full; `focus` is then its source element and the target is among `related`. */
  relationship?: RelationshipRow & { description: string | null; technology: string | null; tags: string[]; views: string[] }
  focus: ElementDetail
  related: RelatedEntity[]
  relatedTruncated: boolean
  /** Nearest container first, ending with the level of the roots. */
  levels: LocateLevel[]
}

const statusOf = (el: ElementModel): Record<string, string | string[]> | undefined => {
  const md = el.getMetadata() as Record<string, string | string[]>
  const keys = [META.status, META.change, META.pending].filter(k => k in md)
  return keys.length ? Object.fromEntries(keys.map(k => [k, md[k]!])) : undefined
}

function medium(s: Snapshot, el: ElementModel, rels: RelationshipModel[], maxRelationships: number): ElementMedium {
  return {
    ...elementRow(s, el, true),
    description: el.description?.text ?? null,
    technology: el.technology ?? null,
    tags: [...el.tags],
    ...(statusOf(el) ? { status: statusOf(el) } : {}),
    relationships: rels.slice(0, maxRelationships).map(r => relationshipRow(s, r)),
    relationshipsTruncated: rels.length > maxRelationships,
  }
}

/** The child of `container` (or the root) whose subtree holds `el`. */
function branchOf(el: ElementModel, container: ElementModel | null): ElementModel {
  let cur = el
  while (cur.parent && cur.parent !== container) cur = cur.parent
  return cur
}

export function locate(s: Snapshot, opts: LocateOptions): LocateResult | null {
  const maxPeers = Math.max(1, Math.min(opts.maxPeers ?? 25, 100))
  const maxRelationships = Math.max(1, Math.min(opts.maxRelationships ?? 10, 50))

  let relationship: LocateResult['relationship']
  let el = resolveElement(s, opts.entity)
  if (!el) {
    const rec = s.registry.resolve(opts.entity)
    const rel = rec?.type === 'relationship' ? s.model.findRelationship(rec.relationId, 'model') : null
    if (!rel) return null
    relationship = { ...relationshipRow(s, rel), description: rel.description?.text ?? null, technology: rel.technology ?? null, tags: [...rel.tags], views: [...rel.views()].map(v => v.id) }
    el = rel.source
  }
  const focus = elementDetail(s, el.id)!
  const chain = [el, ...el.ancestors()] // focus first, root last

  // Related: the other end of every direct relationship, placed against the chain.
  const byOther = new Map<ElementModel, RelationshipModel[]>()
  for (const r of [...el.incoming(), ...el.outgoing()]) {
    const other = r.source === el ? r.target : r.source
    byOther.set(other, [...(byOther.get(other) ?? []), r])
  }
  // Nearest shared container first (inside the focus, then siblings, then further out), ids breaking ties.
  const placed = [...byOther.entries()].map(([other, rels]) => {
    const depth = chain.findIndex(a => a === other || a.isAncestorOf(other))
    return { other, rels, shared: depth < 0 ? null : chain[depth]!, depth: depth < 0 ? chain.length : depth, id: elementRow(s, other).id }
  }).sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id))
  const related: RelatedEntity[] = placed.slice(0, maxPeers).map(({ other, rels, shared }) => {
    const path: ElementRow[] = []
    for (let cur = other.parent; cur && cur !== shared; cur = cur.parent) path.unshift(elementRow(s, cur, true))
    return { ...medium(s, other, rels, maxRelationships), under: shared ? elementRow(s, shared).id : null, path }
  })

  // Levels: for each container in the chain (and finally the roots), split the peers of the member below it.
  const levels: LocateLevel[] = []
  for (let i = 0; i < chain.length; i++) {
    const member = chain[i]!
    const container = chain[i + 1] ?? null
    const peers = [...(container ? container.children() : s.model.roots())].filter(p => p !== member)
    const connectedRels = new Map<ElementModel, RelationshipModel[]>()
    for (const r of [...member.allIncoming, ...member.allOutgoing]) {
      const inside = member.isAncestorOf(r.source) || r.source === member
      const other = inside ? r.target : r.source
      if (other === member || member.isAncestorOf(other)) continue // internal to the subtree
      if (container && !container.isAncestorOf(other)) continue // leaves this container: counted at a higher level
      const peer = branchOf(other, container)
      connectedRels.set(peer, [...(connectedRels.get(peer) ?? []), r])
    }
    const connected = peers.filter(p => connectedRels.has(p))
    const other = peers.filter(p => !connectedRels.has(p))
    const detail = container ? elementDetail(s, container.id)! : null
    levels.push({
      container: detail ? { ...detail, children: detail.children.length } : null,
      connected: connected.slice(0, maxPeers).map(p => medium(s, p, connectedRels.get(p)!, maxRelationships)),
      connectedTruncated: connected.length > maxPeers,
      other: other.slice(0, maxPeers).map(p => elementRow(s, p, true)),
      otherTruncated: other.length > maxPeers,
    })
  }

  return { ...(relationship ? { relationship } : {}), focus, related, relatedTruncated: byOther.size > maxPeers, levels }
}
