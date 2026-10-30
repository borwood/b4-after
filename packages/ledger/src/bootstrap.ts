// Adoption bootstrap (PRD spike 9): bring an existing system into the ledger without pretending to
// know more than we do. Imported architecture is recorded as inferred change sets, promoted with a
// pre-ledger marker and no evidence, so the qualified baseline shows it as unverified.
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Git } from './git.js'
import { IdentityRegistry, STABLE_ID_KEY } from './identity.js'
import { Ledger, changeSetPath, serializeChangeSet, CHANGES_DIR } from './ledger.js'
import { loadModel, modelFromParsedData, MODEL_DIR, type ParsedModelData } from './model.js'
import { STATUS_FLAGS, TAG, TAG_COLOR, isReservedMetadataKey, userTags } from './reserved.js'
import type { ChangeSet, Operation } from './schema.js'
import { finalizeBaseline } from './status.js'
import { generateViews } from './views.js'
import { generateAndCheck, readWorkspace, sameWorkspace, summarizeErrors, writeWorkspace, MODEL_FILE, VIEWS_FILE } from './workspace.js'

export const DEFAULT_KINDS = ['actor', 'system', 'container', 'component', 'datastore'] as const
export const DEFAULT_RELATIONSHIP_KINDS = ['uses', 'publishes_to', 'reads_from', 'writes_to'] as const

export interface InitOptions {
  /** Project name, used in the README. */
  name: string
  actor: string
  kinds?: string[]
  relationshipKinds?: string[]
  tags?: string[]
  date?: string
}

export interface InitResult { sha: string; files: string[] }

/** Create an empty model repository: git, a specification (with the reserved status tags), an empty model, generated views. */
export async function initModelRepo(dir: string, opts: InitOptions): Promise<InitResult> {
  await mkdir(dir, { recursive: true })
  const git = new Git(dir)
  if (!(await Git.isRepo(dir))) await git.exec(['init', '-q', '-b', 'main'])
  else if ((await readdir(join(dir, MODEL_DIR)).catch(() => [])).some(f => /\.c4$/i.test(f))) {
    throw new Error(`${dir} already has a model under ${MODEL_DIR}/; use adoptExistingModel instead`)
  }
  const kinds = opts.kinds?.length ? opts.kinds : [...DEFAULT_KINDS]
  const rels = opts.relationshipKinds?.length ? opts.relationshipKinds : [...DEFAULT_RELATIONSHIP_KINDS]
  const styles: Record<string, string> = { actor: 'person', datastore: 'cylinder', database: 'cylinder', queue: 'queue' }
  const spec = [
    'specification {',
    ...kinds.map(k => styles[k] ? `  element ${k} {\n    style {\n      shape ${styles[k]}\n    }\n  }` : `  element ${k}`),
    '',
    ...rels.map(r => `  relationship ${r}`),
    ...(opts.tags?.length ? ['', ...opts.tags.map(t => `  tag ${t}`)] : []),
    '',
    ...STATUS_FLAGS.map(f => `  tag ${TAG[f]} {\n    color ${TAG_COLOR[f]}\n  }`),
    '}',
    '',
    'model {',
    '}',
    '',
  ].join('\n')
  const modelDir = join(dir, MODEL_DIR)
  await writeWorkspace(modelDir, { [MODEL_FILE]: spec })
  const loaded = await loadModel(dir, { throwIfInvalid: false })
  if (loaded.errors.length) throw new Error(`generated specification is invalid:\n  ${summarizeErrors(loaded.errors).join('\n  ')}`)
  await writeWorkspace(modelDir, { [MODEL_FILE]: spec, [VIEWS_FILE]: generateViews(loaded.parsedData) })
  await mkdir(join(dir, CHANGES_DIR), { recursive: true })
  await mkdir(join(dir, 'evidence'), { recursive: true })
  await writeFile(join(dir, CHANGES_DIR, '.gitkeep'), '', 'utf8')
  await writeFile(join(dir, 'evidence', '.gitkeep'), '', 'utf8')
  await writeFile(join(dir, 'README.md'), readme(opts.name), 'utf8')
  await git.add(['.'])
  const sha = await git.commit(`bootstrap: init model repository for ${opts.name}\n\nActor: ${opts.actor}\n`, { date: opts.date })
  return { sha, files: [`${MODEL_DIR}/${MODEL_FILE}`, `${MODEL_DIR}/${VIEWS_FILE}`, 'README.md'] }
}

export interface AdoptOptions {
  actor: string
  date?: string
  /** Intent text recorded on every inferred change set. */
  intent?: string
}

