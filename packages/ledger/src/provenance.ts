// Git provenance (PRD section 9): human-readable subject, machine-readable trailers, and a
// write path that records a change set as a commit. The YAML record stays authoritative for
// intent and associations; the commit supplies chronology and authorship.
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Git, parseTrailers } from './git.js'
import { changeSetPath, serializeChangeSet, CHANGES_DIR } from './ledger.js'
import type { ChangeSet, Disposition, Implementation } from './schema.js'

export const TRAILER = {
  changeId: 'Change-Id',
  origin: 'Origin',
  actor: 'Actor',
  intent: 'Intent',
  disposition: 'Disposition',
  implementation: 'Implementation',
} as const

const VERB: Record<Disposition, string> = {
  draft: 'draft',
  proposed: 'propose',
  accepted: 'accept',
  rejected: 'reject',
  superseded: 'supersede',
}

export interface CommitMessageOptions {
  /** Who or what is recording this. Required so provenance is attributable (PRD 6.2). */
  actor: string
  /** Override the generated subject. */
  subject?: string
  /** Free text placed between subject and trailers. */
  body?: string
  /** Derived implementation progress at the time of the commit. Default not_started. */
  implementation?: Implementation
}

export function commitMessageFor(cs: ChangeSet, opts: CommitMessageOptions): string {
  const subject = opts.subject ?? `${VERB[cs.disposition]} ${cs.id}: ${cs.title}`
  const origin = cs.sources.find(s => s.role === 'requirement') ?? cs.sources[0]
  const trailers: [string, string][] = [
    [TRAILER.changeId, cs.id],
    ...(origin ? [[TRAILER.origin, origin.ref] as [string, string]] : []),
    [TRAILER.actor, opts.actor],
    [TRAILER.intent, oneLine(cs.intent)],
    [TRAILER.disposition, cs.disposition],
    [TRAILER.implementation, opts.implementation ?? 'not_started'],
  ]
  const parts = [subject.trim()]
  if (opts.body?.trim()) parts.push(opts.body.trim())
  parts.push(trailers.map(([k, v]) => `${k}: ${v}`).join('\n'))
  return parts.join('\n\n') + '\n'
}

export interface ProvenanceTrailers {
  changeId?: string
  origin?: string
  actor?: string
  intent?: string
  disposition?: string
  implementation?: string
}

export function provenanceOf(body: string): ProvenanceTrailers {
  const t = parseTrailers(body)
  const one = (k: string) => t[k]?.[0]
  return {
    changeId: one(TRAILER.changeId),
    origin: one(TRAILER.origin),
    actor: one(TRAILER.actor),
    intent: one(TRAILER.intent),
    disposition: one(TRAILER.disposition),
    implementation: one(TRAILER.implementation),
  }
}

export interface RecordOptions extends CommitMessageOptions {
  changesDir?: string
  /** Fail unless HEAD is this sha. Guards against writing on a stale view of the repository (PRD 9 [P]). */
  expectedHead?: string
  /** Fixed commit date, mainly for tests. */
  date?: string
}

export interface RecordResult { path: string; sha: string; message: string }

/** Write (or overwrite) the change set's YAML record and commit it with provenance trailers. */
export async function recordChangeSet(repoDir: string, cs: ChangeSet, opts: RecordOptions): Promise<RecordResult> {
  const git = new Git(repoDir)
  if (!(await Git.isRepo(repoDir))) throw new Error(`${repoDir} is not a git repository`)
  if (opts.expectedHead !== undefined) {
    const head = await git.headSha()
    if (head !== opts.expectedHead) throw new Error(`repository moved: expected HEAD ${opts.expectedHead}, found ${head}`)
  }
  const path = changeSetPath(cs.id, opts.changesDir ?? CHANGES_DIR)
  const abs = join(repoDir, path)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, serializeChangeSet(cs), 'utf8')
  await git.add([path])
  const message = commitMessageFor(cs, opts)
  const sha = await git.commit(message, { date: opts.date })
  return { path, sha, message }
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}
