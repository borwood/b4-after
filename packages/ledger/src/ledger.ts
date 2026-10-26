// The change-set ledger: YAML records under changes/, read from the working tree or as committed
// at a git revision, plus derived in-memory indexes (PRD 7.3). Indexes are rebuildable caches.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import YAML from 'yaml'
import { ChangeSet, type ChangeSet as ChangeSetT, type Operation } from './schema.js'
import { Git, type Commit } from './git.js'
import { EVIDENCE_DIR, EvidenceError, deriveVerification, parseEvidenceFile, type EvidenceRecord, type Verification, type VerificationPolicy } from './evidence.js'

export const CHANGES_DIR = 'changes'

export type ParticipationRole =
  | 'added' | 'updated' | 'moved' | 'removed'
  | 'relationship_added' | 'relationship_updated' | 'relationship_removed'
  | 'relationship_source' | 'relationship_target'
  | 'relates_to'

export interface Participation {
  entityId: string
  entityType: 'element' | 'relationship'
  role: ParticipationRole
  /** How the entity got involved. Operations and relationship endpoints mutate or touch shape; references never do. */
  via: 'operation' | 'relationship_endpoint' | 'reference'
  op?: Operation['op']
  /** For relationship endpoints: the relationship's stable id. */
  relationshipId?: string
  reason?: string
}

export interface ChangeRecord {
  changeSet: ChangeSetT
  path: string
  /** Commits that touched this record, newest first, as visible from the snapshot revision. */
  commits: Commit[]
  /** Committer date of the oldest commit that touched the record. Null when uncommitted. */
  firstRecordedAt: string | null
  lastRecordedAt: string | null
  unrecorded: boolean
  participants: Participation[]
  /** Evidence records on file for this change set at the snapshot (amended records included; derivation ignores them). */
  evidence: EvidenceRecord[]
  /** Commits that touched the evidence file, newest first. */
  evidenceCommits: Commit[]
  /** Verification derived under the ledger's policy (default: any environment). Never asserted. */
  verification: Verification
}

export interface LedgerSnapshot {
  source: 'worktree' | 'revision'
  /** Resolved commit sha the ledger was read at (HEAD for worktree reads, if any). */
  revision: string | null
  /** When loaded with `before`, the cutoff that was requested. */
  before?: string
  isGitRepo: boolean
}

export interface LedgerProblem { path: string; message: string }

export class LedgerError extends Error {
  constructor(message: string, readonly problems: LedgerProblem[]) {
    super(message)
    this.name = 'LedgerError'
  }
}

export interface LoadLedgerOptions {
  revision?: string
  /** ISO date-time. Resolves to the latest commit at or before it on `revision` (default HEAD). */
  before?: string
  changesDir?: string
  evidenceDir?: string
  /** Policy for the verification derived on each record. */
  verification?: VerificationPolicy
  /** Collect malformed records in `problems` instead of throwing. Default false (AR-15). */
  tolerant?: boolean
}

/** Derive every entity participation from a change set, with the operation/reference distinction intact (PRD 3.2). */
export function participantsOf(cs: ChangeSetT): Participation[] {
  const out: Participation[] = []
  for (const op of cs.operations) {
    switch (op.op) {
      case 'add_element': out.push({ entityId: op.id, entityType: 'element', role: 'added', via: 'operation', op: op.op }); break
      case 'update_element': out.push({ entityId: op.id, entityType: 'element', role: 'updated', via: 'operation', op: op.op }); break
      case 'move_element': out.push({ entityId: op.id, entityType: 'element', role: 'moved', via: 'operation', op: op.op }); break
      case 'remove_element': out.push({ entityId: op.id, entityType: 'element', role: 'removed', via: 'operation', op: op.op }); break
      case 'add_relationship':
        out.push({ entityId: op.id, entityType: 'relationship', role: 'relationship_added', via: 'operation', op: op.op })
        out.push({ entityId: op.from, entityType: 'element', role: 'relationship_source', via: 'relationship_endpoint', op: op.op, relationshipId: op.id })
        out.push({ entityId: op.to, entityType: 'element', role: 'relationship_target', via: 'relationship_endpoint', op: op.op, relationshipId: op.id })
        break
      case 'update_relationship': out.push({ entityId: op.id, entityType: 'relationship', role: 'relationship_updated', via: 'operation', op: op.op }); break
      case 'remove_relationship': out.push({ entityId: op.id, entityType: 'relationship', role: 'relationship_removed', via: 'operation', op: op.op }); break
    }
  }
  for (const ref of cs.references) {
    out.push({ entityId: ref.entity, entityType: 'element', role: 'relates_to', via: 'reference', reason: ref.reason })
  }
  return out
}

