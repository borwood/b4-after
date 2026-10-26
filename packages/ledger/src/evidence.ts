// Evidence records and derived verification (PRD 6.1, 6.2, AR-09, AT-06).
//
// Evidence lives in evidence/CHG-<n>.yaml, one file per change set, append-only (corrections are
// new records that `amend` an earlier one; git keeps the prior claim). Verification is never
// asserted on a change set: it is derived from evidence under an explicit policy.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import YAML from 'yaml'
import { z } from 'zod'
import { Git } from './git.js'
import { STABLE_ID } from './schema.js'
import type { ChangeSet } from './schema.js'

export const EVIDENCE_DIR = 'evidence'

export const EvidenceKind = z.enum(['test', 'runtime_observation', 'deployment', 'code_review', 'manual_review'])
export const EvidenceResult = z.enum(['pass', 'fail', 'inconclusive'])

/** Observations prove something ran; approvals record a judgement; deployments record placement. Only observations verify. */
export const KIND_CLASS: Record<z.infer<typeof EvidenceKind>, 'observation' | 'approval' | 'deployment'> = {
  test: 'observation',
  runtime_observation: 'observation',
  deployment: 'deployment',
  code_review: 'approval',
  manual_review: 'approval',
}

const evidenceId = z.string().regex(/^ev-[a-z0-9][a-z0-9_-]*$/, 'evidence id must look like ev-<slug>')

export const EvidenceRecord = z.strictObject({
  id: evidenceId,
  kind: EvidenceKind,
  result: EvidenceResult,
  /** Stable ids this evidence speaks to. Empty or absent means the whole change set. */
  targets: z.array(z.string().regex(STABLE_ID)).default([]),
  /** Resolvable pointer to the artifact: CI run, PR, trace, ticket. Contents stay external. */
  source_ref: z.string().min(1),
  /** Code revision the observation was made against. Required for an observation to count toward verification. */
  code_revision: z.string().min(4).optional(),
  /** Model repository commit whose baseline this record speaks for. Deployments use it to say which declared architecture is running. */
  baseline_revision: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
  environment: z.string().min(1).optional(),
  observed_at: z.iso.datetime({ offset: true }),
  recorded_by: z.string().min(1),
  notes: z.string().optional(),
  /** Id of an earlier record this one corrects. The earlier record is ignored for derivation but kept on file. */
  amends: evidenceId.optional(),
})

export const EvidenceFile = z.strictObject({
  change_id: z.string(),
  evidence: z.array(EvidenceRecord).default([]),
})

export type EvidenceKind = z.infer<typeof EvidenceKind>
export type EvidenceResult = z.infer<typeof EvidenceResult>
export type EvidenceRecord = z.infer<typeof EvidenceRecord>
export type EvidenceRecordInput = z.input<typeof EvidenceRecord>
export type EvidenceFile = z.infer<typeof EvidenceFile>

export function evidencePath(changeId: string, dir = EVIDENCE_DIR): string {
  return `${dir}/${changeId}.yaml`
}

export class EvidenceError extends Error {
  constructor(message: string, readonly problems: { path: string; message: string }[]) {
    super(message)
    this.name = 'EvidenceError'
  }
}

export function parseEvidenceFile(text: string, path = '<inline>'): EvidenceFile {
  let raw: unknown
  try { raw = YAML.parse(text) } catch (e: any) { throw new EvidenceError(`${path}: invalid YAML: ${e.message}`, [{ path, message: e.message }]) }
  const r = EvidenceFile.safeParse(raw)
  if (!r.success) {
    const problems = r.error.issues.map(i => ({ path, message: `${i.path.join('.') || '<root>'}: ${i.message}` }))
    throw new EvidenceError(`${path}: invalid evidence file:\n  ${problems.map(p => p.message).join('\n  ')}`, problems)
  }
  const ids = new Set<string>()
  for (const rec of r.data.evidence) {
    if (ids.has(rec.id)) throw new EvidenceError(`${path}: duplicate evidence id ${rec.id}`, [{ path, message: `duplicate evidence id ${rec.id}` }])
    ids.add(rec.id)
  }
  return r.data
}

