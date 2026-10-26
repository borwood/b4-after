import { describe, expect, it } from 'vitest'
import { ChangeSet, OPERATION_NAMES } from '../src/schema.js'
import { parseChangeSet, serializeChangeSet, participantsOf, LedgerError } from '../src/ledger.js'

const minimal = { id: 'CHG-1', title: 't', intent: 'i' }

describe('change-set schema', () => {
  it('applies defaults', () => {
    const cs = ChangeSet.parse(minimal)
    expect(cs.disposition).toBe('draft')
    expect(cs.implementation).toBe('not_started')
    expect(cs.operations).toEqual([])
    expect(cs.references).toEqual([])
  })

  it('rejects unknown fields and unknown operations', () => {
    expect(ChangeSet.safeParse({ ...minimal, status: 'done' }).success).toBe(false)
    expect(ChangeSet.safeParse({ ...minimal, operations: [{ op: 'rename_element', id: 'x' }] }).success).toBe(false)
    expect(ChangeSet.safeParse({ ...minimal, operations: [{ op: 'add_element', id: 'x', parent: null, name: '1bad', kind: 'k' }] }).success).toBe(false)
  })

  it('rejects malformed ids', () => {
    expect(ChangeSet.safeParse({ ...minimal, id: 'chg-1' }).success).toBe(false)
    expect(ChangeSet.safeParse({ ...minimal, references: [{ entity: 'Billing.API', relation: 'relates_to' }] }).success).toBe(false)
  })

  it('only knows relates_to as a reference operator (PRD 5.2)', () => {
    expect(ChangeSet.safeParse({ ...minimal, references: [{ entity: 'x', relation: 'impacts' }] }).success).toBe(false)
  })

  it('lists the operation vocabulary from PRD 5.1', () => {
    expect([...OPERATION_NAMES].sort()).toEqual([
      'add_element', 'add_relationship', 'move_element', 'remove_element', 'remove_relationship', 'update_element', 'update_relationship',
    ])
  })

  it('round-trips through YAML', () => {
    const cs = ChangeSet.parse({ ...minimal, operations: [{ op: 'remove_element', id: 'ent-a' }], references: [{ entity: 'ent-b', relation: 'relates_to' }] })
    const back = parseChangeSet(serializeChangeSet(cs), 'x.yaml')
    expect(back).toEqual(cs)
  })

  it('reports actionable parse errors', () => {
    expect(() => parseChangeSet('id: CHG-1\ntitle: t\n', 'changes/CHG-1.yaml')).toThrow(LedgerError)
    try { parseChangeSet('id: CHG-1\ntitle: t\n', 'changes/CHG-1.yaml') } catch (e: any) {
      expect(e.problems[0].message).toMatch(/intent/)
    }
  })
})

describe('participantsOf', () => {
  it('keeps operations, endpoints and references distinct (PRD 3.2)', () => {
    const cs = ChangeSet.parse({
      ...minimal,
      operations: [
        { op: 'add_element', id: 'ent-w', parent: 'ent-b', name: 'w', kind: 'component' },
        { op: 'add_relationship', id: 'rel-1', from: 'ent-api', to: 'ent-w', kind: 'uses' },
      ],
      references: [{ entity: 'ent-ui', relation: 'relates_to', reason: 'visible' }],
    })
    const ps = participantsOf(cs)
    expect(ps).toEqual([
      { entityId: 'ent-w', entityType: 'element', role: 'added', via: 'operation', op: 'add_element' },
      { entityId: 'rel-1', entityType: 'relationship', role: 'relationship_added', via: 'operation', op: 'add_relationship' },
      { entityId: 'ent-api', entityType: 'element', role: 'relationship_source', via: 'relationship_endpoint', op: 'add_relationship', relationshipId: 'rel-1' },
      { entityId: 'ent-w', entityType: 'element', role: 'relationship_target', via: 'relationship_endpoint', op: 'add_relationship', relationshipId: 'rel-1' },
      { entityId: 'ent-ui', entityType: 'element', role: 'relates_to', via: 'reference', reason: 'visible' },
    ])
    // The parent of an added element is not a participant: nothing about it changed.
    expect(ps.some(p => p.entityId === 'ent-b')).toBe(false)
  })
})
