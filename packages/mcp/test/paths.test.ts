import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Git } from '@borwood/b4-after-ledger'
import { mainWorktreeOf, resolveRepoDir } from '../src/paths.js'

let root: string
let main: string
let linked: string

const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'b4-after-paths-')))
  main = join(root, 'code')
  linked = join(root, 'code-feature')
  const git = new Git(root)
  await git.exec(['init', '-q', '-b', 'main', main])
  const mg = new Git(main)
  await mg.exec(['config', 'user.name', 't']); await mg.exec(['config', 'user.email', 't@example.test'])
  await writeFile(join(main, 'README.md'), 'code\n'); await mg.add(['.']); await mg.commit('init\n')
  await mg.exec(['worktree', 'add', '-q', '-b', 'feature', linked])
  await mkdir(join(linked, 'src'))
})
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

describe('resolveRepoDir', () => {
  it('anchors a relative path to the main worktree, from the main checkout and from a linked worktree', async () => {
    const fromMain = await resolveRepoDir('./architecture', main)
    expect(fromMain.via).toBe('main-worktree')
    expect(norm(fromMain.dir)).toBe(norm(join(main, 'architecture')))

    const fromLinked = await resolveRepoDir('./architecture', linked)
    expect(fromLinked.via).toBe('main-worktree')
    expect(norm(fromLinked.dir)).toBe(norm(join(main, 'architecture')))
    expect(norm(fromLinked.mainWorktree!)).toBe(norm(main))

    // A subdirectory of the linked worktree still lands on the same ledger.
    const fromSub = await resolveRepoDir('architecture', join(linked, 'src'))
    expect(norm(fromSub.dir)).toBe(norm(join(main, 'architecture')))
  })

  it('leaves absolute paths alone and uses cwd outside any repository', async () => {
    const abs = await resolveRepoDir(join(root, 'elsewhere'), linked)
    expect(abs).toMatchObject({ via: 'absolute', dir: resolve(join(root, 'elsewhere')) })

    const outside = await resolveRepoDir('./architecture', root)
    expect(outside.via).toBe('cwd')
    expect(norm(outside.dir)).toBe(norm(join(root, 'architecture')))
    expect(await mainWorktreeOf(root)).toBeNull()
  })
})
