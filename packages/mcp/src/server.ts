// The agent-facing MCP server. Fifteen tools, one-line descriptions, compact JSON results, bounded
// defaults, help on demand. See help.ts for the documentation agents can pull in when they need it.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
  storyOf, validateChangeSet, proposeChangeSet, setDisposition, promoteChangeSet, recordEvidence,
  projectModel, renderProjection, qualifyBaseline, deriveVerification, initModelRepo, adoptExistingModel,
  overview, search, expand, elementDetail, resolveElement,
  Ledger, ProjectionError, ProposalRejected, PromotionRefused, LedgerError, EvidenceError,
  type StoryResult, type ValidationIssue,
} from '@like-b4/ledger'
import { RepoContext } from './context.js'
import { help, HELP_TOPICS } from './help.js'

export const SERVER_NAME = 'like-b4'
export const SERVER_VERSION = '0.1.0'

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : null)

function ok(head: string | null | undefined, data: object): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...data, head: short(head) }) }] }
}
function fail(code: string, error: string, extra: Record<string, unknown> = {}): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, code, error, ...extra }) }] }
}
const issueRows = (issues: ValidationIssue[]) => issues.map(i => ({ severity: i.severity, code: i.code, path: i.path, message: i.message, ...('changeId' in i ? { change: (i as any).changeId } : {}) }))

