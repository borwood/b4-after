import { LikeC4 } from 'likec4'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

export const here = dirname(fileURLToPath(import.meta.url))
export const workspace = join(here, '..', 'model')
export const outDir = join(here, '..', 'out')
mkdirSync(outDir, { recursive: true })

export async function load() {
  return LikeC4.fromWorkspace(workspace, { logger: false, throwIfInvalid: true })
}
export const bytes = (v) => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v), 'utf8')
export const writeOut = (name, content) =>
  writeFileSync(join(outDir, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2))
export const section = (t) => console.log(`\n=== ${t} ===`)
export const summarize = (model) => ({
  elements: [...model.elements()].map(e => e.id).sort(),
  relationships: [...model.relationships()]
    .map(r => `${r.id}: ${r.source.id} -[${r.kind}]-> ${r.target.id} "${r.title ?? ''}"`)
    .sort(),
  views: [...model.views()].map(v => v.id).sort(),
})
export const byStableId = (model, stableId) =>
  [...model.elements()].find(e => e.getMetadata('stable_id') === stableId) ?? null
