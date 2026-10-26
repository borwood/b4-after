import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initModelRepo, adoptExistingModel, slug } from '../src/bootstrap.js'
import { proposeChangeSet, setDisposition } from '../src/propose.js'
import { promoteChangeSet } from '../src/promote.js'
import { qualifyBaseline } from '../src/qualify.js'
import { storyOf } from '../src/story.js'
import { formatStory } from '../src/format.js'
import { Ledger } from '../src/ledger.js'
import { loadModel } from '../src/model.js'
import { IdentityRegistry } from '../src/identity.js'
import { Git } from '../src/git.js'

let root: string
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'b4-after-boot-')) })
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

describe('fresh adoption: init, then inferred change sets through the normal path', () => {
  it('initialises an empty, valid model repository', async () => {
    const dir = join(root, 'fresh')
    const r = await initModelRepo(dir, { name: 'Shop', actor: 'adopter', tags: ['external'], date: '2026-06-01T00:00:00Z' })
    expect(r.sha).toMatch(/^[0-9a-f]{40}$/)
    const loaded = await loadModel(dir)
    expect(loaded.errors).toEqual([])
    expect([...loaded.model.elements()]).toHaveLength(0)
    expect([...loaded.model.views()].map(v => v.id)).toEqual(['index'])
    const spec = loaded.model.$data.specification as any
    expect(Object.keys(spec.elements).sort()).toEqual(['actor', 'component', 'container', 'datastore', 'system'])
    expect(Object.keys(spec.tags)).toEqual(['external'])
    expect((await Ledger.load(dir)).records.size).toBe(0)
    await expect(initModelRepo(dir, { name: 'Shop', actor: 'x' })).rejects.toThrow(/already has a model/)
  })

  it('an agent proposes an inferred change set, accepts, promotes; the baseline is honest about it', async () => {
    const dir = join(root, 'fresh')
    const head = await new Git(dir).headSha()
    const r = await proposeChangeSet(dir, {
      id: 'CHG-1', title: 'Inferred baseline: storefront', intent: 'Inferred from repository layout during adoption', inferred: true,
      implementation: 'implemented',
      sources: [{ ref: 'repo://shop/README.md', role: 'other' }],
      operations: [
        { op: 'add_element', id: 'ent-shopper', parent: null, name: 'shopper', kind: 'actor', title: 'Shopper' },
        { op: 'add_element', id: 'ent-storefront', parent: null, name: 'storefront', kind: 'system', title: 'Storefront' },
        { op: 'add_element', id: 'ent-web', parent: 'ent-storefront', name: 'web', kind: 'container', title: 'Web App', technology: 'Next.js' },
        { op: 'add_element', id: 'ent-orders-db', parent: 'ent-storefront', name: 'orders_db', kind: 'datastore', title: 'Orders DB' },
        { op: 'add_relationship', id: 'rel-shopper-uses-web', from: 'ent-shopper', to: 'ent-web', kind: 'uses' },
        { op: 'add_relationship', id: 'rel-web-writes-orders', from: 'ent-web', to: 'ent-orders-db', kind: 'writes_to' },
      ],
    }, { actor: 'adopter', expectedBaseRevision: head!, date: '2026-06-01T01:00:00Z' })
    expect(r.validation.ok).toBe(true)
    await setDisposition(dir, 'CHG-1', 'accepted', { actor: 'adopter', date: '2026-06-01T02:00:00Z' })
    const p = await promoteChangeSet(dir, 'CHG-1', { actor: 'adopter', date: '2026-06-01T03:00:00Z' })
    expect(p.added).toHaveLength(6)

    const q = await qualifyBaseline(dir, { highlight: false })
    expect(q.counts).toEqual({ verified: 0, partial: 0, failed: 0, unverified: 6, unrecorded: 0 })
    expect(q.entities.get('ent-web')!.reason).toMatch(/inferred during adoption \(CHG-1\); no evidence yet/)

    const story = await storyOf(dir, { entity: 'ent-storefront', subtree: true })
    expect(story.entries[0]).toMatchObject({ changeId: 'CHG-1', inferred: true, promoted: true, verification: { status: 'unverified' } })
    expect(formatStory(story)).toContain('accepted / implemented / unverified / promoted / inferred')
  })
})

