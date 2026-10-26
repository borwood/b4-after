import { LikeC4Model } from '@likec4/core/model'
import { computeLikeC4Model, computeParsedModelData } from '@likec4/core/compute-view'
import { load, writeOut, section, summarize } from './_common.mjs'

const likec4 = await load()
const baselineBefore = summarize(await likec4.computedModel())
writeOut('02-baseline.json', baselineBefore)
const relIds = (s) => s.relationships.map(x => x.split(':')[0]).sort().join(',')

// ---------- A. add_element + add_relationship via Builder (documented path) ----------
section('A. add element + relationship via toBuilder()')
try {
  const candidate = (await likec4.toBuilder())
    .model(({ component, rel }, _) => _(
      component('billing.billing_api.retry_worker', {
        title: 'Billing Retry Worker',
        tags: ['candidate'],
        metadata: { stable_id: 'ent-billing-retry-worker' },
      }),
      // NOTE: LikeC4 forbids relationships between an element and its own ancestor/descendant
      // ("Cannot create relationship between elements in the same hierarchy"). This spike nests the
      // worker under billing_api, so the relationship must come from a sibling (charges).
      rel('billing.billing_api.charges', 'billing.billing_api.retry_worker', {
        kind: 'publishes_to', title: 'enqueues retries', tags: ['candidate'],
      }),
    ))
    .toLikeC4Model()
  const s = summarize(candidate)
  console.log(' candidate has retry_worker:', s.elements.includes('billing.billing_api.retry_worker'))
  console.log(' candidate relationships:', s.relationships.length, '(baseline', baselineBefore.relationships.length + ')')
  console.log(' candidate stage:', candidate.stage, ' views:', s.views.length)
  const rw = candidate.element('billing.billing_api.retry_worker')
  console.log(' tagged candidate:', rw.isTagged('candidate'), ' parent:', rw.parent?.id)
  const bv = candidate.view('billing')
  console.log(' billing view now shows:', [...bv.nodes()].map(n => n.id).join(', '))
  writeOut('02-candidate-A.json', s)
} catch (e) { console.log(' FAILED:', e.message) }

// ---------- B. update_element: replace semantics ----------
section('B. update element via re-declaration (replace, not merge)')
try {
  const parsed = await likec4.parsedModel()
  const existing = parsed.element('billing.invoice_ui')
  console.log(' before: technology=%s metadata=%j', existing.technology, existing.getMetadata())
  const naive = (await likec4.toBuilder())
    .model(({ container }, _) => _(container('billing.invoice_ui', { technology: 'Next.js' })))
    .toLikeC4Model()
  const n = naive.element('billing.invoice_ui')
  console.log(' naive update : technology=%s title=%s metadata=%j', n.technology, n.title, n.getMetadata())
  const careful = (await likec4.toBuilder())
    .model(({ container }, _) => _(container('billing.invoice_ui', {
      title: existing.title, technology: 'Next.js', metadata: existing.getMetadata(),
    })))
    .toLikeC4Model()
  const c = careful.element('billing.invoice_ui')
  console.log(' careful update: technology=%s title=%s metadata=%j', c.technology, c.title, c.getMetadata())
  console.log(' relationships preserved:', summarize(careful).relationships.length === baselineBefore.relationships.length)
  try {
    (await likec4.toBuilder()).model(({ component }, _) => _(component('billing.invoice_ui'))).toLikeC4Model()
    console.log(' kind change: ALLOWED (unexpected)')
  } catch (e) { console.log(' kind change rejected:', e.message.slice(0, 120)) }
} catch (e) { console.log(' FAILED:', e.message) }

// ---------- C0. which "parsed data -> computed model" path works at all? ----------
section('C0. compute paths on UNMODIFIED builder.build() data')
const toComputed = (data) => {
  // computeParsedModelData is what Builder.toLikeC4Model() calls internally (verified in dist/builder/index.mjs).
  // computeLikeC4Model() expects a different input shape and throws on parsed data.
  const attempts = [
    ['computeParsedModelData(data)', () => LikeC4Model.create(computeParsedModelData(data))],
    ['computeLikeC4Model(data)', () => LikeC4Model.create(computeLikeC4Model(data))],
    ['LikeC4Model.create(data) (parsed stage)', () => LikeC4Model.create(data)],
  ]
  const errors = []
  for (const [name, fn] of attempts) {
    try { const m = fn(); return { name, model: m } } catch (e) { errors.push(`${name}: ${e.message.slice(0, 100)}`) }
  }
  throw new Error('no compute path worked:\n   ' + errors.join('\n   '))
}
try {
  const raw = (await likec4.toBuilder()).build()
  console.log(' build() keys/types:', Object.entries(raw).map(([k, v]) => `${k}:${v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v}`).join(' '))
  const r = toComputed(raw)
  console.log(' working path:', r.name, '-> stage', r.model.stage, 'views', [...r.model.views()].length)
} catch (e) { console.log(' FAILED:', e.message) }

