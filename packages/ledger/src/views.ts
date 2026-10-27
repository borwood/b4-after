// Generated views (model/views.c4). Nobody authors views: every promotion and reconciliation
// regenerates them from the model and the ledger. Two folders in the viewer:
//   As-is   what exists (intended entities are excluded)
//   Target  what exists plus what is intended, with pending property updates shown as overrides
import type { Ledger } from './ledger.js'
import type { ParsedModelData } from './model.js'
import { STABLE_ID_KEY } from './identity.js'
import { TAG, isReservedTag } from './reserved.js'
import { readPending } from './status.js'

type Folder = 'As-is' | 'Target'

interface Element { id: string; title: string; tags: string[]; stableId: string | undefined; raw: Record<string, any> }

interface PendingValues { title?: string; description?: string; technology?: string }

/** Quote a LikeC4 string. Multi-line content is allowed inside single quotes. */
const q = (s: string) => `'${s.replace(/'/g, "\\'")}'`
/** A view title; `/` is LikeC4's folder separator, so literal slashes in names are escaped. */
const viewTitle = (folder: Folder, name: string) => q(`${folder} / ${name.replace(/\//g, '\\/')}`)
const viewId = (fqn: string) => `el--${fqn.replace(/\./g, '--')}`

const AS_IS_EXCLUDES = [
  `exclude * where tag is #${TAG.intended}`,
  `exclude * -> * where tag is #${TAG.intended}`,
]

export function generateViews(data: ParsedModelData, ledger?: Ledger): string {
  const elements: Element[] = Object.values<any>(data.elements ?? {})
    .map(raw => ({ id: raw.id as string, title: (raw.title ?? raw.id) as string, tags: (raw.tags ?? []) as string[], stableId: raw.metadata?.[STABLE_ID_KEY] as string | undefined, raw }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const childrenOf = (parent: Element) => elements.filter(e => e.id.startsWith(parent.id + '.') && !e.id.slice(parent.id.length + 1).includes('.'))
  const roots = elements.filter(e => !e.id.includes('.'))
  const overrides = pendingOverrides(elements, ledger)

  const blocks: string[] = []
  const pair = (id: string, name: string, base: string[], inScope: Element[], scope?: string) => {
    blocks.push(view(id, viewTitle('As-is', name), scope, [...base, ...AS_IS_EXCLUDES]))
    blocks.push(view(`${id}--target`, viewTitle('Target', name), scope, [...base, ...withOverrides(inScope, overrides)]))
  }

  pair('index', 'Landscape', ['include *'], roots)
  if (elements.length) pair('everything', 'Everything', elements.map(e => `include ${e.id}`), elements)
  for (const el of elements) {
    const children = childrenOf(el)
    if (!children.length) continue
    pair(viewId(el.id), el.title, ['include *', `include -> ${el.id}.* ->`], [el, ...children], el.id)
  }
  for (const tag of Object.keys(data.specification?.tags ?? {}).filter(t => !isReservedTag(t)).sort()) {
    const tagged = elements.filter(e => e.tags.includes(tag))
    if (tagged.length) pair(`tag--${tag}`, `#${tag}`, tagged.map(e => `include ${e.id}`), tagged)
  }

  return `views {\n${blocks.join('\n')}}\n`
}

function view(id: string, title: string, scope: string | undefined, rules: string[]): string {
  const head = scope ? `  view ${id} of ${scope} {` : `  view ${id} {`
  return [head, `    title ${title}`, ...rules.map(r => `    ${r}`), '  }', ''].join('\n')
}

/** Intended property values from deferred update operations, by element FQN. */
function pendingOverrides(elements: Element[], ledger?: Ledger): Map<string, PendingValues> {
  const out = new Map<string, PendingValues>()
  if (!ledger) return out
  for (const el of elements) {
    if (!el.stableId) continue
    const values: PendingValues = {}
    for (const changeId of readPending(el.raw)) {
      for (const op of ledger.get(changeId)?.changeSet.operations ?? []) {
        if (op.op !== 'update_element' || op.id !== el.stableId) continue
        if (op.set.title !== undefined) values.title = op.set.title
        if (op.set.description) values.description = op.set.description
        if (op.set.technology) values.technology = op.set.technology
      }
    }
    if (Object.keys(values).length) out.set(el.id, values)
  }
  return out
}

function withOverrides(inScope: Element[], overrides: Map<string, PendingValues>): string[] {
  const rules: string[] = []
  for (const el of inScope) {
    const v = overrides.get(el.id)
    if (!v) continue
    const props = [v.title !== undefined ? `title ${q(v.title)}` : null, v.description ? `description ${q(v.description)}` : null, v.technology ? `technology ${q(v.technology)}` : null].filter(Boolean)
    rules.push(`include ${el.id} with { ${props.join('; ')} }`)
  }
  return rules
}
