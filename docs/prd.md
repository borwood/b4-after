> **About this document.** This is the original requirements document that cb4 was built
> from, kept for design rationale. It predates the name: it calls the project the "Architecture
> Change Ledger" and refers to implementation phases and acceptance tests (AT-nn, AR-nn) that the
> source code still cites. The READMEs describe what exists today; where the two differ, the
> READMEs are current.

# Architecture Change Ledger — Agent-Facing Product Requirements Document

**Status:** Draft for technical discovery and implementation planning  
**Date:** 2026-10-25  
**Working title:** Architecture Change Ledger (not a product-name decision)  
**Intended readers:** Implementing agents, engineering collaborators, and reviewers

## 0. Reading rules

This document separates **settled product requirements** from **provisional implementation choices** and **open decisions**. Do not silently convert provisional examples or unresolved questions into binding requirements.

- **[S] Settled:** Agreed behavior or deliberate scope boundary.
- **[P] Provisional:** Preferred implementation or API shape, subject to technical validation.
- **[O] Open:** Requires investigation or an explicit decision; do not invent an answer.
- **P0/P1:** Initial implementation priority, not a claim that every proposed feature belongs in the first release.

Examples and API signatures below are illustrative, **not** promises of existing LikeC4 functionality.

## 1. Purpose and success criteria

Build a lightweight, agent-friendly architecture model and change-history system for software projects. It combines hierarchical architecture-as-code, a small typed/ontology-like schema, Git provenance, hypothetical model changes, verification evidence, selective model queries, and human-readable diagrams.

Its distinctive capability is to answer **what a component is, what has been proposed or verified about it, why it changed, and what other components participated in the same intentional change** — without requiring the agent to load an entire codebase or architecture graph.

A successful initial product allows an agent to:

1. Start from a small project-level overview and drill into only relevant architecture.
2. Find entities and traverse typed relationships.
3. Propose a change set without silently changing the declared baseline.
4. Associate an external requirement/AC source with that change set rather than copying those documents into the graph.
5. Associate components by **structural operations** or **non-mutating references**.
6. Inspect a candidate projection and compare it with the baseline.
7. Record implementation/verification evidence without equating a Git commit or PR merge with correctness.
8. Retrieve the chronological **story of** a component or subgraph, including the other components involved in each change set.
9. View the architecture and candidate changes through human-readable diagrams.

## 2. Architecture position and scope

### 2.1 Selected direction

- **[S]** Keep the architecture model distinct from the history of changes to that model.
- **[S]** Treat logical change sets as durable, first-class records. They are **not** merely temporary patches, Git commits, or project-management issues.
- **[S]** Requirements and acceptance criteria may live outside the model/ledger. Change sets retain resolvable **source references** back to them.
- **[S]** Keep architectural relationships distinct from historical co-participation in a change. Being modified together does not imply an architectural dependency.
- **[S]** Prefer selective retrieval and bounded agent responses to loading the whole model.
- **[S]** The system must eventually be renderable for humans; use an existing renderer rather than inventing one without cause.
- **[S]** Humans do not read, write, or annotate model source. The **only write path** to the model and ledger is the agent-facing tooling this project designs or adopts. Model files are machine-generated artifacts; rendered diagrams and query results are the human-facing surface. *(Settled 2026-10-25 after Phase A.)*
- **[P]** Use a separate Git-backed **model-data repository**. Distribute runtime tooling independently from that repository and independently from the application's code repository.
- **[P]** Use **LikeC4** as the baseline modeling, query, and rendering engine. Build a companion application/library and possibly an MCP facade; **do not initially fork LikeC4**.
- **[P]** Use YAML or JSON files for change sets and evidence, validated with schemas; build indexes in memory or a disposable cache.

### 2.2 Boundaries / non-goals

- **[S]** Do not require requirements, AC, issues, or arbitrary documents to be duplicated as ontology nodes.
- **[S]** Do not turn the architecture graph into a full project-management or requirements-management graph.
- **[P]** No new graph database, RDF/OWL engine, bespoke visualization engine, or graph query language in the initial build.
- **[P]** No mandatory automatic code indexing, code-to-diagram synchronization, or architectural drift detection in P0. Evidence and validation interfaces should leave room for those later.
- **[P]** No full enterprise deployment-state engine or multi-user GUI in P0.
- **[S]** No support for hand-editing model files, and no requirement to preserve comments or formatting in model source. *(Struck 2026-10-25: earlier drafts assumed hand-authored DSL.)*

