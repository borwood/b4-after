// The agent-facing MCP server. Nineteen tools, one-line descriptions, compact JSON results, bounded
// defaults, help on demand. See help.ts for the documentation agents can pull in when they need it.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
  storyOf, validateInContext, proposeChangeSet, setDisposition, promoteChangeSet, recordEvidence, reconcileBaseline,
  projectModel, renderProjection, qualifyBaseline, deriveVerification, initModelRepo, adoptExistingModel, loadModel,
  releaseTimeline, releasedBaseline,
  overview, search, expand, elementDetail, resolveElement, locate,
  Ledger, ProjectionError, ProposalRejected, PromotionRefused, ReconcileRefused, LedgerError, EvidenceError,
  type StoryResult, type ValidationIssue, type Renderable, type RenderFormat,
} from '@borwood/b4-after-ledger'
import { RepoContext } from './context.js'
import { help, HELP_TOPICS } from './help.js'

export const SERVER_NAME = 'b4-after'
export const SERVER_VERSION = '0.2.1'

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : null)

function ok(head: string | null | undefined, data: object): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...data, head: short(head) }) }] }
}
function fail(code: string, error: string, extra: Record<string, unknown> = {}): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, code, error, ...extra }) }] }
}
const issueRows = (issues: ValidationIssue[]) => issues.map(i => ({ severity: i.severity, code: i.code, path: i.path, message: i.message, ...('changeId' in i ? { change: (i as any).changeId } : {}) }))
/** Unpromoted dependencies that were projected before validating; absent when there were none. */
const projectedRows = (projected: string[]) => (projected.length ? { projected_dependencies: projected } : {})

function toFailure(e: unknown): CallToolResult {
  if (e instanceof ProposalRejected) return fail('VALIDATION', e.message.split('\n')[0]!, { issues: issueRows(e.validation.issues) })
  if (e instanceof ProjectionError) return fail('PROJECTION', 'projection rejected', { issues: issueRows(e.issues) })
  if (e instanceof PromotionRefused) return fail('REFUSED', e.message, e.issues.length ? { issues: issueRows(e.issues) } : {})
  if (e instanceof ReconcileRefused) return fail('REFUSED', e.message)
  if (e instanceof LedgerError || e instanceof EvidenceError) return fail('VALIDATION', e.message.split('\n')[0]!, { issues: e.problems })
  const msg = e instanceof Error ? e.message : String(e)
  if (/repository moved/i.test(msg)) return fail('REPO_MOVED', msg, { hint: 'HEAD changed since expected_head; re-read, re-validate, retry' })
  if (/write lock busy/i.test(msg)) return fail('LOCK_BUSY', msg)
  if (/not in the ledger|not found|does not exist/i.test(msg)) return fail('NOT_FOUND', msg)
  if (/not an allowed transition|frozen|must be draft|can no longer be revised|promoted/i.test(msg)) return fail('REFUSED', msg)
  if (/invalid LikeC4 model|regenerated model/i.test(msg)) return fail('INVALID_MODEL', msg)
  return fail('ERROR', msg)
}

const RENDER_FORMATS = ['none', 'dsl', 'png', 'html'] as const
const renderInput = {
  render: z.enum(RENDER_FORMATS).optional(),
  out_dir: z.string().optional(),
  views: z.array(z.string()).optional(),
}
type RenderInput = { render?: typeof RENDER_FORMATS[number]; out_dir?: string; views?: string[] }
type SourceMatch =
  | { via: 'source'; role: string; ref: string }
  | { via: 'evidence'; evidence: string; kind: string; result: string; ref: string }

/** Render `target` as requested and add the result to `base` (dsl text, or the files written). */
async function rendered(base: Record<string, unknown>, target: Renderable, a: RenderInput, ledger?: Ledger): Promise<Record<string, unknown>> {
  if (!a.render || a.render === 'none') return base
  const r = await renderProjection(target, { format: a.render as RenderFormat, outDir: a.out_dir, views: a.views, ledger })
  if (r.format === 'dsl') return { ...base, dsl: r.dsl }
  if (r.format === 'png') return { ...base, png: { dir: r.outDir, files: r.files } }
  return { ...base, html: { dir: r.outDir, file: r.file } }
}

