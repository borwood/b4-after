// Lineage pointers and "ever" subtree membership, on top of promote so the history is real.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { proposeChangeSet, setDisposition } from '../src/propose.js'
import { promoteChangeSet } from '../src/promote.js'
import { recordEvidence } from '../src/evidence.js'
import { reconcileBaseline } from '../src/reconcile.js'
import { storyOf } from '../src/story.js'
import { formatStory } from '../src/format.js'
import { validateChangeSet } from '../src/validate.js'
import { participantsOf } from '../src/ledger.js'
import { ChangeSet } from '../src/schema.js'
import { loadModel } from '../src/model.js'
import { IdentityRegistry } from '../src/identity.js'
import { makeRepo, type Fixture } from './fixture.js'

let fx: Fixture
beforeAll(async () => { fx = await makeRepo() })
afterAll(async () => { await fx.cleanup() })

const actor = 'agent'
const land = async (cs: object, date: string) => {
  const r = await proposeChangeSet(fx.dir, cs, { actor, date })
  await setDisposition(fx.dir, r.changeSet.id, 'accepted', { actor: 'reviewer', date })
  return promoteChangeSet(fx.dir, r.changeSet.id, { actor, date })
}

describe('lineage', () => {
  it('participantsOf exposes derived_from and succeeded_by as lineage, not operations', () => {
    const cs = ChangeSet.parse({
      id: 'CHG-1', title: 't', intent: 'i', operations: [
        { op: 'add_element', id: 'ent-b', parent: null, name: 'b', kind: 'system', derived_from: ['ent-a'] },
        { op: 'remove_element', id: 'ent-a', succeeded_by: ['ent-b'] },
      ],
    })
    expect(participantsOf(cs)).toEqual([
      { entityId: 'ent-b', entityType: 'element', role: 'added', via: 'operation', op: 'add_element' },
      { entityId: 'ent-a', entityType: 'element', role: 'derived_from', via: 'lineage', op: 'add_element', lineageOf: 'ent-b' },
      { entityId: 'ent-a', entityType: 'element', role: 'removed', via: 'operation', op: 'remove_element' },
      { entityId: 'ent-b', entityType: 'element', role: 'succeeded_by', via: 'lineage', op: 'remove_element', lineageOf: 'ent-a' },
    ])
  })

  it('validation checks lineage ids without inventing edges', async () => {
    const registry = IdentityRegistry.fromModel((await loadModel(fx.dir)).model)
    const r = validateChangeSet({
      id: 'CHG-2', title: 't', intent: 'i', operations: [
        { op: 'add_element', id: 'ent-x', parent: 'ent-billing', name: 'x', kind: 'component', derived_from: ['ent-x', 'ent-ghost', 'ent-ledger-db'] },
        { op: 'remove_element', id: 'ent-ledger-db', succeeded_by: ['ent-x', 'ent-later'] },
      ],
    }, { registry })
    expect(r.issues.map(i => `${i.code}@${i.path}`)).toEqual([
      'E_SELF_LINEAGE@/operations/0/derived_from/0',
      'E_UNKNOWN_ENTITY@/operations/0/derived_from/1',
      'W_UNKNOWN_SUCCESSOR@/operations/1/succeeded_by/1',
    ])
    // Lineage never becomes an edge: the projection has no relationship between x and ledger_db.
  })

  it('a split keeps both sides findable through story, one hop, with the roles intact', async () => {
    // Split charges into authorisation + capture; remove the original; record lineage both ways.
    await land({
      id: 'CHG-060', title: 'Split charges handler', intent: 'Separate authorisation from capture',
      operations: [
        { op: 'add_element', id: 'ent-authorize', parent: 'ent-billing-api', name: 'authorize', kind: 'component', title: 'Authorisation', derived_from: ['ent-charges'] },
        { op: 'add_element', id: 'ent-capture', parent: 'ent-billing-api', name: 'capture', kind: 'component', title: 'Capture', derived_from: ['ent-charges'] },
        { op: 'add_relationship', id: 'rel-capture-persists', from: 'ent-capture', to: 'ent-ledger-db', kind: 'writes_to' },
        { op: 'remove_element', id: 'ent-charges', succeeded_by: ['ent-authorize', 'ent-capture'] },
      ],
    }, '2026-05-01T10:00:00Z')

    // Until the split is verified, the original still exists and says so; the new halves are intended.
    const retiring = IdentityRegistry.fromModel((await loadModel(fx.dir)).model)
    expect(retiring.model.element('billing.billing_api.charges').isTagged('b4-retiring')).toBe(true)
    expect(retiring.model.element('billing.billing_api.capture').isTagged('b4-intended')).toBe(true)
    await recordEvidence(fx.dir, 'CHG-060', {
      id: 'ev-060-ci', kind: 'test', result: 'pass', source_ref: 'https://ci/60', code_revision: 'c0ffee1', observed_at: '2026-05-01T12:00:00Z', recorded_by: 'ci',
    }, { actor: 'ci', date: '2026-05-01T12:05:00Z' })
    const rec = await reconcileBaseline(fx.dir, { actor: 'ci', date: '2026-05-01T12:06:00Z' })
    expect(rec.applied).toEqual([{ changeId: 'CHG-060', entityId: 'ent-charges', op: 'remove_element' }])

    const old = await storyOf(fx.dir, { entity: 'ent-charges' })
    expect(old.subject.resolved).toBeNull() // gone from the model, story intact (AT-07)
    const e = old.entries.find(x => x.changeId === 'CHG-060')!
    expect(e.matched.map(m => `${m.role}${m.lineageOf ? '<' + m.lineageOf : ''}`)).toEqual([
      'derived_from<ent-authorize', 'derived_from<ent-capture', 'removed',
    ])
    expect(e.others.map(o => `${o.entityId}:${o.role}`)).toEqual(expect.arrayContaining(['ent-authorize:added', 'ent-capture:added', 'ent-authorize:succeeded_by', 'ent-capture:succeeded_by']))

    const cap = await storyOf(fx.dir, { entity: 'ent-capture' })
    expect(cap.entries.map(x => x.changeId)).toEqual(['CHG-060'])
    // added, plus its attached relationship (both the relationship itself and the endpoint role), plus lineage.
    expect(cap.entries[0]!.matched.map(m => m.role)).toEqual(['added', 'relationship_added', 'relationship_source', 'succeeded_by'])
    // No recursion: the capture story does not carry the charges story, just the pointer.
    expect(cap.entries[0]!.others.some(o => o.entityId === 'ent-charges' && o.role === 'derived_from' && o.lineageOf === 'ent-capture')).toBe(true)
  })
})

