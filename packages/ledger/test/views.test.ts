import { describe, expect, it } from 'vitest'
import { generateViews } from '../src/views.js'
import type { Ledger } from '../src/ledger.js'
import { TAG, META } from '../src/reserved.js'

const data = {
  specification: { tags: { external: {}, [TAG.intended]: {} } },
  elements: {
    shop: { id: 'shop', title: 'Shop / Storefront', metadata: { stable_id: 'ent-shop' } },
    'shop.web': { id: 'shop.web', title: "Bob's Web", metadata: { stable_id: 'ent-web', [META.pending]: 'CHG-5,CHG-6' }, tags: [TAG.pending_update] },
    'shop.db': { id: 'shop.db', title: 'DB', metadata: { stable_id: 'ent-db' } },
    'shop.db.schema': { id: 'shop.db.schema', title: 'Schema', metadata: { stable_id: 'ent-schema' } },
    cdn: { id: 'cdn', title: 'CDN', tags: ['external'], metadata: { stable_id: 'ent-cdn' } },
  },
  relations: {},
}

const ledger = {
  get: (id: string) => ({
    'CHG-5': { changeSet: { operations: [{ op: 'update_element', id: 'ent-web', set: { title: 'Web App', technology: 'Next.js' } }] } },
    'CHG-6': { changeSet: { operations: [{ op: 'update_element', id: 'ent-web', set: { description: 'Serves the shop' } }, { op: 'update_element', id: 'ent-db', set: { title: 'ignored: not pending' } }] } },
  } as Record<string, any>)[id],
} as unknown as Ledger

describe('generateViews', () => {
  const out = generateViews(data, ledger)
  const block = (id: string) => out.match(new RegExp(`  view ${id.replace(/-/g, '\\-')}( of [\\w.]+)? \\{\\n([\\s\\S]*?)\\n  \\}`))![0]

  it('makes an As-is and a Target view for the landscape, everything, each parent, and each user tag', () => {
    const ids = [...out.matchAll(/^  view ([\w-]+)/gm)].map(m => m[1])
    expect(ids).toEqual([
      'index', 'index--target', 'everything', 'everything--target',
      'el--shop', 'el--shop--target', 'el--shop--db', 'el--shop--db--target',
      'tag--external', 'tag--external--target',
    ])
    expect(block('el--shop')).toContain('view el--shop of shop {')
    expect(block('el--shop')).toContain('include -> shop.* ->')
  })

  it('As-is views exclude intended entities and edges; Target views do not', () => {
    for (const id of ['index', 'everything', 'el--shop', 'tag--external']) {
      expect(block(id)).toContain(`exclude * where tag is #${TAG.intended}`)
      expect(block(id)).toContain(`exclude * -> * where tag is #${TAG.intended}`)
      expect(block(`${id}--target`)).not.toContain('exclude')
    }
  })

  it('Target views override pending property values from the ledger, only for elements in scope', () => {
    const override = "include shop.web with { title 'Web App'; description 'Serves the shop'; technology 'Next.js' }"
    expect(block('el--shop--target')).toContain(override)
    expect(block('everything--target')).toContain(override)
    expect(block('index--target')).not.toContain('with {') // web is not a root
    expect(block('el--shop')).not.toContain('with {')
    expect(out).not.toContain('ignored: not pending')
  })

  it('titles go into folders and escape the folder separator and quotes', () => {
    expect(block('el--shop')).toContain("title 'As-is / Shop \\/ Storefront'")
    expect(block('el--shop--target')).toContain("title 'Target / Shop \\/ Storefront'")
    expect(block('tag--external')).toContain("title 'As-is / #external'")
    const bobs = generateViews({ ...data, elements: { b: { id: 'b', title: "Bob's", metadata: {} }, 'b.c': { id: 'b.c', title: 'C', metadata: {} } } })
    expect(bobs).toContain("title 'As-is / Bob\\'s'")
  })

  it('an empty model still yields the landscape pair and nothing that would not parse', () => {
    const empty = generateViews({ specification: { tags: {} }, elements: {}, relations: {} })
    expect([...empty.matchAll(/^  view ([\w-]+)/gm)].map(m => m[1])).toEqual(['index', 'index--target'])
    expect(empty).not.toContain('everything')
  })
})
