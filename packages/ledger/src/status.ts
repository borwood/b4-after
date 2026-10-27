// What exists versus what is intended, written into the committed model so that anyone reading it,
// with or without b4-after, can tell the two apart.
//
// Promotion applies additions and moves at once and marks them; it defers property updates and
// removals of entities that exist until evidence verifies them, because applying those early would
// make the model claim a state no environment has. Reconciliation applies deferred operations once
// verified and refreshes every entity's status. All of it is derived from the ledger and evidence.
import { targetVerification, type TargetVerification, type Verification } from './evidence.js'
import { IdentityRegistry } from './identity.js'
import type { ChangeRecord, Ledger } from './ledger.js'
import { modelFromParsedData, type ParsedModelData } from './model.js'
import { applyOperation, emptyDiff, WorkingIds, type OperationDiff } from './operations.js'
import { META, STATUS_FLAGS, TAG, TAG_COLOR, userTags, type StatusFlag } from './reserved.js'
import type { ChangeSet, Operation } from './schema.js'

export interface EntityStatus {
  entityId: string
  type: 'element' | 'relationship'
  fqn?: string
  /** Latest promoted change set operating on the entity. */
  changeId: string | null
  /** Verification of that change set for this entity specifically. */
  verification: TargetVerification | null
  flags: StatusFlag[]
  /** Change sets whose update/remove of this entity is deferred until verified. */
  pending: string[]
  reason: string
}

export type StatusCount = Record<StatusFlag | 'as_is', number>

export interface StatusSummary {
  entities: Map<string, EntityStatus>
  counts: StatusCount
}

export interface HistoryOptions {
  /** Treat this change set as promoted even though the ledger's copy is not yet (used during promotion). */
  promoting?: ChangeSet
}

export interface AppliedOperation { changeId: string; entityId: string; op: Operation['op'] }

export interface FinalizeResult {
  /** Deferred operations that became verified and were applied. */
  applied: AppliedOperation[]
  warnings: string[]
  statuses: StatusSummary
}

/** Apply every verified deferred operation, then annotate every entity. The one pipeline behind promotion, reconciliation and adoption. */
export async function finalizeBaseline(data: ParsedModelData, ledger: Ledger, opts: HistoryOptions = {}): Promise<FinalizeResult> {
  const { applied, warnings } = await applyVerifiedPending(data, ledger, opts)
  const statuses = await annotateStatuses(data, ledger, opts)
  return { applied, warnings, statuses }
}

// ---------------------------------------------------------------------------------------------
// Promotion planning

export interface PromotionPlan {
  immediate: Operation[]
  /** Updates and removals of existing entities that await verification. */
  deferred: Operation[]
}

const isDeferrable = (op: Operation) => op.op.startsWith('update_') || op.op.startsWith('remove_')

/**
 * Split a change set's operations into those applied at promotion and those deferred. Inferred
 * change sets describe what was observed, so nothing is deferred; neither is an operation on an
 * entity the same change set adds, since that entity is marked intended as a whole, nor one on an
 * entity the baseline already marks intended: it does not exist, so there is nothing real to be
 * faithful to, and a revised intention simply replaces the intention.
 */
export function planPromotion(cs: ChangeSet, verification: Verification, intended: ReadonlySet<string> = new Set()): PromotionPlan {
  const plan: PromotionPlan = { immediate: [], deferred: [] }
  const addedHere = new Set<string>()
  for (const op of cs.operations) {
    if (op.op.startsWith('add_')) addedHere.add(op.id)
    const defer = isDeferrable(op) && !cs.inferred && !addedHere.has(op.id) && !intended.has(op.id) && targetVerification(verification, op.id) !== 'verified'
    ;(defer ? plan.deferred : plan.immediate).push(op)
  }
  return plan
}

/** Record deferred operations on their target entities. */
export function markDeferred(data: ParsedModelData, registry: IdentityRegistry, changeId: string, deferred: Operation[]) {
  for (const op of deferred) {
    const entity = entityData(data, registry, op.id)
    if (entity) appendPending(entity, changeId)
  }
}