describe('subtree membership: current vs ever', () => {
  it('ever includes entities a promoted change set placed under the subtree even after they moved out', async () => {
    // retry worker lands under billing (CHG-042 is accepted; CHG-037 is pre-ledger promoted), then moves to the root.
    await promoteChangeSet(fx.dir, 'CHG-042', { actor, date: '2026-05-02T10:00:00Z' })
    await land({
      id: 'CHG-061', title: 'Extract retry worker', intent: 'Run retries as a standalone system',
      operations: [{ op: 'move_element', id: 'ent-billing-retry-worker', parent: null, name: 'retry_worker' }],
    }, '2026-05-03T10:00:00Z')
    const reg = IdentityRegistry.fromModel((await loadModel(fx.dir)).model)
    expect(reg.element('ent-billing-retry-worker')!.fqn).toBe('retry_worker')

    const current = await storyOf(fx.dir, { entity: 'ent-billing', subtree: true })
    expect(current.subject.membership).toBe('descendants_at_snapshot')
    expect(current.subject.members).not.toContain('ent-billing-retry-worker')
    // CHG-042 still appears (it touched ent-billing-api as an endpoint). CHG-043 does not: it only
    // touched a relationship of ent-charges, which no longer exists at this snapshot.
    expect(current.entries.map(e => e.changeId)).toEqual(['CHG-037', 'CHG-042', 'CHG-060'])

    const ever = await storyOf(fx.dir, { entity: 'ent-billing', subtree: true, membership: 'ever' })
    expect(ever.subject.membership).toBe('ever_recorded')
    expect(ever.subject.historicalMembers).toEqual(['ent-billing-retry-worker'])
    // The worker's relationship, added by CHG-042, is attached through the ledger even though the worker moved out.
    expect(ever.subject.attachedRelationships).toContain('rel-billing-api-publishes-retries')
    expect(ever.entries.map(e => e.changeId)).toEqual(['CHG-037', 'CHG-042', 'CHG-060', 'CHG-061'])
    const c61 = ever.entries.at(-1)!
    expect(c61.matched.map(m => `${m.entityId}:${m.role}`)).toEqual(['ent-billing-retry-worker:moved'])
    expect(formatStory(ever)).toContain('incl. 1 historical')

    // "ever" for a removed container works from history alone.
    const gone = await storyOf(fx.dir, { entity: 'ent-charges', subtree: true, membership: 'ever' })
    expect(gone.subject.resolved).toBeNull()
    expect(gone.warnings).toContain('entity is not in the model at this snapshot; membership derived from ledger history only')
    // CHG-043 touched rel-charges-cards, a pre-ledger relationship: not derivable from history (documented limitation).
    expect(gone.entries.map(e => e.changeId)).toEqual(['CHG-037', 'CHG-060'])
  })
})
