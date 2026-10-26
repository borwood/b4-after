import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { qualifyBaseline } from '../src/qualify.js'
import { formatQualification } from '../src/format.js'
import { recordEvidence } from '../src/evidence.js'
import { setDisposition } from '../src/propose.js'
import { promoteChangeSet } from '../src/promote.js'
import { renderProjection } from '../src/render.js'
import { loadModel } from '../src/model.js'
import { IdentityRegistry } from '../src/identity.js'
import { makeRepo, type Fixture } from './fixture.js'

let fx: Fixture
beforeAll(async () => { fx = await makeRepo() })
afterAll(async () => { await fx.cleanup() })

describe('qualifyBaseline', () => {
  it('annotates every baseline entity with the verification of the promoted change set that last operated on it', async () => {
    const q = await qualifyBaseline(fx.dir)
    expect(q.environment).toBe('any')
    // CHG-037 (pre-ledger promoted, verified by ev-037-ci) operated on ledger_db and its relationship.
    expect(q.entities.get('ent-ledger-db')).toMatchObject({ status: 'verified', changeId: 'CHG-037', basis: ['ev-037-ci'] })
    expect(q.entities.get('rel-charges-persist-ledger-db')).toMatchObject({ status: 'verified', changeId: 'CHG-037' })
    // Everything else has no promoted change set behind it.
    expect(q.entities.get('ent-billing-api')).toMatchObject({ status: 'unrecorded', changeId: null })
    expect(q.counts).toEqual({ verified: 2, partial: 0, failed: 0, unverified: 0, unrecorded: 9 })

    // Rendering: tags added to the spec, entities tagged and recoloured, model still valid.
    expect(q.data.specification.tags.verified).toEqual({ color: '#15803d' })
    expect(q.model.element('billing.ledger_db').isTagged('verified')).toBe(true)
    expect(q.model.element('billing.ledger_db').$element.style).toMatchObject({ color: 'green' })
    expect(q.model.element('billing.billing_api').isTagged('unrecorded')).toBe(true)
    const dsl = await renderProjection(q, { format: 'dsl' })
    expect(dsl.format === 'dsl' && dsl.dsl).toMatch(/tag verified \{\s*color #15803d/)

    const text = formatQualification(q)
    expect(text.split('\n')[0]).toMatch(/^# Evidence-qualified baseline \(any, [0-9a-f]{7}\)/)
    expect(text).toContain('verified: 2, unrecorded: 9')
    expect(text).toContain('- verified   ent-ledger-db (billing.ledger_db) via CHG-037')
  })

  it('environment-specific and historical qualification', async () => {
    const prod = await qualifyBaseline(fx.dir, { environment: 'production', highlight: false })
    expect(prod.entities.get('ent-ledger-db')).toMatchObject({ status: 'unverified', changeId: 'CHG-037' })
    expect(prod.model.element('billing.ledger_db').isTagged('verified')).toBe(false)

    // After promoting CHG-042 and recording a failing test, its entities show as failed; the earlier revision does not.
    const before = await fx.git.headSha()
    await promoteChangeSet(fx.dir, 'CHG-042', { actor: 'agent', date: '2026-04-20T10:00:00Z' })
    await recordEvidence(fx.dir, 'CHG-042', {
      id: 'ev-042-smoke', kind: 'runtime_observation', result: 'fail', source_ref: 'https://obs.example.test/alerts/3',
      code_revision: '9f9f9f9', environment: 'staging', observed_at: '2026-04-21T10:00:00Z', recorded_by: 'observer',
    }, { actor: 'observer', date: '2026-04-21T10:05:00Z' })

    const now = await qualifyBaseline(fx.dir, { environment: 'staging' })
    expect(now.entities.get('ent-billing-retry-worker')).toMatchObject({ status: 'failed', changeId: 'CHG-042', basis: ['ev-042-smoke'] })
    expect(now.entities.get('rel-billing-api-publishes-retries')!.status).toBe('failed')
    expect(now.model.element('billing.retry_worker').$element.style).toMatchObject({ color: 'red' })
    // The endpoint billing_api was not operated on by CHG-042: still unrecorded.
    expect(now.entities.get('ent-billing-api')!.status).toBe('unrecorded')

    const then = await qualifyBaseline(fx.dir, { revision: before! })
    expect(then.entities.has('ent-billing-retry-worker')).toBe(false)
    expect(then.counts.failed).toBe(0)
    const reg = IdentityRegistry.fromModel((await loadModel(fx.dir, { revision: before! })).model)
    expect(reg.element('ent-billing-retry-worker')).toBeUndefined()
  })

  it('setDisposition remains usable on unpromoted change sets while evidence accrues', async () => {
    await setDisposition(fx.dir, 'CHG-043', 'proposed', { actor: 'reviewer' })
    const q = await qualifyBaseline(fx.dir, { highlight: false })
    expect(q.entities.get('ent-payment-gateway')!.status).toBe('unrecorded') // CHG-043 is not promoted
  })
})
