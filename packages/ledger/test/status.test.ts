// The committed model says what exists and what is only intended, per operation kind, and
// reconciliation moves things from intended to real as evidence arrives.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { proposeChangeSet, setDisposition } from '../src/propose.js'
import { promoteChangeSet } from '../src/promote.js'
import { recordEvidence, deriveVerification, deriveImplementation, targetVerification } from '../src/evidence.js'
import { reconcileBaseline } from '../src/reconcile.js'
import { planPromotion, annotateStatuses } from '../src/status.js'
import { applyChangeSets } from '../src/projection.js'
import { validateChangeSet } from '../src/validate.js'
import { loadModel } from '../src/model.js'
import { Ledger } from '../src/ledger.js'
import { IdentityRegistry } from '../src/identity.js'
import { ChangeSet } from '../src/schema.js'
import { TAG, META } from '../src/reserved.js'
import { makeRepo, type Fixture } from './fixture.js'

let fx: Fixture
beforeAll(async () => { fx = await makeRepo() })
afterAll(async () => { await fx.cleanup() })

const actor = 'agent'
let clock = 0
const when = () => new Date(Date.UTC(2026, 6, 1, 10, 0, 0) + clock++ * 60_000).toISOString()

const land = async (cs: object) => {
  const r = await proposeChangeSet(fx.dir, cs, { actor, date: when() })
  await setDisposition(fx.dir, r.changeSet.id, 'accepted', { actor: 'reviewer', date: when() })
  return promoteChangeSet(fx.dir, r.changeSet.id, { actor, date: when() })
}
const verify = async (changeId: string, extra: Record<string, unknown> = {}) => {
  await recordEvidence(fx.dir, changeId, {
    id: `ev-${changeId.toLowerCase()}-${clock}`, kind: 'test', result: 'pass', source_ref: `https://ci/${changeId}`,
    code_revision: 'c0ffee1', observed_at: when(), recorded_by: 'ci', ...extra,
  }, { actor: 'ci', date: when() })
  return reconcileBaseline(fx.dir, { actor: 'ci', date: when() })
}
const model = async () => (await loadModel(fx.dir)).model
const views = () => readFile(join(fx.dir, 'model', 'views.c4'), 'utf8')
const relationship = async (stableId: string) => {
  const loaded = await loadModel(fx.dir)
  const rec = IdentityRegistry.fromModel(loaded.model).relationship(stableId)!
  return loaded.parsedData.relations[rec.relationId]
}

describe('additions', () => {
  it('an unverified addition is intended: present, marked, faded, excluded from the As-is views', async () => {
    const res = await promoteChangeSet(fx.dir, 'CHG-042', { actor, date: when() })
    expect(res.deferred).toEqual([])
    const m = await model()
    const worker = m.element('billing.retry_worker')
    expect(worker.tags).toEqual([TAG.intended])
    expect(worker.$element.style).toMatchObject({ border: 'dashed', opacity: 40 })
    expect(worker.getMetadata()).toMatchObject({ [META.change]: 'CHG-042', [META.status]: 'unverified' })
    const rel = await relationship('rel-billing-api-publishes-retries')
    expect(rel).toMatchObject({ line: 'dashed', color: 'amber', tags: [TAG.intended] })
    expect([...m.view('el--billing').nodes()].map(n => n.id)).not.toContain('billing.retry_worker')
    expect([...m.view('el--billing--target').nodes()].map(n => n.id)).toContain('billing.retry_worker')
    // Pre-ledger inferred entities exist, unverified, with no flag.
    expect(m.element('billing.ledger_db').tags).toEqual([])
    expect(m.element('billing.ledger_db').getMetadata()).toMatchObject({ [META.change]: 'CHG-037', [META.status]: 'verified' })
  })

  it('failing evidence adds the failed flag; a correcting pass makes it real', async () => {
    await recordEvidence(fx.dir, 'CHG-042', {
      id: 'ev-042-fail', kind: 'test', result: 'fail', source_ref: 'https://ci/042/1', code_revision: 'c0ffee1', observed_at: when(), recorded_by: 'ci',
    }, { actor: 'ci', date: when() })
    const r1 = await reconcileBaseline(fx.dir, { actor: 'ci', date: when() })
    expect(r1.changed).toBe(true)
    expect([...(await model()).element('billing.retry_worker').tags].sort()).toEqual([TAG.failed, TAG.intended])

    const r2 = await verify('CHG-042', { amends: 'ev-042-fail' })
    expect(r2.changed).toBe(true)
    expect(r2.applied).toEqual([]) // nothing was deferred; only statuses changed
    const worker = (await model()).element('billing.retry_worker')
    expect(worker.tags).toEqual([])
    expect(worker.$element.style).toEqual({})
    expect(worker.getMetadata()).toMatchObject({ [META.status]: 'verified' })
    expect(await relationship('rel-billing-api-publishes-retries')).not.toHaveProperty('line')

    // Reconciliation is idempotent: a second run changes nothing and commits nothing.
    const again = await reconcileBaseline(fx.dir, { actor: 'ci', date: when() })
    expect(again).toMatchObject({ changed: false, sha: r2.sha })
  })
})

