// Per-repository context for the server: cached snapshots keyed by what can change them, and a
// cross-process write lock so several agents (each with their own server process) serialise writes.
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Git, IdentityRegistry, Ledger, loadModel, CHANGES_DIR, EVIDENCE_DIR, MODEL_DIR, type Snapshot } from 'cb4-ledger'

export interface ContextOptions {
  /** Default actor for writes when a tool call does not name one. */
  actor?: string
  lockTimeoutMs?: number
  lockStaleMs?: number
}

export class RepoContext {
  readonly git: Git
  private cached: { signature: string; snapshot: Snapshot } | null = null
  private loading: Promise<Snapshot> | null = null

  constructor(readonly repoDir: string, readonly options: ContextOptions = {}) {
    this.git = new Git(repoDir)
  }

  async head(): Promise<string | null> {
    return (await Git.isRepo(this.repoDir)) ? this.git.headSha() : null
  }

  /** Whether the directory holds LikeC4 sources under model/ (false before bootstrap init). */
  async hasModel(): Promise<boolean> {
    try { return (await readdir(join(this.repoDir, MODEL_DIR))).some(f => /\.c4$/i.test(f)) } catch { return false }
  }

  /** Current working-tree snapshot (model, registry, ledger). Recomputed only when HEAD or the data files change. */
  async snapshot(): Promise<Snapshot> {
    const signature = await this.signature()
    if (this.cached?.signature === signature) return this.cached.snapshot
    if (this.loading) return this.loading
    this.loading = (async () => {
      try {
        const head = await this.head()
        const [loaded, ledger] = await Promise.all([loadModel(this.repoDir), Ledger.load(this.repoDir)])
        const snapshot: Snapshot = { model: loaded.model, parsedData: loaded.parsedData, registry: IdentityRegistry.fromModel(loaded.model), ledger, head }
        this.cached = { signature, snapshot }
        return snapshot
      } finally {
        this.loading = null
      }
    })()
    return this.loading
  }

  invalidate() { this.cached = null }

  private async signature(): Promise<string> {
    const parts: string[] = [(await this.head()) ?? 'no-head']
    for (const dir of [MODEL_DIR, CHANGES_DIR, EVIDENCE_DIR]) {
      let names: string[] = []
      try { names = await readdir(join(this.repoDir, dir)) } catch { continue }
      for (const n of names.sort()) {
        try { const s = await stat(join(this.repoDir, dir, n)); parts.push(`${dir}/${n}:${s.mtimeMs}:${s.size}`) } catch { /* vanished */ }
      }
    }
    return parts.join('|')
  }

  /**
   * Serialise writes across processes with an atomic mkdir lock. The lock lives under .git so it
   * is never committed; before the repository exists (bootstrap init) it lives in the OS temp
   * directory, keyed by path, so it cannot end up inside the work tree about to be created.
   * Stale locks (crashed holder) are broken after `lockStaleMs`.
   */
  async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockDir = (await Git.isRepo(this.repoDir))
      ? join(this.repoDir, '.git', '.cb4.lock')
      : join(tmpdir(), `cb4-${createHash('sha1').update(this.repoDir).digest('hex').slice(0, 12)}.lock`)
    const timeout = this.options.lockTimeoutMs ?? 30_000
    const stale = this.options.lockStaleMs ?? 120_000
    const started = Date.now()
    for (;;) {
      try {
        await mkdir(lockDir)
        await writeFile(join(lockDir, 'owner'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), 'utf8')
        break
      } catch (e: any) {
        if (e.code !== 'EEXIST') throw e
        let age = 0
        try { age = Date.now() - (await stat(lockDir)).mtimeMs } catch { continue }
        if (age > stale) { await rm(lockDir, { recursive: true, force: true }); continue }
        if (Date.now() - started > timeout) {
          let owner = ''
          try { owner = await readFile(join(lockDir, 'owner'), 'utf8') } catch { /* ignore */ }
          throw new Error(`write lock busy for ${Math.round(age / 1000)}s${owner ? ` (held by ${owner})` : ''}; retry shortly`)
        }
        await new Promise(r => setTimeout(r, 50 + Math.random() * 100))
      }
    }
    try {
      return await fn()
    } finally {
      await rm(lockDir, { recursive: true, force: true }).catch(() => {})
      this.invalidate()
    }
  }
}
