// locate: one bounded read that grounds an agent around an entity (PRD section 8 follow-up).
// Built from the shared detail templates in queries.ts: the focus and each container in full,
// related and connected entities at medium, the remaining peers at minimal. Nothing here walks the
// whole graph: every list is capped and says when it was cut.
import type { ElementModel, RelationshipModel } from '@likec4/core/model'
import {
  elementDetail, elementMedium, elementRow, relationshipDetail, relationshipRow, resolveElement,
  type ElementDetail, type ElementMedium, type ElementRow, type RelationshipDetail, type RelationshipRow, type Snapshot,
} from './queries.js'

export interface LocateOptions {
  entity: string
  /** Cap on peers listed per level (connected and other separately) and on related entities. Default 25, max 100. */
  maxPeers?: number
  /** Cap on relationship rows listed per connected entity. Default 10, max 50. */
  maxRelationships?: number
}

/** Medium detail plus the relationships that connect the entity to the thing being examined (not its whole relationship list). */
export interface ConnectedEntity extends ElementMedium {
  relationships: RelationshipRow[]
  relationshipsTruncated: boolean
}

export interface RelatedEntity extends ConnectedEntity {
  /** Nearest container shared with the focus (null when they share only the model root). Related entities are ordered by this, nearest first. */
  under: string | null
  /** Containers between `under` and this entity, outermost first, so it can be placed against the chain. */
  path: ElementRow[]
}

/**
 * Full detail without the lists the surrounding levels already show: children (the level below lists
 * them as focus and peers) and nested relationships (the connected peers at each level carry them).
 */
export type ContainerDetail = Omit<ElementDetail, 'children' | 'nestedIncoming' | 'nestedOutgoing' | 'nestedTruncated'> & { children: number }

export interface LocateLevel {
  container: ContainerDetail | null
  /** Peers of the entity below this container (or of the root, when container is null), connected to that entity's subtree. */
  connected: ConnectedEntity[]
  connectedTruncated: boolean
  other: ElementRow[]
  otherTruncated: boolean
}

export interface LocateResult {
  /** Present when the id named a relationship: the relationship in full; `focus` is then its source element and the target is among `related`. */
  relationship?: RelationshipDetail
  focus: ElementDetail
  related: RelatedEntity[]
  relatedTruncated: boolean
  /** Nearest container first, ending with the level of the roots. */
  levels: LocateLevel[]
}

function connected(s: Snapshot, el: ElementModel, rels: RelationshipModel[], maxRelationships: number): ConnectedEntity {
  return {
    ...elementMedium(s, el),
    relationships: rels.slice(0, maxRelationships).map(r => relationshipRow(s, r)),
    relationshipsTruncated: rels.length > maxRelationships,
  }
}

function container(s: Snapshot, el: ElementModel): ContainerDetail {
  const { children, nestedIncoming, nestedOutgoing, nestedTruncated, ...rest } = elementDetail(s, el.id)!
  void nestedIncoming; void nestedOutgoing; void nestedTruncated
  return { ...rest, children: children.length }
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

  let relationship: RelationshipDetail | undefined
  let el = resolveElement(s, opts.entity)
  if (!el) {
    const rec = s.registry.resolve(opts.entity)
    const rel = rec?.type === 'relationship' ? s.model.findRelationship(rec.relationId, 'model') : null
    if (!rel) return null
    relationship = relationshipDetail(s, rel)
    el = rel.source
  }
  const focus = elementDetail(s, el.id)!
  const chain = [el, ...el.ancestors()] // focus first, root last

  // Related: the other end of every direct relationship, placed against the chain.
  const byOther = new Map<ElementModel, RelationshipModel[]>()
  for (const r of [...el.incoming('direct'), ...el.outgoing('direct')]) {
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
    return { ...connected(s, other, rels, maxRelationships), under: shared ? elementRow(s, shared).id : null, path }
  })

  // Levels: for each container in the chain (and finally the roots), split the peers of the member below it.
  const levels: LocateLevel[] = []
  for (let i = 0; i < chain.length; i++) {
    const member = chain[i]!
    const parent = chain[i + 1] ?? null
    const peers = [...(parent ? parent.children() : s.model.roots())].filter(p => p !== member)
    const connectedRels = new Map<ElementModel, RelationshipModel[]>()
    for (const r of [...member.allIncoming, ...member.allOutgoing]) {
      const inside = member.isAncestorOf(r.source) || r.source === member
      const other = inside ? r.target : r.source
      if (other === member || member.isAncestorOf(other)) continue // internal to the subtree
      if (parent && !parent.isAncestorOf(other)) continue // leaves this container: counted at a higher level
      const peer = branchOf(other, parent)
      connectedRels.set(peer, [...(connectedRels.get(peer) ?? []), r])
    }
    const connectedPeers = peers.filter(p => connectedRels.has(p))
    const other = peers.filter(p => !connectedRels.has(p))
    levels.push({
      container: parent ? container(s, parent) : null,
      connected: connectedPeers.slice(0, maxPeers).map(p => connected(s, p, connectedRels.get(p)!, maxRelationships)),
      connectedTruncated: connectedPeers.length > maxPeers,
      other: other.slice(0, maxPeers).map(p => elementRow(s, p, true)),
      otherTruncated: other.length > maxPeers,
    })
  }

  return { ...(relationship ? { relationship } : {}), focus, related, relatedTruncated: byOther.size > maxPeers, levels }
}
