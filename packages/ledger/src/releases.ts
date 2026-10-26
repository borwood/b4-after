// Release timeline and released baseline (PRD 6.3 "verified/released"). A release is a claim about
// an environment at a time, so it is modelled as deployment evidence over time, not as a filter on
// node statuses. The released baseline for an environment is the committed model at the revision
// the latest passing deployment ran.
import type { LikeC4Model } from '@likec4/core/model'
import { IdentityRegistry } from './identity.js'
import { Ledger, type ChangeRecord } from './ledger.js'
import { loadModel } from './model.js'
import { toUtcIso } from './git.js'
import type { EvidenceResult } from './evidence.js'

export interface ReleaseEvent {
  changeId: string
  evidenceId: string
  environment: string | null
  result: EvidenceResult
  observedAt: string
  codeRevision: string | null
  /** Model-data revision the deployment speaks for: the record's baseline_revision, else the change set's promotion commit. */
  baselineRevision: string | null
  baselineSource: 'record' | 'promotion' | 'unknown'
  promoted: boolean
  recordedBy: string
  sourceRef: string
}

/** The commit that promoted a change set, if the ledger can see it. */
export function promotionCommitOf(rec: ChangeRecord): string | null {
  if (!rec.changeSet.promotion) return null
  const c = rec.commits.find(c => c.subject.startsWith(`promote ${rec.changeSet.id}`))
  return c?.sha ?? null
}

export interface TimelineOptions { environment?: string }

/** Deployment evidence across the ledger, oldest first. */
export function releaseTimeline(ledger: Ledger, opts: TimelineOptions = {}): ReleaseEvent[] {
  const out: ReleaseEvent[] = []
  for (const rec of ledger.records.values()) {
    const amended = new Set(rec.evidence.map(e => e.amends).filter((x): x is string => !!x))
    for (const e of rec.evidence) {
      if (e.kind !== 'deployment' || amended.has(e.id)) continue
      if (opts.environment && e.environment && e.environment !== opts.environment) continue
      const promo = promotionCommitOf(rec)
      out.push({
        changeId: rec.changeSet.id, evidenceId: e.id, environment: e.environment ?? null, result: e.result,
        observedAt: toUtcIso(e.observed_at), codeRevision: e.code_revision ?? null,
        baselineRevision: e.baseline_revision ?? promo, baselineSource: e.baseline_revision ? 'record' : promo ? 'promotion' : 'unknown',
        promoted: !!rec.changeSet.promotion, recordedBy: e.recorded_by, sourceRef: e.source_ref,
      })
    }
  }
  return out.sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.changeId.localeCompare(b.changeId, 'en', { numeric: true }))
}

export interface ReleasedBaselineOptions {
  environment: string
  /** ISO time; default now. */
  at?: string
  /** Load the model at the released revision (default true). */
  loadModel?: boolean
  ledger?: Ledger
}

export interface ReleasedBaseline {
  environment: string
  at: string
  /** The deployment the released baseline rests on, or null when nothing passing was deployed by then. */
  deployment: ReleaseEvent | null
  revision: string | null
  /** Change sets with a passing deployment to this environment at or before `at` and not since failed. */
  deployedChangeSets: string[]
  /** Change sets whose latest deployment attempt in this environment failed. */
  failedChangeSets: string[]
  model: LikeC4Model | null
  registry: IdentityRegistry | null
  warnings: string[]
}

export async function releasedBaseline(repoDir: string, opts: ReleasedBaselineOptions): Promise<ReleasedBaseline> {
  const ledger = opts.ledger ?? await Ledger.load(repoDir)
  const at = toUtcIso(opts.at ?? new Date().toISOString())
  const warnings: string[] = []
  const events = releaseTimeline(ledger, { environment: opts.environment }).filter(e => e.observedAt <= at)

  // Latest attempt per change set decides whether it is deployed or failed.
  const latestByChange = new Map<string, ReleaseEvent>()
  for (const e of events) latestByChange.set(e.changeId, e)
  const deployedChangeSets = [...latestByChange.values()].filter(e => e.result === 'pass').map(e => e.changeId).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  const failedChangeSets = [...latestByChange.values()].filter(e => e.result === 'fail').map(e => e.changeId).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))

  // The released baseline is the latest passing deployment that can name a revision.
  const passing = events.filter(e => e.result === 'pass')
  const deployment = [...passing].reverse().find(e => e.baselineRevision) ?? passing.at(-1) ?? null
  if (deployment && !deployment.baselineRevision) warnings.push(`latest passing deployment ${deployment.evidenceId} names no baseline revision and ${deployment.changeId} has no visible promotion commit`)
  for (const e of latestByChange.values()) if (e.result === 'pass' && !e.promoted) warnings.push(`${e.changeId} was deployed but is not promoted; the released baseline cannot include it`)

  let model: LikeC4Model | null = null
  let registry: IdentityRegistry | null = null
  const revision = deployment?.baselineRevision ?? null
  if (revision && (opts.loadModel ?? true)) {
    try {
      model = (await loadModel(repoDir, { revision })).model
      registry = IdentityRegistry.fromModel(model)
    } catch (e: any) {
      warnings.push(`model at ${revision.slice(0, 7)} could not be loaded: ${e.message}`)
    }
  }
  if (!deployment) warnings.push(`no passing deployment to ${opts.environment} at or before ${at}`)
  return { environment: opts.environment, at, deployment, revision, deployedChangeSets, failedChangeSets, model, registry, warnings }
}
