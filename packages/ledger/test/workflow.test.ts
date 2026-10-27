// End-to-end Phase C: propose -> accept -> promote -> story/projection reflect the new baseline.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { proposeChangeSet, setDisposition, ProposalRejected } from '../src/propose.js'
import { promoteChangeSet, PromotionRefused } from '../src/promote.js'
import { projectModel } from '../src/projection.js'
import { storyOf } from '../src/story.js'
import { Ledger } from '../src/ledger.js'
import { loadModel } from '../src/model.js'
import { IdentityRegistry } from '../src/identity.js'
import { provenanceOf } from '../src/provenance.js'
import { makeRepo, type Fixture } from './fixture.js'

let fx: Fixture
beforeAll(async () => { fx = await makeRepo() })
afterAll(async () => { await fx.cleanup() })

const actor = 'implementation-agent'

describe('propose', () => {
  it('rejects an invalid proposal and writes nothing', async () => {
    const head = await fx.git.headSha()
    await expect(proposeChangeSet(fx.dir, {
      id: 'CHG-050', title: 'bad', intent: 'i',
      operations: [{ op: 'remove_element', id: 'ent-nope' }],
    }, { actor })).rejects.toThrow(ProposalRejected)
    expect(await fx.git.headSha()).toBe(head)
    expect((await fx.git.exec(['status', '--porcelain'])).trim()).toBe('')
  })

  it('refuses governance dispositions and stale base revisions', async () => {
    await expect(proposeChangeSet(fx.dir, { id: 'CHG-051', title: 't', intent: 'i', disposition: 'accepted' }, { actor }))
      .rejects.toThrow(/must be draft or proposed/)
    await expect(proposeChangeSet(fx.dir, { id: 'CHG-051', title: 't', intent: 'i' }, { actor, expectedBaseRevision: fx.shas.stage1 }))
      .rejects.toThrow(/repository moved/)
  })

  it('records a valid proposal with provenance, then a revision of it', async () => {
    const head = await fx.git.headSha()
    const r = await proposeChangeSet(fx.dir, {
      id: 'CHG-052', title: 'Cache invoices', intent: 'Serve invoice reads from a cache',
      sources: [{ ref: 'REQ-300', role: 'requirement' }],
      operations: [{ op: 'add_element', id: 'ent-invoice-cache', parent: 'ent-billing', name: 'invoice_cache', kind: 'datastore', title: 'Invoice Cache' }],
    }, { actor, expectedBaseRevision: head!, date: '2026-04-02T10:00:00Z' })
    expect(r.revised).toBe(false)
    expect(r.changeSet.disposition).toBe('proposed')
    const [c] = await fx.git.log({ rev: r.record.sha, paths: [r.record.path] })
    expect(c!.subject).toBe('propose CHG-052: Cache invoices')
    expect(provenanceOf(c!.body)).toMatchObject({ changeId: 'CHG-052', origin: 'REQ-300', actor })

    const r2 = await proposeChangeSet(fx.dir, {
      id: 'CHG-052', title: 'Cache invoices', intent: 'Serve invoice reads from a cache',
      sources: [{ ref: 'REQ-300', role: 'requirement' }],
      operations: [
        { op: 'add_element', id: 'ent-invoice-cache', parent: 'ent-billing', name: 'invoice_cache', kind: 'datastore', title: 'Invoice Cache', technology: 'Redis' },
        { op: 'add_relationship', id: 'rel-ui-reads-cache', from: 'ent-invoice-ui', to: 'ent-invoice-cache', kind: 'uses' },
      ],
    }, { actor, date: '2026-04-03T10:00:00Z' })
    expect(r2.revised).toBe(true)
    const ledger = await Ledger.load(fx.dir)
    expect(ledger.get('CHG-052')!.commits).toHaveLength(2)
  })
})

