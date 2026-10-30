// Worktree-aware resolution of the model repository path.
//
// Coding agents often run in linked git worktrees of the code repository. The model repository is
// not part of that repository (it is its own git repository, usually nested and ignored), so a
// relative path such as ./architecture must not be taken relative to the worktree: it would be
// empty there, and the agent would init a second ledger. A relative path therefore resolves
// against the top level of the MAIN worktree of whatever repository contains cwd. Absolute paths
// are used as given; outside any repository the path is relative to cwd.
import { isAbsolute, resolve } from 'node:path'
import { Git } from 'cb4-ledger'

export interface ResolvedRepoDir {
  dir: string
  /** How the path was anchored: as given, to cwd, or to the main worktree of the surrounding repository. */
  via: 'absolute' | 'cwd' | 'main-worktree'
  /** Top level of the main worktree when `via` is main-worktree. */
  mainWorktree?: string
}

export async function resolveRepoDir(input: string, cwd = process.cwd()): Promise<ResolvedRepoDir> {
  if (isAbsolute(input)) return { dir: resolve(input), via: 'absolute' }
  const main = await mainWorktreeOf(cwd)
  if (main) return { dir: resolve(main, input), via: 'main-worktree', mainWorktree: main }
  return { dir: resolve(cwd, input), via: 'cwd' }
}

/** Top level of the main worktree of the repository containing `dir`, or null outside a repository or in a bare one. */
export async function mainWorktreeOf(dir: string): Promise<string | null> {
  let out: string
  try { out = await new Git(dir).exec(['worktree', 'list', '--porcelain']) } catch { return null }
  // The first entry is always the main worktree. A bare repository lists "bare" instead of a path we can anchor to.
  const first = out.split(/\r?\n\r?\n/)[0]
  if (!first) return null
  const lines = first.split(/\r?\n/)
  const path = lines.find(l => l.startsWith('worktree '))?.slice('worktree '.length).trim()
  if (!path || lines.includes('bare')) return null
  return resolve(path)
}