export function serializeEvidenceFile(file: EvidenceFile): string {
  return YAML.stringify(file, { lineWidth: 0 })
}

// ---------------------------------------------------------------------------------------------
// Derived verification

export type VerificationStatus = 'unverified' | 'partial' | 'verified' | 'failed'

export interface VerificationPolicy {
  /** Only evidence for this environment (plus environment-agnostic records) counts. Default: any. */
  environment?: string
  /** Observations must carry a code_revision to count. Default true. */
  requireCodeRevision?: boolean
  /** Each listed kind must have at least one passing, applicable record for "verified". Default none. */
  requireKinds?: EvidenceKind[]
  /** Require at least one passing approval in addition to observations. Default false (PRD: approval is not observation). */
  requireApproval?: boolean
}

export interface Verification {
  status: VerificationStatus
  environment: string | 'any'
  /** Operation targets of the change set (what verification must cover). */
  targets: string[]
  covered: string[]
  uncovered: string[]
  /** Passing observations that the status rests on. Answers "what justified this?". */
  basis: string[]
  failing: string[]
  approvals: { id: string; kind: EvidenceKind; result: EvidenceResult; recorded_by: string }[]
  deployments: { id: string; environment: string | null; result: EvidenceResult; observed_at: string; code_revision: string | null }[]
  /** Records that exist but did not count, with the reason. */
  ignored: { id: string; reason: string }[]
}

/** Stable ids a change set's operations act on. Relationship endpoints and references are not targets. */
export function targetsOf(cs: ChangeSet): string[] {
  return [...new Set(cs.operations.map(op => op.id))]
}

export function deriveVerification(cs: ChangeSet, records: EvidenceRecord[], policy: VerificationPolicy = {}): Verification {
  const env = policy.environment
  const requireRev = policy.requireCodeRevision ?? true
  const targets = targetsOf(cs)
  const targetSet = new Set(targets)
  const ignored: Verification['ignored'] = []
  const amended = new Set(records.map(r => r.amends).filter((x): x is string => !!x))

  const applicable = records.filter(r => {
    if (amended.has(r.id)) { ignored.push({ id: r.id, reason: `amended by a later record` }); return false }
    if (env && r.environment && r.environment !== env) { ignored.push({ id: r.id, reason: `environment ${r.environment} is not ${env}` }); return false }
    const unknown = (r.targets ?? []).filter(t => !targetSet.has(t))
    if (unknown.length) { ignored.push({ id: r.id, reason: `targets not operated on by ${cs.id}: ${unknown.join(', ')}` }); return false }
    return true
  })

  const approvals: Verification['approvals'] = []
  const deployments: Verification['deployments'] = []
  const covered = new Set<string>()
  const basis: string[] = []
  const failing: string[] = []
  const passingKinds = new Set<EvidenceKind>()

  for (const r of applicable) {
    const cls = KIND_CLASS[r.kind]
    if (cls === 'approval') { approvals.push({ id: r.id, kind: r.kind, result: r.result, recorded_by: r.recorded_by }); continue }
    if (cls === 'deployment') { deployments.push({ id: r.id, environment: r.environment ?? null, result: r.result, observed_at: r.observed_at, code_revision: r.code_revision ?? null }); continue }
    if (r.result === 'inconclusive') { ignored.push({ id: r.id, reason: 'inconclusive' }); continue }
    if (r.result === 'fail') { failing.push(r.id); continue }
    if (requireRev && !r.code_revision) { ignored.push({ id: r.id, reason: 'passing observation without code_revision' }); continue }
    basis.push(r.id)
    passingKinds.add(r.kind)
    for (const t of r.targets?.length ? r.targets : targets) covered.add(t)
  }

  const uncovered = targets.filter(t => !covered.has(t))
  let status: VerificationStatus
  if (failing.length) status = 'failed'
  else if (basis.length === 0) status = 'unverified'
  else {
    const kindsOk = (policy.requireKinds ?? []).every(k => passingKinds.has(k))
    const approvalOk = !policy.requireApproval || approvals.some(a => a.result === 'pass')
    status = uncovered.length === 0 && kindsOk && approvalOk && targets.length > 0 ? 'verified' : 'partial'
  }

  return {
    status, environment: env ?? 'any', targets, covered: [...covered], uncovered, basis, failing, approvals, deployments, ignored,
  }
}