export function changeSetPath(changeId: string, changesDir = CHANGES_DIR): string {
  return `${changesDir}/${changeId}.yaml`
}

export function parseChangeSet(text: string, path = '<inline>'): ChangeSetT {
  let raw: unknown
  try {
    raw = YAML.parse(text)
  } catch (e: any) {
    throw new LedgerError(`${path}: invalid YAML: ${e.message}`, [{ path, message: e.message }])
  }
  const result = ChangeSet.safeParse(raw)
  if (!result.success) {
    const problems = result.error.issues.map(i => ({ path, message: `${i.path.join('.') || '<root>'}: ${i.message}` }))
    throw new LedgerError(`${path}: invalid change set:\n  ${problems.map(p => p.message).join('\n  ')}`, problems)
  }
  return result.data
}

export function serializeChangeSet(cs: ChangeSetT): string {
  return YAML.stringify(cs, { lineWidth: 0 })
}

/** Chronology (PRD 7.2 [P]): recorded history. Oldest first; uncommitted records last; ties by id. */
export function compareRecorded(a: ChangeRecord, b: ChangeRecord): number {
  if (a.firstRecordedAt && b.firstRecordedAt && a.firstRecordedAt !== b.firstRecordedAt) {
    return a.firstRecordedAt < b.firstRecordedAt ? -1 : 1
  }
  if (!!a.firstRecordedAt !== !!b.firstRecordedAt) return a.firstRecordedAt ? -1 : 1
  return a.changeSet.id.localeCompare(b.changeSet.id, 'en', { numeric: true })
}

export class Ledger {
  readonly records = new Map<string, ChangeRecord>()
  readonly byEntity = new Map<string, Set<string>>()
  readonly problems: LedgerProblem[] = []

  private constructor(readonly repoDir: string, readonly snapshot: LedgerSnapshot) {}

