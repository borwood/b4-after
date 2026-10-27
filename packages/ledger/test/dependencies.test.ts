// A change set may build on entities introduced by dependencies that are proposed but not yet
// promoted: validation projects them onto the baseline first (issue #2). Promotion still goes in
// dependency order.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { proposeChangeSet, setDisposition, validateInContext } from '../src/propose.js'
import { promoteChangeSet } from '../src/promote.js'
import { validateChangeSet } from '../src/validate.js'
import { loadModel } from '../src/model.js'
import { Ledger } from '../src/ledger.js'
import { IdentityRegistry } from '../src/identity.js'
import { makeRepo, type Fixture } from './fixture.js'

let fx: Fixture
beforeAll(async () => { fx = await makeRepo() })
afterAll(async () => { await fx.cleanup() })

const actor = 'agent'
let clock = 0
const when = () => new Date(Date.UTC(2026, 7, 1, 10, 0, 0) + clock++ * 60_000).toISOString()
const context = async () => ({ loaded: await loadModel(fx.dir), ledger: await Ledger.load(fx.dir) })
const codes = (issues: { code: string }[]) => issues.map(i => i.code)
const add = (id: string, name: string, parent = 'ent-billing') => ({ op: 'add_element', id, parent, name, kind: 'component', title: name })

describe('validation sees unpromoted dependencies', () => {
  it('a change set may build on entities introduced by a proposed dependency', async () => {
    await proposeChangeSet(fx.dir, { id: 'CHG-200', title: 'Add X', intent: 'i', operations: [add('ent-dep-x', 'dep_x')] }, { actor, date: when() })
    const follow = {
      id: 'CHG-201', title: 'Wire X', intent: 'i', depends_on: ['CHG-200'],
      operations: [{ op: 'add_relationship', id: 'rel-api-uses-x', from: 'ent-billing-api', to: 'ent-dep-x', kind: 'uses', title: 'uses' }],
    }
    const { loaded, ledger } = await context()
    const bare = validateChangeSet(follow, { registry: IdentityRegistry.fromModel(loaded.model), ledger })
    expect(codes(bare.issues)).toContain('E_UNKNOWN_ENTITY')

    const seen = await validateInContext(loaded, follow, ledger)
    expect(seen.ok).toBe(true)
    expect(seen.projected).toEqual(['CHG-200'])
    const undeclared = await validateInContext(loaded, { ...follow, depends_on: [] }, ledger)
    expect(undeclared.ok).toBe(false)
    expect(undeclared.projected).toEqual([])

    const r = await proposeChangeSet(fx.dir, follow, { actor, date: when() })
    expect(r.validation.projected).toEqual(['CHG-200'])
  })

  it('dependencies are projected transitively, in order', async () => {
    const { loaded, ledger } = await context()
    const r = await validateInContext(loaded, {
      id: 'CHG-202', title: 'Under X', intent: 'i', depends_on: ['CHG-201'], operations: [add('ent-dep-y', 'dep_y', 'ent-dep-x')],
    }, ledger)
    expect(r.ok).toBe(true)
    expect(r.projected).toEqual(['CHG-200', 'CHG-201'])
  })

  it('promotion still requires the dependency promoted first', async () => {
    await setDisposition(fx.dir, 'CHG-201', 'accepted', { actor, date: when() })
    await expect(promoteChangeSet(fx.dir, 'CHG-201', { actor, date: when() })).rejects.toThrow(/depends on CHG-200, which is not promoted yet/)
    await setDisposition(fx.dir, 'CHG-200', 'accepted', { actor, date: when() })
    await promoteChangeSet(fx.dir, 'CHG-200', { actor, date: when() })
    const r = await promoteChangeSet(fx.dir, 'CHG-201', { actor, date: when() })
    expect(r.added).toContain('rel-api-uses-x')
  })

  it('falls back to the bare baseline, with a warning, when a dependency no longer projects', async () => {
    await proposeChangeSet(fx.dir, { id: 'CHG-210', title: 'Stale', intent: 'i', operations: [add('ent-stale', 'taken_name')] }, { actor, date: when() })
    await proposeChangeSet(fx.dir, { id: 'CHG-211', title: 'Takes the name', intent: 'i', operations: [add('ent-other', 'taken_name')] }, { actor, date: when() })
    await setDisposition(fx.dir, 'CHG-211', 'accepted', { actor, date: when() })
    await promoteChangeSet(fx.dir, 'CHG-211', { actor, date: when() })

    const { loaded, ledger } = await context()
    const r = await validateInContext(loaded, {
      id: 'CHG-212', title: 'On stale', intent: 'i', depends_on: ['CHG-210'], operations: [add('ent-under-stale', 'under', 'ent-stale')],
    }, ledger)
    expect(r.projected).toEqual([])
    expect(r.ok).toBe(false)
    expect(codes(r.issues)).toEqual(['W_DEPENDENCY_NOT_PROJECTED', 'E_UNKNOWN_ENTITY'])
    expect(r.issues[0]!.message).toMatch(/CHG-210/)
  })
})
