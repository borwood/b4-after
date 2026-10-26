// Baseline vs candidate rendering (AT-10): build a candidate in memory, materialize it as a disposable
// LikeC4 workspace via the DSL generator, verify it parses, lay out both, and (if a browser is available)
// export PNGs for both.
import { LikeC4 } from 'likec4'
import { generate as generateLikeC4 } from 'likec4/generators/likec4'
import { LikeC4Model } from '@likec4/core/model'
import { computeParsedModelData } from '@likec4/core/compute-view'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { load, outDir, here, section, bytes } from './_common.mjs'

const likec4 = await load()

section('1. build candidate: CHG-042 add retry worker + relationship, and remove ledger_db (two ops types)')
const candidateBuilder = (await likec4.toBuilder())
  .model(({ component, rel }, _) => _(
    component('billing.billing_api.retry_worker', {
      title: 'Billing Retry Worker', technology: 'Node.js worker',
      tags: ['candidate'], metadata: { stable_id: 'ent-billing-retry-worker', change: 'CHG-042' },
      style: { color: 'amber', border: 'dashed' },   // visual distinction for AT-10; tag color alone does not restyle nodes
    }),
    rel('billing.billing_api.charges', 'billing.billing_api.retry_worker', {
      kind: 'publishes_to', title: 'enqueues retries', tags: ['candidate'], color: 'amber',
    }),
  ))
const data = candidateBuilder.build()
// remove_element via data surgery
delete data.elements['billing.ledger_db']
for (const [id, r] of Object.entries(data.relations)) {
  if (r.source?.model === 'billing.ledger_db' || r.target?.model === 'billing.ledger_db') delete data.relations[id]
}
const candidate = LikeC4Model.create(computeParsedModelData(data))
console.log(' candidate elements:', [...candidate.elements()].map(e => e.id).join(', '))
console.log(' candidate views   :', [...candidate.views()].map(v => `${v.id}(${[...v.nodes()].length} nodes, ${[...v.edges()].length} edges)`).join(', '))

section('2. generateLikeC4(): materialize candidate as DSL')
let dsl
// FINDING: generating from a COMPUTED model's $data silently drops view rules (computed views hold
// nodes/edges, not include/exclude predicates), yielding empty views. Always generate from PARSED data.
for (const [label, input] of [['builder.build() data (parsed)', data], ['candidate.$data (computed)', candidate.$data]]) {
  try {
    dsl = generateLikeC4(input)
    console.log(` OK with ${label}: ${bytes(dsl)} bytes`)
    break
  } catch (e) { console.log(` FAIL with ${label}: ${e.message.slice(0, 160)}`) }
}
if (!dsl) { await likec4.dispose(); process.exit(1) }
const candWs = join(outDir, 'candidate-ws')
rmSync(candWs, { recursive: true, force: true }); mkdirSync(candWs, { recursive: true })
writeFileSync(join(candWs, 'candidate.c4'), dsl)
console.log(' --- generated candidate DSL (model section excerpt) ---')
const lines = dsl.split('\n'); const mi = lines.findIndex(l => l.startsWith('model'))
console.log(lines.slice(mi, mi + 40).map(l => '   ' + l).join('\n'))

section('3. does the generated candidate workspace parse and compute identically?')
const cand2 = await LikeC4.fromWorkspace(candWs, { logger: false, throwIfInvalid: false })
const errs = cand2.getErrors()
console.log(' errors:', errs.length, errs.slice(0, 5).map(e => `${e.line}: ${e.message.slice(0, 100)}`))
const cm2 = await cand2.computedModel()
const sig = (m) => JSON.stringify({ e: [...m.elements()].map(e => e.id).sort(), r: [...m.relationships()].map(r => `${r.source.id}>${r.target.id}:${r.kind}`).sort(), v: [...m.views()].map(v => v.id).sort() })
console.log(' same elements/relationships/views as in-memory candidate:', sig(cm2) === sig(candidate))
console.log(' retry_worker still tagged candidate:', cm2.element('billing.billing_api.retry_worker').isTagged('candidate'))

section('4. layout both (graphviz wasm, no browser)')
const lb = await likec4.layoutedModel(); const lc = await cand2.layoutedModel()
for (const [label, m] of [['baseline ', lb], ['candidate', lc]]) {
  const v = m.view('billing')
  console.log(` ${label} billing view: ${[...v.nodes()].length} nodes, ${[...v.edges()].length} edges, bounds=${JSON.stringify(v.$view.bounds)}`)
}
const candNode = [...lc.view('billing').nodes()].find(n => n.id === 'billing.billing_api.retry_worker')
console.log(' candidate node in layouted view:', candNode ? `color=${candNode.color} tags=${JSON.stringify(candNode.tags)} keys=${Object.keys(candNode.$node).join(',')}` : 'NOT FOUND')
console.log(' spec tag colors in candidate:', JSON.stringify(lc.$data.specification.tags))

section('5. PNG export via CLI (playwright)')
const bin = join(here, '..', 'node_modules', 'likec4', 'bin', 'likec4.mjs')
for (const [label, ws] of [['baseline', join(here, '..', 'model')], ['candidate', candWs]]) {
  const out = join(outDir, 'png', label)
  mkdirSync(out, { recursive: true })
  const r = spawnSync(process.execPath, [bin, 'export', 'png', ws, '-o', out, '--flat', '-f', 'billing', '-t', '60', '--max-attempts', '1'], { encoding: 'utf8', timeout: 180000 })
  const files = existsSync(out) ? readdirSync(out) : []
  const tail = (r.stdout + r.stderr).split('\n').filter(l => /error|fail|export|browser|install|chromium/i.test(l)).slice(-4).map(l => l.replace(/\x1b\[[0-9;]*m/g, '').trim())
  console.log(` ${label}: exit=${r.status} files=${JSON.stringify(files)}`)
  for (const l of tail) console.log('    ' + l.slice(0, 200))
}

await cand2.dispose(); await likec4.dispose()
