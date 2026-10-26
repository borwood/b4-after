import { LikeC4 } from 'likec4'
import { load, bytes, writeOut, section, byStableId } from './_common.mjs'

const likec4 = await load()
const model = await likec4.computedModel()

section('roots (overview)')
for (const r of model.roots()) console.log(` ${r.id} [${r.kind}] "${r.title}" children=${[...r.children()].length}`)

section('expand billing, depth 1')
for (const c of model.element('billing').children()) console.log(` ${c.id} [${c.kind}] stable_id=${c.getMetadata('stable_id')}`)

section('relationships with ids')
for (const r of model.relationships()) console.log(` ${r.id}  ${r.source.id} -[${r.kind}]-> ${r.target.id}  "${r.title}"`)

section('resolve stable_id -> fqn')
for (const sid of ['ent-charges', 'ent-ledger-db', 'ent-nope']) console.log(` ${sid} -> ${byStableId(model, sid)?.id ?? 'NOT FOUND'}`)

section('payload sizes')
const parsed = await likec4.parsedModel()
console.log(' parsed model data  :', bytes(parsed.$data), 'bytes')
console.log(' computed model data:', bytes(model.$data), 'bytes')
const el = model.element('billing.billing_api')
console.log(' one element ($element):', bytes(el.$element), 'bytes')
writeOut('01-parsed-data.json', parsed.$data)

section('relationship identity probe')
const src = (prefix = '') => `
specification {
  element c
  relationship uses
}
model {
  a = c
  b = c
  ${prefix}
  a -[uses]-> b "first"
  a -[uses]-> b "second"
  a -[uses]-> b "second"
  a -> b
}
views { view index { include * } }
`
const ids = async (text) => {
  const p = await LikeC4.fromSource(text, { logger: false, throwIfInvalid: true })
  const m = await p.computedModel()
  const out = [...m.relationships()].map(r => `${r.id} kind=${r.kind} title="${r.title}"`)
  await p.dispose()
  return out
}
const run1 = await ids(src())
console.log(' declared 4 relationships a->b (two identical); model has', run1.length)
for (const line of run1) console.log('  ' + line)
const run2 = await ids(src())
console.log(' same source re-parsed -> same ids:', JSON.stringify(run1) === JSON.stringify(run2))
const run3 = await ids(src('// a comment shifts source positions\n\n\n'))
console.log(' whitespace/comment inserted before relationships -> same ids:', JSON.stringify(run1) === JSON.stringify(run3))
const run4 = await ids(src('a_extra = c'))
console.log(' extra element declared before relationships -> same ids:', JSON.stringify(run1) === JSON.stringify(run4))
if (JSON.stringify(run1) !== JSON.stringify(run4)) for (const line of run4) console.log('  ' + line)

await likec4.dispose()