function storySummary(r: StoryResult) {
  return {
    subject: { id: r.subject.resolved?.stableId ?? r.subject.requested, fqn: r.subject.resolved?.fqn ?? null, members: r.subject.members.length, membership: r.subject.membership, ...(r.subject.historicalMembers.length ? { historical: r.subject.historicalMembers } : {}) },
    snapshot: { source: r.snapshot.source, revision: short(r.snapshot.revision), ...(r.snapshot.before ? { before: r.snapshot.before } : {}) },
    total: r.total, truncated: r.truncated, ...(r.nextCursor ? { cursor: r.nextCursor } : {}),
    entries: r.entries.map(e => ({
      change: e.changeId, title: e.title, when: e.recordedAt?.slice(0, 10) ?? null,
      state: `${e.disposition}/${e.implementation}/${e.verification.status}${e.verification.environment !== 'any' ? '@' + e.verification.environment : ''}${e.promoted ? '/promoted' : ''}`,
      matched: e.matched.map(m => `${m.entityId}:${m.role}`),
      with: e.others.map(o => `${o.entityId}:${o.role}`),
      ...(e.sources?.length ? { sources: e.sources.map(s => `${s.role}:${s.ref}`) } : {}),
      ...(e.dependsOn.length ? { depends_on: e.dependsOn } : {}),
    })),
    ...(r.warnings.length ? { warnings: r.warnings } : {}),
  }
}

