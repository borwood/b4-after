# @like-b4/ledger

Phase B of the Architecture Change Ledger: change-set records, stable identity, Git provenance,
derived indexes, validation, and a bounded `storyOf()` over a LikeC4 model-data repository.
See the PRD at the repository root and `spikes/phase-a/FINDINGS.md` for the decisions this encodes.

## Repository layout it reads

```
<model-data repo>/
  model/      LikeC4 DSL (machine-generated; agents are the only writers)
  changes/    CHG-<n>.yaml, one logical change set per file, revised in place over time
```

Every element and relationship in `model/` must carry `stable_id` metadata. Change sets refer to
entities only by stable id. LikeC4 FQNs and relationship hashes are resolved from stable ids at
query time and never stored in the ledger, so renames, moves, and removals do not sever history.

## API

```ts
import { Ledger, storyOf, validateChangeSet, recordChangeSet, loadModel, IdentityRegistry } from '@like-b4/ledger'

const ledger = await Ledger.load(repoDir)                       // working tree
const asOf   = await Ledger.load(repoDir, { revision: 'abc123' })
const before = await Ledger.load(repoDir, { before: '2026-02-01T00:00:00Z' })

const { model } = await loadModel(repoDir, { revision: 'abc123' }) // baseline at that commit
const registry = IdentityRegistry.fromModel(model)                 // stable id <-> FQN / relation id

const story = await storyOf(repoDir, { entity: 'ent-billing', subtree: true, limit: 20 })
const check = validateChangeSet(yamlObject, { registry, ledger })
await recordChangeSet(repoDir, changeSet, { actor: 'implementation-agent', expectedHead: sha })
```

## Semantics worth knowing

**Chronology is recorded history.** A change set's position is the committer date of the first
commit that touched its file. A query at revision R or `before` T reads the records exactly as they
were committed then, so later dispositions and revisions do not leak into earlier snapshots
(AT-04). `before` resolves to the latest commit at or before T on the branch; a time before the
first commit yields an empty ledger, not an error. Uncommitted records are returned from working
tree reads flagged `unrecorded` and sorted last. A record may also state `effective_at`; it is
surfaced separately and never used for ordering.