describe('promote', () => {
  it('refuses non-accepted, unpromoted-dependency, and uncommitted cases without touching the baseline', async () => {
    const before = await readFile(join(fx.dir, 'model', 'model.c4'), 'utf8')
    await expect(promoteChangeSet(fx.dir, 'CHG-043', { actor })).rejects.toThrow(/is rejected; promotion requires one of: accepted/)
    await expect(promoteChangeSet(fx.dir, 'CHG-052', { actor })).rejects.toThrow(/is proposed/)
    // CHG-037 carries a pre-ledger promotion record: already in the baseline.
    const e = await promoteChangeSet(fx.dir, 'CHG-037', { actor }).catch(e => e)
    expect(e).toBeInstanceOf(PromotionRefused)
    expect(e.message).toMatch(/already promoted/)
    // A proposal depending on an unpromoted change set cannot be promoted.
    await proposeChangeSet(fx.dir, {
      id: 'CHG-054', title: 'Depends on rejected', intent: 'i', depends_on: ['CHG-043'],
      operations: [{ op: 'update_element', id: 'ent-customer', set: { title: 'Payer' } }],
    }, { actor, date: '2026-04-01T09:00:00Z' })
    await setDisposition(fx.dir, 'CHG-054', 'accepted', { actor: 'reviewer', date: '2026-04-01T09:30:00Z' })
    await expect(promoteChangeSet(fx.dir, 'CHG-054', { actor })).rejects.toThrow(/depends on CHG-043, which is not promoted yet/)
    expect(await readFile(join(fx.dir, 'model', 'model.c4'), 'utf8')).toBe(before)
  })

  it('promotes an accepted change set: regenerates the model, records promotion, keeps every stable id', async () => {
    // Promote CHG-052 (no dependencies). Accept it first.
    await setDisposition(fx.dir, 'CHG-052', 'accepted', { actor: 'reviewer', date: '2026-04-04T10:00:00Z' })
    const head = await fx.git.headSha()
    const res = await promoteChangeSet(fx.dir, 'CHG-052', { actor, expectedHead: head!, date: '2026-04-05T10:00:00Z' })
    expect(res.baseline).toBe(head)
    expect(res.added.sort()).toEqual(['ent-invoice-cache', 'rel-ui-reads-cache'])

    // Model directory now holds only the generated files; hand-written views and specs are gone.
    expect((await readdir(join(fx.dir, 'model'))).sort()).toEqual(['model.c4', 'views.c4'])
    const loaded = await loadModel(fx.dir)
    expect(loaded.errors).toEqual([])
    const reg = IdentityRegistry.fromModel(loaded.model)
    expect(reg.problems).toEqual([])
    expect(reg.element('ent-invoice-cache')!.fqn).toBe('billing.invoice_cache')
    expect(reg.relationship('rel-ui-reads-cache')!.toFqn).toBe('billing.invoice_cache')
    expect(reg.element('ent-charges')!.fqn).toBe('billing.billing_api.charges') // pre-existing ids survived regeneration
    const views = [...loaded.model.views()].map(v => v.id)
    expect(views).toEqual(expect.arrayContaining(['index', 'index--target', 'everything', 'el--billing', 'el--billing--target', 'el--billing--billing_api', 'tag--external']))
    // Unverified additions are intended: present, marked, excluded from the As-is views.
    expect(loaded.model.element('billing.invoice_cache').isTagged('b4-intended')).toBe(true)
    expect([...loaded.model.view('el--billing').nodes()].map(n => n.id)).not.toContain('billing.invoice_cache')
    expect([...loaded.model.view('el--billing--target').nodes()].map(n => n.id)).toContain('billing.invoice_cache')

    // One commit carrying both files, with provenance.
    const [c] = await fx.git.log({ rev: res.sha })
    expect(c!.sha).toBe(res.sha)
    expect(c!.files.sort()).toEqual(['changes/CHG-052.yaml', 'model/model.c4', 'model/specs.c4', 'model/views.c4'])
    expect(c!.subject).toBe('promote CHG-052: Cache invoices')
    expect(provenanceOf(c!.body)).toMatchObject({ changeId: 'CHG-052', disposition: 'accepted' })
    expect(c!.body).toContain(`Promoted-From: ${head}`)

    const ledger = await Ledger.load(fx.dir)
    expect(ledger.get('CHG-052')!.changeSet.promotion).toEqual({ at: '2026-04-05T10:00:00Z', baseline: head, actor })
  })

  it('a promoted change set is frozen and excluded from projections; its story still reads', async () => {
    await expect(promoteChangeSet(fx.dir, 'CHG-052', { actor })).rejects.toThrow(/already promoted/)
    await expect(setDisposition(fx.dir, 'CHG-052', 'rejected', { actor })).rejects.toThrow(/frozen/)
    await expect(proposeChangeSet(fx.dir, { id: 'CHG-052', title: 't', intent: 'i' }, { actor })).rejects.toThrow(/can no longer be revised/)
    const err = await projectModel(fx.dir, { includeChanges: ['CHG-052'] }).catch(e => e)
    expect(err.issues[0].code).toBe('E_ALREADY_PROMOTED')

    const story = await storyOf(fx.dir, { entity: 'ent-invoice-cache', include: ['commits'] })
    expect(story.subject.resolved).toEqual({ stableId: 'ent-invoice-cache', fqn: 'billing.invoice_cache', type: 'element' })
    expect(story.entries.map(e => e.changeId)).toEqual(['CHG-052'])
    expect(story.entries[0]!.commits.map(c => c.subject)).toEqual([
      'promote CHG-052: Cache invoices', 'accept CHG-052: Cache invoices', 'propose CHG-052: Cache invoices', 'propose CHG-052: Cache invoices',
    ])

    // A follow-up that depends on the promoted change projects cleanly on the new baseline.
    const follow = await proposeChangeSet(fx.dir, {
      id: 'CHG-053', title: 'Warm cache', intent: 'i', depends_on: ['CHG-052'],
      operations: [{ op: 'update_element', id: 'ent-invoice-cache', set: { technology: 'Redis 7' } }],
    }, { actor })
    expect(follow.validation.ok).toBe(true)
    const p = await projectModel(fx.dir, { includeChanges: ['CHG-053'] })
    expect(p.model.element('billing.invoice_cache').technology).toBe('Redis 7')

    // CHG-042 (accepted, depends on the pre-ledger CHG-037) promotes onto the regenerated baseline.
    const res = await promoteChangeSet(fx.dir, 'CHG-042', { actor, date: '2026-04-06T10:00:00Z' })
    expect(res.added.sort()).toEqual(['ent-billing-retry-worker', 'rel-billing-api-publishes-retries'])
    const reg = IdentityRegistry.fromModel((await loadModel(fx.dir)).model)
    expect(reg.element('ent-billing-retry-worker')!.fqn).toBe('billing.retry_worker')
    expect(reg.element('ent-invoice-cache')!.fqn).toBe('billing.invoice_cache')
    expect(reg.problems).toEqual([])
  })

  it('history before the promotion still shows the pre-promotion baseline', async () => {
    const then = await storyOf(fx.dir, { entity: 'ent-invoice-cache', before: '2026-04-04T12:00:00Z' })
    expect(then.subject.resolved).toBeNull() // not in the model yet at that time
    expect(then.entries[0]).toMatchObject({ changeId: 'CHG-052', disposition: 'accepted' })
    expect(then.entries[0]!.commits).toHaveLength(1)
  })
})