/** Remember where unverified moves came from, so the badge can say so. Intended entities get no badge: nothing real has moved. */
export function markMoves(data: ParsedModelData, moved: OperationDiff['moved'], cs: ChangeSet, verification: Verification, intended: ReadonlySet<string> = new Set()) {
  if (cs.inferred) return
  for (const m of moved) {
    if (m.changeId !== cs.id || intended.has(m.entityId) || targetVerification(verification, m.entityId) === 'verified') continue
    const el = data.elements[m.to]
    if (el) el.metadata = { ...(el.metadata ?? {}), [META.movedFrom]: m.from }
  }
}

// ---------------------------------------------------------------------------------------------
// Pending markers

export function readPending(entity: Record<string, any>): string[] {
  const raw = entity.metadata?.[META.pending]
  return typeof raw === 'string' && raw ? raw.split(',') : []
}

function setPending(entity: Record<string, any>, ids: string[]) {
  entity.metadata ??= {}
  if (ids.length) entity.metadata[META.pending] = ids.join(',')
  else delete entity.metadata[META.pending]
}

function appendPending(entity: Record<string, any>, changeId: string) {
  const ids = readPending(entity)
  if (!ids.includes(changeId)) setPending(entity, [...ids, changeId])
}

function entityData(data: ParsedModelData, registry: IdentityRegistry, stableId: string): Record<string, any> | undefined {
  const rec = registry.get(stableId)
  if (!rec) return undefined
  return rec.type === 'element' ? data.elements[rec.fqn] : data.relations[rec.relationId]
}

/** Whether an entity, as committed, is marked intended: added by a promoted change set and not yet shown to exist. */
export const isIntended = (entity: Record<string, any> | undefined): boolean => !!entity?.tags?.includes(TAG.intended)

/**
 * Stable ids of every intended entity in the baseline. Nothing waits on these: an update, move or
 * removal of something that does not exist yet is applied at once as the revised plan.
 */
