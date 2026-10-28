import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import YAML from 'yaml'
import { validateChangeSet } from '../src/validate.js'
import { Ledger } from '../src/ledger.js'
import { loadModel } from '../src/model.js'
import { IdentityRegistry } from '../src/identity.js'
import { makeRepo, type Fixture, EXAMPLE_DIR } from './fixture.js'

let fx: Fixture
let ledger: Ledger
let registry: IdentityRegistry
beforeAll(async () => {
  fx = await makeRepo()
  ledger = await Ledger.load(fx.dir)
  registry = IdentityRegistry.fromModel((await loadModel(fx.dir)).model)
})
afterAll(async () => { await fx.cleanup() })

const base = { id: 'CHG-100', title: 't', intent: 'i' }
const codes = (r: ReturnType<typeof validateChangeSet>) => r.issues.map(i => i.code)

describe('validateChangeSet', () => {
  it('accepts the shipped CHG-042 against the baseline', async () => {
    const raw = YAML.parse(await readFile(join(EXAMPLE_DIR, 'changes', 'CHG-042.yaml'), 'utf8'))
    const r = validateChangeSet(raw, { registry, ledger })
    expect(r.issues).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('stable_id cannot be set or overwritten through metadata', () => {
    const r = validateChangeSet({ ...base, operations: [
      { op: 'add_element', id: 'ent-x', parent: null, name: 'x', kind: 'system', metadata: { stable_id: 'ent-other' } },
      { op: 'update_element', id: 'ent-billing', set: { metadata: { stable_id: 'ent-other' } } },
    ] }, { registry, ledger })
    expect(r.issues.map(i => `${i.code}@${i.path}`)).toEqual(['E_RESERVED_METADATA@/operations/0/metadata/stable_id', 'E_RESERVED_METADATA@/operations/1/set/metadata/stable_id'])
  })

  it('reports schema errors with paths', () => {
    const r = validateChangeSet({ ...base, operations: [{ op: 'add_element' }] }, { registry })
    expect(r.ok).toBe(false)
    expect(r.issues.every(i => i.code === 'E_SCHEMA')).toBe(true)
    expect(r.issues.map(i => i.path)).toContain('/operations/0/id')
  })

  it('AT-08: unknown entities, kinds, and parents', () => {
    const r = validateChangeSet({
      ...base,
      operations: [
        { op: 'update_element', id: 'ent-nope', set: { title: 'x' } },
        { op: 'add_element', id: 'ent-new', parent: 'ent-missing-parent', name: 'n', kind: 'spaceship' },
        { op: 'add_relationship', id: 'rel-new', from: 'ent-charges', to: 'ent-customer', kind: 'teleports_to' },
        { op: 'remove_relationship', id: 'ent-charges' },
      ],
      references: [{ entity: 'ent-ghost', relation: 'relates_to' }],
    }, { registry })
    expect(r.ok).toBe(false)
    expect(codes(r)).toEqual([
      'E_UNKNOWN_ENTITY', 'E_UNKNOWN_KIND', 'E_UNKNOWN_ENTITY', 'E_UNKNOWN_RELATIONSHIP_KIND', 'E_UNKNOWN_ENTITY', 'E_UNKNOWN_ENTITY',
    ])
    expect(r.issues.find(i => i.path === '/operations/3/id')!.message).toMatch(/is an element id/)
    expect(r.issues.find(i => i.path === '/operations/1/kind')!.message).toMatch(/known: actor, system/)
  })

  it('catches the LikeC4 same-hierarchy rule before LikeC4 does (Phase A)', () => {
    const r = validateChangeSet({
      ...base,
      operations: [
        { op: 'add_element', id: 'ent-worker', parent: 'ent-billing-api', name: 'retry_worker', kind: 'component' },
        { op: 'add_relationship', id: 'rel-x', from: 'ent-billing-api', to: 'ent-worker', kind: 'publishes_to' },
        { op: 'add_relationship', id: 'rel-y', from: 'ent-billing', to: 'ent-charges', kind: 'uses' },
      ],
    }, { registry })
    expect(codes(r)).toEqual(['E_SAME_HIERARCHY', 'E_SAME_HIERARCHY'])
    expect(r.issues[0]!.message).toMatch(/billing\.billing_api\.retry_worker/)
  })

  it('tracks virtual state across operations: duplicates, names, use-after-remove', () => {
    const r = validateChangeSet({
      ...base,
      operations: [
        { op: 'add_element', id: 'ent-charges', parent: 'ent-billing', name: 'charges2', kind: 'component' },
        { op: 'add_element', id: 'ent-dup', parent: 'ent-billing', name: 'invoice_ui', kind: 'container' },
        { op: 'remove_element', id: 'ent-ledger-db' },
        { op: 'update_element', id: 'ent-ledger-db', set: { title: 'late' } },
        { op: 'remove_relationship', id: 'rel-charges-cards' },
        { op: 'update_relationship', id: 'rel-charges-cards', set: { title: 'late' } },
        { op: 'move_element', id: 'ent-billing', parent: 'ent-charges' },
      ],
    }, { registry })
    expect(codes(r)).toEqual(['E_DUPLICATE_ID', 'E_DUPLICATE_NAME', 'E_AFTER_REMOVE', 'E_AFTER_REMOVE', 'E_MOVE_INTO_DESCENDANT'])
  })

  it('checks dependencies against the ledger, including cycles', () => {
    const unknown = validateChangeSet({ ...base, depends_on: ['CHG-999'], operations: [{ op: 'remove_element', id: 'ent-customer' }] }, { registry, ledger })
    expect(codes(unknown)).toEqual(['E_UNKNOWN_DEPENDENCY'])
    const self = validateChangeSet({ ...base, depends_on: ['CHG-100'], operations: [{ op: 'remove_element', id: 'ent-customer' }] }, { registry, ledger })
    expect(codes(self)).toEqual(['E_SELF_DEPENDENCY'])
    // CHG-042 depends on CHG-037; revising CHG-037 to depend on CHG-042 closes a cycle.
    const cyc = validateChangeSet({ id: 'CHG-037', title: 't', intent: 'i', depends_on: ['CHG-042'], operations: [{ op: 'remove_element', id: 'ent-customer' }] }, { registry, ledger })
    expect(codes(cyc)).toEqual(['E_DEPENDENCY_CYCLE'])
    expect(cyc.issues[0]!.message).toMatch(/CHG-037 -> CHG-042 -> CHG-037/)
  })

  it('warns, without failing, on redundant references and empty change sets', () => {
    const empty = validateChangeSet(base, { registry, ledger })
    expect(empty.ok).toBe(true)
    expect(codes(empty)).toEqual(['W_NO_PARTICIPANTS'])
    const redundant = validateChangeSet({
      ...base,
      operations: [{ op: 'update_element', id: 'ent-invoice-ui', set: { technology: 'Next.js' } }],
      references: [{ entity: 'ent-invoice-ui', relation: 'relates_to' }],
    }, { registry, ledger })
    expect(redundant.ok).toBe(true)
    expect(codes(redundant)).toEqual(['W_REFERENCE_ALSO_OPERATED'])
  })

  it('rejects LikeC4 keywords as element names, on add and on rename', () => {
    const add = validateChangeSet({ ...base, operations: [{ op: 'add_element', id: 'ent-head', parent: 'ent-billing', name: 'head', kind: 'component' }] }, { registry, ledger })
    expect(add.ok).toBe(false)
    expect(add.issues).toContainEqual(expect.objectContaining({ code: 'E_RESERVED_WORD', path: '/operations/0/name' }))
    const rename = validateChangeSet({ ...base, operations: [{ op: 'move_element', id: 'ent-charges', parent: 'ent-billing-api', name: 'title' }] }, { registry, ledger })
    expect(codes(rename)).toEqual(['E_RESERVED_WORD'])
    const fine = validateChangeSet({ ...base, operations: [{ op: 'add_element', id: 'ent-head', parent: 'ent-billing', name: 'head_field', kind: 'component' }] }, { registry, ledger })
    expect(fine.ok).toBe(true)
  })

  it('a move may not land on a name that is already taken', () => {
    const clash = validateChangeSet({ ...base, operations: [{ op: 'move_element', id: 'ent-charges', parent: 'ent-billing', name: 'ledger_db' }] }, { registry, ledger })
    expect(clash.issues).toContainEqual(expect.objectContaining({ code: 'E_DUPLICATE_NAME', path: '/operations/0/name' }))
    const sameName = validateChangeSet({
      ...base,
      operations: [
        { op: 'add_element', id: 'ent-x', parent: 'ent-billing', name: 'charges', kind: 'component' },
        { op: 'move_element', id: 'ent-charges', parent: 'ent-billing' },
      ],
    }, { registry, ledger })
    expect(sameName.issues).toContainEqual(expect.objectContaining({ code: 'E_DUPLICATE_NAME', path: '/operations/1/parent' }))
    const free = validateChangeSet({ ...base, operations: [{ op: 'move_element', id: 'ent-charges', parent: 'ent-billing' }] }, { registry, ledger })
    expect(free.ok).toBe(true)
  })

  it('without a baseline it validates shape only and says so', () => {
    const r = validateChangeSet({ ...base, operations: [{ op: 'remove_element', id: 'ent-anything' }] })
    expect(r.ok).toBe(true)
    expect(codes(r)).toEqual(['W_NO_BASELINE'])
  })
})

describe('IdentityRegistry', () => {
  it('maps stable ids to FQNs and relationship hashes, both directions', () => {
    expect(registry.problems).toEqual([])
    expect(registry.element('ent-charges')!.fqn).toBe('billing.billing_api.charges')
    expect(registry.elementByFqn('billing.ledger_db')!.stableId).toBe('ent-ledger-db')
    const rel = registry.relationship('rel-charges-cards')!
    expect(rel.fromFqn).toBe('billing.billing_api.charges')
    expect(rel.toFqn).toBe('payment_gateway')
    expect(rel.kind).toBe('uses')
    expect(registry.relationshipByRelationId(rel.relationId)!.stableId).toBe('rel-charges-cards')
    expect(registry.descendantsOf('ent-billing').ids.sort()).toEqual(['ent-billing-api', 'ent-charges', 'ent-invoice-ui', 'ent-ledger-db'])
  })
})