  static async load(repoDir: string, opts: LoadLedgerOptions = {}): Promise<Ledger> {
    const changesDir = opts.changesDir ?? CHANGES_DIR
    const evidenceDir = opts.evidenceDir ?? EVIDENCE_DIR
    const isGitRepo = await Git.isRepo(repoDir)
    const git = isGitRepo ? new Git(repoDir) : null

    let revision: string | null = null
    let source: LedgerSnapshot['source'] = 'worktree'
    if (opts.before || opts.revision) {
      if (!git) throw new Error(`history queries need a git repository at ${repoDir}`)
      source = 'revision'
      const base = opts.revision ? await git.revParse(opts.revision) : 'HEAD'
      revision = opts.before ? await git.revBefore(opts.before, base) : base
      if (opts.before && !revision) {
        // Nothing was recorded yet at that time: an empty ledger is the honest answer.
        return new Ledger(repoDir, { source, revision: null, before: opts.before, isGitRepo })
      }
    } else if (git) {
      revision = await git.headSha()
    }

    const ledger = new Ledger(repoDir, { source, revision, ...(opts.before ? { before: opts.before } : {}), isGitRepo })

    // 1. Read the records (change sets and evidence files).
    const readDir = async (dir: string): Promise<{ path: string; text: string }[]> => {
      const out: { path: string; text: string }[] = []
      if (source === 'revision') {
        for (const path of await git!.lsTree(revision!, dir)) {
          if (!/\.ya?ml$/i.test(path)) continue
          out.push({ path, text: await git!.show(revision!, path) })
        }
      } else {
        let names: string[] = []
        try { names = await readdir(join(repoDir, dir)) } catch { names = [] }
        for (const name of names.filter(n => /\.ya?ml$/i.test(n)).sort()) {
          const path = `${dir}/${name}`
          out.push({ path, text: await readFile(join(repoDir, path), 'utf8') })
        }
      }
      return out
    }
    const files = await readDir(changesDir)
    const evidenceFiles = await readDir(evidenceDir)

    // 2. Commit history per record, one git call.
    const commitsByPath = new Map<string, Commit[]>()
    if (git && revision) {
      for (const c of await git.log({ rev: revision, paths: [changesDir, evidenceDir] })) {
        for (const f of c.files) (commitsByPath.get(f) ?? commitsByPath.set(f, []).get(f)!).push(c)
      }
    }
    const evidenceByChange = new Map<string, EvidenceRecord[]>()
    for (const { path, text } of evidenceFiles) {
      try {
        const file = parseEvidenceFile(text, path)
        const expected = `${evidenceDir}/${file.change_id}.yaml`
        if (path !== expected) throw new EvidenceError(`${path}: evidence file for ${file.change_id} must be at ${expected}`, [{ path, message: 'file name does not match change_id' }])
        evidenceByChange.set(file.change_id, file.evidence)
      } catch (e) {
        if (e instanceof EvidenceError && opts.tolerant) { ledger.problems.push(...e.problems); continue }
        throw e
      }
    }

    // 3. Parse, index.
    for (const { path, text } of files) {
      let cs: ChangeSetT
      try {
        cs = parseChangeSet(text, path)
      } catch (e) {
        if (e instanceof LedgerError && opts.tolerant) { ledger.problems.push(...e.problems); continue }
        throw e
      }
      const expected = changeSetPath(cs.id, changesDir)
      if (path !== expected) {
        const problem = { path, message: `record id ${cs.id} does not match its file name (expected ${expected})` }
        if (!opts.tolerant) throw new LedgerError(problem.message, [problem])
        ledger.problems.push(problem); continue
      }
      if (ledger.records.has(cs.id)) {
        const problem = { path, message: `duplicate change id ${cs.id}` }
        if (!opts.tolerant) throw new LedgerError(problem.message, [problem])
        ledger.problems.push(problem); continue
      }
      const commits = commitsByPath.get(path) ?? []
      const participants = participantsOf(cs)
      const evidence = evidenceByChange.get(cs.id) ?? []
      const rec: ChangeRecord = {
        changeSet: cs, path, commits,
        firstRecordedAt: commits.length ? commits[commits.length - 1]!.committedAt : null,
        lastRecordedAt: commits.length ? commits[0]!.committedAt : null,
        unrecorded: commits.length === 0,
        participants,
        evidence,
        evidenceCommits: commitsByPath.get(`${evidenceDir}/${cs.id}.yaml`) ?? [],
        verification: deriveVerification(cs, evidence, opts.verification),
      }
      ledger.records.set(cs.id, rec)
      for (const p of participants) {
        (ledger.byEntity.get(p.entityId) ?? ledger.byEntity.set(p.entityId, new Set()).get(p.entityId)!).add(cs.id)
      }
    }
    for (const [changeId] of evidenceByChange) {
      if (!ledger.records.has(changeId)) {
        const problem = { path: `${evidenceDir}/${changeId}.yaml`, message: `evidence for ${changeId}, which is not in the ledger` }
        if (!opts.tolerant) throw new LedgerError(problem.message, [problem])
        ledger.problems.push(problem)
      }
    }
    return ledger
  }

  /** Re-derive verification for one change set under a different policy (e.g. a specific environment). */
  verificationOf(changeId: string, policy: VerificationPolicy): Verification | undefined {
    const rec = this.records.get(changeId)
    return rec ? deriveVerification(rec.changeSet, rec.evidence, policy) : undefined
  }

  get(changeId: string): ChangeRecord | undefined { return this.records.get(changeId) }
  has(changeId: string): boolean { return this.records.has(changeId) }

  /** All records in recorded chronology. */
  all(): ChangeRecord[] {
    return [...this.records.values()].sort(compareRecorded)
  }

  /** Change ids involving any of the given entities (operation, endpoint, or reference). */
  changeIdsFor(entityIds: Iterable<string>): Set<string> {
    const out = new Set<string>()
    for (const id of entityIds) for (const c of this.byEntity.get(id) ?? []) out.add(c)
    return out
  }
}