## 3. Conceptual model and invariants

### 3.1 Four layers

**A. Architecture model** — hierarchical entities, typed kinds, metadata/properties, and typed architectural relationships. Generates diagram views. It describes *declared architecture*, not automatically established truth.

**B. Change-set ledger** — logical changes with durable IDs, intent, sources, dependencies, proposed operations, non-mutating entity references, and evolution over time. Together with entities, change sets form a small *historical association graph* without polluting architectural dependency edges.

**C. State and evidence** — proposal disposition, implementation progress, verification observations, and optionally environment/release qualification. Evidence is attributable, scoped, and linked to relevant source-control or execution artifacts.

**D. Projections and access** — compute selected baseline/candidate representations and expose scoped queries to agents and diagrams to humans. A projection is a query result, not a second independent source of truth.

### 3.2 Distinctions that must not collapse

| Distinction | Required meaning |
|---|---|
| Architectural relationship vs. change association | `A -> B` in the architecture has domain meaning; `A` and `B` belonging to the same change set has historical meaning only. |
| `operations` vs. `references` | Operations change architecture shape/properties. References establish relevant participation **without** mutating the referenced entity. |
| Source reference vs. architecture node | A requirement, issue, or AC can remain external; a resolvable pointer and its role suffice. |
| Logical change set vs. Git commit | One `CHG-*` may evolve over multiple commits. Git versions the records; the change-set ID carries identity and intent. |
| Proposal disposition vs. implementation vs. verification | Accepted does not mean implemented; implemented or merged does not mean verified; verified in staging need not mean deployed to production. |
| Committed baseline vs. demonstrated reality | A committed architecture definition is a declared model, not proof that running software matches it. |
| Historical time vs. current interpretation | A query “as known at revision X” must not silently apply today's disposition/evidence to the past. |

## 4. Functional requirements

| ID | Priority | Status | Requirement |
|---|---|---|---|
| AR-01 | P0 | [S] | Represent architecture hierarchically with arbitrary useful nesting, not a fixed C4 depth. |
| AR-02 | P0 | [S] | Define entity kinds with expected properties and typed architectural relationship kinds. |
| AR-03 | P0 | [S] | Retrieve a top-level overview, search entities, and selectively expand descendants and relationships. |
| AR-04 | P0 | [S] | Enforce bounded default query results (depth, count, size); never require full-graph retrieval for ordinary agent operations. |
| AR-05 | P0 | [S] | Record a change set with stable ID, intent, external sources, zero or more model operations, and zero or more non-mutating entity references. |
| AR-06 | P0 | [S] | Preserve that several entities were involved in **one** logical change, distinguishing their roles. |
| AR-07 | P0 | [S] | Support creation and inspection of hypothetical changes without silently promoting them to the baseline. |
| AR-08 | P0 | [S] | Maintain lifecycle state without conflating proposed, accepted, implemented, verified, and deployed. |
| AR-09 | P0 | [S] | Keep independently inspectable verification evidence, including what was checked and to which change/version/environment it applies. |
| AR-10 | P0 | [S] | Provide `storyOf(entityOrSubgraph)` returning chronological, deduplicated change sets, matched entities, other participants, and source references. |
| AR-11 | P0 | [S] | Support history cutoff by time and/or Git revision; use a documented historical-time interpretation. |
| AR-12 | P0 | [S] | Preserve useful history when a component is renamed, moved, or deleted. |
| AR-13 | P0 | [S] | Track model and ledger edits in Git with machine-readable provenance linking commits to logical change sets. |
| AR-14 | P0 | [S] | Render declared architecture for humans; distinguish a candidate projection from baseline when presenting both. |
| AR-15 | P0 | [S] | Reject invalid change sets or projections rather than silently manufacturing a valid-looking architecture. |
| AR-16 | P1 | [P] | Support composed candidate projections from dependent change sets with explicit dependency and conflict checking. |
| AR-17 | P1 | [P] | Support historical subtree membership modes (current, at revision, ever) and richer historical comparisons. |
| AR-18 | P1 | [P] | Support policy-gated baseline promotion and environment-specific verified/released views. |
| AR-19 | P1 | [P] | Add programmatic architecture drift checks against code and deployment evidence when justified. |

