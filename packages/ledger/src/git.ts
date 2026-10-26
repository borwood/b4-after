// Thin git wrapper. The ledger relies on git for chronology, snapshots at a revision, and provenance.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export interface Commit {
  sha: string
  /** Committer date (ISO 8601). This is the ledger's "recorded at" time. */
  committedAt: string
  /** Author date (ISO 8601). */
  authoredAt: string
  author: string
  subject: string
  body: string
  /** Paths touched by the commit, relative to the repository root, when requested. */
  files: string[]
}

export class GitError extends Error {
  constructor(message: string, readonly args: string[], readonly stderr: string) {
    super(message)
    this.name = 'GitError'
  }
}

const RS = '\x1e'
const US = '\x1f'

export class Git {
  constructor(readonly dir: string) {}

  static async isRepo(dir: string): Promise<boolean> {
    try {
      const out = await new Git(dir).exec(['rev-parse', '--is-inside-work-tree'])
      return out.trim() === 'true'
    } catch {
      return false
    }
  }

  async exec(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
    try {
      const { stdout } = await execFileP('git', args, {
        cwd: this.dir,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, ...env },
      })
      return stdout
    } catch (e: any) {
      throw new GitError(`git ${args.join(' ')} failed: ${(e.stderr ?? e.message ?? '').toString().trim()}`, args, e.stderr ?? '')
    }
  }

  async revParse(rev: string): Promise<string> {
    return (await this.exec(['rev-parse', '--verify', `${rev}^{commit}`])).trim()
  }

  async headSha(): Promise<string | null> {
    try { return await this.revParse('HEAD') } catch { return null }
  }

  /** Latest commit reachable from `rev` whose committer date is at or before `isoDate`. */
  async revBefore(isoDate: string, rev = 'HEAD'): Promise<string | null> {
    const out = (await this.exec(['rev-list', '-1', `--before=${isoDate}`, rev])).trim()
    return out || null
  }

  /** Files under `path` at `rev`, repo-relative with forward slashes. */
  async lsTree(rev: string, path: string): Promise<string[]> {
    const out = await this.exec(['ls-tree', '-r', '--name-only', '-z', rev, '--', path])
    return out.split('\0').filter(Boolean)
  }

  async show(rev: string, path: string): Promise<string> {
    return this.exec(['show', `${rev}:${path}`])
  }

  /** Commits touching `paths`, newest first, with the list of touched files per commit. */
  async log(opts: { rev?: string; paths?: string[]; withFiles?: boolean } = {}): Promise<Commit[]> {
    const format = `${RS}%H${US}%cI${US}%aI${US}%an${US}%s${US}%b${US}`
    const args = ['log', `--format=${format}`]
    if (opts.withFiles !== false) args.push('--name-only')
    args.push(opts.rev ?? 'HEAD')
    if (opts.paths?.length) args.push('--', ...opts.paths)
    let out: string
    try {
      out = await this.exec(args)
    } catch (e) {
      // An unborn branch (no commits yet) is not an error for the ledger.
      if (e instanceof GitError && /does not have any commits|unknown revision|bad revision/i.test(e.stderr)) return []
      throw e
    }
    return parseLog(out)
  }

  async add(paths: string[]): Promise<void> {
    await this.exec(['add', '--', ...paths])
  }

  async commit(message: string, opts: { author?: string; date?: string } = {}): Promise<string> {
    const args = ['commit', '-q', '-F', '-']
    if (opts.author) args.push(`--author=${opts.author}`)
    const env: NodeJS.ProcessEnv = {}
    if (opts.date) { env.GIT_AUTHOR_DATE = opts.date; env.GIT_COMMITTER_DATE = opts.date }
    await execWithStdin(this.dir, args, message, env)
    return this.revParse('HEAD')
  }
}

function parseLog(out: string): Commit[] {
  const commits: Commit[] = []
  for (const chunk of out.split(RS)) {
    if (!chunk.trim()) continue
    const parts = chunk.split(US)
    if (parts.length < 7) continue
    const [sha, committedAt, authoredAt, author, subject, body, tail] = parts as [string, string, string, string, string, string, string]
    const files = tail.split('\n').map(s => s.trim()).filter(Boolean)
    // Normalise to UTC ISO so timestamps compare lexicographically regardless of committer offset.
    commits.push({ sha, committedAt: toUtcIso(committedAt), authoredAt: toUtcIso(authoredAt), author, subject, body: body.replace(/\s+$/, ''), files })
  }
  return commits
}

export function toUtcIso(date: string): string {
  const d = new Date(date)
  return Number.isNaN(d.getTime()) ? date : d.toISOString()
}

function execWithStdin(cwd: string, args: string[], stdin: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      if (err) reject(new GitError(`git ${args.join(' ')} failed: ${String(stderr).trim()}`, args, String(stderr)))
      else resolve(stdout)
    })
    child.stdin?.end(stdin)
  })
}

/** Parse `Key: value` trailers from the final paragraph of a commit body. */
export function parseTrailers(body: string): Record<string, string[]> {
  const paragraphs = body.trim().split(/\n\s*\n/)
  const last = paragraphs[paragraphs.length - 1] ?? ''
  const trailers: Record<string, string[]> = {}
  const lines = last.split('\n')
  if (!lines.every(l => /^[A-Za-z][A-Za-z0-9-]*:\s/.test(l))) return trailers
  for (const line of lines) {
    const m = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1]!, value = m[2]!.trim()
    ;(trailers[key] ??= []).push(value)
  }
  return trailers
}
