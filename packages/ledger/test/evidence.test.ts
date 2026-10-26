import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deriveVerification, recordEvidence, parseEvidenceFile, EvidenceError, targetsOf } from '../src/evidence.js'
import { ChangeSet } from '../src/schema.js'
import { Ledger } from '../src/ledger.js'
import { storyOf } from '../src/story.js'
import { formatStory } from '../src/format.js'
import { makeRepo, type Fixture } from './fixture.js'

const cs = ChangeSet.parse({
  id: 'CHG-042', title: 'Add asynchronous billing retries', intent: 'i',
  operations: [
    { op: 'add_element', id: 'ent-billing-retry-worker', parent: 'ent-billing', name: 'retry_worker', kind: 'component' },
    { op: 'add_relationship', id: 'rel-billing-api-publishes-retries', from: 'ent-billing-api', to: 'ent-billing-retry-worker', kind: 'publishes_to' },
  ],
  references: [{ entity: 'ent-invoice-ui', relation: 'relates_to' }],
})
const base = { source_ref: 'https://ci.example.test/runs/1', observed_at: '2026-04-10T12:00:00Z', recorded_by: 'ci' }
const ev = (over: Record<string, unknown>) => ({ id: 'ev-x', kind: 'test', result: 'pass', code_revision: 'abc1234', ...base, ...over }) as any

describe('deriveVerification', () => {
  it('targets are operation ids only; endpoints and references are not targets', () => {
    expect(targetsOf(cs)).toEqual(['ent-billing-retry-worker', 'rel-billing-api-publishes-retries'])
  })

  it('is unverified with no evidence, and AT-06: approvals and merges never verify by themselves', () => {
    expect(deriveVerification(cs, []).status).toBe('unverified')
    const v = deriveVerification(cs, [
      ev({ id: 'ev-pr', kind: 'code_review', result: 'pass', source_ref: 'https://example.test/pulls/9', notes: 'merged' }),
      ev({ id: 'ev-mr', kind: 'manual_review', result: 'pass' }),
      ev({ id: 'ev-dep', kind: 'deployment', result: 'pass', environment: 'staging' }),
    ])
    expect(v.status).toBe('unverified')
    expect(v.approvals.map(a => a.id)).toEqual(['ev-pr', 'ev-mr'])
    expect(v.deployments.map(d => d.id)).toEqual(['ev-dep'])
    expect(v.basis).toEqual([])
  })

  it('verified needs passing observations with a code revision covering every target', () => {
    const noRev = deriveVerification(cs, [ev({ id: 'ev-1', code_revision: undefined })])
    expect(noRev.status).toBe('unverified')
    expect(noRev.ignored).toEqual([{ id: 'ev-1', reason: 'passing observation without code_revision' }])

    const partial = deriveVerification(cs, [ev({ id: 'ev-2', targets: ['ent-billing-retry-worker'] })])
    expect(partial.status).toBe('partial')
    expect(partial.uncovered).toEqual(['rel-billing-api-publishes-retries'])

    const whole = deriveVerification(cs, [ev({ id: 'ev-3' })]) // no targets = whole change set
    expect(whole.status).toBe('verified')
    expect(whole.basis).toEqual(['ev-3'])
    expect(whole.covered.sort()).toEqual(targetsOf(cs).sort())

    const combined = deriveVerification(cs, [
      ev({ id: 'ev-4', targets: ['ent-billing-retry-worker'] }),
      ev({ id: 'ev-5', kind: 'runtime_observation', targets: ['rel-billing-api-publishes-retries'] }),
    ])
    expect(combined.status).toBe('verified')
    expect(combined.basis).toEqual(['ev-4', 'ev-5'])
  })

  it('any applicable failing observation wins; amendments retract; inconclusive is ignored', () => {
    const failed = deriveVerification(cs, [ev({ id: 'ev-ok' }), ev({ id: 'ev-bad', result: 'fail' })])
    expect(failed.status).toBe('failed')
    expect(failed.failing).toEqual(['ev-bad'])

    const amended = deriveVerification(cs, [ev({ id: 'ev-ok' }), ev({ id: 'ev-bad', result: 'fail' }), ev({ id: 'ev-fix', result: 'inconclusive', amends: 'ev-bad', notes: 'flaky runner' })])
    expect(amended.status).toBe('verified')
    expect(amended.ignored).toEqual(expect.arrayContaining([{ id: 'ev-bad', reason: 'amended by a later record' }, { id: 'ev-fix', reason: 'inconclusive' }]))
  })

  it('qualifies by environment: agnostic records count everywhere, others only in their environment', () => {
    const records = [ev({ id: 'ev-stg', environment: 'staging' }), ev({ id: 'ev-any', targets: ['ent-billing-retry-worker'] })]
    expect(deriveVerification(cs, records).status).toBe('verified')
    expect(deriveVerification(cs, records, { environment: 'staging' }).status).toBe('verified')
    const prod = deriveVerification(cs, records, { environment: 'production' })
    expect(prod.status).toBe('partial')
    expect(prod.ignored).toEqual([{ id: 'ev-stg', reason: 'environment staging is not production' }])
  })

  it('honours stricter policies', () => {
    const records = [ev({ id: 'ev-t' })]
    expect(deriveVerification(cs, records, { requireKinds: ['runtime_observation'] }).status).toBe('partial')
    expect(deriveVerification(cs, records, { requireApproval: true }).status).toBe('partial')
    expect(deriveVerification(cs, [...records, ev({ id: 'ev-a', kind: 'manual_review' })], { requireApproval: true }).status).toBe('verified')
  })

  it('ignores evidence aimed at entities the change set does not operate on', () => {
    const v = deriveVerification(cs, [ev({ id: 'ev-ui', targets: ['ent-invoice-ui'] })])
    expect(v.status).toBe('unverified')
    expect(v.ignored[0]!.reason).toMatch(/not operated on by CHG-042: ent-invoice-ui/)
  })

  it('parses evidence files strictly', () => {
    expect(() => parseEvidenceFile('change_id: CHG-1\nevidence:\n  - id: ev-1\n    kind: vibes\n', 'e.yaml')).toThrow(EvidenceError)
    expect(() => parseEvidenceFile('change_id: CHG-1\nevidence:\n  - id: ev-1\n    kind: test\n    result: pass\n    source_ref: x\n    observed_at: 2026-01-01T00:00:00Z\n    recorded_by: me\n  - id: ev-1\n    kind: test\n    result: pass\n    source_ref: x\n    observed_at: 2026-01-01T00:00:00Z\n    recorded_by: me\n', 'e.yaml')).toThrow(/duplicate evidence id/)
  })
})

