// storyOf(): bounded chronological history of an entity or subtree (PRD section 7, AR-10/11/12).
import { Ledger, type ChangeRecord, type Participation } from './ledger.js'
import { IdentityRegistry } from './identity.js'
import { loadModel } from './model.js'
import type { Source, Operation, Reference, Disposition, Implementation } from './schema.js'

export type StoryInclude = 'operations' | 'references' | 'sources' | 'commits'

export interface StoryQuery {
  /** Stable id, or a current FQN (resolved against the model at the selected snapshot). */
  entity: string
  /** Include change sets touching any current descendant of the entity (AT-09). */
  subtree?: boolean
  /** Reconstruct ledger and model as recorded at this git revision (AT-04). */
  revision?: string
  /** ISO date-time cutoff: resolves to the latest commit at or before it. */
  before?: string
  limit?: number
  cursor?: string
  include?: StoryInclude[]
}

export interface StoryEntry {
  changeId: string
  title: string
  intent: string
  disposition: Disposition
  implementation: Implementation
  /** Committer date of the first commit recording this change set, as visible at the snapshot. */
  recordedAt: string | null
  lastRecordedAt: string | null
  /** Claimed effective time, if the record states one (distinct from recordedAt, PRD 7.2). */
  effectiveAt?: string
  unrecorded: boolean
  /** How the queried entity (or subtree members) took part. */
  matched: Participation[]
  /** Other entities in the same logical change, one hop only, by role. */
  others: Participation[]
  sources?: Source[]
  operations?: Operation[]
  references?: Reference[]
  commits: { sha: string; recordedAt: string; subject: string }[]
  dependsOn: string[]
  supersedes: string[]
}

export interface StoryResult {
  subject: {
    requested: string
    /** Null when the entity is absent from the model at the snapshot (removed, renamed without id, or never existed). */
    resolved: { stableId: string; fqn: string | null; type: 'element' | 'relationship' } | null
    members: string[]
    /**
     * Relationships attached (at the snapshot) to member elements. Operations that name a relationship
     * only by id (update/remove) still count as touching its endpoints (PRD 7.1).
     */
    attachedRelationships: string[]
    /** How subtree members were determined. Phase B supports current-at-snapshot only (PRD 7.2 [O]). */
    membership: 'target_only' | 'descendants_at_snapshot'
    /** Descendants that lack a stable id and therefore cannot appear in the ledger. */
    unidentifiedDescendants: number
  }
  snapshot: {
    source: 'worktree' | 'revision'
    revision: string | null
    before?: string
    chronology: 'recorded'
    modelLoaded: boolean
  }
  entries: StoryEntry[]
  total: number
  truncated: boolean
  nextCursor?: string
  /** Problems that did not stop the query (e.g. model could not be loaded, so FQN resolution was skipped). */
  warnings: string[]
}

export interface StoryDeps {
  ledger?: Ledger
  registry?: IdentityRegistry | null
}

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const DEFAULT_INCLUDE: StoryInclude[] = ['operations', 'references', 'sources']