export interface AdoptResult {
  sha: string | null
  assignedIds: { elements: number; relationships: number }
  changeSets: { id: string; title: string; operations: number }[]
  /** Entities already covered by a promoted change set and therefore skipped. */
  skipped: number
}

/**
 * Adopt an existing LikeC4 model: assign missing stable ids, record one inferred, pre-ledger-promoted
 * change set per root element plus one for cross-root relationships, and regenerate the workspace
 * with statuses and views. Safe to run again: entities already covered by a promoted change set are
 * skipped, and nothing is committed when the model is already as it should be.
 */
export async function adoptExistingModel(dir: string, opts: AdoptOptions): Promise<AdoptResult> {
  const git = new Git(dir)
  if (!(await Git.isRepo(dir))) await git.exec(['init', '-q', '-b', 'main'])
  const dirty = (await git.exec(['status', '--porcelain', '--', MODEL_DIR, CHANGES_DIR]).catch(() => '')).trim()
  const headBefore = await git.headSha()
  if (dirty && headBefore) throw new Error(`uncommitted changes under ${MODEL_DIR}/ or ${CHANGES_DIR}/; commit or discard them first:\n${dirty}`)

  // 1. Stable ids.
  const loaded = await loadModel(dir)
  const data = structuredClone(loaded.parsedData) as ParsedModelData
  const assigned = assignStableIds(data)

  // 2. Inferred change sets from the (now fully identified) model.
  const model = await modelFromParsedData(data)
  const registry = IdentityRegistry.fromModel(model)
  if (registry.problems.length) throw new Error(`identity problems after id assignment:\n  ${registry.problems.map(p => p.message).join('\n  ')}`)
  const ledger = await Ledger.load(dir, { tolerant: true })
  const covered = new Set<string>()
  for (const rec of ledger.records.values()) if (rec.changeSet.promotion) for (const p of rec.participants) if (p.via === 'operation') covered.add(p.entityId)
  let next = 1 + Math.max(0, ...[...ledger.records.keys()].map(id => Number(id.slice(4)) || 0))
  const at = opts.date ?? new Date().toISOString()
  const intent = opts.intent ?? 'Declared architecture inferred during adoption; unverified until evidence is recorded'
  const made: ChangeSet[] = []
  let skipped = 0

  const elementOp = (fqn: string): Operation | null => {
    const rec = registry.elementByFqn(fqn)!
    if (covered.has(rec.stableId)) { skipped++; return null }
    const el = model.element(fqn)
    const op: Operation = {
      op: 'add_element', id: rec.stableId, parent: rec.parentFqn ? registry.elementByFqn(rec.parentFqn)!.stableId : null,
      name: lastSegment(fqn), kind: rec.kind, title: el.title,
    }
    if (el.technology) op.technology = el.technology
    if (el.description?.text) op.description = el.description.text
    const tags = userTags(el.tags)
    if (tags.length) op.tags = tags
    const md = Object.fromEntries(Object.entries(el.getMetadata() as Record<string, string | string[]>).filter(([k, v]) => k !== STABLE_ID_KEY && !isReservedMetadataKey(k) && (typeof v === 'string' || Array.isArray(v))))
    if (Object.keys(md).length) op.metadata = md
    return op
  }
  const relationOp = (r: ReturnType<IdentityRegistry['relationships']>[number]): Operation | null => {
    if (covered.has(r.stableId)) { skipped++; return null }
    const op: Operation = { op: 'add_relationship', id: r.stableId, from: registry.elementByFqn(r.fromFqn)!.stableId, to: registry.elementByFqn(r.toFqn)!.stableId }
    if (r.kind) op.kind = r.kind
    if (r.title) op.title = r.title
    return op
  }
  const rootOf = (fqn: string) => fqn.split('.')[0]!
  for (const root of model.roots()) {
    const ops: Operation[] = []
    const walk = (fqn: string) => {
      const op = elementOp(fqn); if (op) ops.push(op)
      for (const c of model.element(fqn).children()) walk(c.id)
    }
    walk(root.id)
    for (const r of registry.relationships()) {
      if (rootOf(r.fromFqn) === root.id && rootOf(r.toFqn) === root.id) { const op = relationOp(r); if (op) ops.push(op) }
    }
    if (ops.length) made.push(inferredChangeSet(`CHG-${next++}`, `Inferred baseline: ${root.title}`, intent, ops, at, opts.actor))
  }
  const cross: Operation[] = []
  for (const r of registry.relationships()) {
    if (rootOf(r.fromFqn) !== rootOf(r.toFqn)) { const op = relationOp(r); if (op) cross.push(op) }
  }
  if (cross.length) made.push(inferredChangeSet(`CHG-${next++}`, 'Inferred baseline: cross-boundary relationships', intent, cross, at, opts.actor))

  // 3. Record the change sets, then regenerate the workspace with statuses derived from the ledger that now holds them.
  const written: string[] = []
  try {
    await mkdir(join(dir, CHANGES_DIR), { recursive: true })
    for (const cs of made) {
      const path = changeSetPath(cs.id)
      await writeFile(join(dir, path), serializeChangeSet(cs), 'utf8')
      written.push(path)
    }
    const ledgerAfter = made.length ? await Ledger.load(dir, { tolerant: true }) : ledger
    await finalizeBaseline(data, ledgerAfter)
    const check = await generateAndCheck(data, ledgerAfter)
    if (check.errors.length) throw new Error(`model does not regenerate cleanly; nothing written:\n  ${summarizeErrors(check.errors).join('\n  ')}`)
    const files: string[] = []
    if (!sameWorkspace(await readWorkspace(join(dir, MODEL_DIR)), check.files)) {
      await writeWorkspace(join(dir, MODEL_DIR), check.files)
      files.push(MODEL_DIR)
    }
    if (made.length) files.push(CHANGES_DIR)
    if (!files.length) return { sha: headBefore, assignedIds: assigned, changeSets: [], skipped }

    await git.exec(['add', '-A', '--', ...files])
    const sha = await git.commit(
      `bootstrap: adopt existing model (${made.length} inferred change set${made.length === 1 ? '' : 's'}, ${assigned.elements + assigned.relationships} ids assigned)\n\n` +
      made.map(c => `Change-Id: ${c.id}`).join('\n') + `\nActor: ${opts.actor}\n`,
      { date: opts.date },
    )
    return { sha, assignedIds: assigned, changeSets: made.map(c => ({ id: c.id, title: c.title, operations: c.operations.length })), skipped }
  } catch (e) {
    for (const path of written) await rm(join(dir, path), { force: true })
    await git.exec(['checkout', '-q', '--', MODEL_DIR]).catch(() => {})
    throw e
  }
}