describe('adopting an existing LikeC4 model', () => {
  let dir: string
  beforeAll(async () => {
    dir = join(root, 'existing')
    await mkdir(join(dir, 'model'), { recursive: true })
    await writeFile(join(dir, 'model', 'specs.c4'), 'specification {\n  element system\n  element container\n  relationship uses\n  tag legacy\n}\n', 'utf8')
    await writeFile(join(dir, 'model', 'model.c4'), [
      'model {',
      "  crm = system 'CRM' {",
      "    api = container 'CRM API' {",
      "      technology 'Java'",
      "      metadata { stable_id 'ent-crm-api' }",   // one element already identified
      '    }',
      "    db = container 'CRM DB'",
      "    api -[uses]-> db 'reads'",
      '  }',
      "  mailer = system 'Mailer' {",
      '    #legacy',
      '  }',
      "  crm.api -[uses]-> mailer 'sends email'",
      "  crm.api -[uses]-> mailer 'sends sms'",
      '}',
      'views {',
      '  view index {',
      '    include *',
      '  }',
      '}',
      '',
    ].join('\n'), 'utf8')
  })

  it('assigns missing stable ids, regenerates, and records inferred pre-ledger change sets per root', async () => {
    const r = await adoptExistingModel(dir, { actor: 'adopter', date: '2026-06-02T00:00:00Z' })
    expect(r.assignedIds).toEqual({ elements: 3, relationships: 3 }) // crm.api already had one
    expect(r.changeSets.map(c => `${c.id}:${c.title}:${c.operations}`)).toEqual([
      'CHG-1:Inferred baseline: CRM:4',
      'CHG-2:Inferred baseline: Mailer:1',
      'CHG-3:Inferred baseline: cross-boundary relationships:2',
    ])
    expect((await readdir(join(dir, 'model'))).sort()).toEqual(['model.c4'])

    const loaded = await loadModel(dir)
    expect(loaded.errors).toEqual([])
    const reg = IdentityRegistry.fromModel(loaded.model)
    expect(reg.problems).toEqual([])
    expect(reg.element('ent-crm-api')!.fqn).toBe('crm.api')       // kept
    expect(reg.element('ent-crm-db')!.fqn).toBe('crm.db')         // assigned from fqn
    expect(reg.elementByFqn('mailer')!.stableId).toBe('ent-mailer')
    const relIds = reg.relationships().map(x => x.stableId).sort()
    expect(relIds).toEqual(['rel-api-uses-db', 'rel-api-uses-mailer', 'rel-api-uses-mailer-2']) // parallel edges deduped
    expect(loaded.model.element('mailer').isTagged('legacy')).toBe(true)

    const ledger = await Ledger.load(dir)
    const c1 = ledger.get('CHG-1')!.changeSet
    expect(c1).toMatchObject({ inferred: true, disposition: 'accepted', promotion: { baseline: 'pre-ledger', actor: 'adopter' } })
    expect(c1.operations.map(o => o.op)).toEqual(['add_element', 'add_element', 'add_element', 'add_relationship'])
    expect(c1.operations.map(o => o.id)).toEqual(['ent-crm', 'ent-crm-api', 'ent-crm-db', 'rel-api-uses-db'])
    // The regenerated model keeps the tag colour it was assigned, as hex the parser accepts.
    expect((loaded.model.$data.specification as any).tags.legacy.color).toMatch(/^#[0-9a-fA-F]{6}$/)
    expect(ledger.get('CHG-2')!.changeSet.operations[0]).toMatchObject({ op: 'add_element', id: 'ent-mailer', tags: ['legacy'] })
    expect(ledger.get('CHG-1')!.unrecorded).toBe(false)

    const q = await qualifyBaseline(dir, { highlight: false })
    expect(q.counts).toEqual({ verified: 0, partial: 0, failed: 0, unverified: 7, unrecorded: 0 })
    const story = await storyOf(dir, { entity: 'crm.api' })
    expect(story.entries.map(e => e.changeId)).toEqual(['CHG-1', 'CHG-3'])
    expect(story.entries[0]!.inferred).toBe(true)
  })

  it('is idempotent: a second run records nothing new', async () => {
    const before = await new Git(dir).headSha()
    const r = await adoptExistingModel(dir, { actor: 'adopter' })
    expect(r.changeSets).toEqual([])
    expect(r.assignedIds).toEqual({ elements: 0, relationships: 0 })
    expect(r.skipped).toBe(7)
    expect(await new Git(dir).headSha()).toBe(before)
  })

  it('refuses to adopt a model that does not load', async () => {
    const bad = join(root, 'bad')
    await mkdir(join(bad, 'model'), { recursive: true })
    await writeFile(join(bad, 'model', 'model.c4'), 'model { x = nope }\n', 'utf8')
    await expect(adoptExistingModel(bad, { actor: 'a' })).rejects.toThrow(/invalid LikeC4 model/)
    expect(await readFile(join(bad, 'model', 'model.c4'), 'utf8')).toBe('model { x = nope }\n')
  })
})

describe('slug', () => {
  it('produces valid stable-id material', () => {
    expect(slug('crm.api')).toBe('crm-api')
    expect(slug('Payment Gateway (v2)')).toBe('payment-gateway-v2')
    expect(slug('3rd_party')).toBe('x3rd-party')
  })
})