## 5. Change-set semantics

### 5.1 Operations

**[S]** Operations carry requested or recorded structural/property changes. **[P]** Initial operation vocabulary:

- `add_element`, `update_element`, `move_element`, `remove_element`
- `add_relationship`, `update_relationship`, `remove_relationship`

Each operation should identify its target unambiguously, express relevant values, and permit precondition checking. An `add_relationship` associates both its source and target with the change set for history queries; it does **not** imply the nodes themselves were edited.

Relationship identity is an open technical issue if LikeC4 permits multiple otherwise-similar edges. Do not assume endpoints plus kind uniquely identify every relationship.

### 5.2 Non-mutating references

**[S]** A change set can reference an entity that its operations do not change. The minimal operator means **`relates_to`**: this entity is relevant to the intended change, with no assertion about dependency, implementation change, or modified architecture shape. A free-text reason may be attached. Do not infer architectural edges from it.

**[P]** Typed variants (e.g. `impacts`) may come later but must not be introduced merely for expressiveness without a defined meaning.

### 5.3 Provisional example

```yaml
id: CHG-042
title: Add asynchronous billing retries
intent: Isolate transient payment failures from synchronous billing requests
sources:
  - ref: https://example.test/issues/238
    role: requirement
  - ref: https://example.test/issues/238#acceptance-criteria
    role: acceptance_criteria
depends_on: [CHG-037]
disposition: proposed
operations:
  - op: add_element
    id: billing-retry-worker # illustrative stable identity
    parent: billing-service
    local_name: retry_worker
    kind: component
    title: Billing Retry Worker
  - op: add_relationship
    id: billing-api-publishes-retries
    from: billing-api
    to: billing-retry-worker
    kind: publishes_to
references:
  - entity: invoice-ui
    relation: relates_to
    reason: Failure and retry status is user-visible; model shape unchanged
```

**Notes:** This schema is illustrative; its fields, URI formats, and ID strategy are not finalized. `billing-api` participates via a relationship operation; `invoice-ui` participates only via `references`. Both must appear in an appropriate `storyOf()` response, with the distinction intact. Requirement and AC contents remain external.

### 5.4 Identity and evolution

- **[S]** A logical change set keeps its identity through proposal revisions, review, implementation, verification, and even rejection or supersession.
- **[S]** Rejected and superseded change sets remain available in history; they are not silently deleted.
- **[S]** Component histories must survive rename/move/removal.
- **[P]** Assign stable, non-hierarchical entity IDs, then resolve them to current LikeC4 fully qualified names (FQNs). The mapping may be stored in element metadata or a separate registry.
- **[O]** Decide relationship-ID scheme and how to model splits, merges, and replacement identity.
- **[P]** *(2026-10-26.)* Relationship ids: explicit `stable_id` metadata (Phase A). Splits, merges, replacements: `derived_from` on `add_element` and `succeeded_by` on `remove_element`, recorded in the ledger as lineage, shown one hop in `storyOf`, never turned into architectural relationships.

## 6. State, evidence, and model projections

### 6.1 Orthogonal state dimensions

**[S]** Do not implement one monolithic lifecycle enum.

**[P]** Start with:

- `disposition`: `draft | proposed | accepted | rejected | superseded`
- `implementation`: `not_started | in_progress | implemented` (with commit/PR references as evidence)
- `verification`: `unverified | partial | verified | failed` (derived from linked evidence where possible)
- Optional `environment` and release qualification on observations, rather than pretending `verified` is universal.

These enums and transition rules remain **[O]**. Evidence should distinguish *observation* from *approval*: CI success proves that a specific run passed, not that an entire architectural claim is verified.

**[P]** *(Phase D, 2026-10-26.)* Implemented as stated: `disposition` and `implementation` are recorded on the change set; `verification` is never recorded, only derived from evidence under a policy (`deriveVerification`). Evidence kinds are classed as observation (test, runtime_observation), approval (code_review, manual_review), or deployment. Only observations with a `code_revision` can verify; approvals and deployments are surfaced but never verify by themselves. Status is always environment-qualified. Disposition transitions follow the table in `setDisposition`.