/** Give every element and relationship without a stable id one derived from its name. Returns the counts. */
function assignStableIds(data: ParsedModelData): { elements: number; relationships: number } {
  const taken = new Set<string>()
  for (const el of Object.values<any>(data.elements)) if (el.metadata?.[STABLE_ID_KEY]) taken.add(String(el.metadata[STABLE_ID_KEY]))
  for (const rel of Object.values<any>(data.relations)) if (rel.metadata?.[STABLE_ID_KEY]) taken.add(String(rel.metadata[STABLE_ID_KEY]))
  const unique = (base: string) => { let id = base, n = 2; while (taken.has(id)) id = `${base}-${n++}`; taken.add(id); return id }
  let elements = 0, relationships = 0
  for (const [fqn, el] of Object.entries<any>(data.elements)) {
    if (el.metadata?.[STABLE_ID_KEY]) continue
    el.metadata = { ...(el.metadata ?? {}), [STABLE_ID_KEY]: unique('ent-' + slug(fqn)) }
    elements++
  }
  for (const rel of Object.values<any>(data.relations)) {
    if (rel.metadata?.[STABLE_ID_KEY]) continue
    const from = slug(lastSegment(rel.source?.model ?? '')), to = slug(lastSegment(rel.target?.model ?? ''))
    rel.metadata = { ...(rel.metadata ?? {}), [STABLE_ID_KEY]: unique(`rel-${from}-${slug(rel.kind ?? 'to')}-${to}`) }
    relationships++
  }
  return { elements, relationships }
}

function inferredChangeSet(id: string, title: string, intent: string, operations: Operation[], at: string, actor: string): ChangeSet {
  return {
    id, title, intent, sources: [], depends_on: [], supersedes: [],
    disposition: 'accepted', inferred: true,
    operations, references: [],
    promotion: { at, baseline: 'pre-ledger', actor },
  }
}

export function slug(s: string): string {
  const out = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-')
  return /^[a-z]/.test(out) ? out : `x${out}`
}
const lastSegment = (fqn: string) => fqn.slice(fqn.lastIndexOf('.') + 1)

function readme(name: string): string {
  return `# ${name} architecture

Architecture model repository managed by [cb4](https://github.com/borwood/cb4).

- \`model/\` LikeC4 DSL, machine-generated. \`model.c4\` holds the specification and model, \`views.c4\` the generated views (As-is and Target folders). Written by promotion and reconciliation.
- \`changes/\` one YAML record per logical change set.
- \`evidence/\` append-only evidence per change set; verification is derived from it.

Agents are the only writers. Humans get diagrams and summaries. Entities tagged \`b4-intended\` do not exist yet; \`b4-retiring\` ones still do.
`
}
