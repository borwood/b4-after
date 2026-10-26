// Why does computeLikeC4Model() fail on builder.build() data, when builder.toLikeC4Model() works?
import { LikeC4Model } from '@likec4/core/model'
import { computeLikeC4Model, computeParsedModelData } from '@likec4/core/compute-view'
import { load, section } from './_common.mjs'

const likec4 = await load()
const fromBuilder = (await likec4.toBuilder()).build()
const fromWorkspace = (await likec4.parsedModel()).$data

const tryAll = (label, data) => {
  section(label)
  const attempts = {
    'computeLikeC4Model(data)': () => LikeC4Model.create(computeLikeC4Model(data)),
    'computeParsedModelData(data)': () => LikeC4Model.create(computeParsedModelData(data)),
    'LikeC4Model.fromParsed(data).asComputed()': () => LikeC4Model.fromParsed(data).asComputed(),
    'LikeC4Model.create(data)': () => LikeC4Model.create(data),
  }
  for (const [name, fn] of Object.entries(attempts)) {
    try {
      const m = fn()
      console.log(` OK   ${name} -> stage=${m.stage} views=${[...m.views()].length}`)
    } catch (e) {
      const where = (e.stack ?? '').split('\n').slice(1, 3).map(s => s.trim().replace(/file:\/\/\/.*?node_modules\//, '')).join(' | ')
      console.log(` FAIL ${name}: ${e.message.slice(0, 120)}  @ ${where}`)
    }
  }
}
tryAll('A. builder.build() data', fromBuilder)
tryAll('B. parsedModel().$data (workspace parsed data)', fromWorkspace)

section('C. shape differences build() vs parsed $data')
const shape = (o, depth = 1) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) =>
  [k, v === null ? 'null' : Array.isArray(v) ? `array(${v.length})` : typeof v === 'object' ? (depth > 0 ? shape(v, depth - 1) : `object{${Object.keys(v).length}}`) : typeof v]))
console.log(' build()      :', JSON.stringify(shape(fromBuilder, 0)))
console.log(' parsed $data :', JSON.stringify(shape(fromWorkspace, 0)))
console.log(' build().specification :', JSON.stringify(shape(fromBuilder.specification, 0)))
console.log(' parsed.specification  :', JSON.stringify(shape(fromWorkspace.specification, 0)))
console.log(' build().views sample  :', JSON.stringify(Object.values(fromBuilder.views)[0]).slice(0, 300))
console.log(' parsed.views sample   :', JSON.stringify(Object.values(fromWorkspace.views)[0]).slice(0, 300))
console.log(' build().project       :', JSON.stringify(fromBuilder.project).slice(0, 200))
console.log(' parsed.project        :', JSON.stringify(fromWorkspace.project).slice(0, 200))

section('D. does toBuilder().toLikeC4Model() with NO changes equal the baseline?')
const viaBuilder = (await likec4.toBuilder()).toLikeC4Model()
console.log(' stage:', viaBuilder.stage, 'views:', [...viaBuilder.views()].length, 'elements:', [...viaBuilder.elements()].length)

await likec4.dispose()
