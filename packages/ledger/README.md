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

## Not in Phase B

Projections (applying operations to the model), candidate rendering, promotion to baseline,
evidence records, composed multi-change projections, and the agent-facing MCP facade. Those are
Phases C and D. The Phase A spike shows the mechanics each will use.

## Development

```
npm install                      # npm >= 12; npm 11.5 crashed resolving LikeC4's peer graph
npm run typecheck -w packages/ledger
npm test -w packages/ledger
```

Tests build a temporary git repository from `examples/billing` with dated commits.
