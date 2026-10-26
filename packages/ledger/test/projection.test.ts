import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { projectModel, applyChangeSets, ProjectionError, CANDIDATE_TAG } from '../src/projection.js'
import { renderProjection, materializeProjection } from '../src/render.js'
import { loadModel } from '../src/model.js'
import { Ledger } from '../src/ledger.js'
import { IdentityRegistry } from '../src/identity.js'
import { ChangeSet } from '../src/schema.js'
import { makeRepo, type Fixture } from './fixture.js'

let fx: Fixture
beforeAll(async () => { fx = await makeRepo() })
afterAll(async () => { await fx.cleanup() })

const ids = (reg: IdentityRegistry) => [...reg.elements(), ...reg.relationships()].map(r => r.stableId).sort()

describe('projectModel', () => {
  it('AT-05: applies CHG-042 as a candidate while the baseline stays unchanged', async () => {
    const before = IdentityRegistry.fromModel((await loadModel(fx.dir)).model)
    const p = await projectModel(fx.dir, { includeChanges: ['CHG-042'] })
    expect(p.applied).toEqual(['CHG-042'])
    expect(p.baseline).toEqual({ source: 'worktree', revision: fx.shas.stage3 })

    const worker = p.registry.element('ent-billing-retry-worker')!
    expect(worker.fqn).toBe('billing.retry_worker')
    expect(worker.kind).toBe('component')
    const rel = p.registry.relationship('rel-billing-api-publishes-retries')!
    expect(rel.fromFqn).toBe('billing.billing_api')
    expect(rel.toFqn).toBe('billing.retry_worker')
    expect(rel.kind).toBe('publishes_to')

    // Visual distinction: amber + dashed + tag, and the tag was added to the spec.
    const node = p.model.element('billing.retry_worker')
    expect(node.isTagged(CANDIDATE_TAG)).toBe(true)
    expect(node.$element.style).toEqual({ color: 'amber', border: 'dashed' })
    expect(p.data.specification.tags[CANDIDATE_TAG]).toEqual({ color: '#d97706' })
    expect(p.diff.added.map(a => a.entityId)).toEqual(['ent-billing-retry-worker', 'rel-billing-api-publishes-retries'])

    // Views still compute with the new node in place.
    expect([...p.model.view('billing').nodes()].map(n => n.id)).toContain('billing.retry_worker')

    // Baseline untouched (fresh load, same ids as before).
    const after = IdentityRegistry.fromModel((await loadModel(fx.dir)).model)
    expect(ids(after)).toEqual(ids(before))
    expect(after.element('ent-billing-retry-worker')).toBeUndefined()
  })

  it('can project without highlight, and at a historical baseline revision', async () => {
    const p = await projectModel(fx.dir, { includeChanges: ['CHG-042'], highlight: false, baselineRevision: fx.shas.stage2 })
    expect(p.baseline).toEqual({ source: 'revision', revision: fx.shas.stage2 })
    expect(p.model.element('billing.retry_worker').isTagged(CANDIDATE_TAG)).toBe(false)
    expect(p.data.specification.tags[CANDIDATE_TAG]).toBeUndefined()
  })

  it('refuses unknown change sets and reports why', async () => {
    await expect(projectModel(fx.dir, { includeChanges: ['CHG-999'] })).rejects.toThrow(ProjectionError)
  })

  it('rejected change sets are still projectable on request (AT-05: inspectable, never accidental)', async () => {
    const p = await projectModel(fx.dir, { includeChanges: ['CHG-043'] })
    expect(p.registry.element('ent-payment-gateway')).toBeUndefined()
    expect(p.registry.relationship('rel-charges-cards')).toBeUndefined()
    expect(p.diff.removed).toEqual([
      { entityId: 'ent-payment-gateway', type: 'element', fqn: 'payment_gateway', changeId: 'CHG-043' },
      { entityId: 'rel-charges-cards', type: 'relationship', changeId: 'CHG-043', cascade: true },
    ])
    // The explicit remove_relationship after the cascade is tolerated and flagged.
    expect(p.warnings.map(w => w.code)).toEqual(['W_REDUNDANT_REMOVE'])
    expect([...p.model.view('index').nodes()].map(n => n.id).sort()).toEqual(['billing', 'customer'])
  })
})

