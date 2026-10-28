# @borwood/b4-after-ledger

The library behind [b4-after](https://github.com/borwood/b4-after): change-set records with
stable identity and git provenance, candidate projections, governed promotion into a LikeC4
baseline, evidence-derived verification, a qualified baseline, release timelines, and a bounded
`storyOf()`. The MCP server in `@borwood/b4-after` is a thin facade over these functions; use the
library directly for CI hooks, custom tooling, or your own agent surface.

```sh
npm install @borwood/b4-after-ledger
```

Node 22.22 or later and git. HTML rendering shells out to the LikeC4 CLI and needs nothing more.
PNG rendering also needs Playwright with
Chromium.

## The repository it reads

```
<model repository>/
  model/      model.c4 and views.c4, generated LikeC4 DSL; written only by promotion, reconciliation and adoption.
  changes/    CHG-<n>.yaml, one logical change set per file, revised in place until promoted.
  evidence/   CHG-<n>.yaml, append-only evidence records per change set.
```

Every element and relationship in `model/` carries `stable_id` metadata. Change sets and evidence
refer to entities only by stable id. LikeC4 fully-qualified names and relationship hashes are
resolved from stable ids at query time and never stored in the ledger, so renames, moves, and
removals do not sever history.

## Load and query

```ts
import { Ledger, loadModel, IdentityRegistry, storyOf, formatStory } from '@borwood/b4-after-ledger'

const ledger = await Ledger.load(repoDir)                           // working tree
const asOf   = await Ledger.load(repoDir, { revision: 'abc123' })
const before = await Ledger.load(repoDir, { before: '2026-02-01T00:00:00Z' })

const { model } = await loadModel(repoDir, { revision: 'abc123' })  // baseline at that commit
const registry = IdentityRegistry.fromModel(model)                  // stable id <-> fqn / relation id

const story = await storyOf(repoDir, { entity: 'ent-billing', subtree: true, limit: 20 })
console.log(formatStory(story))                                     // compact Markdown
```

**Chronology is recorded history.** A change set's position is the committer date of the first
commit that touched its file. A query at a revision or `before` a time reads the records exactly
as they were committed then, so later dispositions and revisions do not leak into earlier
snapshots. Uncommitted records come back from working-tree reads flagged `unrecorded` and sorted
last. A record may also state `effective_at`; it is surfaced separately and never used for
ordering.

**Participation keeps its distinctions.** Per change set, each participant took part `via:
operation` (its own shape changed), `via: relationship_endpoint` (it is the source or target of a
relationship operation), or `via: reference` (`relates_to`; nothing about it changed). None of
these is ever turned into an architectural edge.

**storyOf() is bounded and one hop deep.** Each change set appears once. `matched` lists how the
queried entity or subtree members participated; `others` lists the remaining participants by
role, with no recursion into their histories. Pagination uses `limit` and `cursor`; `truncated` is
explicit. `subtree: true` uses the entity plus its descendants at the selected snapshot;
`membership: 'ever'` also includes everything a promoted change set ever added or moved under it.
An entity absent from the model (removed, or proposed but not yet promoted) still has a story.
Lineage recorded with `derived_from` and `succeeded_by` (splits, merges, replacements) shows up
one hop in stories and is never an architectural edge.

## Change sets

```ts
import { validateChangeSet, validateInContext, proposeChangeSet, setDisposition, promoteChangeSet } from '@borwood/b4-after-ledger'

const check = validateChangeSet(yamlObject, { registry, ledger })           // against one registry
const staged = await validateInContext(loaded, yamlObject, ledger)         // unpromoted depends_on projected first
await proposeChangeSet(repoDir, yamlObject, { actor: 'planning-agent', expectedBaseRevision: sha })
await setDisposition(repoDir, 'CHG-042', 'accepted', { actor: 'reviewer' })
await promoteChangeSet(repoDir, 'CHG-042', { actor: 'release-agent', expectedHead: sha })
```

**Validation refuses before LikeC4 would.** Schema first, then the operations in order against a
virtual copy of the baseline: unknown entities, kinds, and parents; duplicate ids and names (moves
included); names that are LikeC4 keywords (`E_RESERVED_WORD`: the DSL cannot quote them, so the
generated model would not parse); use after remove; moves into self or a descendant; LikeC4's rule
that a relationship cannot connect an element with its own ancestor or descendant; dependency
existence and cycles. Warnings cover empty change sets and references that duplicate an operation.
`validateInContext` first projects the change set's unpromoted dependencies (transitively) onto the
baseline, so related change sets can be proposed before any is promoted; its result lists the
`projected` ids, and warns (`W_DEPENDENCY_NOT_PROJECTED`) when they do not apply cleanly.

**Proposing** validates that way against HEAD's baseline and ledger and records the change set as
`proposed` (or `draft`) in its own commit. It never touches `model/`. Re-proposing the same id
revises it until it is promoted; after that, propose a new change set that depends on it.
**Dispositions** follow a fixed transition table: draft, proposed, accepted, rejected, superseded.

**Promotion is the only write path into `model/`.** The change set must be committed, `accepted`,
not yet promoted, with every dependency promoted. `planPromotion` splits its operations: additions
and moves apply now and are marked; updates and removals of entities that already exist are
deferred until evidence verifies them. Inferred change sets, already-verified targets, and targets
that are themselves still intended apply at once: an entity that does not exist yet has nothing to
stay faithful to, so a revised plan replaces the plan and a dropped one disappears. The workspace
is regenerated, reloaded with the real parser, and every stable id is checked
to survive, all before anything is written. Then `model/model.c4` and `model/views.c4` are
rewritten and the change set gains a `promotion` record, in one commit with provenance trailers.
Any failure restores the working tree. The result lists `deferred` operations and `warnings`,
including the case where deferral had to be abandoned because it would leave the change set
inconsistent.

**Provenance is dual.** Commits carry a subject such as `propose CHG-042: Add asynchronous billing
retries` and trailers `Change-Id`, `Origin`, `Actor`, `Intent`, `Disposition`, `Implementation`
(the derived value at commit time). The YAML stays authoritative for intent and associations; the
commit supplies chronology and authorship. `expectedHead` refuses to write on a stale view of the
repository.

## Status and reconciliation

```ts
import { reconcileBaseline, annotateStatuses, TAG, META, flagsOfTags } from '@borwood/b4-after-ledger'

await reconcileBaseline(repoDir, { actor: 'ci' })   // { changed, sha, applied, warnings, counts }
const s = await annotateStatuses(parsedData, ledger) // per-entity flags and reasons, data annotated in place
flagsOfTags(element.tags)                            // ['intended'] | ['retiring'] | ['pending_update', 'failed'] | []
```

The committed model says what exists. Every entity carries metadata `b4_change` (latest promoted
change set operating on it), `b4_status` (its verification for that entity: verified, unverified,
failed) and, when operations are deferred, `b4_pending`. Reserved tags carry the flags:
`b4-intended` (added, unverified: does not exist yet; dashed and faded), `b4-retiring` (removal
promoted, unverified: still exists; dotted and muted), `b4-pending-update` (current values shown),
`b4-pending-move` (with `b4_moved_from`), `b4-failed`. Agents cannot set or erase them: validation
rejects `b4-*` tags, `b4_*` metadata and `stable_id` (`E_RESERVED_TAG`, `E_RESERVED_METADATA`) and tag
replacement keeps them. Building on a retiring element is allowed and warned (`W_RETIRING_TARGET`).

`reconcileBaseline` applies every deferred operation whose change set is now verified for that
target (removals cascade), refreshes all flags, regenerates `model/`, and commits once, only when
something changed. It is idempotent, and it is how a repository written before statuses existed is
brought up to date. Verification per target comes from `targetVerification`; implementation
progress from `deriveImplementation` (inferred or verified: implemented; any observation: in
progress; else not started). The `implementation` field on change sets is deprecated: accepted,
dropped, and warned about.

**Views are generated** (`generateViews`) into `model/views.c4`: folders "As-is" and "Target",
each with a landscape, an everything view, one view per element with children (`el--<fqn>`), and
one per user tag (`tag--<name>`). As-is views exclude intended entities and edges; Target views show
them and override pending titles, descriptions and technologies with the intended values from the
ledger. `workspaceFiles` produces both files from parsed data; `generateAndCheck` proves they load.

## Projections and rendering

```ts
import { projectModel, renderProjection } from '@borwood/b4-after-ledger'

const p = await projectModel(repoDir, { includeChanges: ['CHG-042', 'CHG-044'] })
p.model            // computed LikeC4 model with the operations applied; baseline untouched
p.diff             // added / updated / moved / removed, cascades marked
await renderProjection(p, { format: 'dsl', ledger })
await renderProjection(p, { format: 'html', ledger })          // interactive single-file site: the format for people
await renderProjection(p, { format: 'png', views: ['el--billing'] })
```

Projections apply operations to a copy of the baseline's parsed data and recompute. Each change
set is validated against the state the previous ones produced; overlapping writes to the same
field by change sets with no `depends_on` between them fail with `E_CONFLICT`. Dependencies must
be included or already promoted. Candidate additions and changes render amber with a dashed border
and a `candidate` tag; pass `highlight: false` to skip. `update_*` merges (metadata keys patched,
`null` deletes a key; tags replaced); `move_element` rewrites fully-qualified names, relationship endpoints, and view
rules; `remove_element` cascades to descendants, attached relationships, and view predicates.

## Evidence and verification

```ts
import { recordEvidence, deriveVerification, qualifyBaseline, formatQualification } from '@borwood/b4-after-ledger'

await recordEvidence(repoDir, 'CHG-042', {
  id: 'ev-042-ci', kind: 'test', result: 'pass', source_ref: 'https://ci/runs/9912',
  code_revision: '3f2a1c9', environment: 'staging', observed_at: '2026-04-11T12:00:00Z', recorded_by: 'ci-agent',
}, { actor: 'ci-agent' })

const ledger = await Ledger.load(repoDir)                      // every record carries .evidence and .verification
ledger.verificationOf('CHG-042', { environment: 'production' })
const q = await qualifyBaseline(repoDir, { environment: 'staging' })
console.log(formatQualification(q))
```

Evidence records have `id`, `kind` (test, runtime_observation, deployment, code_review,
manual_review), `result` (pass, fail, inconclusive), optional `targets` (stable ids the record
speaks to; none means the whole change set), `source_ref`, optional `code_revision`,
`baseline_revision`, and `environment`, `observed_at`, `recorded_by`, and optional `amends`
pointing at an earlier record it corrects. Corrections are new records; the prior claim stays on
file and in git. Recording refuses evidence for unknown change sets or uninvolved entities and
never touches `model/` or `changes/`.

**Verification is derived, never asserted.** `deriveVerification(changeSet, records, policy)`:

- Targets are the change set's operation ids. Relationship endpoints and references are not
  targets; evidence aimed at them is listed as ignored, with the reason.
- Only observations (test, runtime_observation) can verify. Approvals (code_review,
  manual_review) and deployments are surfaced separately and never verify by themselves.
- A passing observation counts only with a `code_revision` (policy `requireCodeRevision`, default
  true). Records amended by a later record, and inconclusive results, are ignored.
- `failed` if any applicable observation failed; `verified` when every target is covered by a
  passing observation and any `requireKinds` / `requireApproval` policy is met; `partial` when
  there are passing observations without full coverage; otherwise `unverified`.
- `environment` restricts to that environment plus environment-agnostic records, so status is
  always qualified by environment (`any` when none was asked for).

The result says what it rests on: `basis`, `failing`, `covered`, `uncovered`, `approvals`,
`deployments`, `ignored`. A historical query shows only the evidence on file at that revision.

**qualifyBaseline** annotates each entity of the committed model with the verification of the
promoted change set that last operated on it (`unrecorded` when none). It does not filter the
architecture by status; it tags and recolours entities so a rendered diagram shows what is
verified, partial, failed, unverified, or unrecorded, per environment and at any revision.

## Releases

```ts
import { releaseTimeline, releasedBaseline } from '@borwood/b4-after-ledger'

releaseTimeline(ledger, { environment: 'production' })
await releasedBaseline(repoDir, { environment: 'production', at: '2026-06-01T00:00:00Z' })
```

A release is a claim about an environment at a time, so it is derived from deployment evidence
rather than from status fields. The timeline lists deployment records oldest first; each names the
model revision it speaks for (the record's `baseline_revision`, else the change set's promotion
commit). The released baseline is the latest passing deployment at or before `at`, the committed
model at that revision, the change sets whose latest attempt passed, and those whose latest
attempt failed. Deployments of unpromoted change sets are listed and flagged.

## Adoption

```ts
import { initModelRepo, adoptExistingModel } from '@borwood/b4-after-ledger'

await initModelRepo(dir, { name: 'Shop', actor: 'adopter', kinds: ['actor', 'system', 'container', 'component', 'datastore'], tags: ['external'] })
await adoptExistingModel(dir, { actor: 'adopter' })
```

`initModelRepo` creates an empty, valid model repository as its own git repository, even when the
directory sits inside another repository's work tree. `adoptExistingModel` takes an existing
LikeC4 model, assigns missing stable ids, records one inferred, pre-ledger-promoted change set per
root plus one for cross-root relationships, and regenerates `model/` with statuses and views; it is
idempotent. Inferred change sets carry `inferred: true` so stories and the qualified baseline say
where knowledge came from. The agent procedure for inferring a baseline from a codebase is the
`b4-after-adopt` skill shipped with `@borwood/b4-after`.

## Notes on LikeC4

The library pins an exact LikeC4 version. Tag colours: LikeC4 assigns palette names to tags
declared without a colour, and its generator writes them back in a form its parser rejects;
`generateDSL` normalises these to hex so every regeneration path is safe. `computedModel()`
returns one shared mutable instance; the library disposes LikeC4 services right after extracting
a model and only ever projects on detached parsed data. More in the
[LikeC4 notes](https://github.com/borwood/b4-after/blob/main/docs/likec4-findings.md).

## Changelog

Release notes for both packages live in the repository's
[CHANGELOG.md](https://github.com/borwood/b4-after/blob/main/CHANGELOG.md).

## Development

```sh
npm install
npm run build -w packages/ledger
npm test -w packages/ledger
```

Tests build a temporary git repository from `examples/billing` with dated commits.