// ---------- C. remove_element via build() data surgery ----------
section('C. remove element (data surgery on build() + LikeC4Model.fromParsed)')
try {
  const data = (await likec4.toBuilder()).build()
  const victim = 'billing.ledger_db'
  const refersTo = (ref) => ref?.model === victim || ref?.model?.startsWith(victim + '.')
  delete data.elements[victim]
  const removedRels = []
  for (const [id, r] of Object.entries(data.relations)) {
    if (refersTo(r.source) || refersTo(r.target)) { removedRels.push(id); delete data.relations[id] }
  }
  console.log(' removed element + relations:', removedRels)
  const m = LikeC4Model.fromParsed(data)
  const s = summarize(m)
  console.log(' fromParsed ok. stage=%s has ledger_db=%s rels=%d', m.stage, s.elements.includes(victim), s.relationships.length)
  const { name, model: cm } = toComputed(data)
  console.log(' compute via %s ok. stage=%s views=%d', name, cm.stage, [...cm.views()].length)
  const bv = cm.view('billing')
  console.log(' billing view nodes:', [...bv.nodes()].map(n => n.id).join(', '))
  writeOut('02-candidate-C-remove.json', s)
} catch (e) { console.log(' FAILED:', e.message, e.stack?.split('\n')[1]) }

// ---------- D. move_element via data surgery (rename FQN) ----------
section('D. move element billing.billing_api.charges -> billing.charges (data surgery)')
try {
  const data = (await likec4.toBuilder()).build()
  const from = 'billing.billing_api.charges', to = 'billing.charges'
  const remap = (fqn) => fqn === from ? to : fqn.startsWith(from + '.') ? to + fqn.slice(from.length) : fqn
  const newElements = {}
  for (const [fqn, el] of Object.entries(data.elements)) {
    const nf = remap(fqn)
    newElements[nf] = { ...el, id: nf }
  }
  data.elements = newElements
  for (const r of Object.values(data.relations)) {
    if (r.source?.model) r.source = { ...r.source, model: remap(r.source.model) }
    if (r.target?.model) r.target = { ...r.target, model: remap(r.target.model) }
  }
  const { model: m } = toComputed(data)
  const s = summarize(m)
  console.log(' moved ok:', s.elements.includes(to), '/ old gone:', !s.elements.includes(from))
  console.log(' relations touching charges:\n   ' + s.relationships.filter(x => x.includes('charges')).join('\n   '))
  console.log(' relation ids unchanged after move:', relIds(s) === relIds(baselineBefore))
  console.log(' billing view nodes (rule was include billing.billing_api.*):', [...m.view('billing').nodes()].map(n => n.id).join(', '))
} catch (e) { console.log(' FAILED:', e.message, e.stack?.split('\n')[1]) }

// ---------- E. invalid candidate must be rejected ----------
section('E. invalid candidate: unknown target / unknown kind / dangling relation')
try {
  (await likec4.toBuilder()).model(({ rel }, _) => _(rel('billing.billing_api', 'billing.does_not_exist', { kind: 'uses' }))).toLikeC4Model()
  console.log(' unknown target: ACCEPTED (bad)')
} catch (e) { console.log(' unknown target rejected:', e.message.slice(0, 140)) }
try {
  (await likec4.toBuilder()).model(({ rel }, _) => _(rel('billing.billing_api', 'billing.ledger_db', { kind: 'teleports_to' }))).toLikeC4Model()
  console.log(' unknown relationship kind: ACCEPTED (no spec validation at build time)')
} catch (e) { console.log(' unknown kind rejected:', e.message.slice(0, 140)) }
try {
  (await likec4.toBuilder()).model(({ component }, _) => _(component('billing.ghost_parent.child'))).toLikeC4Model()
  console.log(' element under missing parent: ACCEPTED (bad)')
} catch (e) { console.log(' element under missing parent rejected:', e.message.slice(0, 140)) }
try {
  const data = (await likec4.toBuilder()).build()
  data.relations['bogus'] = { id: 'bogus', source: { model: 'billing' }, target: { model: 'nope' }, kind: 'uses' }
  const { model: m } = toComputed(data)
  console.log(' fromParsed with dangling relation: ACCEPTED, rels=%d (validation is our job)', [...m.relationships()].length)
} catch (e) { console.log(' dangling relation via fromParsed rejected:', e.message.slice(0, 140)) }

// ---------- F. baseline isolation ----------
section('F. baseline unchanged after all candidate work')
const baselineAfter = summarize(await likec4.computedModel())
console.log(' baseline identical:', JSON.stringify(baselineAfter) === JSON.stringify(baselineBefore))
const m1 = await likec4.computedModel(), m2 = await likec4.computedModel()
console.log(' computedModel() returns same instance each call:', m1 === m2)

section('G. does model.addElement() on the live model leak into the baseline?')
try {
  const live = await likec4.computedModel()
  const before = [...live.elements()].length
  const result = live.addElement({
    id: 'billing.leak_probe', kind: 'component', title: 'Leak Probe',
    description: null, technology: null, tags: [], links: null, style: {}, metadata: {},
  })
  const after = [...(await likec4.computedModel()).elements()].length
  console.log(' addElement returned:', result?.constructor?.name, '| elements before=%d after(next computedModel())=%d', before, after)
  console.log(' => live model is %s; our facade must never hand agents the shared instance for candidate work',
    after > before ? 'MUTABLE AND SHARED (leak!)' : 'safe')
} catch (e) { console.log(' addElement threw:', e.message.slice(0, 160)) }

await likec4.dispose()
