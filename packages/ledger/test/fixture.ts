// Builds a temporary git repository from examples/billing, committed in dated stages so tests can
// query the ledger at a revision or a point in time.
import { cp, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Git } from '../src/git.js'

export const EXAMPLE_DIR = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'examples', 'billing')

export const T1 = '2026-01-10T10:00:00+00:00' // model + CHG-037
export const T2 = '2026-02-10T10:00:00+00:00' // CHG-042 proposed
export const T3 = '2026-03-10T10:00:00+00:00' // CHG-042 accepted + in_progress, CHG-043 rejected

export interface Fixture {
  dir: string
  git: Git
  shas: { stage1: string; stage2: string; stage3: string }
  cleanup(): Promise<void>
}

export async function makeRepo(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'like-b4-fixture-'))
  const git = new Git(dir)
  await git.exec(['init', '-q', '-b', 'main'])
  await git.exec(['config', 'user.name', 'fixture'])
  await git.exec(['config', 'user.email', 'fixture@example.test'])
  await git.exec(['config', 'core.autocrlf', 'false'])

  // Stage 1: model and CHG-037.
  await cp(join(EXAMPLE_DIR, 'model'), join(dir, 'model'), { recursive: true })
  await cp(join(EXAMPLE_DIR, 'changes', 'CHG-037.yaml'), join(dir, 'changes', 'CHG-037.yaml'))
  await git.add(['.'])
  const stage1 = await git.commit('accept CHG-037: Introduce ledger database\n\nChange-Id: CHG-037\nActor: fixture\n', { date: T1 })

  // Stage 2: CHG-042 as proposed (the example file as shipped).
  await cp(join(EXAMPLE_DIR, 'changes', 'CHG-042.yaml'), join(dir, 'changes', 'CHG-042.yaml'))
  await git.add(['.'])
  const stage2 = await git.commit('propose CHG-042: Add asynchronous billing retries\n\nChange-Id: CHG-042\nActor: fixture\n', { date: T2 })

  // Stage 3: CHG-042 revised (accepted, in progress) and CHG-043 recorded as rejected.
  const p42 = join(dir, 'changes', 'CHG-042.yaml')
  const v2 = (await readFile(p42, 'utf8'))
    .replace('disposition: proposed', 'disposition: accepted')
    .replace('implementation: not_started', 'implementation: in_progress')
  await writeFile(p42, v2, 'utf8')
  await cp(join(EXAMPLE_DIR, 'changes', 'CHG-043.yaml'), join(dir, 'changes', 'CHG-043.yaml'))
  await git.add(['.'])
  const stage3 = await git.commit('accept CHG-042; reject CHG-043\n\nChange-Id: CHG-042\nChange-Id: CHG-043\nActor: fixture\n', { date: T3 })

  return {
    dir, git,
    shas: { stage1, stage2, stage3 },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}