describe('recordEvidence and ledger integration', () => {
  let fx: Fixture
  beforeAll(async () => { fx = await makeRepo() })
  afterAll(async () => { await fx.cleanup() })

  it('the example evidence file is read and derived at load', async () => {
    const ledger = await Ledger.load(fx.dir)
    const r37 = ledger.get('CHG-037')!
    expect(r37.evidence.map(e => e.id)).toEqual(['ev-037-ci', 'ev-037-review'])
    // ev-037-ci has no targets: covers the whole change set, incl. the removed legacy exporter.
    expect(r37.verification.status).toBe('verified')
    expect(r37.verification.approvals).toHaveLength(1)
    expect(ledger.get('CHG-042')!.verification.status).toBe('unverified')
    expect(ledger.verificationOf('CHG-037', { environment: 'production' })!.status).toBe('unverified')
  })

  it('refuses evidence for unknown change sets or uninvolved targets; warns on non-target participants', async () => {
    await expect(recordEvidence(fx.dir, 'CHG-999', ev({ id: 'ev-1' }), { actor: 'ci' })).rejects.toThrow(/not in the ledger/)
    await expect(recordEvidence(fx.dir, 'CHG-042', ev({ id: 'ev-1', targets: ['ent-ledger-db'] }), { actor: 'ci' })).rejects.toThrow(/not involved in CHG-042/)
    await expect(recordEvidence(fx.dir, 'CHG-042', { id: 'bad id', kind: 'test' }, { actor: 'ci' })).rejects.toThrow(EvidenceError)
    expect((await fx.git.exec(['status', '--porcelain'])).trim()).toBe('')
  })

  it('AT-06 end to end: a merged PR is recorded, nothing becomes verified; a test run then verifies; AT-04 snapshots hold', async () => {
    const head = await fx.git.headSha()
    const pr = await recordEvidence(fx.dir, 'CHG-042', {
      id: 'ev-042-pr', kind: 'code_review', result: 'pass', source_ref: 'https://example.test/pulls/501',
      observed_at: '2026-04-10T09:00:00Z', recorded_by: 'reviewer-2', notes: 'merged to main',
    }, { actor: 'reviewer-2', expectedRevision: head!, date: '2026-04-10T09:05:00Z' })
    expect(pr.path).toBe('evidence/CHG-042.yaml')
    let ledger = await Ledger.load(fx.dir)
    expect(ledger.get('CHG-042')!.verification.status).toBe('unverified')
    expect(ledger.get('CHG-042')!.evidenceCommits.map(c => c.sha)).toEqual([pr.sha])

    const ui = await recordEvidence(fx.dir, 'CHG-042', {
      id: 'ev-042-ui', kind: 'manual_review', result: 'pass', targets: ['ent-invoice-ui'], source_ref: 'https://example.test/qa/77',
      observed_at: '2026-04-10T10:00:00Z', recorded_by: 'qa',
    }, { actor: 'qa', date: '2026-04-10T10:05:00Z' })
    expect(ui.warnings[0]).toMatch(/participant of CHG-042 but not an operation target/)

    const test = await recordEvidence(fx.dir, 'CHG-042', {
      id: 'ev-042-ci', kind: 'test', result: 'pass', source_ref: 'https://ci.example.test/runs/9912', code_revision: '3f2a1c9',
      environment: 'staging', observed_at: '2026-04-11T12:00:00Z', recorded_by: 'ci-agent',
    }, { actor: 'ci-agent', date: '2026-04-11T12:05:00Z' })
    const [c] = await fx.git.log({ rev: test.sha, paths: [test.path] })
    expect(c!.subject).toBe('evidence CHG-042: test pass in staging')
    expect(c!.body).toContain('Evidence-Id: ev-042-ci')

    ledger = await Ledger.load(fx.dir)
    const v = ledger.get('CHG-042')!.verification
    expect(v.status).toBe('verified')
    expect(v.basis).toEqual(['ev-042-ci'])
    expect(v.approvals.map(a => a.id)).toEqual(['ev-042-pr'])
    expect(v.ignored).toEqual([{ id: 'ev-042-ui', reason: 'targets not operated on by CHG-042: ent-invoice-ui' }])
    expect(ledger.verificationOf('CHG-042', { environment: 'production' })!.status).toBe('unverified')

    // Story carries the derived status and can expand the evidence; the earlier snapshot shows none of it.
    const now = await storyOf(fx.dir, { entity: 'ent-billing-api', include: ['evidence'] })
    expect(now.entries[0]!.verification).toMatchObject({ status: 'verified', environment: 'any', basis: ['ev-042-ci'] })
    expect(now.entries[0]!.evidence!.records).toHaveLength(3)
    const prodView = await storyOf(fx.dir, { entity: 'ent-billing-api', environment: 'production' })
    expect(prodView.entries[0]!.verification).toMatchObject({ status: 'unverified', environment: 'production' })
    const then = await storyOf(fx.dir, { entity: 'ent-billing-api', revision: pr.sha, include: ['evidence'] })
    expect(then.entries[0]!.verification.status).toBe('unverified')
    expect(then.entries[0]!.evidence!.records.map(r => r.id)).toEqual(['ev-042-pr'])
    const before = await storyOf(fx.dir, { entity: 'ent-billing-api', revision: head! })
    expect(before.entries[0]!.verification.status).toBe('unverified')

    const text = formatStory(now)
    expect(text).toContain('# Story of ent-billing-api (billing.billing_api)')
    expect(text).toContain('**CHG-042** Add asynchronous billing retries — 2026-02-10 — accepted / in_progress / verified')
    expect(text).toContain('verified by: ev-042-ci')
  })

  it('amendments append rather than rewrite; the prior claim stays in the file and in git', async () => {
    await recordEvidence(fx.dir, 'CHG-042', {
      id: 'ev-042-fail', kind: 'test', result: 'fail', source_ref: 'https://ci.example.test/runs/9950', code_revision: '3f2a1c9',
      observed_at: '2026-04-12T12:00:00Z', recorded_by: 'ci-agent',
    }, { actor: 'ci-agent', date: '2026-04-12T12:05:00Z' })
    expect((await Ledger.load(fx.dir)).get('CHG-042')!.verification.status).toBe('failed')
    await expect(recordEvidence(fx.dir, 'CHG-042', ev({ id: 'ev-042-fix', amends: 'ev-nope' }), { actor: 'ci' })).rejects.toThrow(/amends unknown record/)
    await recordEvidence(fx.dir, 'CHG-042', {
      id: 'ev-042-fix', kind: 'test', result: 'inconclusive', amends: 'ev-042-fail', source_ref: 'https://ci.example.test/runs/9950',
      observed_at: '2026-04-12T13:00:00Z', recorded_by: 'ci-agent', notes: 'runner out of disk; not a product failure',
    }, { actor: 'ci-agent', date: '2026-04-12T13:05:00Z' })
    const ledger = await Ledger.load(fx.dir)
    const r = ledger.get('CHG-042')!
    expect(r.verification.status).toBe('verified')
    expect(r.evidence.map(e => e.id)).toContain('ev-042-fail')
    expect(r.evidenceCommits).toHaveLength(5)
  })
})
