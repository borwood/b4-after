// Lists what the runtime objects actually expose, so later scripts target real APIs.
import { LikeC4 } from 'likec4'
import * as likec4Pkg from 'likec4'
import * as core from '@likec4/core'
import * as coreModel from '@likec4/core/model'
import * as coreBuilder from '@likec4/core/builder'
import * as coreCompute from '@likec4/core/compute-view'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const workspace = join(here, '..', 'model')

const protoMethods = (obj) => {
  const names = new Set()
  let p = obj
  while (p && p !== Object.prototype) {
    for (const n of Object.getOwnPropertyNames(p)) if (n !== 'constructor') names.add(n)
    p = Object.getPrototypeOf(p)
  }
  return [...names].sort()
}
const statics = (cls) => Object.getOwnPropertyNames(cls).filter(n => !['length','name','prototype'].includes(n)).sort()

console.log('likec4 exports:', Object.keys(likec4Pkg).sort().join(', '))
console.log('@likec4/core exports (count):', Object.keys(core).length)
console.log('@likec4/core/model exports:', Object.keys(coreModel).sort().join(', '))
console.log('@likec4/core/builder exports:', Object.keys(coreBuilder).sort().join(', '))
console.log('@likec4/core/compute-view exports:', Object.keys(coreCompute).sort().join(', '))

const likec4 = await LikeC4.fromWorkspace(workspace, { logger: false, throwIfInvalid: true })
console.log('\nLikeC4 statics:', statics(LikeC4).join(', '))
console.log('LikeC4 instance methods:', protoMethods(likec4).join(', '))

const model = await likec4.computedModel()
console.log('\nLikeC4Model statics:', statics(model.constructor).join(', '))
console.log('LikeC4Model instance methods:', protoMethods(model).join(', '))

const el = model.element('billing.billing_api')
console.log('\nElementModel methods:', protoMethods(el).join(', '))
const rel = [...model.relationships()][0]
console.log('RelationshipModel methods:', protoMethods(rel).join(', '))

const builder = await likec4.toBuilder()
console.log('\nBuilder statics:', statics(builder.constructor).join(', '))
console.log('Builder instance methods:', protoMethods(builder).join(', '))

const built = builder.build()
console.log('\nbuilder.build() top-level keys:', Object.keys(built).join(', '))
console.log('build().elements sample key:', Object.keys(built.elements ?? {})[0])
console.log('build().relations sample:', JSON.stringify(Object.values(built.relations ?? {})[0], null, 0).slice(0, 400))

await likec4.dispose?.()