export function intendedIds(data: ParsedModelData, registry: IdentityRegistry): Set<string> {
  const out = new Set<string>()
  for (const rec of [...registry.elements(), ...registry.relationships()]) {
    if (isIntended(entityData(data, registry, rec.stableId))) out.add(rec.stableId)
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Applying verified deferred operations

async function applyVerifiedPending(data: ParsedModelData, ledger: Ledger, opts: HistoryOptions): Promise<{ applied: AppliedOperation[]; warnings: string[] }> {
  const applied: AppliedOperation[] = []
  const warnings: string[] = []
  const records = new Map(promotedRecords(ledger, opts).map(r => [r.changeSet.id, r]))

  // Each pass applies at most one change set's operations on one entity, then recomputes identity,
  // because a removal cascades. Every pass retires a marker or an entity, so this terminates.
  for (;;) {
    const registry = IdentityRegistry.fromModel(await modelFromParsedData(data))
    const step = await applyOnePending(data, registry, records, warnings)
    if (!step) return { applied, warnings }
    applied.push(...step)
  }
}

async function applyOnePending(data: ParsedModelData, registry: IdentityRegistry, records: Map<string, ChangeRecord>, warnings: string[]): Promise<AppliedOperation[] | null> {
  const entities = [...registry.elements(), ...registry.relationships()]
  for (const rec of entities) {
    const entity = entityData(data, registry, rec.stableId)
    if (!entity) continue
    const pending = readPending(entity)
    if (!pending.length) continue
    for (const changeId of [...records.keys()].filter(id => pending.includes(id))) {
      const record = records.get(changeId)!
      if (!isIntended(entity) && targetVerification(record.verification, rec.stableId) !== 'verified') continue
      const ops = record.changeSet.operations.filter(op => op.id === rec.stableId && isDeferrable(op))
      const diff = emptyDiff()
      for (const op of ops) applyOperation(data, new WorkingIds(registry), op, changeId, { highlight: false }, diff)
      if (!diff.removed.length) setPending(entity, pending.filter(id => id !== changeId))
      return ops.map(op => ({ changeId, entityId: rec.stableId, op: op.op }))
    }
    const unknown = pending.filter(id => !records.has(id))
    if (unknown.length) {
      warnings.push(`${rec.stableId}: pending change set(s) ${unknown.join(', ')} are not promoted in the ledger; marker dropped`)
      setPending(entity, pending.filter(id => records.has(id)))
      return []
    }
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Status derivation and annotation

interface OpEvent { rec: ChangeRecord; op: Operation }

function promotedRecords(ledger: Ledger, opts: HistoryOptions): ChangeRecord[] {
  return ledger.all()
    .map(rec => (opts.promoting && rec.changeSet.id === opts.promoting.id ? { ...rec, changeSet: opts.promoting } : rec))
    .filter(rec => !!rec.changeSet.promotion)
}

/** Promoted operations per entity, in recorded chronology. */
function operationHistory(ledger: Ledger, opts: HistoryOptions): Map<string, OpEvent[]> {
  const out = new Map<string, OpEvent[]>()
  for (const rec of promotedRecords(ledger, opts)) {
    for (const op of rec.changeSet.operations) (out.get(op.id) ?? out.set(op.id, []).get(op.id)!).push({ rec, op })
  }
  return out
}

const findLast = <T>(xs: T[], pred: (x: T) => boolean): T | undefined => { for (let i = xs.length - 1; i >= 0; i--) if (pred(xs[i]!)) return xs[i]; return undefined }

export function deriveEntityStatus(
  ent: { entityId: string; type: 'element' | 'relationship'; fqn?: string },
  entity: Record<string, any>,
  history: OpEvent[],
): EntityStatus {
  const tv = (e: OpEvent) => targetVerification(e.rec.verification, ent.entityId)
  /** Observed in the code (inferred) or verified by evidence, by this event or a later one: the entity exists as operated on. */
  const provenSince = (e: OpEvent) => history.slice(history.indexOf(e)).some(x => x.rec.changeSet.inferred || tv(x) === 'verified')
  const unproven = (e: OpEvent | undefined) => !!e && !provenSince(e)
  const pending = readPending(entity)
  const pendingEvents = history.filter(e => pending.includes(e.rec.changeSet.id))
  const last = history[history.length - 1]
  const adder = findLast(history, e => e.op.op.startsWith('add_'))
  const lastMove = findLast(history, e => e.op.op === 'move_element')

  const present = new Set<StatusFlag>()
  if (unproven(adder)) present.add('intended')
  if (pendingEvents.some(e => e.op.op.startsWith('remove_'))) present.add('retiring')
  if (pendingEvents.some(e => e.op.op.startsWith('update_'))) present.add('pending_update')
  if (!present.has('intended') && unproven(lastMove)) present.add('pending_move')
  if (last && tv(last) === 'failed') present.add('failed')
  const flags = STATUS_FLAGS.filter(f => present.has(f))

  const ids = (es: OpEvent[]) => [...new Set(es.map(e => e.rec.changeSet.id))].join(', ')
  const reasons: string[] = []
  if (present.has('intended')) reasons.push(`added by ${adder!.rec.changeSet.id}, not yet verified: does not exist yet`)
  if (present.has('retiring')) reasons.push(`removal by ${ids(pendingEvents.filter(e => e.op.op.startsWith('remove_')))} awaits verification: still exists`)
  if (present.has('pending_update')) reasons.push(`update by ${ids(pendingEvents.filter(e => e.op.op.startsWith('update_')))} awaits verification: current values shown`)
  if (present.has('pending_move')) reasons.push(`moved by ${lastMove!.rec.changeSet.id}, not yet verified`)
  if (present.has('failed')) reasons.push(`failing evidence on ${last!.rec.changeSet.id}`)
  if (!reasons.length) {
    reasons.push(!last ? 'no promoted change set operates on this entity'
      : tv(last) === 'verified' ? `verified via ${last.rec.changeSet.id}`
      : last.rec.changeSet.inferred ? `inferred during adoption (${last.rec.changeSet.id}); no evidence yet`
      : `exists; ${last.rec.changeSet.id} has no evidence yet`)
  }

  return {
    entityId: ent.entityId, type: ent.type, fqn: ent.fqn,
    changeId: last?.rec.changeSet.id ?? null,
    verification: last ? tv(last) : null,
    flags, pending, reason: reasons.join('; '),
  }
}

/** Declare the reserved tags in the specification so generated DSL always parses. */
export function ensureReservedTags(data: ParsedModelData) {
  data.specification ??= {}
  data.specification.tags ??= {}
  for (const f of STATUS_FLAGS) data.specification.tags[TAG[f]] ??= { color: TAG_COLOR[f] }
}

/** Write tags, metadata and visuals for every entity from the ledger. Idempotent. */
export async function annotateStatuses(data: ParsedModelData, ledger: Ledger, opts: HistoryOptions = {}): Promise<StatusSummary> {
  ensureReservedTags(data)
  const registry = IdentityRegistry.fromModel(await modelFromParsedData(data))
  const history = operationHistory(ledger, opts)
  const entities = new Map<string, EntityStatus>()
  const counts = Object.fromEntries([...STATUS_FLAGS, 'as_is'].map(k => [k, 0])) as StatusCount

  const all = [
    ...registry.elements().map(e => ({ entityId: e.stableId, type: 'element' as const, fqn: e.fqn, entity: data.elements[e.fqn] })),
    ...registry.relationships().map(r => ({ entityId: r.stableId, type: 'relationship' as const, fqn: undefined, entity: data.relations[r.relationId] })),
  ]
  for (const { entity, ...ent } of all) {
    if (!entity) continue
    const status = deriveEntityStatus(ent, entity, history.get(ent.entityId) ?? [])
    writeStatus(entity, ent.type, status)
    entities.set(ent.entityId, status)
    if (status.flags.length) for (const f of status.flags) counts[f]++
    else counts.as_is++
  }
  return { entities, counts }
}

const ELEMENT_VISUAL: Partial<Record<StatusFlag, { border: string; opacity: number }>> = {
  intended: { border: 'dashed', opacity: 40 },
  retiring: { border: 'dotted', opacity: 60 },
}
const RELATION_VISUAL: Partial<Record<StatusFlag, { line: string; color: string }>> = {
  intended: { line: 'dashed', color: 'amber' },
  retiring: { line: 'dotted', color: 'muted' },
}

function writeStatus(entity: Record<string, any>, type: 'element' | 'relationship', status: EntityStatus) {
  const tags = [...userTags(entity.tags), ...status.flags.map(f => TAG[f])]
  if (tags.length) entity.tags = tags
  else delete entity.tags

  entity.metadata ??= {}
  if (status.changeId) {
    entity.metadata[META.change] = status.changeId
    entity.metadata[META.status] = status.verification
  } else {
    delete entity.metadata[META.change]
    delete entity.metadata[META.status]
  }
  if (!status.flags.includes('pending_move')) delete entity.metadata[META.movedFrom]

  // b4-after owns border/opacity on elements and line/color on relationships while a change is pending.
  const key: StatusFlag | null = status.flags.includes('retiring') ? 'retiring' : status.flags.includes('intended') ? 'intended' : null
  if (type === 'element') {
    const style = { ...(entity.style ?? {}) }
    delete style.border; delete style.opacity
    entity.style = key ? { ...style, ...ELEMENT_VISUAL[key] } : style
  } else {
    delete entity.line; delete entity.color
    if (key) Object.assign(entity, RELATION_VISUAL[key])
  }
}
