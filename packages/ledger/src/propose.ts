// Agent write path for the ledger (PRD section 8: proposeChangeSet, validateChangeSet).
// Writes only under changes/; never touches model/.
import { Git } from './git.js'
import { IdentityRegistry } from './identity.js'
import { Ledger } from './ledger.js'
import { loadModel } from './model.js'
import { recordChangeSet, type RecordResult } from './provenance.js'
import { ChangeSet, type ChangeSet as ChangeSetT, type Disposition } from './schema.js'
import { validateChangeSet, type ValidationResult } from './validate.js'

export interface ProposeOptions {
  actor: string
  /** Refuse unless HEAD is this commit, so the proposal was validated against the baseline it lands on. */
  expectedBaseRevision?: string
  /** Record as draft instead of proposed. */
  draft?: boolean
  date?: string
}

export interface ProposeResult {
  validation: ValidationResult
  record: RecordResult
  changeSet: ChangeSetT
  /** True when a record with this id already existed and was revised. */
  revised: boolean
}

export class ProposalRejected extends Error {
  constructor(message: string, readonly validation: ValidationResult) {
    super(message)
    this.name = 'ProposalRejected'
  }
}

/** Validate a change set against the current baseline and ledger, then record it as proposed (or draft). */
export async function proposeChangeSet(repoDir: string, input: unknown, opts: ProposeOptions): Promise<ProposeResult> {
  const git = new Git(repoDir)
  const head = await git.headSha()
  if (opts.expectedBaseRevision !== undefined && head !== opts.expectedBaseRevision) {
    throw new Error(`repository moved: expected base ${opts.expectedBaseRevision}, HEAD is ${head}`)
  }

  const ledger = await Ledger.load(repoDir)
  const loaded = await loadModel(repoDir)
  const registry = IdentityRegistry.fromModel(loaded.model)

  const pre = ChangeSet.safeParse(input)
  if (!pre.success) {
    const validation = validateChangeSet(input, { registry, ledger })
    throw new ProposalRejected(`proposal rejected:\n  ${validation.issues.map(i => `${i.path}: ${i.message}`).join('\n  ')}`, validation)
  }
  const existing = ledger.get(pre.data.id)
  if (existing?.changeSet.promotion) {
    throw new Error(`${pre.data.id} is promoted into the baseline and can no longer be revised; propose a new change set that depends on it`)
  }
  if (pre.data.promotion) throw new Error('a proposal may not carry a promotion record')

  const target: Disposition = opts.draft ? 'draft' : 'proposed'
  if (!['draft', 'proposed'].includes(pre.data.disposition)) {
    throw new Error(`a proposal must be draft or proposed, not ${pre.data.disposition}; use setDisposition for governance transitions`)
  }
  const cs: ChangeSetT = { ...pre.data, disposition: target }

  const validation = validateChangeSet(cs, { registry, ledger })
  if (!validation.ok) {
    throw new ProposalRejected(`proposal rejected:\n  ${validation.issues.filter(i => i.severity === 'error').map(i => `${i.path}: ${i.message}`).join('\n  ')}`, validation)
  }

  const record = await recordChangeSet(repoDir, cs, { actor: opts.actor, expectedHead: head ?? undefined, date: opts.date })
  return { validation, record, changeSet: cs, revised: !!existing }
}

/** Allowed disposition transitions before promotion (PRD 6.1 [P]; governance is still open). */
export const DISPOSITION_TRANSITIONS: Record<Disposition, Disposition[]> = {
  draft: ['proposed', 'superseded'],
  proposed: ['accepted', 'rejected', 'draft', 'superseded'],
  accepted: ['rejected', 'superseded'],
  rejected: ['proposed', 'superseded'],
  superseded: [],
}

export interface DispositionOptions {
  actor: string
  expectedHead?: string
  /** Required when moving to superseded: the change set that replaces this one. */
  supersededBy?: string
  date?: string
}

/** Governance transition recorded as its own commit. Promoted change sets are frozen. */
export async function setDisposition(repoDir: string, changeId: string, to: Disposition, opts: DispositionOptions): Promise<RecordResult> {
  const ledger = await Ledger.load(repoDir)
  const rec = ledger.get(changeId)
  if (!rec) throw new Error(`${changeId} is not in the ledger`)
  const cs = rec.changeSet
  if (cs.promotion) throw new Error(`${changeId} is promoted; its disposition is frozen at ${cs.disposition}`)
  if (!DISPOSITION_TRANSITIONS[cs.disposition].includes(to)) {
    throw new Error(`${changeId}: ${cs.disposition} -> ${to} is not an allowed transition (allowed: ${DISPOSITION_TRANSITIONS[cs.disposition].join(', ') || 'none'})`)
  }
  if (to === 'superseded') {
    if (!opts.supersededBy) throw new Error('superseding requires supersededBy')
    const by = ledger.get(opts.supersededBy)
    if (!by) throw new Error(`${opts.supersededBy} is not in the ledger`)
    if (!by.changeSet.supersedes.includes(changeId)) {
      throw new Error(`${opts.supersededBy} does not declare "supersedes: [${changeId}]"; record that first`)
    }
  }
  const next: ChangeSetT = { ...cs, disposition: to }
  return recordChangeSet(repoDir, next, {
    actor: opts.actor,
    expectedHead: opts.expectedHead,
    date: opts.date,
    subject: `${to === 'superseded' ? 'supersede' : to === 'accepted' ? 'accept' : to === 'rejected' ? 'reject' : to === 'proposed' ? 'propose' : 'draft'} ${cs.id}: ${cs.title}`,
    body: to === 'superseded' ? `Superseded-By: ${opts.supersededBy}` : undefined,
  })
}
