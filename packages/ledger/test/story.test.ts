import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { storyOf } from '../src/story.js'
import { Ledger } from '../src/ledger.js'
import { loadModel } from '../src/model.js'
import { IdentityRegistry } from '../src/identity.js'
import { makeRepo, type Fixture } from './fixture.js'

let fx: Fixture
let ledger: Ledger
let registry: IdentityRegistry
beforeAll(async () => {
  fx = await makeRepo()
  ledger = await Ledger.load(fx.dir)
  registry = IdentityRegistry.fromModel((await loadModel(fx.dir)).model)
})
afterAll(async () => { await fx.cleanup() })

const deps = () => ({ ledger, registry })

describe('storyOf', () => {
  it('AT-02: both endpoints of an added relationship see the change once, each explaining the other', async () => {
    const api = await storyOf(fx.dir, { entity: 'ent-billing-api' }, deps())
    expect(api.entries.map(e => e.changeId)).toEqual(['CHG-042'])
    const e = api.entries[0]!
    expect(e.matched).toEqual([
      expect.objectContaining({ entityId: 'ent-billing-api', role: 'relationship_source', via: 'relationship_endpoint', relationshipId: 'rel-billing-api-publishes-retries' }),
    ])
    expect(e.others.map(o => `${o.entityId}:${o.role}`)).toEqual([
      'ent-billing-retry-worker:added',
      'rel-billing-api-publishes-retries:relationship_added',
      'ent-billing-retry-worker:relationship_target',
      'ent-invoice-ui:relates_to',
    ])

    // The worker does not exist in the baseline yet; the ledger still knows its story.
    const worker = await storyOf(fx.dir, { entity: 'ent-billing-retry-worker' }, deps())
    expect(worker.subject.resolved).toBeNull()
    expect(worker.entries.map(e => e.changeId)).toEqual(['CHG-042'])
    expect(worker.entries[0]!.matched.map(m => m.role)).toEqual(['added', 'relationship_target'])
    expect(worker.entries[0]!.others.some(o => o.entityId === 'ent-billing-api' && o.role === 'relationship_source')).toBe(true)
  })

  it('AT-03: a non-mutating reference appears as relates_to and nothing else', async () => {
    const ui = await storyOf(fx.dir, { entity: 'ent-invoice-ui' }, deps())
    expect(ui.entries.map(e => e.changeId)).toEqual(['CHG-042'])
    expect(ui.entries[0]!.matched).toEqual([
      { entityId: 'ent-invoice-ui', entityType: 'element', role: 'relates_to', via: 'reference', reason: 'Failure and retry status is user-visible; model shape unchanged' },
    ])
    // Architectural representation unchanged: the model still has exactly its baseline relationships.
    expect(registry.element('ent-invoice-ui')!.fqn).toBe('billing.invoice_ui')
    expect(registry.relationships().filter(r => r.fromFqn === 'billing.invoice_ui' || r.toFqn === 'billing.invoice_ui').map(r => r.stableId).sort())
      .toEqual(['rel-customer-views-invoices', 'rel-invoice-ui-calls-billing-api'])
  })

  it('accepts a current FQN and resolves it to the stable id', async () => {
    const byFqn = await storyOf(fx.dir, { entity: 'billing.billing_api' }, deps())
    expect(byFqn.subject.resolved).toEqual({ stableId: 'ent-billing-api', fqn: 'billing.billing_api', type: 'element' })
    expect(byFqn.entries.map(e => e.changeId)).toEqual(['CHG-042'])
  })

  it('AT-04: a historical query returns the state as recorded at the cutoff', async () => {
    const now = await storyOf(fx.dir, { entity: 'ent-billing-api' }, deps())
    expect(now.entries[0]).toMatchObject({ disposition: 'accepted', implementation: 'in_progress' })

    const then = await storyOf(fx.dir, { entity: 'ent-billing-api', revision: fx.shas.stage2 })
    expect(then.snapshot).toMatchObject({ source: 'revision', revision: fx.shas.stage2, modelLoaded: true })
    expect(then.entries).toHaveLength(1)
    expect(then.entries[0]).toMatchObject({ changeId: 'CHG-042', disposition: 'proposed', implementation: 'not_started' })
    expect(then.entries[0]!.lastRecordedAt).toBe(then.entries[0]!.recordedAt)

    const byTime = await storyOf(fx.dir, { entity: 'ent-payment-gateway', before: '2026-02-28T00:00:00Z' })
    expect(byTime.entries).toEqual([]) // CHG-043 was recorded in March
    const later = await storyOf(fx.dir, { entity: 'ent-payment-gateway' }, deps())
    expect(later.entries.map(e => e.changeId)).toEqual(['CHG-043'])
    expect(later.entries[0]!.disposition).toBe('rejected') // rejected history stays inspectable (AT-05)
  })

  it('AT-07: an entity removed from the model keeps its story', async () => {
    const gone = await storyOf(fx.dir, { entity: 'ent-legacy-exporter' }, deps())
    expect(gone.subject.resolved).toBeNull()
    expect(gone.entries.map(e => e.changeId)).toEqual(['CHG-037'])
    expect(gone.entries[0]!.matched[0]).toMatchObject({ role: 'removed', via: 'operation' })
  })

  it('AT-09: a subtree story finds each intersecting change once with one-hop context only', async () => {
    const sub = await storyOf(fx.dir, { entity: 'ent-billing', subtree: true }, deps())
    expect(sub.subject.membership).toBe('descendants_at_snapshot')
    expect(sub.subject.members.sort()).toEqual(['ent-billing', 'ent-billing-api', 'ent-charges', 'ent-invoice-ui', 'ent-ledger-db'])
    expect(sub.subject.attachedRelationships.sort()).toEqual([
      'rel-charges-cards', 'rel-charges-persist-ledger-db', 'rel-customer-views-invoices', 'rel-invoice-ui-calls-billing-api',
    ])
    expect(sub.entries.map(e => e.changeId)).toEqual(['CHG-037', 'CHG-042', 'CHG-043'])
    const c37 = sub.entries[0]!
    // Several members matched (ledger_db added, the relationship, both endpoints); still one entry.
    expect(c37.matched.map(m => `${m.entityId}:${m.role}`)).toEqual([
      'ent-ledger-db:added',
      'rel-charges-persist-ledger-db:relationship_added',
      'ent-charges:relationship_source',
      'ent-ledger-db:relationship_target',
    ])
    expect(c37.others.map(o => `${o.entityId}:${o.role}`)).toEqual(['ent-legacy-exporter:removed'])
    // CHG-043 names no member element directly; it removes a relationship attached to ent-charges.
    const c43 = sub.entries[2]!
    expect(c43.matched.map(m => `${m.entityId}:${m.role}`)).toEqual(['rel-charges-cards:relationship_removed'])
    expect(c43.others.map(o => `${o.entityId}:${o.role}`)).toEqual(['ent-payment-gateway:removed'])
    // One hop only: the gateway's own history is not expanded.
    expect(Object.keys(c43)).not.toContain('story')
  })

  it('paginates with an explicit truncation indicator', async () => {
    const p1 = await storyOf(fx.dir, { entity: 'ent-billing', subtree: true, limit: 2 }, deps())
    expect(p1.total).toBe(3)
    expect(p1.entries.map(e => e.changeId)).toEqual(['CHG-037', 'CHG-042'])
    expect(p1.truncated).toBe(true)
    const p2 = await storyOf(fx.dir, { entity: 'ent-billing', subtree: true, limit: 2, cursor: p1.nextCursor }, deps())
    expect(p2.entries.map(e => e.changeId)).toEqual(['CHG-043'])
    expect(p2.truncated).toBe(false)
    expect(p2.nextCursor).toBeUndefined()
    await expect(storyOf(fx.dir, { entity: 'ent-billing', cursor: 'nope' }, deps())).rejects.toThrow(/cursor/)
  })

  it('honours include and always carries at least the latest commit', async () => {
    const lean = await storyOf(fx.dir, { entity: 'ent-billing-api', include: [] }, deps())
    const e = lean.entries[0]!
    expect(e.operations).toBeUndefined()
    expect(e.sources).toBeUndefined()
    expect(e.references).toBeUndefined()
    expect(e.commits).toHaveLength(1)
    const full = await storyOf(fx.dir, { entity: 'ent-billing-api', include: ['commits', 'sources'] }, deps())
    expect(full.entries[0]!.commits).toHaveLength(2)
    expect(full.entries[0]!.sources).toHaveLength(2)
  })

  it('returns an empty story for an unknown entity instead of guessing', async () => {
    const none = await storyOf(fx.dir, { entity: 'ent-does-not-exist' }, deps())
    expect(none.entries).toEqual([])
    expect(none.total).toBe(0)
    expect(none.subject.resolved).toBeNull()
  })
})