describe('applyChangeSets (operation semantics)', () => {
  let baseline: Awaited<ReturnType<typeof loadModel>>
  beforeAll(async () => { baseline = await loadModel(fx.dir) })
  const apply = (sets: unknown[], highlight = false) =>
    applyChangeSets(baseline.parsedData, sets.map(s => ChangeSet.parse(s)), { baseline: { source: 'worktree', revision: null }, highlight })

  it('update_element merges instead of replacing (Phase A finding)', async () => {
    const p = await apply([{ id: 'CHG-200', title: 't', intent: 'i', operations: [
      { op: 'update_element', id: 'ent-invoice-ui', set: { technology: 'Next.js', metadata: { team: 'web' } } },
    ] }])
    const el = p.model.element('billing.invoice_ui')
    expect(el.title).toBe('Invoice UI')
    expect(el.technology).toBe('Next.js')
    expect(el.getMetadata()).toEqual({ stable_id: 'ent-invoice-ui', team: 'web' })
    expect(p.registry.element('ent-invoice-ui')!.fqn).toBe('billing.invoice_ui')
  })

  it('move_element rewrites FQNs, relationship endpoints and view rules', async () => {
    const p = await apply([{ id: 'CHG-201', title: 't', intent: 'i', operations: [
      { op: 'move_element', id: 'ent-billing-api', parent: null, name: 'api' },
    ] }])
    expect(p.registry.element('ent-billing-api')!.fqn).toBe('api')
    expect(p.registry.element('ent-charges')!.fqn).toBe('api.charges')
    expect(p.registry.relationship('rel-invoice-ui-calls-billing-api')!.toFqn).toBe('api')
    expect(p.registry.relationship('rel-charges-cards')!.fromFqn).toBe('api.charges')
    // The billing view's rule "include billing.billing_api.*" followed the move.
    const rule = p.data.views.billing.rules[0].include.find((x: any) => x.ref)
    expect(rule.ref.model).toBe('api')
    expect([...p.model.view('billing').nodes()].map(n => n.id)).toContain('api.charges')
    expect(ids(p.registry)).toEqual(ids(IdentityRegistry.fromModel(baseline.model)))
  })

  it('remove_element drops descendants, relationships, and view predicates that name them', async () => {
    const p = await apply([{ id: 'CHG-202', title: 't', intent: 'i', operations: [
      { op: 'remove_element', id: 'ent-billing-api' },
    ] }])
    expect(p.registry.element('ent-billing-api')).toBeUndefined()
    expect(p.registry.element('ent-charges')).toBeUndefined()
    expect(p.registry.relationship('rel-charges-cards')).toBeUndefined()
    expect(p.registry.relationship('rel-invoice-ui-calls-billing-api')).toBeUndefined()
    expect(p.registry.relationship('rel-customer-views-invoices')).toBeDefined()
    expect(p.data.views.billing.rules[0].include).toEqual([{ wildcard: true }])
    expect([...p.model.view('billing').nodes()].map(n => n.id).sort()).toEqual(['billing', 'billing.invoice_ui', 'billing.ledger_db', 'customer'])
    // A view scoped to a removed element disappears rather than dangling.
    const p2 = await apply([{ id: 'CHG-203', title: 't', intent: 'i', operations: [{ op: 'remove_element', id: 'ent-billing' }] }])
    expect(p2.data.views.billing).toBeUndefined()
    expect([...p2.model.views()].map(v => v.id)).toEqual(['index'])
  })

  it('composes dependent change sets in dependency order', async () => {
    const a = { id: 'CHG-210', title: 'a', intent: 'i', operations: [
      { op: 'add_element', id: 'ent-queue', parent: 'ent-billing', name: 'queue', kind: 'datastore', title: 'Retry Queue' },
    ] }
    const b = { id: 'CHG-211', title: 'b', intent: 'i', depends_on: ['CHG-210'], operations: [
      { op: 'add_relationship', id: 'rel-charges-queue', from: 'ent-charges', to: 'ent-queue', kind: 'writes_to' },
      { op: 'update_element', id: 'ent-queue', set: { technology: 'Redis' } },
    ] }
    const p = await apply([b, a]) // deliberately out of order: applyChangeSets honours the order it is given...
      .catch(e => e)
    expect(p).toBeInstanceOf(ProjectionError) // ...so b first fails: ent-queue does not exist yet
    const ok = await apply([a, b])
    expect(ok.applied).toEqual(['CHG-210', 'CHG-211'])
    expect(ok.model.element('billing.queue').technology).toBe('Redis')
  })

  it('flags overlapping writes by independent change sets as conflicts, but not when ordered by depends_on', async () => {
    const x = { id: 'CHG-220', title: 'x', intent: 'i', operations: [{ op: 'update_element', id: 'ent-invoice-ui', set: { technology: 'Next.js' } }] }
    const y = { id: 'CHG-221', title: 'y', intent: 'i', operations: [{ op: 'update_element', id: 'ent-invoice-ui', set: { technology: 'Remix' } }] }
    const err = await apply([x, y]).catch(e => e)
    expect(err).toBeInstanceOf(ProjectionError)
    expect(err.issues.map((i: any) => i.code)).toEqual(['E_CONFLICT'])
    expect(err.issues[0].message).toMatch(/CHG-221 and CHG-220 both change ent-invoice-ui \(technology\)/)

    const z = { ...y, id: 'CHG-222', depends_on: ['CHG-220'] }
    const ok = await apply([x, z])
    expect(ok.model.element('billing.invoice_ui').technology).toBe('Remix')

    // Different fields on the same entity do not conflict.
    const w = { id: 'CHG-223', title: 'w', intent: 'i', operations: [{ op: 'update_element', id: 'ent-invoice-ui', set: { title: 'Invoices' } }] }
    const ok2 = await apply([x, w])
    expect(ok2.applied).toEqual(['CHG-220', 'CHG-223'])
  })

  it('AT-08: an invalid change set is rejected before anything is applied', async () => {
    const bad = { id: 'CHG-230', title: 't', intent: 'i', operations: [
      { op: 'add_element', id: 'ent-ok', parent: 'ent-billing', name: 'ok', kind: 'component' },
      { op: 'add_relationship', id: 'rel-bad', from: 'ent-billing', to: 'ent-ok', kind: 'uses' }, // same hierarchy
    ] }
    const err = await apply([bad]).catch(e => e)
    expect(err).toBeInstanceOf(ProjectionError)
    expect(err.issues.map((i: any) => i.code)).toEqual(['E_SAME_HIERARCHY'])
  })
})