// ---------------------------------------------------------------------------------------------
// Recording

export interface RecordEvidenceOptions {
  actor: string
  /** Refuse unless HEAD is this sha. */
  expectedRevision?: string
  evidenceDir?: string
  date?: string
}

export interface RecordEvidenceResult {
  path: string
  sha: string
  record: EvidenceRecord
  warnings: string[]
}

/**
 * Append an evidence record for a change set and commit it. The change set must exist in the
 * ledger; targets must be entities the change set operates on. Never touches model/ or changes/.
 */
export async function recordEvidence(repoDir: string, changeId: string, input: unknown, opts: RecordEvidenceOptions): Promise<RecordEvidenceResult> {
  const { Ledger } = await import('./ledger.js')
  const git = new Git(repoDir)
  if (!(await Git.isRepo(repoDir))) throw new Error(`${repoDir} is not a git repository`)
  const head = await git.headSha()
  if (opts.expectedRevision !== undefined && head !== opts.expectedRevision) {
    throw new Error(`repository moved: expected ${opts.expectedRevision}, HEAD is ${head}`)
  }
  const parsed = EvidenceRecord.safeParse(input)
  if (!parsed.success) {
    const problems = parsed.error.issues.map(i => ({ path: '/' + i.path.join('/'), message: i.message }))
    throw new EvidenceError(`invalid evidence:\n  ${problems.map(p => `${p.path}: ${p.message}`).join('\n  ')}`, problems)
  }
  const rec = parsed.data
  const ledger = await Ledger.load(repoDir)
  const change = ledger.get(changeId)
  if (!change) throw new Error(`${changeId} is not in the ledger`)

  const warnings: string[] = []
  const targets = new Set(targetsOf(change.changeSet))
  const participants = new Set(change.participants.map(p => p.entityId))
  for (const t of rec.targets) {
    if (targets.has(t)) continue
    if (participants.has(t)) warnings.push(`${t} is a participant of ${changeId} but not an operation target; this record will not count toward verification`)
    else throw new Error(`${t} is not involved in ${changeId}`)
  }
  if (KIND_CLASS[rec.kind] === 'observation' && rec.result === 'pass' && !rec.code_revision) {
    warnings.push('passing observation without code_revision will not count toward verification under the default policy')
  }

  const dir = opts.evidenceDir ?? EVIDENCE_DIR
  const path = evidencePath(changeId, dir)
  const abs = join(repoDir, path)
  let file: EvidenceFile = { change_id: changeId, evidence: [] }
  try { file = parseEvidenceFile(await readFile(abs, 'utf8'), path) } catch (e: any) { if (e.code !== 'ENOENT') throw e }
  if (file.evidence.some(e => e.id === rec.id)) throw new Error(`evidence id ${rec.id} already exists for ${changeId}`)
  if (rec.amends && !file.evidence.some(e => e.id === rec.amends)) throw new Error(`${rec.id} amends unknown record ${rec.amends}`)
  file.evidence.push(rec)

  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, serializeEvidenceFile(file), 'utf8')
  await git.add([path])
  const message = [
    `evidence ${changeId}: ${rec.kind} ${rec.result}${rec.environment ? ` in ${rec.environment}` : ''}`,
    [
      `Change-Id: ${changeId}`,
      `Evidence-Id: ${rec.id}`,
      `Actor: ${opts.actor}`,
      `Kind: ${rec.kind}`,
      `Result: ${rec.result}`,
      ...(rec.environment ? [`Environment: ${rec.environment}`] : []),
      ...(rec.code_revision ? [`Code-Revision: ${rec.code_revision}`] : []),
    ].join('\n'),
  ].join('\n\n') + '\n'
  const sha = await git.commit(message, { date: opts.date })
  return { path, sha, record: rec, warnings }
}
