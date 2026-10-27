import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Git } from '@borwood/b4-after-ledger'
import { createServer } from '../src/server.js'
import { RepoContext } from '../src/context.js'

const EXAMPLE_DIR = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'examples', 'billing')

let dir: string
let git: Git
let client: Client
let ctx: RepoContext

async function connect(options: { actor?: string } = {}): Promise<{ client: Client; ctx: RepoContext }> {
  const c = new RepoContext(dir, options)
  const server = createServer(c)
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  const cl = new Client({ name: 'test', version: '0' })
  await cl.connect(ct)
  return { client: cl, ctx: c }
}

const call = async (cl: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = await cl.callTool({ name, arguments: args })
  const text = (r.content as any[]).find(c => c.type === 'text')?.text ?? ''
  let json: any = null
  try { json = JSON.parse(text) } catch { /* help returns plain text */ }
  return { isError: !!r.isError, text, json }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'b4-after-'))
  git = new Git(dir)
  await git.exec(['init', '-q', '-b', 'main'])
  await git.exec(['config', 'user.name', 'fixture'])
  await git.exec(['config', 'user.email', 'fixture@example.test'])
  await cp(EXAMPLE_DIR, dir, { recursive: true })
  await git.add(['.'])
  await git.commit('bootstrap\n', { date: '2026-01-10T10:00:00Z' })
  ;({ client, ctx } = await connect())
})
afterAll(async () => { await client.close(); await rm(dir, { recursive: true, force: true }) })

describe('surface', () => {
  it('exposes 19 tools with a small token footprint, and help on demand', async () => {
    const tools = (await client.listTools()).tools
    expect(tools.map(t => t.name).sort()).toEqual([
      'bootstrap', 'change', 'changes', 'element', 'expand', 'help', 'overview', 'project', 'promote', 'propose', 'qualify', 'reconcile', 'record_evidence', 'releases', 'render', 'search', 'set_disposition', 'story', 'validate',
    ])
    const bytes = JSON.stringify(tools).length
    expect(bytes).toBeLessThan(14_000) // roughly 3.5k tokens for the whole tool list
    for (const t of tools) expect((t.description ?? '').length).toBeLessThan(120)

    const index = await call(client, 'help')
    expect(index.text).toMatch(/Topics/)
    const start = await call(client, 'help', { topic: 'start' })
    expect(start.text).toMatch(/1\. overview/)
    const ids = await call(client, 'help', { topic: 'concurrency' })
    expect(ids.text).toMatch(/expected_head/)
    const status = await call(client, 'help', { topic: 'status' })
    expect(status.text).toMatch(/b4-intended/)
  })

  it('overview is bounded and carries head', async () => {
    const r = await call(client, 'overview')
    expect(r.isError).toBe(false)
    expect(r.json.ok).toBe(true)
    expect(r.json.head).toMatch(/^[0-9a-f]{7}$/)
    expect(r.json.roots.map((x: any) => x.id)).toEqual(['ent-customer', 'ent-billing', 'ent-payment-gateway'])
    expect(r.json.model.elements).toBe(7)
    expect(r.json.ledger).toMatchObject({ changeSets: 3, promoted: 1, open: ['CHG-042'] })
    expect(r.json.identity.withoutStableId).toBe(0)
    expect(JSON.stringify(r.json).length).toBeLessThan(1500)
  })

  it('search, expand, element are compact and resolve both ids and fqns', async () => {
    const s = await call(client, 'search', { query: 'billing', limit: 3 })
    expect(s.json.elements[0]).toMatchObject({ id: 'ent-billing', fqn: 'billing' })
    expect(s.json.truncated).toBe(true)

    const e = await call(client, 'expand', { entity: 'billing', depth: 2 })
    expect(e.json.entity.id).toBe('ent-billing')
    expect(e.json.descendants.map((d: any) => `${d.id}@${d.depth}`)).toEqual(['ent-invoice-ui@1', 'ent-billing-api@1', 'ent-charges@2', 'ent-ledger-db@1'])
    expect(e.json.relationships.map((r: any) => r.id).sort()).toEqual(['rel-charges-cards', 'rel-charges-persist-ledger-db', 'rel-customer-views-invoices', 'rel-invoice-ui-calls-billing-api'])

    const d = await call(client, 'element', { entity: 'ent-charges', qualify: true })
    expect(d.json).toMatchObject({ id: 'ent-charges', fqn: 'billing.billing_api.charges', parent: 'ent-billing-api', changeSets: ['CHG-037', 'CHG-043'] })
    expect(d.json.outgoing.map((r: any) => r.to).sort()).toEqual(['ent-ledger-db', 'ent-payment-gateway'])
    expect(d.json.qualification).toMatchObject({ status: 'unrecorded' })

    const nf = await call(client, 'expand', { entity: 'ent-nope' })
    expect(nf.isError).toBe(true)
    expect(nf.json.code).toBe('NOT_FOUND')
  })

  it('story summary rows are terse; full detail available', async () => {
    const r = await call(client, 'story', { entity: 'ent-billing', subtree: true })
    expect(r.json.entries.map((e: any) => e.change)).toEqual(['CHG-037', 'CHG-042', 'CHG-043'])
    expect(r.json.entries[1]).toMatchObject({ state: 'proposed/not_started/unverified', matched: ['ent-billing-api:relationship_source', 'ent-invoice-ui:relates_to'] })
    expect(r.json.entries[0].state).toBe('accepted/implemented/verified/promoted')
    const full = await call(client, 'story', { entity: 'ent-billing-api', detail: 'full' })
    expect(full.json.story.entries[0].operations).toHaveLength(2)
    expect(full.json.story.entries[0].evidence.derivation.status).toBe('unverified')
  })

  it('changes and change', async () => {
    const list = await call(client, 'changes', { promoted: false })
    expect(list.json.changes.map((c: any) => c.change)).toEqual(['CHG-042', 'CHG-043'])
    const one = await call(client, 'change', { change_id: 'CHG-037', include_evidence: true })
    expect(one.json.verification).toMatchObject({ status: 'verified', basis: ['ev-037-ci'], approvals: ['ev-037-review'] })
    expect(one.json.evidence).toHaveLength(2)
    const prod = await call(client, 'change', { change_id: 'CHG-037', environment: 'production' })
    expect(prod.json.verification.status).toBe('unverified')
  })
})