**[P]** *(2026-10-27.)* `implementation` is no longer recorded. A promoted change set could never have its field updated (promoted records are frozen), so the normal flow left every change set at `not_started` forever. It is now derived (`deriveImplementation`): inferred or verified means implemented, any observation means in progress, otherwise not started. The field is accepted in input for compatibility, dropped, and warned about (`W_DEPRECATED_FIELD`).

### 6.2 Evidence records

**[S]** Evidence attaches to a logical change, relevant operation/entity as needed, a version/scope, and a source artifact. It should be possible to answer *what justified marking this as verified?*

**[P]** Evidence record fields: `change_id`, `target_ids`, `kind` (code_review, test, runtime_observation, deployment, manual_review), `source_ref`, `code_revision`, `environment`, `observed_at`, `recorded_by`, `result`, `notes`.

Evidence may be appended or amended in Git-tracked files; Git history must preserve prior claims and corrections. Do not infer verified status solely from PR merge or model publication.

**[P]** *(Phase D.)* Records live in `evidence/CHG-<n>.yaml`, append-only; a correction is a new record with `amends: <id>`. Fields as listed above plus `id` and `amends`; `target_ids` is `targets` and defaults to the whole change set. `recordEvidence` validates against the ledger and commits with provenance trailers.

### 6.3 Projections

**[S]** A hypothetical change must be queryable/renderable without silently becoming part of the committed baseline. **[P]** Initial projection modes:

