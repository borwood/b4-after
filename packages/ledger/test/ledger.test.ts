import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Ledger, LedgerError } from '../src/ledger.js'
import { makeRepo, type Fixture, T1, T2, T3 } from './fixture.js'

let fx: Fixture
beforeAll(async () => { fx = await makeRepo() })
afterAll(async () => { await fx.cleanup() })

describe('Ledger.load (worktree)', () => {
  it('reads every record, indexes participants, and orders by recorded chronology', async () => {
    const ledger = await Ledger.load(fx.dir)
    expect(ledger.snapshot).toMatchObject({ source: 'worktree', revision: fx.shas.stage3, isGitRepo: true })
    expect([...ledger.records.keys()].sort()).toEqual(['CHG-037', 'CHG-042', 'CHG-043'])
    expect(ledger.all().map(r => r.changeSet.id)).toEqual(['CHG-037', 'CHG-042', 'CHG-043'])

    const r42 = ledger.get('CHG-042')!
    expect(r42.firstRecordedAt).toBe(new Date(T2).toISOString())
    expect(r42.lastRecordedAt).toBe(new Date(T3).toISOString())
    expect(r42.commits).toHaveLength(2)
    expect(r42.changeSet.disposition).toBe('accepted')

    expect([...ledger.changeIdsFor(['ent-billing-api'])]).toEqual(['CHG-042'])
    expect([...ledger.changeIdsFor(['ent-ledger-db'])]).toEqual(['CHG-037'])
    expect([...ledger.changeIdsFor(['ent-invoice-ui'])]).toEqual(['CHG-042'])
    expect([...ledger.changeIdsFor(['ent-legacy-exporter'])]).toEqual(['CHG-037'])
    expect([...ledger.changeIdsFor(['rel-charges-cards'])]).toEqual(['CHG-043'])
  })

  it('flags uncommitted records and sorts them last', async () => {
    const extra = join(fx.dir, 'changes', 'CHG-050.yaml')
    await writeFile(extra, 'id: CHG-050\ntitle: Draft\nintent: wip\noperations:\n  - op: remove_element\n    id: ent-customer\n', 'utf8')
    try {
      const ledger = await Ledger.load(fx.dir)
      const r = ledger.get('CHG-050')!
      expect(r.unrecorded).toBe(true)
      expect(r.firstRecordedAt).toBeNull()
      expect(ledger.all().map(r => r.changeSet.id).at(-1)).toBe('CHG-050')
    } finally {
      await fx.git.exec(['clean', '-fq', '--', 'changes/CHG-050.yaml'])
    }
  })

  it('rejects malformed records by default and collects them when tolerant', async () => {
    const bad = join(fx.dir, 'changes', 'CHG-099.yaml')
    await writeFile(bad, 'id: CHG-099\ntitle: broken\n', 'utf8')
    try {
      await expect(Ledger.load(fx.dir)).rejects.toThrow(LedgerError)
      const ledger = await Ledger.load(fx.dir, { tolerant: true })
      expect(ledger.problems).toHaveLength(1)
      expect(ledger.problems[0]!.path).toBe('changes/CHG-099.yaml')
      expect(ledger.has('CHG-099')).toBe(false)
    } finally {
      await fx.git.exec(['clean', '-fq', '--', 'changes/CHG-099.yaml'])
    }
  })

  it('rejects a record whose file name does not match its id', async () => {
    const wrong = join(fx.dir, 'changes', 'CHG-041.yaml')
    await writeFile(wrong, 'id: CHG-040\ntitle: t\nintent: i\n', 'utf8')
    try {
      await expect(Ledger.load(fx.dir)).rejects.toThrow(/does not match its file name/)
    } finally {
      await fx.git.exec(['clean', '-fq', '--', 'changes/CHG-041.yaml'])
    }
  })
})

describe('Ledger.load (history)', () => {
  it('at a revision returns the records and states as committed then (AT-04)', async () => {
    const ledger = await Ledger.load(fx.dir, { revision: fx.shas.stage2 })
    expect(ledger.snapshot).toMatchObject({ source: 'revision', revision: fx.shas.stage2 })
    expect([...ledger.records.keys()].sort()).toEqual(['CHG-037', 'CHG-042'])
    const r42 = ledger.get('CHG-042')!
    expect(r42.changeSet.disposition).toBe('proposed')
    expect(r42.commits).toHaveLength(1)
    expect(r42.lastRecordedAt).toBe(r42.firstRecordedAt)
  })

  it('before a time resolves to the latest commit at or before it', async () => {
    const mid = await Ledger.load(fx.dir, { before: '2026-02-20T00:00:00Z' })
    expect(mid.snapshot.revision).toBe(fx.shas.stage2)
    expect(mid.get('CHG-042')!.changeSet.disposition).toBe('proposed')
    expect(mid.has('CHG-043')).toBe(false)

    const exact = await Ledger.load(fx.dir, { before: T1 })
    expect(exact.snapshot.revision).toBe(fx.shas.stage1)
    expect([...exact.records.keys()]).toEqual(['CHG-037'])
  })

  it('before the first commit yields an empty ledger, not an error', async () => {
    const none = await Ledger.load(fx.dir, { before: '2025-12-31T00:00:00Z' })
    expect(none.snapshot).toMatchObject({ source: 'revision', revision: null, before: '2025-12-31T00:00:00Z' })
    expect(none.records.size).toBe(0)
  })
})