describe('guidance', () => {
  it('documents planning ahead of building', async () => {
    const plan = await call(client, 'help', { topic: 'plan' })
    expect(plan.text).toMatch(/promote the plan/)
    expect(plan.text).toMatch(/targets=\[ids built\]/)
  })
})

describe('writes and concurrency', () => {
  const cs = (id: string, name: string) => ({
    id, title: `Add ${name}`, intent: 'test', operations: [{ op: 'add_element', id: `ent-${name}`, parent: 'ent-billing', name, kind: 'component' }],
  })

  it('requires an actor and validates before writing', async () => {
    const noActor = await call(client, 'propose', { change_set: cs('CHG-100', 'a') })
    expect(noActor.isError).toBe(true)
    expect(noActor.json.error).toMatch(/actor is required/)
    const bad = await call(client, 'propose', { change_set: { ...cs('CHG-100', 'a'), operations: [{ op: 'remove_element', id: 'ent-nope' }] }, actor: 'agent-a' })
    expect(bad.json.code).toBe('VALIDATION')
    expect(bad.json.issues[0]).toMatchObject({ code: 'E_UNKNOWN_ENTITY', path: '/operations/0/id' })
    const v = await call(client, 'validate', { change_set: cs('CHG-100', 'a') })
    expect(v.json.valid).toBe(true)
  })

  it('two agents proposing concurrently both land, serialised by the lock', async () => {
    const a = await connect({ actor: 'agent-a' })
    const b = await connect({ actor: 'agent-b' })
    const [ra, rb] = await Promise.all([
      call(a.client, 'propose', { change_set: cs('CHG-101', 'alpha') }),
      call(b.client, 'propose', { change_set: cs('CHG-102', 'beta') }),
    ])
    expect(ra.json.ok && rb.json.ok).toBe(true)
    expect(ra.json.head).not.toBe(rb.json.head)
    const list = await call(client, 'changes', { disposition: 'proposed' })
    expect(list.json.changes.map((c: any) => c.change)).toEqual(expect.arrayContaining(['CHG-101', 'CHG-102']))
    await a.client.close(); await b.client.close()
  })

  it('validate sees entities introduced by unpromoted dependencies and says which were projected', async () => {
    const follow = {
      id: 'CHG-105', title: 'Wire alpha', intent: 'test', depends_on: ['CHG-101'],
      operations: [{ op: 'add_relationship', id: 'rel-alpha-uses-api', from: 'ent-alpha', to: 'ent-billing-api', kind: 'uses' }],
    }
    const seen = await call(client, 'validate', { change_set: follow })
    expect(seen.json).toMatchObject({ valid: true, projected_dependencies: ['CHG-101'] })
    const bare = await call(client, 'validate', { change_set: { ...follow, depends_on: [] } })
    expect(bare.json.valid).toBe(false)
    expect(bare.json.projected_dependencies).toBeUndefined()
    const keyword = await call(client, 'validate', { change_set: cs('CHG-106', 'head') })
    expect(keyword.json.valid).toBe(false)
    expect(keyword.json.issues[0]).toMatchObject({ code: 'E_RESERVED_WORD', path: '/operations/0/name' })
  })

  it('expected_head (short sha accepted) refuses a write on a moved repository', async () => {
    const before = (await call(client, 'overview')).json.head
    await call(client, 'propose', { change_set: cs('CHG-103', 'gamma'), actor: 'agent-a' })
    const stale = await call(client, 'propose', { change_set: cs('CHG-104', 'delta'), actor: 'agent-b', expected_head: before })
    expect(stale.isError).toBe(true)
    expect(stale.json.code).toBe('REPO_MOVED')
    const fresh = (await call(client, 'overview')).json.head
    const okr = await call(client, 'propose', { change_set: cs('CHG-104', 'delta'), actor: 'agent-b', expected_head: fresh })
    expect(okr.json.ok).toBe(true)
  })

  it('reports a busy lock instead of hanging', async () => {
    const quick = new RepoContext(dir, { lockTimeoutMs: 300 })
    const server = createServer(quick)
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    const cl = new Client({ name: 't', version: '0' }); await cl.connect(ct)
    let release!: () => void
    const held = ctx.withWriteLock(() => new Promise<void>(r => { release = r }))
    await new Promise(r => setTimeout(r, 50))
    const busy = await call(cl, 'set_disposition', { change_id: 'CHG-101', to: 'accepted', actor: 'x' })
    expect(busy.json.code).toBe('LOCK_BUSY')
    release(); await held
    await cl.close()
  })

  it('full workflow through the server: accept, project, promote, evidence, qualify', async () => {
    const acc = await call(client, 'set_disposition', { change_id: 'CHG-101', to: 'accepted', actor: 'reviewer' })
    expect(acc.json.disposition).toBe('accepted')

    const proj = await call(client, 'project', { changes: ['CHG-101'], render: 'dsl' })
    expect(proj.json.applied).toEqual(['CHG-101'])
    expect(proj.json.diff.added.map((x: any) => x.entityId)).toEqual(['ent-alpha'])
    expect(proj.json.dsl).toMatch(/alpha = component/)
    const promotedCheck = await call(client, 'project', { changes: ['CHG-037'] })
    expect(promotedCheck.json.code).toBe('PROJECTION')
    expect(promotedCheck.json.issues[0].code).toBe('E_ALREADY_PROMOTED')

    const refused = await call(client, 'promote', { change_id: 'CHG-102', actor: 'agent' })
    expect(refused.json.code).toBe('REFUSED')
    const prom = await call(client, 'promote', { change_id: 'CHG-101', actor: 'agent', expected_head: acc.json.head })
    expect(prom.json).toMatchObject({ ok: true, change: 'CHG-101', added: ['ent-alpha'], deferred: [] })
    expect(await readFile(join(dir, 'model', 'model.c4'), 'utf8')).toMatch(/alpha = component/)
    expect((await call(client, 'overview')).json.model.elements).toBe(8)
    // Promoted but unverified: present, and every row says it is only intended.
    const intended = await call(client, 'element', { entity: 'ent-alpha' })
    expect(intended.json).toMatchObject({ pending: ['intended'], tags: ['b4-intended'], metadata: { b4_change: 'CHG-101', b4_status: 'unverified' } })
    expect((await call(client, 'search', { query: 'alpha' })).json.elements[0].pending).toEqual(['intended'])
    expect((await call(client, 'expand', { entity: 'ent-billing' })).json.descendants.find((d: any) => d.id === 'ent-alpha').pending).toEqual(['intended'])
    expect((await call(client, 'changes', { entity: 'ent-alpha' })).json.changes[0].state).toBe('accepted/not_started/unverified/promoted')

    const ev = await call(client, 'record_evidence', { change_id: 'CHG-101', actor: 'ci', evidence: {
      id: 'ev-101-ci', kind: 'test', result: 'pass', source_ref: 'https://ci/1', code_revision: 'abcdef0', environment: 'staging', observed_at: '2026-05-01T00:00:00Z', recorded_by: 'ci',
    } })
    expect(ev.json).toMatchObject({ ok: true, evidence: 'ev-101-ci', verification: 'verified', reconcile: { changed: true } })
    expect(ev.json.head).not.toBe(prom.json.head)
    const real = await call(client, 'element', { entity: 'ent-alpha' })
    expect(real.json.pending).toBeUndefined()
    expect(real.json.metadata.b4_status).toBe('verified')
    const idle = await call(client, 'reconcile', { actor: 'ci' })
    expect(idle.json).toMatchObject({ ok: true, changed: false, applied: [] })
    expect(idle.json.counts.as_is).toBeGreaterThan(0)

    const q = await call(client, 'qualify', { environment: 'staging' })
    expect(q.json.counts.verified).toBe(3) // ledger_db + its relationship (CHG-037) and alpha (CHG-101)
    const qp = await call(client, 'qualify', { environment: 'production', detail: 'full' })
    expect(qp.json.entities.find((e: any) => e.id === 'ent-alpha').status).toBe('unverified')

    const story = await call(client, 'story', { entity: 'ent-alpha', environment: 'staging' })
    expect(story.json.entries[0].state).toBe('accepted/implemented/verified@staging/promoted')
    expect((await call(client, 'change', { change_id: 'CHG-101' })).json.implementation).toBe('implemented')

    // Releases: a deployment of the promoted change set gives staging a released baseline.
    const none = await call(client, 'releases', { environment: 'staging', detail: 'baseline' })
    expect(none.json.revision).toBeNull()
    await call(client, 'record_evidence', { change_id: 'CHG-101', actor: 'cd', evidence: {
      id: 'ev-101-deploy', kind: 'deployment', result: 'pass', environment: 'staging', source_ref: 'https://cd/1', observed_at: '2026-05-02T00:00:00Z', recorded_by: 'cd',
    } })
    const tl = await call(client, 'releases', {})
    expect(tl.json.events).toHaveLength(1)
    expect(tl.json.events[0]).toMatchObject({ change: 'CHG-101', env: 'staging', result: 'pass', baseline: prom.json.head })
    const rel = await call(client, 'releases', { environment: 'staging', detail: 'baseline' })
    expect(rel.json).toMatchObject({ revision: prom.json.head, deployed: ['CHG-101'], failed: [] })
    expect(rel.json.model.elements).toBe(8)
    expect((await call(client, 'releases', { detail: 'baseline' })).json.code).toBe('VALIDATION')
  })

  it('render gives people the interactive site of the committed baseline', async () => {
    const dsl = await call(client, 'render', { format: 'dsl' })
    expect(dsl.json.views).toEqual(expect.arrayContaining(['index', 'index--target', 'el--billing--target']))
    expect(dsl.json.dsl).toMatch(/views \{/)
    const out = await mkdtemp(join(tmpdir(), 'b4-after-html-'))
    try {
      const html = await call(client, 'render', { out_dir: out })
      expect(html.json.html.file).toBe(join(out, 'index.html'))
      expect((await readFile(html.json.html.file, 'utf8')).length).toBeGreaterThan(500_000)
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  }, 240_000)

  it('bootstrap init on a directory that does not exist yet, nested in another repository', async () => {
    // The common dogfooding layout: <code repo>/architecture, before anything is there.
    const outer = await mkdtemp(join(tmpdir(), 'b4-after-outer-'))
    const fresh = join(outer, 'architecture')
    try {
      const og = new Git(outer)
      await og.exec(['init', '-q', '-b', 'main'])
      await og.exec(['config', 'user.name', 'outer']); await og.exec(['config', 'user.email', 'outer@example.test'])
      await writeFile(join(outer, 'README.md'), 'code\n'); await og.add(['.']); await og.commit('code\n')
      const c = new RepoContext(fresh, { actor: 'adopter' })
      const server = createServer(c)
      const [ct, st] = InMemoryTransport.createLinkedPair()
      await server.connect(st)
      const cl = new Client({ name: 't', version: '0' }); await cl.connect(ct)
      const empty = await call(cl, 'overview')
      expect(empty.json).toMatchObject({ ok: true, head: null, initialized: false })
      expect(empty.json.next).toMatch(/bootstrap mode=init/)
      const noName = await call(cl, 'bootstrap', { mode: 'init' })
      expect(noName.json.code).toBe('VALIDATION')
      const init = await call(cl, 'bootstrap', { mode: 'init', name: 'Shop', tags: ['external'] })
      expect(init.json).toMatchObject({ ok: true, mode: 'init' })
      expect(init.json.next).toMatch(/inferred/)
      // Its own repository, not a subtree of the outer one; nothing from the lock ended up in it.
      expect(await Git.isRepo(fresh)).toBe(true)
      expect((await og.exec(['status', '--porcelain'])).trim()).toBe('?? architecture/')
      expect(await new Git(fresh).exec(['ls-files'])).not.toMatch(/lock/)
      const ov = await call(cl, 'overview')
      expect(ov.json.initialized).toBeUndefined()
      expect(ov.json.model.elements).toBe(0)
      expect(ov.json.model.tags).toEqual(['external'])
      const adopt = await call(cl, 'bootstrap', { mode: 'adopt' })
      expect(adopt.json).toMatchObject({ ok: true, mode: 'adopt', change_sets: [] })
      const prop = await call(cl, 'propose', { change_set: {
        id: 'CHG-1', title: 'Inferred baseline: shop', intent: 'from README', inferred: true,
        operations: [{ op: 'add_element', id: 'ent-shop', parent: null, name: 'shop', kind: 'system', title: 'Shop' }],
      } })
      expect(prop.json.ok).toBe(true)
      await call(cl, 'set_disposition', { change_id: 'CHG-1', to: 'accepted' })
      const prom = await call(cl, 'promote', { change_id: 'CHG-1' })
      expect(prom.json.added).toEqual(['ent-shop'])
      const q = await call(cl, 'qualify', { detail: 'full' })
      expect(q.json.counts).toMatchObject({ unverified: 1, unrecorded: 0 })
      expect(q.json.entities[0].reason).toMatch(/inferred during adoption/)
      const adoptHelp = await call(cl, 'help', { topic: 'adopt' })
      expect(adoptHelp.text).toMatch(/Two paths/)
      await cl.close()
    } finally {
      await rm(outer, { recursive: true, force: true })
    }
  })

  it('snapshot cache follows out-of-band changes to the repository', async () => {
    const before = (await call(client, 'overview')).json.ledger.changeSets
    await writeFile(join(dir, 'changes', 'CHG-200.yaml'), 'id: CHG-200\ntitle: external\nintent: i\noperations:\n  - op: remove_element\n    id: ent-customer\n', 'utf8')
    const after = (await call(client, 'overview')).json.ledger.changeSets
    expect(after).toBe(before + 1)
    await git.exec(['clean', '-fq', '--', 'changes/CHG-200.yaml'])
    expect((await call(client, 'overview')).json.ledger.changeSets).toBe(before)
  })
})
