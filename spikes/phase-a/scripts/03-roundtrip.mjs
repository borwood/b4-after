import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load, writeOut, section, workspace, bytes } from './_common.mjs'

const likec4 = await load()
section('toDSL()')
const dsl = await likec4.toDSL()
writeOut('03-roundtrip.c4', dsl)
const original = ['specs.c4', 'billing.c4', 'views.c4'].map(f => readFileSync(join(workspace, f), 'utf8')).join('\n')
const count = (s, re) => (s.match(re) ?? []).length
console.log(' original bytes=%d comments=%d   | toDSL bytes=%d comments=%d', bytes(original), count(original, /\/\//g), bytes(dsl), count(dsl, /\/\//g))
console.log(' stable_id metadata survives:', count(dsl, /stable_id/g), 'occurrences (original', count(original, /stable_id/g) + ')')
console.log(' relationship titles survive:', dsl.includes('persists charges'))
console.log(' views survive:', dsl.includes('view billing'))
console.log(' --- first 45 lines of generated DSL ---')
console.log(dsl.split('\n').slice(0, 45).map(l => '   ' + l).join('\n'))

section('format() - is there a source-preserving formatter?')
try {
  const res = await likec4.format({})
  console.log(' format() returned type:', typeof res, Array.isArray(res) ? `array(${res.length})` : Object.keys(res ?? {}).slice(0, 10))
  const sample = Array.isArray(res) ? res[0] : res
  console.log(' sample:', JSON.stringify(sample, (k, v) => typeof v === 'string' && v.length > 300 ? v.slice(0, 300) + '...' : v, 1).slice(0, 1200))
} catch (e) { console.log(' format() failed:', e.message.slice(0, 200)) }

await likec4.dispose()
