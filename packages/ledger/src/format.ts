// Compact textual summaries for agents and humans (PRD 7.1: "a concise summary with detail
// expansion on demand"). Markdown, deterministic, no model loading.
import type { StoryResult, StoryEntry } from './story.js'
import type { QualifiedBaseline } from './qualify.js'

export function formatStory(story: StoryResult): string {
  const s = story.subject
  const head = s.resolved
    ? `${s.resolved.stableId}${s.resolved.fqn ? ` (${s.resolved.fqn})` : ''}`
    : `${s.requested} (not in the model at this snapshot)`
  const lines: string[] = []
  lines.push(`# Story of ${head}`)
  const snap = story.snapshot.source === 'revision'
    ? `as recorded at ${story.snapshot.revision?.slice(0, 7) ?? 'nothing'}${story.snapshot.before ? ` (before ${story.snapshot.before})` : ''}`
    : `working tree${story.snapshot.revision ? ` at ${story.snapshot.revision.slice(0, 7)}` : ''}`
  const scope = s.membership === 'descendants_at_snapshot' ? `subtree of ${s.members.length} entities`
    : s.membership === 'ever_recorded' ? `subtree of ${s.members.length} entities incl. ${s.historicalMembers.length} historical`
    : 'entity only'
  lines.push(`${snap}; ${scope}; ${story.total} change set${story.total === 1 ? '' : 's'}${story.truncated ? ` (showing ${story.entries.length}, truncated)` : ''}.`)
  if (story.warnings.length) lines.push(...story.warnings.map(w => `> ${w}`))
  lines.push('')
  for (const e of story.entries) lines.push(formatEntry(e))
  return lines.join('\n').trimEnd() + '\n'
}

export function formatEntry(e: StoryEntry): string {
  const when = e.recordedAt ? e.recordedAt.slice(0, 10) : 'uncommitted'
  const state = [e.disposition, e.implementation, `${e.verification.status}${e.verification.environment !== 'any' ? `@${e.verification.environment}` : ''}`, e.promoted ? 'promoted' : null, e.inferred ? 'inferred' : null].filter(Boolean).join(' / ')
  const matched = e.matched.map(m => `${m.entityId}:${m.role}`).join(', ')
  const others = e.others.map(o => `${o.entityId}:${o.role}`).join(', ')
  const out = [`- **${e.changeId}** ${e.title} — ${when} — ${state}`]
  out.push(`  intent: ${e.intent}`)
  out.push(`  matched: ${matched || '(none)'}`)
  if (others) out.push(`  with: ${others}`)
  if (e.sources?.length) out.push(`  sources: ${e.sources.map(s => `${s.role} ${s.ref}`).join('; ')}`)
  if (e.dependsOn.length) out.push(`  depends on: ${e.dependsOn.join(', ')}`)
  if (e.verification.failing.length) out.push(`  failing evidence: ${e.verification.failing.join(', ')}`)
  else if (e.verification.basis.length) out.push(`  verified by: ${e.verification.basis.join(', ')}${e.verification.uncovered.length ? `; uncovered: ${e.verification.uncovered.join(', ')}` : ''}`)
  return out.join('\n')
}

export function formatQualification(q: QualifiedBaseline): string {
  const lines = [`# Evidence-qualified baseline (${q.environment}${q.baseline.revision ? `, ${q.baseline.revision.slice(0, 7)}` : ''})`]
  lines.push(Object.entries(q.counts).filter(([, n]) => n > 0).map(([k, n]) => `${k}: ${n}`).join(', '))
  lines.push('')
  const order: Record<string, number> = { failed: 0, partial: 1, unverified: 2, unrecorded: 3, verified: 4 }
  for (const e of [...q.entities.values()].sort((a, b) => (order[a.status]! - order[b.status]!) || a.entityId.localeCompare(b.entityId))) {
    lines.push(`- ${e.status.padEnd(10)} ${e.entityId}${e.fqn ? ` (${e.fqn})` : ''}${e.changeId ? ` via ${e.changeId}` : ''}: ${e.reason}`)
  }
  return lines.join('\n') + '\n'
}