- **Baseline:** committed LikeC4 model at a selected model-repository Git revision; its accuracy remains evidence-qualified.
- **Candidate:** selected baseline plus an explicit set of change-set operations, subject to dependency, conflict, and schema validation; visually distinguish candidate additions/changes where feasible.
- **Verified/released:** a future policy-defined projection based on the qualifying evidence and environment. **Do not claim this is automatically implementable by filtering node statuses.** *(Phase D delivers `qualifyBaseline`: the committed model annotated per entity with the derived status of the promoted change set that last operated on it, by environment and revision. It annotates; it does not filter. Released view, 2026-10-26: `releasedBaseline(environment, at)` is the committed model at the revision named by the latest passing deployment record, with deployed and failed change sets listed. Deployment records may carry `baseline_revision`; otherwise the change set's promotion commit is used. A release is thus a dated, evidence-backed claim about an environment, never a filter on statuses.)*

**[O]** Decide promotion policy: when does an accepted/implemented change become part of the committed baseline, what actor may promote it, and how is that reconciled with later verification or deployment? Model source is generated only by the agent-facing tooling; avoid silent changes.

**[P]** *(Phase C, 2026-10-26.)* Initial promotion policy, implemented in `promoteChangeSet`: a change set is promotable when it is committed, `accepted`, not yet promoted, and all of its `depends_on` are promoted. Promotion applies the operations to the committed baseline, regenerates `model/model.c4`, verifies the regenerated model loads with every stable id intact, and records a `promotion { at, baseline, actor }` block on the change set, all in one commit. Promoted change sets are frozen. The baseline therefore represents **accepted declared architecture**; implementation and verification remain separate axes and do not gate promotion by default (policy can require them). Reconciliation with later verification is Phase D.

**[P]** *(2026-10-27, after dogfooding.)* A baseline of accepted-but-unbuilt architecture was a source of misbelief: nothing in `model/` distinguished what existed from what was planned. The committed model is now faithful to what exists, per operation kind. Promotion applies `add_*` and `move_element` at once and marks the targets (`b4-intended`, `b4-pending-move`); it defers `update_*` and `remove_*` of existing entities, recording them in `b4_pending` and tagging the target (`b4-pending-update`, `b4-retiring`), unless the change set is inferred or the target is already verified. `reconcileBaseline` applies deferred operations once verified and refreshes every entity's `b4_change`, `b4_status` and flags; it runs after each evidence record and on demand, and is idempotent. Views are generated (`model/views.c4`): As-is views exclude intended entities, Target views include them and show pending property values as overrides. Visual statuses use LikeC4 tags, element border/opacity and relationship line/colour, all cb4-owned. The interactive HTML build is the human rendering; PNG is optional. Known limits: an element cannot be drawn under two parents, so a pending move is a badge with `b4_moved_from`; a retiring element keeps its local name until verified, so a change set that reuses the name is applied without deferral and says so; committed statuses use the default (any-environment) verification policy, per-environment truth stays in `qualify` and deployment evidence.

**[P]** *(2026-10-27, planning ahead of building.)* Three follow-ups so a project can be designed in the ledger first and built in slices. (1) Operations on an *intended* target apply at once (`planPromotion` takes the baseline's intended ids; `reconcileBaseline` applies any pending marker left on one): a fork that renames, moves or drops a planned element replaces the plan instead of queuing behind evidence that could never arrive, and an entity stays intended until some change set operating on it is verified or inferred. (2) `validateInContext` projects a change set's unpromoted `depends_on` (transitively) onto the baseline before validating, used by `propose` and the `validate` tool, so related change sets can be staged for one review (issue #2); promotion still requires them promoted in order. (3) LikeC4 keywords are rejected as element names (`E_RESERVED_WORD`, list determined empirically against the pinned grammar), and moves are checked for name clashes (issue #1). A `help plan` topic and a general `cb4-guide` skill describe layering the plan (one change set per bounded context or layer, evidence per change set with `targets`), what evidence and the derived implementation state mean, and how in-progress work appears in the model.

**[S]** *(Resolved by Phase A, 2026-10-25.)* LikeC4's builder supports add and update; remove and move are done by editing parsed data and recomputing. Source-preserving writes are not needed because model source is never hand-authored. See `spikes/phase-a/FINDINGS.md`.

## 7. Historical query: `storyOf()`

### 7.1 Semantics

**[S]** Given a component or subgraph, return a bounded chronological sequence of logical change sets involving it. A change set qualifies when an operation targets the element, a relationship operation touches it, or a non-mutating reference names it. For a subgraph, apply those rules to the resolved member set.

Return each logical change set **once**, even when multiple operations or references match. Each entry should provide:

- Change-set ID, title, intent, lifecycle/disposition information appropriate to the selected revision.
- Matched entities and **how** they participated (operation, relationship endpoint, non-mutating reference).
- Other entities participating in the same change, identified by role.
- External requirement/AC sources, Git/change history references, and optionally verification evidence.
- A concise summary with detail expansion on demand.

No recursive expansion into the histories of the other participants by default. Use pagination/limits and explicit truncation indicators.

### 7.2 Historical cutoff

**[S]** Support queries bounded by a time or revision, not only the latest state. **[P]** Default chronology is the model-ledger repository's *recorded history* (Git commit/time), and a query at Git revision R reconstructs associations and statuses as recorded at R. Explicitly distinguish an event's claimed effective time from the commit that recorded it if those differ.

**[O]** For a moved/deleted subgraph, define membership semantics: current descendants, descendants as of a historical revision, or anyone ever under it. MVP may use current members by default, but must state the choice to the caller.

**[P]** *(2026-10-26.)* All three exist. Default is current descendants at the snapshot; passing a revision resolves descendants at that revision; `membership: ever` adds everything a promoted change set ever added or moved under the subtree (and relationships it added to them), derived from the ledger. The response states which was used. Pre-ledger moves are invisible to `ever`, by construction.

### 7.3 Computation

**[P]** Build derived indexes, e.g. `stable_entity_id -> change_set_ids` and `change_set_id -> operations/references/sources`. Resolve a requested subgraph into a bounded entity set, collect intersecting change sets, filter by temporal scope, deduplicate, sort, and attach one-hop participation summaries. Indexes are rebuildable caches, not a new authoritative database.

## 8. Agent-facing operations (provisional)

Existing LikeC4 API/MCP capabilities should be reused, wrapped, or delegated to rather than reimplemented. These are **new proposed contracts**; names and signatures are illustrative.

```typescript
getArchitecture({ revision?, scope?: 'baseline', depth?: 1, maxNodes? })
searchElements({ query, kinds?, limit? })
expand({ entityId, depth?: 1, relationships?: 'direct' | 'none', maxNodes? })
getElement({ entityId, revision? })

getChangeSet({ changeId, revision?, includeEvidence? })
storyOf({ entityId, subtree?: false, before?, revision?,
          include?: ['operations', 'references', 'sources'], limit?, cursor? })
projectModel({ baselineRevision?, includeChanges: ['CHG-042'], maxNodes? })
renderProjection({ projectionId, view?, format? })

proposeChangeSet({ changeSet, expectedBaseRevision? })
validateChangeSet({ changeId, baseRevision? })
recordEvidence({ changeId, evidence, expectedRevision? })
setDisposition({ changeId, to, supersededBy? })          // governance transitions, fixed table
promoteChangeSet({ changeId, expectedHead?, policy? })  // Phase C: behind the policy in 6.3
```

**[S]** An agent must be able to request top-level context and selectively drill down without receiving the complete model. Defaults must make context-efficient retrieval the easy path. Write operations must validate input and avoid unrequested baseline mutation. **[P]** A dedicated MCP facade can expose these operations while calling LikeC4's model API/MCP internally; an agent skill should document navigation, state qualification, and safe change authoring.

## 9. Repository and provenance (provisional)

```text
project-architecture/                 # separate Git model-data repository
  model/                              # LikeC4 DSL, authoritative declared baseline
    specs.c4
    landscape.c4
    billing/
      model.c4
      views.c4
  changes/
    CHG-042.yaml                      # one logical change set, versioned over time
  evidence/
    CHG-042.yaml                      # structured observation / review records
  rules/
    model-policy.yaml                 # domain conventions and transition policy
  README.md
```

**[P]** Generate human-readable Git commit subjects and machine-readable trailers from structured change metadata:

```text
model: propose asynchronous billing retries

Change-Id: CHG-042
Origin: REQ-238
Actor: implementation-agent
Intent: decouple transient billing failures
```

The change-set file is authoritative for logical intent/associations; Git supplies revision chronology and authorship records; external implementation repositories supply code commits and runtime evidence. **Do not use computed commit messages as the only source of semantic provenance.**

**[P]** For writes, use expected repository revision, temporary worktree or branch, validation, and explicit commit creation. Failed validation must leave the authoritative baseline unchanged. Multi-writer conflict handling and permission boundaries need design before shared operation.

## 10. Acceptance scenarios

**AT-01 — Progressive discovery.** Given a project with many entities, requesting an overview returns a bounded set of top-level entities; selecting `billing` yields only its requested descendants and relationships, with pagination/truncation behavior explicit.

**AT-02 — Shared historical change.** Given `CHG-042` adding a retry worker and a relationship from the billing API, `storyOf(billing-api)` and `storyOf(billing-retry-worker)` both return `CHG-042`; each explains the other's participation without implying a new historical architectural edge.

**AT-03 — Non-mutating reference.** Given `CHG-042.references = [invoice-ui]` and no operation targeting the UI, `storyOf(invoice-ui)` includes `CHG-042` marked `relates_to`; the UI's architectural representation remains unchanged.

**AT-04 — Temporal history.** Given multiple revisions to `CHG-042`, a historical query returns the logical change once, with details and state as recorded at the requested cutoff. Later evidence does not appear in an earlier snapshot.

**AT-05 — Hypothetical isolation.** Proposing a new component allows a candidate view of it while the default baseline still excludes it. Rejected proposals remain inspectable but are not included in ordinary candidate projections by accident.

**AT-06 — Evidence qualification.** A code PR merge can be recorded without causing an automatic `verified` classification. A verification claim references a specific observation and revision/scope.

**AT-07 — Continuity of identity.** Moving/renaming a component does not sever earlier change-set associations. Removing it from the current model does not erase its story.

**AT-08 — Validation safety.** A change set with invalid entity IDs, unresolved mandatory dependencies, contradictory operations, or invalid kinds/relationships produces actionable errors and does not mutate the baseline.

**AT-09 — Subgraph story.** A subtree history finds every intersecting change set once and shows related out-of-subtree participants only as one-hop context, not an unbounded traversal.

**AT-10 — Human readability.** A baseline diagram and a candidate diagram can be rendered from the model/projection, with a clear indication of which is hypothetical and no independent diagram source to maintain.

## 11. Technical spikes / open decisions

Investigate these **before committing to a permanent storage or patching design**:

1. **[S] LikeC4 feasibility:** *(Resolved 2026-10-25, see `spikes/phase-a/FINDINGS.md`.)* Builder covers add/update; remove/move via parsed-data surgery plus `computeParsedModelData`; candidate rendering via disposable generated workspace. Formatting preservation struck as a non-requirement.
2. **[O] Stable identity:** Metadata key vs external ID registry; treatment of relationships, renamed/moved entities, aliases, deleted elements, splits/merges.
3. **[O] Baseline promotion:** Does the baseline represent accepted, implemented, or verified architecture? What is the review/verification gate? How do staging and production diverge?
4. **[O] State machine:** Exact dispositions, realization stages, evidence standards, and who/what is authorized to assert them.
5. **[O] Composition:** Dependency ordering, cycle detection, competing edits to the same field, rejected prerequisite behavior, idempotence, and reversibility of change sets.
6. **[O] Historical semantics:** Git revision/time vs effective time; subtree membership at historical revisions; handling commits that revise a single change set.
7. **[O] Schema validation:** Appropriate rule format for entity kinds, required properties, allowed relationship endpoint kinds, and cross-record integrity.
8. **[O] Agent surface:** One companion MCP facade vs existing LikeC4 MCP plus a separate ledger MCP; scope, connection/setup friction, and default response budgets.
9. **[P] Adoption:** *(2026-10-26.)* `initModelRepo` plus agent-authored inferred change sets, or `adoptExistingModel` for an existing LikeC4 model. Imported knowledge carries `inferred: true`, is promoted with a `pre-ledger` marker and no evidence, and therefore renders as unverified until evidence arrives. Procedure in `packages/mcp/skills/cb4-adopt`.

## 12. Suggested implementation sequence

**Phase A: Feasibility proof.** Create a tiny LikeC4 model, compile a structured candidate with add/update/remove cases in memory, render baseline vs candidate, and establish what cannot round-trip safely. Test the MCP/query footprint. Do not write a large framework until this works.

**Phase B: Ledger + story.** Define a minimal change-set schema (operations, references, sources), stable IDs, Git provenance, derived indexes, and bounded `storyOf()` for elements/subtrees including time cutoff.

**Phase C: Candidate workflow.** Add `proposeChangeSet`, validation, dependency/conflict checks, and candidate projection. Keep baseline writes behind explicit, verified rules.

**Phase D: Evidence and human presentation.** Record qualified evidence and separate lifecycle axes; expose diagrams and historical summaries. Add richer verification and deployment projections only after policies are tested.

The deliverable should remain useful after Phase B. If LikeC4 makes Phase C disproportionately complicated, reconsider the storage/backend boundary before forking it.

## 13. Agent implementation instructions

- Treat **[S]** statements as requirements; **[P]** as hypotheses; **[O]** as research and decision tasks.
- Prefer reuse of LikeC4's actual capabilities over a custom parser, renderer, graph database, or MCP graph server.
- Avoid letting the current LikeC4 FQN become the only durable historical identifier without a migration/alias strategy.
- Never assert that a committed model is verified solely because it was committed, nor that a PR merged means implementation is correct or deployed.
- Never map a change set's `references` into architectural relationships or implicit model edits.
- Default queries to narrow context; provide expansion on demand; expose incomplete/truncated results explicitly.
- When external requirements/AC are unavailable, preserve references and report inability to inspect their contents rather than fabricating them.
- Validate writes and keep candidate state separate from baseline state. Preserve rejected/superseded history.
- When a technical spike contradicts a provisional design, document the finding and propose the narrowest adjustment rather than silently enlarging scope.

## 14. Upstream references (current at drafting)

- LikeC4 overview, hierarchy, and MIT license: https://github.com/likec4/likec4
- LikeC4 modeling language: https://likec4.dev/dsl/intro/
- LikeC4 elements and metadata: https://likec4.dev/dsl/model/
- LikeC4 relationship kinds: https://likec4.dev/dsl/relationships/
- LikeC4 Model API, model builder, round-trip limitation: https://likec4.dev/tooling/model-api/
- LikeC4 MCP and agent tools: https://likec4.dev/tooling/ai-tools/

**Final architecture recommendation:** Develop a **companion project**, not a LikeC4 fork, until a targeted technical spike establishes a reason to maintain downstream changes. Preserve the option to replace LikeC4 as the architecture backend if the change-set or provenance model eventually exceeds its natural scope.