export async function storyOf(repoDir: string, q: StoryQuery, deps: StoryDeps = {}): Promise<StoryResult> {
  const warnings: string[] = []
  const include = new Set(q.include ?? DEFAULT_INCLUDE)
  const limit = Math.max(1, Math.min(q.limit ?? DEFAULT_LIMIT, MAX_LIMIT))
  const offset = decodeCursor(q.cursor)

  const ledger = deps.ledger ?? await Ledger.load(repoDir, { revision: q.revision, before: q.before })

  // Model at the same snapshot, for FQN resolution and subtree membership.
  let registry: IdentityRegistry | null = deps.registry ?? null
  if (registry === null && deps.registry === undefined) {
    if (ledger.snapshot.source === 'revision' && !ledger.snapshot.revision) {
      warnings.push('nothing was recorded at or before the requested cutoff')
    } else {
      try {
        const loaded = await loadModel(repoDir, ledger.snapshot.source === 'revision' ? { revision: ledger.snapshot.revision! } : {})
        registry = IdentityRegistry.fromModel(loaded.model)
      } catch (e: any) {
        warnings.push(`model not loaded, FQN resolution and subtree expansion skipped: ${e.message}`)
      }
    }
  }

  // Resolve the subject.
  const rec = registry?.resolve(q.entity)
  const stableId = rec?.stableId ?? q.entity
  const resolved: StoryResult['subject']['resolved'] = rec
    ? { stableId: rec.stableId, fqn: rec.type === 'element' ? rec.fqn : null, type: rec.type }
    : null
  if (!rec && registry && q.entity.includes('.')) {
    warnings.push(`"${q.entity}" is not a current FQN at this snapshot; treated as a stable id`)
  }

  let members = [stableId]
  let membership: StoryResult['subject']['membership'] = 'target_only'
  let unidentifiedDescendants = 0
  if (q.subtree) {
    if (rec?.type === 'element' && registry) {
      const d = registry.descendantsOf(rec.stableId)
      members = [stableId, ...d.ids]
      unidentifiedDescendants = d.unidentified
      membership = 'descendants_at_snapshot'
    } else {
      warnings.push('subtree requested but the entity is not a resolvable element at this snapshot; only the entity itself was used')
    }
  }
  const attachedRelationships: string[] = []
  if (registry) {
    const memberFqns = new Set(members.map(id => registry.element(id)?.fqn).filter((f): f is string => !!f))
    if (memberFqns.size) {
      for (const rel of registry.relationships()) {
        if (memberFqns.has(rel.fromFqn) || memberFqns.has(rel.toFqn)) attachedRelationships.push(rel.stableId)
      }
    }
  }
  const memberSet = new Set([...members, ...attachedRelationships])

  // Collect, dedupe, sort.
  const ids = ledger.changeIdsFor(memberSet)
  const records = [...ids].map(id => ledger.get(id)!).sort(compareRecordedStable)
  const total = records.length
  const page = records.slice(offset, offset + limit)
  const truncated = offset + page.length < total

  const entries = page.map(r => toEntry(r, memberSet, include))
  return {
    subject: { requested: q.entity, resolved, members, attachedRelationships, membership, unidentifiedDescendants },
    snapshot: {
      source: ledger.snapshot.source,
      revision: ledger.snapshot.revision,
      ...(ledger.snapshot.before ? { before: ledger.snapshot.before } : {}),
      chronology: 'recorded',
      modelLoaded: registry !== null,
    },
    entries,
    total,
    truncated,
    ...(truncated ? { nextCursor: encodeCursor(offset + page.length) } : {}),
    warnings,
  }
}

function toEntry(r: ChangeRecord, members: Set<string>, include: Set<StoryInclude>): StoryEntry {
  const cs = r.changeSet
  const matched = r.participants.filter(p => members.has(p.entityId))
  const others = dedupeParticipants(r.participants.filter(p => !members.has(p.entityId)))
  return {
    changeId: cs.id,
    title: cs.title,
    intent: cs.intent,
    disposition: cs.disposition,
    implementation: cs.implementation,
    recordedAt: r.firstRecordedAt,
    lastRecordedAt: r.lastRecordedAt,
    ...(cs.effective_at ? { effectiveAt: cs.effective_at } : {}),
    unrecorded: r.unrecorded,
    matched,
    others,
    ...(include.has('sources') ? { sources: cs.sources } : {}),
    ...(include.has('operations') ? { operations: cs.operations } : {}),
    ...(include.has('references') ? { references: cs.references } : {}),
    commits: include.has('commits')
      ? r.commits.map(c => ({ sha: c.sha, recordedAt: c.committedAt, subject: c.subject }))
      : r.commits.slice(0, 1).map(c => ({ sha: c.sha, recordedAt: c.committedAt, subject: c.subject })),
    dependsOn: cs.depends_on,
    supersedes: cs.supersedes,
  }
}

function dedupeParticipants(ps: Participation[]): Participation[] {
  const seen = new Set<string>()
  return ps.filter(p => {
    const key = `${p.entityId}|${p.role}|${p.relationshipId ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function compareRecordedStable(a: ChangeRecord, b: ChangeRecord): number {
  if (a.firstRecordedAt && b.firstRecordedAt && a.firstRecordedAt !== b.firstRecordedAt) return a.firstRecordedAt < b.firstRecordedAt ? -1 : 1
  if (!!a.firstRecordedAt !== !!b.firstRecordedAt) return a.firstRecordedAt ? -1 : 1
  return a.changeSet.id.localeCompare(b.changeSet.id, 'en', { numeric: true })
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url')
}
function decodeCursor(cursor?: string): number {
  if (!cursor) return 0
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (typeof v?.o === 'number' && v.o >= 0) return v.o
  } catch { /* fall through */ }
  throw new Error('invalid cursor')
}
