import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { releaseTimeline, releasedBaseline, promotionCommitOf } from '../src/releases.js'
import { recordEvidence } from '../src/evidence.js'
import { promoteChangeSet } from '../src/promote.js'
import { proposeChangeSet, setDisposition } from '../src/propose.js'
import { Ledger } from '../src/ledger.js'
import { makeRepo, type Fixture } from './fixture.js'

let fx: Fixture
beforeAll(async () => { fx = await makeRepo() })
afterAll(async () => { await fx.cleanup() })

const dep = (id: string, env: string, result: 'pass' | 'fail', at: string, extra: Record<string, unknown> = {}) => ({
  id, kind: 'deployment', result, environment: env, source_ref: `https://deploy.example.test/${id}`, observed_at: at, recorded_by: 'cd', ...extra,
})

describe('release timeline and released baseline', () => {
  it('empty when nothing was deployed; says so instead of guessing', async () => {
    const ledger = await Ledger.load(fx.dir)
    expect(releaseTimeline(ledger)).toEqual([])
    const r = await releasedBaseline(fx.dir, { environment: 'staging', ledger })
    expect(r.deployment).toBeNull()
    expect(r.revision).toBeNull()
    expect(r.model).toBeNull()
    expect(r.warnings).toEqual(['no passing deployment to staging at or before ' + r.at])
  })

  it('a deployment of a promoted change set resolves to its promotion commit unless the record names a baseline', async () => {
    const promo = await promoteChangeSet(fx.dir, 'CHG-042', { actor: 'agent', date: '2026-05-01T10:00:00Z' })
    await recordEvidence(fx.dir, 'CHG-042', dep('ev-042-stg', 'staging', 'pass', '2026-05-02T10:00:00Z', { code_revision: 'c0ffee1' }), { actor: 'cd', date: '2026-05-02T10:05:00Z' })
    let ledger = await Ledger.load(fx.dir)
    expect(promotionCommitOf(ledger.get('CHG-042')!)).toBe(promo.sha)
    const t = releaseTimeline(ledger)
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({ changeId: 'CHG-042', environment: 'staging', result: 'pass', baselineRevision: promo.sha, baselineSource: 'promotion', promoted: true })

    const stg = await releasedBaseline(fx.dir, { environment: 'staging', ledger })
    expect(stg.revision).toBe(promo.sha)
    expect(stg.deployedChangeSets).toEqual(['CHG-042'])
    expect(stg.registry!.element('ent-billing-retry-worker')!.fqn).toBe('billing.retry_worker')
    expect(stg.warnings).toEqual([])

    // Production: nothing yet. Then an explicit baseline revision on the record wins over the promotion commit.
    const prodNone = await releasedBaseline(fx.dir, { environment: 'production', ledger, loadModel: false })
    expect(prodNone.revision).toBeNull()
    await recordEvidence(fx.dir, 'CHG-042', dep('ev-042-prod', 'production', 'pass', '2026-05-03T10:00:00Z', { baseline_revision: fx.shas.stage3 }), { actor: 'cd', date: '2026-05-03T10:05:00Z' })
    ledger = await Ledger.load(fx.dir)
    const prod = await releasedBaseline(fx.dir, { environment: 'production', ledger })
    expect(prod.deployment).toMatchObject({ evidenceId: 'ev-042-prod', baselineSource: 'record' })
    expect(prod.revision).toBe(fx.shas.stage3)
    // stage3 predates the promotion: the model there has no retry worker. The record said so; the tool reports it.
    expect(prod.registry!.element('ent-billing-retry-worker')).toBeUndefined()
  })

  it('time cutoff, failed attempts, and unpromoted deployments', async () => {
    // A later failed deploy to staging marks the change set failed; the released baseline keeps the last passing one.
    await recordEvidence(fx.dir, 'CHG-042', dep('ev-042-stg-2', 'staging', 'fail', '2026-05-04T10:00:00Z'), { actor: 'cd', date: '2026-05-04T10:05:00Z' })
    // An unpromoted change set gets deployed somewhere (it happens): visible, flagged.
    await proposeChangeSet(fx.dir, {
      id: 'CHG-070', title: 'Hotfix', intent: 'i', operations: [{ op: 'update_element', id: 'ent-invoice-ui', set: { technology: 'React 19' } }],
    }, { actor: 'agent', date: '2026-05-05T09:00:00Z' })
    await setDisposition(fx.dir, 'CHG-070', 'accepted', { actor: 'reviewer', date: '2026-05-05T09:30:00Z' })
    await recordEvidence(fx.dir, 'CHG-070', dep('ev-070-stg', 'staging', 'pass', '2026-05-05T10:00:00Z'), { actor: 'cd', date: '2026-05-05T10:05:00Z' })

    const ledger = await Ledger.load(fx.dir)
    expect(releaseTimeline(ledger, { environment: 'staging' }).map(e => `${e.evidenceId}:${e.result}`)).toEqual(['ev-042-stg:pass', 'ev-042-stg-2:fail', 'ev-070-stg:pass'])

    const now = await releasedBaseline(fx.dir, { environment: 'staging', ledger, loadModel: false })
    expect(now.failedChangeSets).toEqual(['CHG-042'])
    expect(now.deployedChangeSets).toEqual(['CHG-070'])
    // ev-070-stg has no baseline (unpromoted, no promotion commit); the baseline falls back to the last passing one that names a revision.
    expect(now.deployment!.evidenceId).toBe('ev-042-stg')
    expect(now.warnings).toEqual(['CHG-070 was deployed but is not promoted; the released baseline cannot include it'])

    const before = await releasedBaseline(fx.dir, { environment: 'staging', at: '2026-05-03T00:00:00Z', ledger, loadModel: false })
    expect(before.deployment!.evidenceId).toBe('ev-042-stg')
    expect(before.deployedChangeSets).toEqual(['CHG-042'])
    expect(before.failedChangeSets).toEqual([])
    const none = await releasedBaseline(fx.dir, { environment: 'staging', at: '2026-05-01T00:00:00Z', ledger, loadModel: false })
    expect(none.deployment).toBeNull()
  })
})