**Participation keeps the PRD distinctions.** `participantsOf()` derives, per change set, who took
part and how: `via: operation` (the entity's own shape changed), `via: relationship_endpoint`
(the entity is the source or target of a relationship operation; the entity itself was not edited),
or `via: reference` (`relates_to`; nothing about the entity changed). Nothing here is ever turned
into an architectural edge.

**storyOf() is bounded and one hop deep.** Each logical change set appears once. `matched` lists
how the queried entity (or subtree members) participated; `others` lists the remaining
participants by role, with no recursion into their histories. Pagination uses `limit` and
`cursor`, and `truncated` is explicit. Subtree membership is the entity plus its current
descendants at the selected snapshot (`membership: descendants_at_snapshot`); "ever under it" and
"as of another revision" are not implemented (PRD 7.2 [O]). Relationships attached to member
elements at the snapshot are included in the match set, so an update or removal that names a
relationship only by id still counts as touching its endpoints (PRD 7.1). An entity absent from
the model (removed, or proposed but not yet promoted) still has a story; `subject.resolved` is
null in that case.

**Validation refuses before LikeC4 would.** `validateChangeSet()` checks schema, then walks the
operations in order against a virtual copy of the baseline: unknown entities, kinds, and parents;
duplicate ids and names; use after remove; moves into self or a descendant; the LikeC4 rule that a
relationship cannot connect an element with its own ancestor or descendant; dependency existence
and cycles. Warnings cover empty change sets and references that duplicate an operation. Without
a registry only the schema is checked, and the result says so.

**Provenance is dual.** `recordChangeSet()` writes the YAML and commits it with a subject such as
`propose CHG-042: Add asynchronous billing retries` and trailers `Change-Id`, `Origin`, `Actor`,
`Intent`, `Disposition`, `Implementation`. The YAML stays authoritative for intent and
associations; the commit supplies chronology and authorship. `expectedHead` refuses to write on a
stale view of the repository.

## Phase C: candidates, proposals, promotion

```ts
import { projectModel, renderProjection, proposeChangeSet, setDisposition, promoteChangeSet } from '@like-b4/ledger'

const p = await projectModel(repoDir, { includeChanges: ['CHG-042', 'CHG-044'], baselineRevision?: sha })
p.model            // computed LikeC4Model with the operations applied; baseline untouched
p.diff             // added / updated / moved / removed (cascades marked)
await renderProjection(p, { format: 'dsl' })                 // generated DSL for the candidate
await renderProjection(p, { format: 'png', views: ['billing'] }) // via likec4 CLI (Playwright)

await proposeChangeSet(repoDir, yamlObject, { actor, expectedBaseRevision: sha })
await setDisposition(repoDir, 'CHG-042', 'accepted', { actor: 'reviewer' })
await promoteChangeSet(repoDir, 'CHG-042', { actor, expectedHead: sha })
```

**Projections** apply operations to a copy of the baseline's parsed data and recompute. Each
change set is validated against the state the previous ones produced, so hard conflicts fail
validation; overlapping writes to the same field by change sets with no `depends_on` between them
fail with `E_CONFLICT`. Dependencies must be included or already promoted; cycles and rejected
dependencies are refused. Candidate additions and changes render amber with a dashed border and
the `candidate` tag (added to the spec for the projection only); pass `highlight: false` to skip.
Operation semantics: `update_*` merges (metadata keys are patched, tags replace); `move_element`
rewrites FQNs, relationship endpoints, and view rules; `remove_element` cascades to descendants,
attached relationships, and view predicates, and drops views scoped to the element.

**proposeChangeSet** validates against HEAD's baseline and ledger and records the change set as
`proposed` (or `draft`) in its own commit. It never touches `model/`. A promoted change set cannot
be revised; propose a new one that depends on it. **setDisposition** records governance
transitions (draft, proposed, accepted, rejected, superseded) with a fixed transition table.

**promoteChangeSet** is the only write path into `model/`. Policy (default): the change set must be
committed, `accepted`, not yet promoted, and every dependency must be promoted. The operations are
applied without highlight, the DSL is regenerated, reloaded with the real parser, and every stable
id is checked to survive, all before anything is written. Then `model/model.c4` is rewritten (other
`.c4` files are removed on the first promotion: the generated file is the only source) and the
change set gains a `promotion` record, in one commit with provenance trailers. Any failure restores
the working tree. A change set recorded after its operations were already in the baseline carries
`promotion.baseline: pre-ledger`.

## Phase D: evidence, derived verification, qualified baseline

```ts
import { recordEvidence, deriveVerification, qualifyBaseline, formatStory, formatQualification } from '@like-b4/ledger'

await recordEvidence(repoDir, 'CHG-042', {
  id: 'ev-042-ci', kind: 'test', result: 'pass', source_ref: 'https://ci/runs/9912',
  code_revision: '3f2a1c9', environment: 'staging', observed_at: '2026-04-11T12:00:00Z', recorded_by: 'ci-agent',
}, { actor: 'ci-agent', expectedRevision: sha })

const ledger = await Ledger.load(repoDir)             // every record carries .evidence and .verification
ledger.verificationOf('CHG-042', { environment: 'production' })
const q = await qualifyBaseline(repoDir, { environment: 'staging' })  // per-entity status over the committed model
formatStory(await storyOf(repoDir, { entity: 'ent-billing', subtree: true }))
```

**Evidence** lives in `evidence/CHG-<n>.yaml`, one file per change set, append-only. A record has
`id`, `kind` (test, runtime_observation, deployment, code_review, manual_review), `result` (pass,
fail, inconclusive), optional `targets` (stable ids the record speaks to; none means the whole
change set), `source_ref`, optional `code_revision` and `environment`, `observed_at`,
`recorded_by`, and optional `amends` pointing at an earlier record it corrects. Corrections are new
records; the prior claim stays on file and in git. `recordEvidence` refuses evidence for unknown
change sets or uninvolved entities and commits with `Change-Id`, `Evidence-Id`, `Actor`, `Kind`,
`Result` trailers. It never touches `model/` or `changes/`.

**Verification is derived, never asserted.** `deriveVerification(changeSet, records, policy)`:

- Targets are the change set's operation ids. Relationship endpoints and `relates_to` references
  are not targets; evidence aimed at them is listed as ignored with the reason.
- Only *observations* (test, runtime_observation) can verify. Approvals (code_review,
  manual_review) and deployments are surfaced separately and never verify by themselves (AT-06).
- A passing observation counts only with a `code_revision` (policy `requireCodeRevision`, default
  true). Records amended by a later record, and inconclusive results, are ignored.
- `failed` if any applicable observation failed; `verified` when every target is covered by a
  passing observation and any `requireKinds` / `requireApproval` policy is met; `partial` when
  there are passing observations without full coverage; otherwise `unverified`.
- `environment` restricts to that environment plus environment-agnostic records. Status is
  therefore always qualified by environment (`any` when none was asked for).

The result says what it rests on: `basis`, `failing`, `covered`, `uncovered`, `approvals`,
`deployments`, `ignored`. Ledger records expose it as `verification`; story entries carry a
summary and can include the records and full derivation with `include: ['evidence']`; a
historical query shows only the evidence on file at that revision (AT-04).

**qualifyBaseline** annotates each entity of the committed model with the verification of the
promoted change set that last operated on it (`unrecorded` when none). It does not filter the
architecture by status (PRD 6.3 warns against that); it tags and recolours entities so a rendered
diagram shows what is verified, partial, failed, unverified, or unrecorded, per environment and
at any revision.

**formatStory / formatQualification** render compact Markdown summaries for agents and humans.

## Not yet

Historical subtree membership modes, release/deployment projections beyond listing deployment
evidence, and the agent-facing MCP facade.

## Development

```
npm install                      # npm >= 12; npm 11.5 crashed resolving LikeC4's peer graph
npm run typecheck -w packages/ledger
npm test -w packages/ledger
```

Tests build a temporary git repository from `examples/billing` with dated commits.