export function createServer(ctx: RepoContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, {
    instructions: 'Architecture model + change ledger. Start with overview, then help topic=start. Entities are stable ids (help ids). Rows carry pending=[...] when an entity is intended or retiring rather than real (help status). Writes need actor; pass expected_head when other agents may be writing.',
  })
  const actorOf = (a?: string) => a ?? ctx.options.actor
  const needActor = (a?: string): string => {
    const v = actorOf(a)
    if (!v) throw new Error('actor is required (who or what is recording this); pass actor=<name> or start the server with --actor')
    return v
  }
  const guarded = (fn: () => Promise<CallToolResult>) => fn().catch(toFailure)

  server.registerTool('help', {
    description: 'Documentation by topic; no topic lists topics',
    inputSchema: { topic: z.enum(HELP_TOPICS).optional() },
  }, async ({ topic }) => ({ content: [{ type: 'text', text: help(topic) }] }))

  const detailInput = z.enum(['minimal', 'medium']).optional()

  server.registerTool('overview', {
    description: 'Project summary: roots, counts, open change sets, head',
    inputSchema: { detail: detailInput },
  }, async (a) => guarded(async () => {
    const s = await ctx.snapshot()
    if (!(await ctx.hasModel())) {
      return ok(s.head, { ...overview(s), initialized: false, next: 'no model repository here yet: bootstrap mode=init name=<project> creates one (help adopt), or mode=adopt if model/ already holds LikeC4 sources' })
    }
    return ok(s.head, overview(s, { detail: a.detail }))
  }))

  server.registerTool('search', {
    description: 'Find elements by id, fqn, title, kind, tag or metadata (ranked, limit<=50); detail=medium adds descriptions',
    inputSchema: { query: z.string(), kinds: z.array(z.string()).optional(), tags: z.array(z.string()).optional(), metadata: z.record(z.string(), z.string()).optional(), limit: z.number().int().optional(), detail: detailInput },
  }, async (a) => guarded(async () => {
    const s = await ctx.snapshot()
    return ok(s.head, search(s, a))
  }))

  server.registerTool('expand', {
    description: 'Descendants of an entity plus relationships touching them (depth<=5); detail=medium adds descriptions',
    inputSchema: { entity: z.string(), depth: z.number().int().optional(), relationships: z.enum(['direct', 'none']).optional(), max_nodes: z.number().int().optional(), detail: detailInput },
  }, async (a) => guarded(async () => {
    const s = await ctx.snapshot()
    const r = expand(s, { entity: a.entity, depth: a.depth, relationships: a.relationships, maxNodes: a.max_nodes, detail: a.detail })
    return r ? ok(s.head, r) : fail('NOT_FOUND', `no element ${a.entity} at HEAD`, { hint: 'help ids; story still works for removed entities' })
  }))

  server.registerTool('element', {
    description: 'One element in full: properties, direct and nested relationships, views, change sets; qualify=true adds verification',
    inputSchema: { entity: z.string(), qualify: z.boolean().optional(), environment: z.string().optional() },
  }, async (a) => guarded(async () => {
    const s = await ctx.snapshot()
    const d = elementDetail(s, a.entity)
    if (!d) return fail('NOT_FOUND', `no element ${a.entity} at HEAD`, { hint: 'help ids' })
    if (!a.qualify) return ok(s.head, d)
    const q = await qualifyBaseline(ctx.repoDir, { environment: a.environment, highlight: false, ledger: s.ledger })
    const sid = d.id.startsWith('fqn:') ? null : d.id
    return ok(s.head, { ...d, qualification: sid ? q.entities.get(sid) ?? null : null })
  }))

  server.registerTool('locate', {
    description: 'Ground around an entity: full detail, related entities, then each container up to the root with its peers',
    inputSchema: { entity: z.string(), max_peers: z.number().int().optional(), max_relationships: z.number().int().optional() },
  }, async (a) => guarded(async () => {
    const s = await ctx.snapshot()
    const r = locate(s, { entity: a.entity, maxPeers: a.max_peers, maxRelationships: a.max_relationships })
    return r ? ok(s.head, r) : fail('NOT_FOUND', `no element or relationship ${a.entity} at HEAD`, { hint: 'help ids' })
  }))

  server.registerTool('story', {
    description: 'Chronological change sets involving an entity or subtree, with roles and sources (paged)',
    inputSchema: {
      entity: z.string(), subtree: z.boolean().optional(), membership: z.enum(['current', 'ever']).optional(),
      revision: z.string().optional(), before: z.string().optional(),
      environment: z.string().optional(), limit: z.number().int().optional(), cursor: z.string().optional(),
      detail: z.enum(['summary', 'full']).optional(),
    },
  }, async (a) => guarded(async () => {
    const historical = !!(a.revision || a.before)
    const s = historical ? null : await ctx.snapshot()
    const r = await storyOf(ctx.repoDir, {
      entity: a.entity, subtree: a.subtree, membership: a.membership, revision: a.revision, before: a.before, environment: a.environment, limit: a.limit, cursor: a.cursor,
      include: a.detail === 'full' ? ['operations', 'references', 'sources', 'commits', 'evidence'] : ['sources'],
    }, s ? { ledger: s.ledger, registry: s.registry } : {})
    return ok(s?.head ?? (await ctx.head()), a.detail === 'full' ? { story: r } : storySummary(r))
  }))

  server.registerTool('changes', {
    description: 'List change sets, filterable by disposition, promoted, entity, or source ref (sources and evidence)',
    inputSchema: {
      disposition: z.enum(['draft', 'proposed', 'accepted', 'rejected', 'superseded']).optional(), promoted: z.boolean().optional(), entity: z.string().optional(),
      source: z.string().optional(), source_match: z.enum(['exact', 'contains']).optional(), limit: z.number().int().optional(),
    },
  }, async (a) => guarded(async () => {
    const s = await ctx.snapshot()
    const limit = Math.max(1, Math.min(a.limit ?? 50, 200))
    let recs = s.ledger.all()
    const matchedBy = new Map<string, SourceMatch[]>()
    if (a.source !== undefined) {
      const hits = (ref: string) => a.source_match === 'contains' ? ref.includes(a.source!) : ref === a.source
      for (const r of recs) {
        const m: SourceMatch[] = [
          ...r.changeSet.sources.filter(x => hits(x.ref)).map(x => ({ via: 'source' as const, role: x.role, ref: x.ref })),
          ...r.evidence.filter(x => hits(x.source_ref)).map(x => ({ via: 'evidence' as const, evidence: x.id, kind: x.kind, result: x.result, ref: x.source_ref })),
        ]
        if (m.length) matchedBy.set(r.changeSet.id, m)
      }
      recs = recs.filter(r => matchedBy.has(r.changeSet.id))
    }
    if (a.disposition) recs = recs.filter(r => r.changeSet.disposition === a.disposition)
    if (a.promoted !== undefined) recs = recs.filter(r => !!r.changeSet.promotion === a.promoted)
    if (a.entity) {
      const el = resolveElement(s, a.entity)
      const sid = el ? (s.registry.elementByFqn(el.id)?.stableId ?? a.entity) : a.entity
      const ids = s.ledger.changeIdsFor([sid])
      recs = recs.filter(r => ids.has(r.changeSet.id))
    }
    return ok(s.head, {
      total: recs.length, truncated: recs.length > limit,
      changes: recs.slice(0, limit).map(r => ({
        change: r.changeSet.id, title: r.changeSet.title, when: r.firstRecordedAt?.slice(0, 10) ?? null,
        state: `${r.changeSet.disposition}/${r.implementation}/${r.verification.status}${r.changeSet.promotion ? '/promoted' : ''}`,
        targets: [...new Set(r.changeSet.operations.map(o => o.id))], ...(r.changeSet.depends_on.length ? { depends_on: r.changeSet.depends_on } : {}),
        ...(matchedBy.has(r.changeSet.id) ? { matched: matchedBy.get(r.changeSet.id) } : {}),
      })),
    })
  }))

  server.registerTool('change', {
    description: 'One change set with commits and derived verification; include_evidence adds the records',
    inputSchema: { change_id: z.string(), revision: z.string().optional(), include_evidence: z.boolean().optional(), environment: z.string().optional() },
  }, async (a) => guarded(async () => {
    const ledger = a.revision ? await Ledger.load(ctx.repoDir, { revision: a.revision }) : (await ctx.snapshot()).ledger
    const r = ledger.get(a.change_id)
    if (!r) return fail('NOT_FOUND', `${a.change_id} is not in the ledger${a.revision ? ` at ${a.revision}` : ''}`)
    const v = a.environment ? deriveVerification(r.changeSet, r.evidence, { environment: a.environment }) : r.verification
    return ok(ledger.snapshot.revision, {
      change: r.changeSet,
      implementation: r.implementation,
      recorded: { first: r.firstRecordedAt, last: r.lastRecordedAt, unrecorded: r.unrecorded },
      commits: r.commits.map(c => ({ sha: short(c.sha), at: c.committedAt, subject: c.subject })),
      verification: { status: v.status, environment: v.environment, basis: v.basis, failing: v.failing, uncovered: v.uncovered, approvals: v.approvals.map(x => x.id), deployments: v.deployments.map(d => `${d.id}@${d.environment ?? 'any'}:${d.result}`) },
      ...(a.include_evidence ? { evidence: r.evidence, ignored: v.ignored } : { evidence_count: r.evidence.length }),
    })
  }))

  server.registerTool('validate', {
    description: 'Check a change set against the baseline and ledger without writing',
    inputSchema: { change_set: z.record(z.string(), z.unknown()) },
  }, async (a) => guarded(async () => {
    const s = await ctx.snapshot()
    const v = await validateInContext(s, a.change_set, s.ledger)
    return ok(s.head, { valid: v.ok, issues: issueRows(v.issues), ...projectedRows(v.projected) })
  }))

  server.registerTool('propose', {
    description: 'Validate and record a change set as proposed (or draft); never touches the model',
    inputSchema: { change_set: z.record(z.string(), z.unknown()), actor: z.string().optional(), expected_head: z.string().optional(), draft: z.boolean().optional() },
  }, async (a) => guarded(() => ctx.withWriteLock(async () => {
    const actor = needActor(a.actor)
    const r = await proposeChangeSet(ctx.repoDir, a.change_set, { actor, expectedBaseRevision: await resolveExpected(ctx, a.expected_head), draft: a.draft })
    return ok(r.record.sha, { change: r.changeSet.id, disposition: r.changeSet.disposition, revised: r.revised, path: r.record.path, warnings: issueRows(r.validation.issues), ...projectedRows(r.validation.projected) })
  })))

  server.registerTool('set_disposition', {
    description: 'Governance transition for a change set (draft/proposed/accepted/rejected/superseded)',
    inputSchema: { change_id: z.string(), to: z.enum(['draft', 'proposed', 'accepted', 'rejected', 'superseded']), actor: z.string().optional(), expected_head: z.string().optional(), superseded_by: z.string().optional() },
  }, async (a) => guarded(() => ctx.withWriteLock(async () => {
    const actor = needActor(a.actor)
    const r = await setDisposition(ctx.repoDir, a.change_id, a.to, { actor, expectedHead: await resolveExpected(ctx, a.expected_head), supersededBy: a.superseded_by })
    return ok(r.sha, { change: a.change_id, disposition: a.to })
  })))

  server.registerTool('promote', {
    description: 'Apply an accepted change set to the baseline, marking what is unverified as intended (the only write into model/)',
    inputSchema: { change_id: z.string(), actor: z.string().optional(), expected_head: z.string().optional() },
  }, async (a) => guarded(() => ctx.withWriteLock(async () => {
    const actor = needActor(a.actor)
    const r = await promoteChangeSet(ctx.repoDir, a.change_id, { actor, expectedHead: await resolveExpected(ctx, a.expected_head) })
    return ok(r.sha, {
      change: r.changeId, baseline_was: short(r.baseline), added: r.added, removed: r.removed,
      deferred: r.deferred.map(d => `${d.entityId}:${d.op}`),
      ...(r.reconciled.length ? { reconciled: r.reconciled.map(x => `${x.changeId}:${x.entityId}:${x.op}`) } : {}),
      ...(r.warnings.length ? { warnings: r.warnings } : {}),
    })
  })))

  server.registerTool('record_evidence', {
    description: 'Append an evidence record to a change set; verification is derived, then the model is reconciled',
    inputSchema: { change_id: z.string(), evidence: z.record(z.string(), z.unknown()), actor: z.string().optional(), expected_head: z.string().optional() },
  }, async (a) => guarded(() => ctx.withWriteLock(async () => {
    const actor = needActor(a.actor)
    const r = await recordEvidence(ctx.repoDir, a.change_id, a.evidence, { actor, expectedRevision: await resolveExpected(ctx, a.expected_head) })
    const s = await ctx.snapshot()
    const v = s.ledger.get(a.change_id)!.verification
    // The evidence is committed either way; a failed reconciliation is reported, not fatal.
    const reconcile = await reconcileBaseline(ctx.repoDir, { actor })
      .then(x => ({ changed: x.changed, ...(x.applied.length ? { applied: x.applied.map(o => `${o.changeId}:${o.entityId}:${o.op}`) } : {}), ...(x.warnings.length ? { warnings: x.warnings } : {}) }))
      .catch((e: unknown) => ({ changed: false, error: e instanceof Error ? e.message.split('\n')[0] : String(e) }))
    return ok(await ctx.head(), { change: a.change_id, evidence: r.record.id, verification: v.status, warnings: r.warnings, reconcile })
  })))

  server.registerTool('reconcile', {
    description: 'Apply verified deferred operations and refresh status tags in the committed model (idempotent)',
    inputSchema: { actor: z.string().optional(), expected_head: z.string().optional() },
  }, async (a) => guarded(() => ctx.withWriteLock(async () => {
    const actor = needActor(a.actor)
    const r = await reconcileBaseline(ctx.repoDir, { actor, expectedHead: await resolveExpected(ctx, a.expected_head) })
    return ok(r.sha, { changed: r.changed, applied: r.applied.map(o => `${o.changeId}:${o.entityId}:${o.op}`), counts: r.counts, ...(r.warnings.length ? { warnings: r.warnings } : {}) })
  })))

  server.registerTool('project', {
    description: 'Candidate projection of change sets on the baseline (nothing written); render dsl, html or png',
    inputSchema: { changes: z.array(z.string()).min(1), baseline_revision: z.string().optional(), highlight: z.boolean().optional(), ...renderInput },
  }, async (a) => guarded(async () => {
    const s = a.baseline_revision ? null : await ctx.snapshot()
    const p = await projectModel(ctx.repoDir, { includeChanges: a.changes, baselineRevision: a.baseline_revision, highlight: a.highlight, ledger: s?.ledger })
    const base: Record<string, unknown> = {
      applied: p.applied, baseline: { source: p.baseline.source, revision: short(p.baseline.revision) },
      diff: p.diff, elements: [...p.model.elements()].length, relationships: [...p.model.relationships()].length,
      ...(p.warnings.length ? { warnings: issueRows(p.warnings) } : {}),
    }
    return ok(p.baseline.revision, await rendered(base, p, a, s?.ledger))
  }))

  server.registerTool('qualify', {
    description: 'Committed baseline annotated per entity with derived verification (by environment, revision)',
    inputSchema: { environment: z.string().optional(), revision: z.string().optional(), detail: z.enum(['counts', 'full']).optional(), ...renderInput },
  }, async (a) => guarded(async () => {
    const s = a.revision ? null : await ctx.snapshot()
    const q = await qualifyBaseline(ctx.repoDir, { environment: a.environment, revision: a.revision, highlight: a.render !== undefined && a.render !== 'none', ledger: s?.ledger })
    const base: Record<string, unknown> = { environment: q.environment, baseline: { source: q.baseline.source, revision: short(q.baseline.revision) }, counts: q.counts }
    if (a.detail === 'full') base.entities = [...q.entities.values()].filter(e => e.status !== 'unrecorded').map(e => ({ id: e.entityId, status: e.status, change: e.changeId, basis: e.basis, reason: e.reason }))
    else base.attention = [...q.entities.values()].filter(e => e.status === 'failed' || e.status === 'partial').map(e => `${e.entityId}:${e.status}:${e.changeId}`)
    return ok(q.baseline.revision, await rendered(base, q, a, s?.ledger))
  }))

  server.registerTool('render', {
    description: 'Render the committed baseline for people: html (interactive site, default), png, or dsl',
    inputSchema: { format: z.enum(['html', 'png', 'dsl']).optional(), revision: z.string().optional(), out_dir: z.string().optional(), views: z.array(z.string()).optional() },
  }, async (a) => guarded(async () => {
    const s = a.revision ? null : await ctx.snapshot()
    const loaded = await loadModel(ctx.repoDir, a.revision ? { revision: a.revision } : {})
    const base = { baseline: { source: loaded.source, revision: short(loaded.revision ?? s?.head) }, views: Object.keys(loaded.parsedData.views ?? {}) }
    return ok(loaded.revision ?? s?.head, await rendered(base, { data: loaded.parsedData }, { render: a.format ?? 'html', out_dir: a.out_dir, views: a.views }, s?.ledger))
  }))

  server.registerTool('releases', {
    description: 'Deployment timeline per environment, and the released baseline (model at the latest passing deployment)',
    inputSchema: { environment: z.string().optional(), at: z.string().optional(), detail: z.enum(['timeline', 'baseline']).optional() },
  }, async (a) => guarded(async () => {
    const s = await ctx.snapshot()
    const timeline = releaseTimeline(s.ledger, { environment: a.environment }).map(e => ({
      change: e.changeId, evidence: e.evidenceId, env: e.environment, result: e.result, at: e.observedAt,
      code: e.codeRevision, baseline: short(e.baselineRevision), promoted: e.promoted,
    }))
    if (a.detail !== 'baseline') return ok(s.head, { environment: a.environment ?? 'all', events: timeline.slice(-50), truncated: timeline.length > 50 })
    if (!a.environment) return fail('VALIDATION', 'environment is required for detail=baseline')
    const r = await releasedBaseline(ctx.repoDir, { environment: a.environment, at: a.at, ledger: s.ledger })
    const summary = r.model && r.registry
      ? { elements: [...r.model.elements()].length, relationships: [...r.model.relationships()].length, roots: [...r.model.roots()].map(e => r.registry!.elementByFqn(e.id)?.stableId ?? `fqn:${e.id}`) }
      : null
    return ok(s.head, {
      environment: r.environment, at: r.at, revision: short(r.revision),
      deployment: r.deployment ? { change: r.deployment.changeId, evidence: r.deployment.evidenceId, at: r.deployment.observedAt, baseline_source: r.deployment.baselineSource } : null,
      deployed: r.deployedChangeSets, failed: r.failedChangeSets, model: summary, ...(r.warnings.length ? { warnings: r.warnings } : {}),
    })
  }))

  server.registerTool('bootstrap', {
    description: 'Adopt a system: init an empty model repo, or adopt an existing LikeC4 model as inferred baseline (help adopt)',
    inputSchema: {
      mode: z.enum(['init', 'adopt']), actor: z.string().optional(),
      name: z.string().optional(), kinds: z.array(z.string()).optional(), relationship_kinds: z.array(z.string()).optional(), tags: z.array(z.string()).optional(),
    },
  }, async (a) => guarded(() => ctx.withWriteLock(async () => {
    const actor = needActor(a.actor)
    if (a.mode === 'init') {
      if (!a.name) return fail('VALIDATION', 'name is required for init')
      const r = await initModelRepo(ctx.repoDir, { name: a.name, actor, kinds: a.kinds, relationshipKinds: a.relationship_kinds, tags: a.tags })
      return ok(r.sha, { mode: 'init', files: r.files, next: 'propose inferred change sets (inferred: true), accept, promote; see help adopt' })
    }
    const r = await adoptExistingModel(ctx.repoDir, { actor })
    return ok(r.sha, { mode: 'adopt', assigned_ids: r.assignedIds, change_sets: r.changeSets, skipped: r.skipped })
  })))

  return server
}

/** expected_head may be a short sha; resolve it to the full sha so the library's equality check works. */
async function resolveExpected(ctx: RepoContext, expected?: string): Promise<string | undefined> {
  if (!expected) return undefined
  try { return await ctx.git.revParse(expected) } catch { return expected }
}
