// Evidence-qualified baseline (PRD 6.3: "its accuracy remains evidence-qualified"). This does not
// filter the architecture by status; it annotates every entity in the committed baseline with the
// verification derived for the promoted change set that last operated on it.
import type { LikeC4Model } from '@likec4/core/model'
import { IdentityRegistry } from './identity.js'
import { Ledger, type ChangeRecord } from './ledger.js'
import { loadModel, modelFromParsedData, type ParsedModelData } from './model.js'
import type { VerificationStatus } from './evidence.js'

export type QualificationStatus = VerificationStatus | 'unrecorded'

export interface EntityQualification {
  entityId: string
  type: 'element' | 'relationship'
  fqn?: string
  status: QualificationStatus
  /** Promoted change set whose verification this status comes from, if any. */
  changeId: string | null
  /** Evidence ids the status rests on (passing observations) or that caused failure. */
  basis: string[]
  reason: string
}

export interface QualifiedBaseline {
  data: ParsedModelData
  model: LikeC4Model
  registry: IdentityRegistry
  baseline: { source: 'worktree' | 'revision'; revision: string | null }
  environment: string | 'any'
  entities: Map<string, EntityQualification>
  counts: Record<QualificationStatus, number>
}

export const QUALIFICATION_TAGS: Record<QualificationStatus, { color: string; style?: { color: string } }> = {
  verified: { color: '#15803d', style: { color: 'green' } },
  partial: { color: '#d97706', style: { color: 'amber' } },
  failed: { color: '#b91c1c', style: { color: 'red' } },
  unverified: { color: '#64748b', style: { color: 'muted' } },
  unrecorded: { color: '#94a3b8' },
}

export interface QualifyOptions {
  revision?: string
  environment?: string
  /** Tag and recolour entities in the returned data for rendering. Default true. */
  highlight?: boolean
  ledger?: Ledger
}

export async function qualifyBaseline(repoDir: string, opts: QualifyOptions = {}): Promise<QualifiedBaseline> {
  const ledger = opts.ledger ?? await Ledger.load(repoDir, {
    ...(opts.revision ? { revision: opts.revision } : {}),
    ...(opts.environment ? { verification: { environment: opts.environment } } : {}),
  })
  const loaded = await loadModel(repoDir, opts.revision ? { revision: opts.revision } : {})
  const registry = IdentityRegistry.fromModel(loaded.model)
  const data = structuredClone(loaded.parsedData) as ParsedModelData

  // Latest promoted change set operating on each entity (by recorded chronology).
  const lastOp = new Map<string, ChangeRecord>()
  for (const rec of ledger.all()) {
    if (!rec.changeSet.promotion) continue
    for (const p of rec.participants) if (p.via === 'operation') lastOp.set(p.entityId, rec)
  }

  const entities = new Map<string, EntityQualification>()
  const counts: Record<QualificationStatus, number> = { verified: 0, partial: 0, failed: 0, unverified: 0, unrecorded: 0 }
  const all = [...registry.elements().map(e => ({ id: e.stableId, type: 'element' as const, fqn: e.fqn, relationId: undefined })),
               ...registry.relationships().map(r => ({ id: r.stableId, type: 'relationship' as const, fqn: undefined, relationId: r.relationId }))]
  for (const ent of all) {
    const rec = lastOp.get(ent.id)
    let q: EntityQualification
    if (!rec) {
      q = { entityId: ent.id, type: ent.type, fqn: ent.fqn, status: 'unrecorded', changeId: null, basis: [], reason: 'no promoted change set operates on this entity' }
    } else {
      const v = opts.environment && rec.verification.environment !== opts.environment
        ? ledger.verificationOf(rec.changeSet.id, { environment: opts.environment })!
        : rec.verification
      const basis = v.status === 'failed' ? v.failing : v.basis
      const reason = v.status === 'verified' ? `all targets of ${rec.changeSet.id} covered by passing observations`
        : v.status === 'failed' ? `failing observation on ${rec.changeSet.id}`
        : v.status === 'partial' ? `${rec.changeSet.id} has passing observations but ${v.uncovered.length} uncovered target(s)`
        : rec.changeSet.inferred ? `inferred during adoption (${rec.changeSet.id}); no evidence yet`
        : `no passing observation on ${rec.changeSet.id}`
      q = { entityId: ent.id, type: ent.type, fqn: ent.fqn, status: v.status, changeId: rec.changeSet.id, basis, reason }
    }
    entities.set(ent.id, q)
    counts[q.status]++
    if (opts.highlight ?? true) {
      const tag = QUALIFICATION_TAGS[q.status]
      data.specification.tags ??= {}
      data.specification.tags[q.status] ??= { color: tag.color }
      const target = ent.type === 'element' ? data.elements[ent.fqn!] : data.relations[ent.relationId!]
      if (!target) continue
      target.tags = [...new Set([...(target.tags ?? []), q.status])]
      if (tag.style) {
        if (ent.type === 'element') target.style = { ...(target.style ?? {}), color: tag.style.color }
        else target.color = tag.style.color
      }
    }
  }

  const model = (opts.highlight ?? true) ? await modelFromParsedData(data) : loaded.model
  return {
    data, model, registry: IdentityRegistry.fromModel(model),
    baseline: { source: loaded.source, revision: loaded.revision ?? ledger.snapshot.revision },
    environment: opts.environment ?? 'any',
    entities, counts,
  }
}
