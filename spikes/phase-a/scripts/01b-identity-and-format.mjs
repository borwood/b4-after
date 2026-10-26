import { LikeC4 } from 'likec4'
import { load, section, workspace } from './_common.mjs'
import { join } from 'node:path'

const wrap = (modelBody) => `
specification {
  element c
  relationship uses
}
model {
${modelBody}
}
views { view index { include * } }
`
const ids = async (text) => {
  const p = await LikeC4.fromSource(text, { logger: false, throwIfInvalid: true })
  const m = await p.computedModel()
  const out = [...m.relationships()].map(r => `${r.id}:${r.source.id}->${r.target.id}:${r.title}`)
  await p.dispose()
  return out
}
section('relationship id: what does the hash depend on?')
const base = await ids(wrap(`a = c\nb = c\na -[uses]-> b "r1"\na -[uses]-> b "r2"`))
console.log(' base                              :', base.join('  '))
const afterElem = await ids(wrap(`a = c\nb = c\na -[uses]-> b "r1"\na -[uses]-> b "r2"\nz = c`))
console.log(' element declared AFTER rels       :', afterElem.join('  '), '| same:', JSON.stringify(afterElem) === JSON.stringify(base))
const reordered = await ids(wrap(`a = c\nb = c\na -[uses]-> b "r2"\na -[uses]-> b "r1"`))
console.log(' rels swapped                      :', reordered.join('  '))
const renamedElem = await ids(wrap(`a = c\nbb = c\na -[uses]-> bb "r1"\na -[uses]-> bb "r2"`))
console.log(' target renamed b->bb              :', renamedElem.join('  '))
const nested = await ids(wrap(`a = c\nb = c {\n  a -[uses]-> b "r1"\n}\na -[uses]-> b "r2"`))
console.log(' r1 declared inside b block         :', nested.join('  '))
const otherFile = await ids(wrap(`a = c\nb = c\na -[uses]-> b "r1"`) + '\n' + `model {\n  a -[uses]-> b "r2"\n}`)
console.log(' r2 in a second model block        :', otherFile.join('  '))

section('programmatic format(): signature probe')
const likec4 = await load()
for (const args of [[], [{}], [{ files: [join(workspace, 'billing.c4')] }], [{ projects: ['default'] }]]) {
  try {
    const r = await likec4.format(...args)
    const desc = r instanceof Map ? `Map(${r.size}) keys=${[...r.keys()].map(k => String(k).split(/[\\/]/).pop()).join(',')}` : Array.isArray(r) ? `array(${r.length})` : JSON.stringify(r)?.slice(0, 200)
    console.log(` format(${JSON.stringify(args).slice(0, 60)}) ->`, desc)
  } catch (e) { console.log(` format(${JSON.stringify(args).slice(0, 60)}) threw:`, e.message.slice(0, 120)) }
}
await likec4.dispose()
