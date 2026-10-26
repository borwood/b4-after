// Stable identity (PRD 5.4, Phase A finding 3). Elements and relationships carry `stable_id` in
// LikeC4 metadata. LikeC4 FQNs and relationship hashes are resolved from it, never the reverse.
import type { LikeC4Model } from '@likec4/core/model'

export const STABLE_ID_KEY = 'stable_id'

export interface ElementRecord {
  type: 'element'
  stableId: string
  fqn: string
  kind: string
  title: string
  parentFqn: string | null
}
export interface RelationshipRecord {
  type: 'relationship'
  stableId: string
  relationId: string
  fromFqn: string
  toFqn: string
  kind: string | null
  title: string | null
}
export type EntityRecord = ElementRecord | RelationshipRecord

export interface IdentityProblem {
  code: 'MISSING_STABLE_ID' | 'DUPLICATE_STABLE_ID' | 'MULTIPLE_STABLE_IDS'
  stableId?: string
  fqn?: string
  relationId?: string
  message: string
}

function single(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v.length === 1 ? v[0] : undefined
  return v
}

export class IdentityRegistry {
  private byStableId = new Map<string, EntityRecord>()
  private byFqn = new Map<string, ElementRecord>()
  private byRelationId = new Map<string, RelationshipRecord>()
  readonly problems: IdentityProblem[] = []

  private constructor(readonly model: LikeC4Model) {}

  static fromModel(model: LikeC4Model): IdentityRegistry {
    const reg = new IdentityRegistry(model)
    for (const el of model.elements()) {
      const raw = el.getMetadata(STABLE_ID_KEY) as string | string[] | undefined
      if (raw === undefined) {
        reg.problems.push({ code: 'MISSING_STABLE_ID', fqn: el.id, message: `element ${el.id} has no ${STABLE_ID_KEY} metadata` })
        continue
      }
      const sid = single(raw)
      if (!sid) {
        reg.problems.push({ code: 'MULTIPLE_STABLE_IDS', fqn: el.id, message: `element ${el.id} declares several ${STABLE_ID_KEY} values` })
        continue
      }
      const rec: ElementRecord = { type: 'element', stableId: sid, fqn: el.id, kind: el.kind, title: el.title, parentFqn: el.parent?.id ?? null }
      reg.register(rec)
      reg.byFqn.set(el.id, rec)
    }
    for (const rel of model.relationships()) {
      const raw = rel.getMetadata(STABLE_ID_KEY) as string | string[] | undefined
      if (raw === undefined) {
        reg.problems.push({ code: 'MISSING_STABLE_ID', relationId: rel.id, message: `relationship ${rel.source.id} -> ${rel.target.id} (${rel.id}) has no ${STABLE_ID_KEY} metadata` })
        continue
      }
      const sid = single(raw)
      if (!sid) {
        reg.problems.push({ code: 'MULTIPLE_STABLE_IDS', relationId: rel.id, message: `relationship ${rel.id} declares several ${STABLE_ID_KEY} values` })
        continue
      }
      const rec: RelationshipRecord = {
        type: 'relationship', stableId: sid, relationId: rel.id,
        fromFqn: rel.source.id, toFqn: rel.target.id, kind: rel.kind ?? null, title: rel.title ?? null,
      }
      reg.register(rec)
      reg.byRelationId.set(rel.id, rec)
    }
    return reg
  }

  private register(rec: EntityRecord) {
    const existing = this.byStableId.get(rec.stableId)
    if (existing) {
      this.problems.push({ code: 'DUPLICATE_STABLE_ID', stableId: rec.stableId, message: `${rec.stableId} is declared by both ${describe(existing)} and ${describe(rec)}` })
      return
    }
    this.byStableId.set(rec.stableId, rec)
  }

  get(stableId: string): EntityRecord | undefined { return this.byStableId.get(stableId) }
  element(stableId: string): ElementRecord | undefined {
    const r = this.byStableId.get(stableId)
    return r?.type === 'element' ? r : undefined
  }
  relationship(stableId: string): RelationshipRecord | undefined {
    const r = this.byStableId.get(stableId)
    return r?.type === 'relationship' ? r : undefined
  }
  elementByFqn(fqn: string): ElementRecord | undefined { return this.byFqn.get(fqn) }
  relationshipByRelationId(id: string): RelationshipRecord | undefined { return this.byRelationId.get(id) }

  /** Accepts a stable id or a current FQN. */
  resolve(idOrFqn: string): EntityRecord | undefined {
    return this.byStableId.get(idOrFqn) ?? this.byFqn.get(idOrFqn) ?? this.byRelationId.get(idOrFqn)
  }

  elements(): ElementRecord[] {
    return [...this.byStableId.values()].filter((r): r is ElementRecord => r.type === 'element')
  }
  relationships(): RelationshipRecord[] {
    return [...this.byStableId.values()].filter((r): r is RelationshipRecord => r.type === 'relationship')
  }

  /** Stable ids of all current descendants of an element (not including itself). Elements lacking a stable id are counted, not returned. */
  descendantsOf(stableId: string): { ids: string[]; unidentified: number } {
    const rec = this.element(stableId)
    if (!rec) return { ids: [], unidentified: 0 }
    const ids: string[] = []
    let unidentified = 0
    for (const d of this.model.element(rec.fqn).descendants()) {
      const r = this.byFqn.get(d.id)
      if (r) ids.push(r.stableId)
      else unidentified++
    }
    return { ids, unidentified }
  }

  /** True when `a` is an ancestor of `b`, or vice versa, or they are equal (LikeC4 forbids relationships inside one hierarchy). */
  static sameHierarchy(fqnA: string, fqnB: string): boolean {
    return fqnA === fqnB || fqnA.startsWith(fqnB + '.') || fqnB.startsWith(fqnA + '.')
  }
}

function describe(r: EntityRecord): string {
  return r.type === 'element' ? `element ${r.fqn}` : `relationship ${r.fromFqn} -> ${r.toFqn}`
}