function toFailure(e: unknown): CallToolResult {
  if (e instanceof ProposalRejected) return fail('VALIDATION', e.message.split('\n')[0]!, { issues: issueRows(e.validation.issues) })
  if (e instanceof ProjectionError) return fail('PROJECTION', 'projection rejected', { issues: issueRows(e.issues) })
  if (e instanceof PromotionRefused) return fail('REFUSED', e.message, e.issues.length ? { issues: issueRows(e.issues) } : {})
  if (e instanceof LedgerError || e instanceof EvidenceError) return fail('VALIDATION', e.message.split('\n')[0]!, { issues: e.problems })
  const msg = e instanceof Error ? e.message : String(e)
  if (/repository moved/i.test(msg)) return fail('REPO_MOVED', msg, { hint: 'HEAD changed since expected_head; re-read, re-validate, retry' })
  if (/write lock busy/i.test(msg)) return fail('LOCK_BUSY', msg)
  if (/not in the ledger|not found|does not exist/i.test(msg)) return fail('NOT_FOUND', msg)
  if (/not an allowed transition|frozen|must be draft|can no longer be revised|promoted/i.test(msg)) return fail('REFUSED', msg)
  if (/invalid LikeC4 model|regenerated model/i.test(msg)) return fail('INVALID_MODEL', msg)
  return fail('ERROR', msg)
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
    instructions: 'Architecture model + change ledger. Start with overview, then help topic=start. Entities are stable ids (help ids). Writes need actor; pass expected_head when other agents may be writing.',
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

  server.registerTool('overview', {
    description: 'Project summary: roots, counts, open change sets, head',
    inputSchema: {},
  }, async () => guarded(async () => {
    const s = await ctx.snapshot()
    return ok(s.head, overview(s))
  }))

  server.registerTool('search', {
    description: 'Find elements by id, fqn, title, kind or tag (ranked, limit<=50)',
    inputSchema: { query: z.string(), kinds: z.array(z.string()).optional(), tags: z.array(z.string()).optional(), limit: z.number().int().optional() },
  }, async (a) => guarded(async () => {
    const s = await ctx.snapshot()
    return ok(s.head, search(s, a))
  }))

  server.registerTool('expand', {
    description: 'Descendants of an entity plus relationships touching them (depth<=5, max_nodes<=200)',
    inputSchema: { entity: z.string(), depth: z.number().int().optional(), relationships: z.enum(['direct', 'none']).optional(), max_nodes: z.number().int().optional() },
  }, async (a) => guarded(async () => {
    const s = await ctx.snapshot()
    const r = expand(s, { entity: a.entity, depth: a.depth, relationships: a.relationships, maxNodes: a.max_nodes })
    return r ? ok(s.head, r) : fail('NOT_FOUND', `no element ${a.entity} at HEAD`, { hint: 'help ids; story still works for removed entities' })
  }))

  server.registerTool('element', {
    description: 'One element in full: properties, relationships, views, change sets; qualify=true adds verification',
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
    description: 'List change sets, filterable by disposition, promoted, or entity',
    inputSchema: { disposition: z.enum(['draft', 'proposed', 'accepted', 'rejected', 'superseded']).optional(), promoted: z.boolean().optional(), entity: z.string().optional(), limit: z.number().int().optional() },
  }, async (a) => guarded(async () => {
    const s = await ctx.snapshot()
    const limit = Math.max(1, Math.min(a.limit ?? 50, 200))
    let recs = s.ledger.all()
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
        state: `${r.changeSet.disposition}/${r.changeSet.implementation}/${r.verification.status}${r.changeSet.promotion ? '/promoted' : ''}`,
        targets: [...new Set(r.changeSet.operations.map(o => o.id))], ...(r.changeSet.depends_on.length ? { depends_on: r.changeSet.depends_on } : {}),
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
    const v = validateChangeSet(a.change_set, { registry: s.registry, ledger: s.ledger })
    return ok(s.head, { valid: v.ok, issues: issueRows(v.issues) })
  }))

  server.registerTool('propose', {
    description: 'Validate and record a change set as proposed (or draft); never touches the model',
    inputSchema: { change_set: z.record(z.string(), z.unknown()), actor: z.string().optional(), expected_head: z.string().optional(), draft: z.boolean().optional() },
  }, async (a) => guarded(() => ctx.withWriteLock(async () => {
    const actor = needActor(a.actor)
    const r = await proposeChangeSet(ctx.repoDir, a.change_set, { actor, expectedBaseRevision: await resolveExpected(ctx, a.expected_head), draft: a.draft })
    return ok(r.record.sha, { change: r.changeSet.id, disposition: r.changeSet.disposition, revised: r.revised, path: r.record.path, warnings: issueRows(r.validation.issues) })
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
    description: 'Apply an accepted change set to the committed baseline (policy-gated; the only write into model/)',
    inputSchema: { change_id: z.string(), actor: z.string().optional(), expected_head: z.string().optional() },
  }, async (a) => guarded(() => ctx.withWriteLock(async () => {
    const actor = needActor(a.actor)
    const r = await promoteChangeSet(ctx.repoDir, a.change_id, { actor, expectedHead: await resolveExpected(ctx, a.expected_head) })
    return ok(r.sha, { change: r.changeId, baseline_was: short(r.baseline), added: r.added, removed: r.removed })
  })))

  server.registerTool('record_evidence', {
    description: 'Append an evidence record to a change set; verification is derived from these',
    inputSchema: { change_id: z.string(), evidence: z.record(z.string(), z.unknown()), actor: z.string().optional(), expected_head: z.string().optional() },
  }, async (a) => guarded(() => ctx.withWriteLock(async () => {
    const actor = needActor(a.actor)
    const r = await recordEvidence(ctx.repoDir, a.change_id, a.evidence, { actor, expectedRevision: await resolveExpected(ctx, a.expected_head) })
    const s = await ctx.snapshot()
    const v = s.ledger.get(a.change_id)!.verification
    return ok(r.sha, { change: a.change_id, evidence: r.record.id, verification: v.status, warnings: r.warnings })
  })))

  server.registerTool('project', {
    description: 'Candidate projection of change sets on the baseline (nothing written); render dsl or png',
    inputSchema: { changes: z.array(z.string()).min(1), baseline_revision: z.string().optional(), highlight: z.boolean().optional(), render: z.enum(['none', 'dsl', 'png']).optional(), out_dir: z.string().optional(), views: z.array(z.string()).optional() },
  }, async (a) => guarded(async () => {
    const s = a.baseline_revision ? null : await ctx.snapshot()
    const p = await projectModel(ctx.repoDir, { includeChanges: a.changes, baselineRevision: a.baseline_revision, highlight: a.highlight, ledger: s?.ledger })
    const base: Record<string, unknown> = {
      applied: p.applied, baseline: { source: p.baseline.source, revision: short(p.baseline.revision) },
      diff: p.diff, elements: [...p.model.elements()].length, relationships: [...p.model.relationships()].length,
      ...(p.warnings.length ? { warnings: issueRows(p.warnings) } : {}),
    }
    if (a.render === 'dsl') { const r = await renderProjection(p, { format: 'dsl' }); if (r.format === 'dsl') base.dsl = r.dsl }
    if (a.render === 'png') { const r = await renderProjection(p, { format: 'png', outDir: a.out_dir, views: a.views }); if (r.format === 'png') base.png = { dir: r.outDir, files: r.files } }
    return ok(p.baseline.revision, base)
  }))

  server.registerTool('qualify', {
    description: 'Committed baseline annotated per entity with derived verification (by environment, revision)',
    inputSchema: { environment: z.string().optional(), revision: z.string().optional(), detail: z.enum(['counts', 'full']).optional(), render: z.enum(['none', 'dsl', 'png']).optional(), out_dir: z.string().optional(), views: z.array(z.string()).optional() },
  }, async (a) => guarded(async () => {
    const s = a.revision ? null : await ctx.snapshot()
    const q = await qualifyBaseline(ctx.repoDir, { environment: a.environment, revision: a.revision, highlight: a.render !== undefined && a.render !== 'none', ledger: s?.ledger })
    const base: Record<string, unknown> = { environment: q.environment, baseline: { source: q.baseline.source, revision: short(q.baseline.revision) }, counts: q.counts }
    if (a.detail === 'full') base.entities = [...q.entities.values()].filter(e => e.status !== 'unrecorded').map(e => ({ id: e.entityId, status: e.status, change: e.changeId, basis: e.basis, reason: e.reason }))
    else base.attention = [...q.entities.values()].filter(e => e.status === 'failed' || e.status === 'partial').map(e => `${e.entityId}:${e.status}:${e.changeId}`)
    if (a.render === 'dsl') { const r = await renderProjection(q, { format: 'dsl' }); if (r.format === 'dsl') base.dsl = r.dsl }
    if (a.render === 'png') { const r = await renderProjection(q, { format: 'png', outDir: a.out_dir, views: a.views }); if (r.format === 'png') base.png = { dir: r.outDir, files: r.files } }
    return ok(q.baseline.revision, base)
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
      return ok(r.sha, { mode: 'init', files: r.files, next: 'propose inferred change sets (inferred: true, implementation: implemented), accept, promote; see help adopt' })
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