describe('property updates', () => {
  it('are deferred: current values stay, the Target views show the intended ones', async () => {
    const res = await land({
      id: 'CHG-070', title: 'Rename customer', intent: 'Customers pay, so call them payers',
      operations: [{ op: 'update_element', id: 'ent-customer', set: { title: 'Payer', technology: 'Human' } }],
    })
    expect(res.deferred).toEqual([{ entityId: 'ent-customer', op: 'update_element' }])
    const customer = (await model()).element('customer')
    expect(customer.title).toBe('Customer')
    expect(customer.technology).toBeNull()
    expect(customer.tags).toEqual([TAG.pending_update])
    expect(customer.getMetadata()).toMatchObject({ [META.pending]: 'CHG-070', [META.change]: 'CHG-070', [META.status]: 'unverified' })
    const v = await views()
    expect(v).toMatch(/view index--target \{[^}]*include customer with \{ title 'Payer'; technology 'Human' \}/s)
    expect(v).not.toMatch(/view index \{[^}]*with \{/s)
  })

  it('an agent cannot set or erase status tags and metadata', async () => {
    const s = { registry: IdentityRegistry.fromModel(await model()), ledger: await Ledger.load(fx.dir) }
    const r = validateChangeSet({
      id: 'CHG-071', title: 't', intent: 'i', operations: [
        { op: 'update_element', id: 'ent-customer', set: { tags: [TAG.intended], metadata: { b4_status: 'verified' } } },
        { op: 'add_relationship', id: 'rel-x', from: 'ent-customer', to: 'ent-billing', tags: ['b4-anything'], metadata: { b4_change: 'CHG-1' } },
      ],
    }, s)
    expect(r.issues.map(i => `${i.code}@${i.path}`)).toEqual([
      'E_RESERVED_TAG@/operations/0/set/tags', 'E_RESERVED_METADATA@/operations/0/set/metadata/b4_status',
      'E_RESERVED_TAG@/operations/1/tags', 'E_RESERVED_METADATA@/operations/1/metadata/b4_change',
    ])
    // Replacing tags keeps the status tag.
    const loaded = await loadModel(fx.dir)
    const p = await applyChangeSets(loaded.parsedData, [ChangeSet.parse({
      id: 'CHG-072', title: 't', intent: 'i', operations: [{ op: 'update_element', id: 'ent-customer', set: { tags: ['external'] } }],
    })], { baseline: { source: 'worktree', revision: null }, highlight: false })
    expect([...p.model.element('customer').tags].sort()).toEqual(['b4-pending-update', 'external'])
  })

  it('are applied by reconciliation once verified', async () => {
    const r = await verify('CHG-070')
    expect(r.applied).toEqual([{ changeId: 'CHG-070', entityId: 'ent-customer', op: 'update_element' }])
    const customer = (await model()).element('customer')
    expect(customer.title).toBe('Payer')
    expect(customer.technology).toBe('Human')
    expect(customer.tags).toEqual([])
    expect(customer.getMetadata()).not.toHaveProperty(META.pending)
    expect(await views()).not.toContain('with {')
  })
})

describe('removals', () => {
  it('are deferred: the entity is retiring, still present and dotted, and building on it is flagged', async () => {
    const res = await land({
      id: 'CHG-073', title: 'Retire the gateway', intent: 'Acquiring moves in-house',
      operations: [{ op: 'remove_element', id: 'ent-payment-gateway' }],
    })
    expect(res.deferred).toEqual([{ entityId: 'ent-payment-gateway', op: 'remove_element' }])
    expect(res.removed).toEqual([])
    const m = await model()
    const gw = m.element('payment_gateway')
    expect([...gw.tags].sort()).toEqual([TAG.retiring, 'external'])
    expect(gw.$element.style).toMatchObject({ border: 'dotted', opacity: 60 })
    expect([...m.view('index').nodes()].map(n => n.id)).toContain('payment_gateway')
    expect(await relationship('rel-charges-cards')).toBeDefined()

    const v = validateChangeSet({
      id: 'CHG-074', title: 't', intent: 'i',
      operations: [{ op: 'add_relationship', id: 'rel-ui-gateway', from: 'ent-invoice-ui', to: 'ent-payment-gateway', kind: 'uses' }],
    }, { registry: IdentityRegistry.fromModel(m) })
    expect(v.ok).toBe(true)
    expect(v.issues).toEqual([expect.objectContaining({ code: 'W_RETIRING_TARGET', path: '/operations/0/to' })])
  })

  it('verified removals cascade to attached relationships', async () => {
    const r = await verify('CHG-073')
    expect(r.applied).toEqual([{ changeId: 'CHG-073', entityId: 'ent-payment-gateway', op: 'remove_element' }])
    const reg = IdentityRegistry.fromModel(await model())
    expect(reg.element('ent-payment-gateway')).toBeUndefined()
    expect(reg.relationship('rel-charges-cards')).toBeUndefined()
  })

  it('falls back to applying at once when deferring would leave the change set inconsistent, and says so', async () => {
    const res = await land({
      id: 'CHG-075', title: 'Replace the invoice UI', intent: 'Rewrite, keeping the name',
      operations: [
        { op: 'remove_element', id: 'ent-invoice-ui' },
        { op: 'add_element', id: 'ent-invoice-ui-v2', parent: 'ent-billing', name: 'invoice_ui', kind: 'container', title: 'Invoice UI v2' },
      ],
    })
    expect(res.deferred).toEqual([])
    expect(res.removed).toEqual(expect.arrayContaining(['ent-invoice-ui']))
    expect(res.warnings[0]).toMatch(/could not defer remove_element ent-invoice-ui/)
    const reg = IdentityRegistry.fromModel(await model())
    expect(reg.element('ent-invoice-ui')).toBeUndefined()
    expect(reg.element('ent-invoice-ui-v2')!.fqn).toBe('billing.invoice_ui')
  })
})

describe('moves and inferred change sets', () => {
  it('a move is applied at once and badged until verified', async () => {
    await land({
      id: 'CHG-076', title: 'Lift charges', intent: 'Charges become a container',
      operations: [{ op: 'move_element', id: 'ent-charges', parent: 'ent-billing' }],
    })
    const charges = (await model()).element('billing.charges')
    expect(charges.tags).toEqual([TAG.pending_move])
    expect(charges.getMetadata()).toMatchObject({ [META.movedFrom]: 'billing.billing_api.charges' })
    await verify('CHG-076')
    const after = (await model()).element('billing.charges')
    expect(after.tags).toEqual([])
    expect(after.getMetadata()).not.toHaveProperty(META.movedFrom)
  })

  it('an inferred change set describes what was observed: everything applies at once, nothing is intended', async () => {
    const res = await land({
      id: 'CHG-077', title: 'Inferred: UI stack', intent: 'Seen in package.json', inferred: true,
      operations: [
        { op: 'update_element', id: 'ent-invoice-ui-v2', set: { technology: 'Vue' } },
        { op: 'add_element', id: 'ent-cdn', parent: null, name: 'cdn', kind: 'system', title: 'CDN', tags: ['external'] },
      ],
    })
    expect(res.deferred).toEqual([])
    const m = await model()
    expect(m.element('billing.invoice_ui').technology).toBe('Vue')
    expect(m.element('cdn').tags).toEqual(['external'])
    expect(m.element('cdn').getMetadata()).toMatchObject({ [META.change]: 'CHG-077', [META.status]: 'unverified' })
    const ledger = await Ledger.load(fx.dir)
    expect(ledger.get('CHG-077')!.implementation).toBe('implemented')
  })
})

describe('revising intentions', () => {
  // A plan promoted before anything is built is all intended. Forks of that plan must replace it,
  // not queue behind evidence that can never arrive for things that do not exist.
  it('a fork of a promoted plan applies at once: nothing waits on an entity that does not exist', async () => {
    await land({
      id: 'CHG-300', title: 'Plan', intent: 'plan first', operations: [
        { op: 'add_element', id: 'ent-plan-a', parent: 'ent-billing', name: 'plan_a', kind: 'component', title: 'Plan A' },
        { op: 'add_element', id: 'ent-plan-b', parent: 'ent-billing', name: 'plan_b', kind: 'component', title: 'Plan B' },
        { op: 'add_relationship', id: 'rel-plan-a-b', from: 'ent-plan-a', to: 'ent-plan-b', kind: 'uses', title: 'uses' },
      ],
    })
    const fork = await land({
      id: 'CHG-301', title: 'Fork', intent: 'the design changed', depends_on: ['CHG-300'], operations: [
        { op: 'update_element', id: 'ent-plan-a', set: { title: 'Plan A, revised', technology: 'Go' } },
        { op: 'move_element', id: 'ent-plan-b', parent: 'ent-billing-api', name: 'plan_b2' },
      ],
    })
    expect(fork.deferred).toEqual([])
    expect(fork.warnings).toEqual([])
    const m = await model()
    const a = m.element('billing.plan_a')
    expect(a.title).toBe('Plan A, revised')
    expect(a.tags).toEqual([TAG.intended])
    expect(a.getMetadata()).toMatchObject({ [META.change]: 'CHG-301', [META.status]: 'unverified' })
    expect(a.getMetadata()[META.pending]).toBeUndefined()
    const b = m.element('billing.billing_api.plan_b2')
    expect(b.tags).toEqual([TAG.intended])
    expect(b.getMetadata()[META.movedFrom]).toBeUndefined()
  })

  it('dropping a planned element removes it outright, with its relationships', async () => {
    const drop = await land({ id: 'CHG-302', title: 'Drop B', intent: 'ruled out', depends_on: ['CHG-301'], operations: [{ op: 'remove_element', id: 'ent-plan-b' }] })
    expect(drop.deferred).toEqual([])
    expect(drop.removed.sort()).toEqual(['ent-plan-b', 'rel-plan-a-b'])
    const m = await model()
    expect(() => m.element('billing.billing_api.plan_b2')).toThrow()
    expect(await views()).not.toMatch(/plan_b2/)
  })

  it('evidence on the latest change set proves a planned entity exists, although the plan itself is unverified', async () => {
    const r = await verify('CHG-301', { targets: ['ent-plan-a'] })
    expect(r.changed).toBe(true)
    const a = (await model()).element('billing.plan_a')
    expect(a.tags).toEqual([])
    expect(a.getMetadata()).toMatchObject({ [META.change]: 'CHG-301', [META.status]: 'verified' })
  })

  it('planPromotion applies operations on intended targets at once', () => {
    const c = ChangeSet.parse({ id: 'CHG-9', title: 't', intent: 'i', operations: [{ op: 'update_element', id: 'ent-a', set: { title: 'x' } }, { op: 'remove_element', id: 'ent-b' }] })
    const plan = planPromotion(c, deriveVerification(c, []), new Set(['ent-a']))
    expect(plan.immediate.map(o => o.id)).toEqual(['ent-a'])
    expect(plan.deferred.map(o => o.id)).toEqual(['ent-b'])
  })
})

describe('derivations', () => {
  const cs = (ops: object[], extra: object = {}) => ChangeSet.parse({ id: 'CHG-9', title: 't', intent: 'i', operations: ops, ...extra })
  const none = deriveVerification(cs([{ op: 'update_element', id: 'ent-a', set: { title: 'x' } }, { op: 'remove_element', id: 'ent-b' }]), [])

  it('planPromotion defers only unverified updates and removals of entities that already exist', () => {
    const c = cs([
      { op: 'add_element', id: 'ent-n', parent: null, name: 'n', kind: 'system' },
      { op: 'update_element', id: 'ent-n', set: { title: 'N' } },
      { op: 'update_element', id: 'ent-a', set: { title: 'x' } },
      { op: 'remove_element', id: 'ent-b' },
      { op: 'move_element', id: 'ent-c', parent: null },
    ])
    const plan = planPromotion(c, deriveVerification(c, []))
    expect(plan.immediate.map(o => `${o.op}:${o.id}`)).toEqual(['add_element:ent-n', 'update_element:ent-n', 'move_element:ent-c'])
    expect(plan.deferred.map(o => `${o.op}:${o.id}`)).toEqual(['update_element:ent-a', 'remove_element:ent-b'])
    expect(planPromotion({ ...c, inferred: true }, deriveVerification(c, [])).deferred).toEqual([])
    const verified = deriveVerification(c, [{ id: 'ev-1', kind: 'test', result: 'pass', targets: ['ent-a'], source_ref: 's', code_revision: 'abcd', observed_at: '2026-01-01T00:00:00Z', recorded_by: 'ci' }])
    expect(planPromotion(c, verified).deferred.map(o => o.id)).toEqual(['ent-b'])
  })

  it('targetVerification and deriveImplementation follow the evidence', () => {
    expect(targetVerification(none, 'ent-a')).toBe('unverified')
    expect(deriveImplementation({ inferred: false }, none)).toBe('not_started')
    const c = cs([{ op: 'update_element', id: 'ent-a', set: { title: 'x' } }, { op: 'remove_element', id: 'ent-b' }])
    const mixed = deriveVerification(c, [
      { id: 'ev-1', kind: 'test', result: 'pass', targets: ['ent-a'], source_ref: 's', code_revision: 'abcd', observed_at: '2026-01-01T00:00:00Z', recorded_by: 'ci' },
      { id: 'ev-2', kind: 'test', result: 'fail', targets: ['ent-b'], source_ref: 's', code_revision: 'abcd', observed_at: '2026-01-01T00:00:00Z', recorded_by: 'ci' },
    ])
    expect(mixed.failedTargets).toEqual(['ent-b'])
    expect(targetVerification(mixed, 'ent-a')).toBe('verified')
    expect(targetVerification(mixed, 'ent-b')).toBe('failed')
    expect(deriveImplementation({ inferred: false }, mixed)).toBe('in_progress')
    expect(deriveImplementation({ inferred: true }, none)).toBe('implemented')
  })

  it('annotateStatuses is idempotent and counts flags', async () => {
    const loaded = await loadModel(fx.dir)
    const ledger = await Ledger.load(fx.dir)
    const data = structuredClone(loaded.parsedData)
    const a = await annotateStatuses(data, ledger)
    const snapshot = JSON.stringify(data)
    const b = await annotateStatuses(data, ledger)
    expect(JSON.stringify(data)).toBe(snapshot)
    expect(b.counts).toEqual(a.counts)
    expect(a.counts.as_is).toBeGreaterThan(0)
    expect(a.entities.get('ent-cdn')!.reason).toMatch(/inferred during adoption \(CHG-077\)/)
  })
})