describe('projection dependency resolution', () => {
  it('requires dependencies to be included or promoted', async () => {
    // CHG-042 depends on CHG-037, which carries a pre-ledger promotion record: fine.
    const ok = await projectModel(fx.dir, { includeChanges: ['CHG-042'] })
    expect(ok.applied).toEqual(['CHG-042'])

    // A record depending on the rejected, unpromoted CHG-043 cannot be projected alone...
    const { writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    await writeFile(join(fx.dir, 'changes', 'CHG-060.yaml'),
      'id: CHG-060\ntitle: t\nintent: i\ndepends_on: [CHG-043]\noperations:\n  - op: update_element\n    id: ent-customer\n    set:\n      title: Payer\n', 'utf8')
    try {
      const err = await projectModel(fx.dir, { includeChanges: ['CHG-060'] }).catch(e => e)
      expect(err).toBeInstanceOf(ProjectionError)
      expect(err.issues.map((i: any) => i.code)).toEqual(['E_UNRESOLVED_DEPENDENCY'])
      // ...but projects when the dependency is included too, applied first.
      const both = await projectModel(fx.dir, { includeChanges: ['CHG-060', 'CHG-043'] })
      expect(both.applied).toEqual(['CHG-043', 'CHG-060'])
      expect(both.model.element('customer').title).toBe('Payer')
      expect(both.registry.element('ent-payment-gateway')).toBeUndefined()
    } finally {
      await fx.git.exec(['clean', '-fq', '--', 'changes/CHG-060.yaml'])
    }
  })
})

describe('render', () => {
  it('AT-10: a projection materialises as a valid LikeC4 workspace with the candidate marked', async () => {
    const ledger = await Ledger.load(fx.dir)
    const cs42 = ledger.get('CHG-042')!.changeSet
    const base = await loadModel(fx.dir)
    const p = await applyChangeSets(base.parsedData, [cs42], { baseline: { source: 'worktree', revision: null }, highlight: true })
    const dsl = await renderProjection(p, { format: 'dsl' })
    expect(dsl.format).toBe('dsl')
    if (dsl.format !== 'dsl') return
    expect(dsl.dsl).toMatch(/retry_worker = component 'Billing Retry Worker'/)
    expect(dsl.dsl).toMatch(/#candidate/)
    expect(dsl.dsl).toMatch(/tag candidate \{\s*color #d97706/)

    const ws = await materializeProjection(p)
    try {
      const reloaded = await loadModel(ws.dir, { modelDir: '.' })
      expect(reloaded.errors).toEqual([])
      const reg = IdentityRegistry.fromModel(reloaded.model)
      expect(ids(reg)).toEqual(ids(p.registry))
      expect([...reloaded.model.view('billing').nodes()].map(n => n.id)).toContain('billing.retry_worker')
    } finally {
      await ws.dispose()
    }
  })

  it.skipIf(!process.env.RENDER_PNG)('exports PNGs through the likec4 CLI', async () => {
    const base = await loadModel(fx.dir)
    const p = await applyChangeSets(base.parsedData, [], { baseline: { source: 'worktree', revision: null }, highlight: false })
    const r = await renderProjection(p, { format: 'png', views: ['billing'] })
    expect(r.format).toBe('png')
    if (r.format === 'png') expect(r.files).toEqual(['billing.png'])
  })
})
