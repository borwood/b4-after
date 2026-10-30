---
name: b4-after-guide
description: How b4-after works and how to work with it - the model repository, change sets, promotion, evidence, status flags, planning a project or feature before building it, and how in-progress work shows in the model. Use whenever a workspace has the b4-after MCP server and you need to plan, record, prove or read architecture, or when asked how b4-after works; also the source to derive smaller task-specific skills from.
---

# Working with b4-after

b4-after keeps a C4 model of a system that coding agents maintain through MCP tools, next to a
ledger of intended changes and the evidence that proves them. Three things are always kept apart:
what **exists**, what is **intended**, and what is merely **proposed**. Everything an agent writes
is a record; everything the model says about status is derived from those records, never asserted.

Read this once for the mental model. For exact field lists and tool arguments call
`help topic=<name>` at the moment you need it (`start`, `ids`, `schema`, `operations`, `evidence`,
`status`, `workflow`, `plan`, `concurrency`, `queries`, `policy`, `errors`, `adopt`).

## The repository

The model repository is its own git repository (usually `./architecture`, shared by every worktree
and subagent of the code repository), with three directories:

| Directory | Holds | Written by |
|---|---|---|
| `model/` | `model.c4` (LikeC4 specification and model, with status tags and metadata) and `views.c4` (generated As-is and Target views) | promotion, reconciliation, adoption only; never by hand |
| `changes/` | one `CHG-<n>.yaml` per change set, revised in place until promoted | `propose`, `set_disposition`, `promote` |
| `evidence/` | one `CHG-<n>.yaml` per change set, append-only evidence records | `record_evidence` |

Start every session with `overview`. Everything is addressed by **stable id** (`ent-...`,
`rel-...`), never by LikeC4 name, so renames and moves do not break history.

## Three states of an architectural fact

| State | Where it lives | What the model shows | How to see it |
|---|---|---|---|
| Proposed | a change set in `changes/`, disposition draft, proposed or accepted | nothing | `changes`, `change`, `project changes=[...]` |
| Intended | a promoted change set with no verifying evidence yet | present, tagged `b4-intended`, dashed and faded, excluded from As-is views, shown in Target views | `search`/`expand`/`element` rows carry `pending: [intended]` |
| Real | verified by evidence, or inferred during adoption | present, no flag | the As-is views |

Changes to things that already exist are held back rather than faked: a promoted removal leaves the
entity in place as `b4-retiring`; a promoted property update leaves current values and tags the
entity `b4-pending-update`, with the intended values shown only in the Target views; a move is
applied with a `b4-pending-move` badge. Failing evidence adds `b4-failed`. Each entity carries
`b4_change` (the latest promoted change set operating on it) and `b4_status` (its own verification).
Agents cannot set any `b4-*` tag or `b4_*` metadata; validation rejects them.

An operation on an **intended** entity applies at once, since nothing real exists to be faithful
to: revising or dropping a plan simply replaces the plan.

## Change sets

A change set is a record, not a patch. It keeps its id through revision, review, rejection,
supersession and promotion. It carries `title`, `intent`, `sources` (pointers to the requirement,
ticket or decision; never copies of them), `depends_on`, and `operations`: add, update, move and
remove for elements; add, update and remove for relationships. `references` name entities that
are relevant without changing them.

Lifecycle: `propose` (draft or proposed) -> `set_disposition to=accepted` -> `promote`. Rejected
and superseded are terminal for that id. Re-proposing an id revises it until it is promoted;
promoted change sets are frozen, so a follow-up or a reversal is a new change set that
`depends_on` the old one.

Validation (`validate`, and `propose` itself) checks the change set against the baseline **with
its unpromoted dependencies projected on top**, so a chain of related change sets can be proposed
and reviewed together. Promotion still goes in dependency order. Names must be LikeC4 local names
and not LikeC4 keywords (`head`, `title`, `kind`, `link`, ...); the validator says so.

Keep a change set to one coherent intent and at most about fifty operations, parents before
children, relationships after both ends exist.

## Evidence

Evidence is recorded **per change set**, optionally narrowed to `targets` (stable ids that change
set operates on). A record without `targets` speaks for every target of the change set.

| Kind | Needs | Effect |
|---|---|---|
| `test`, `runtime_observation` | `code_revision`, `result` | the only kinds that verify; `fail` marks the named targets failed |
| `code_review`, `manual_review` | `result` | recorded as approvals; never verify on their own |
| `deployment` | `environment`, `result` | feeds `releases`; never verifies |

Derived from the records, per target: `verified`, `unverified` or `failed`. Per change set:
`unverified`, `partial` (some targets covered), `verified` (all covered), `failed`. Implementation
progress is derived too: `not_started` (no observation), `in_progress` (any observation),
`implemented` (verified, or inferred). Nobody declares any of it.

Recording evidence reconciles the model: covered intended entities lose their flag, verified
deferred removals and updates are applied, views regenerate. `reconcile` does the same on demand.
`environment` on a record scopes it; the committed flags use the any-environment view, and
`qualify environment=<env>` overlays a per-environment view.

Two consequences shape planning. A change set is the unit you expect to prove together, so cut
change sets along the seams work will actually land in. And since evidence names targets, one
promoted change set can be proven slice by slice without ever being rewritten.

## How in-progress work looks

| Stage | Ledger | Model | Read it with |
|---|---|---|---|
| Designing | change set draft or proposed | unchanged | `project changes=[...] render=html` |
| Agreed, not started | promoted, no evidence; implementation `not_started` | additions `b4-intended`; removals `b4-retiring`; updates `b4-pending-update` | `qualify`, Target views in `render` |
| Being built | some evidence; implementation `in_progress`, verification `partial` | proven entities lose their flag; failing ones gain `b4-failed` | `change <id>` (what is covered, what is not), `element qualify=true` |
| Done | every target covered; `verified`, `implemented` | no flags; retiring entities gone, updates applied | As-is views, `story` |

## Planning before building

A project or feature can be designed in the ledger before any code exists. The plan is promoted,
not parked: a promoted plan of additions is entirely `b4-intended`, so the baseline still says
nothing exists while every reader sees the design in the Target views. An unpromoted plan is
invisible to `search`, `expand` and `element`, has no views, and is overwritten in place when revised.

1. **Layer the plan.** One change set per bounded context or architectural layer, chained with
   `depends_on`, at system and container granularity. Leave components to later change sets.
   Verification is per change set, so a single giant plan would read as `partial` for the life of
   the project and collect every evidence record there is.
2. **Review and promote the layers** in dependency order. `project changes=[...] render=html`
   shows the whole plan on top of the baseline before any of it is promoted.
3. **Build in slices.** A task that builds exactly what a plan change set says is **evidence, not
   a new change set**: `record_evidence change_id=<plan> targets=[ids built] code_revision=<sha>`.
   A task that refines the plan (components inside a planned container, new relationships) is a
   change set with `depends_on` the plan layer; its additions are intended until its own evidence
   arrives. Make such a slice **operate on the planned entities it realises**: add an
   `update_element` on each one (the real technology, a sharper description), not only relationships
   to it. An entity stops being intended as soon as any promoted operation on it is verified, so
   verifying the slice's own change set then proves the planned entities too, and nothing has to be
   routed back to the plan. Merely referencing a planned entity, as a relationship endpoint or as a
   parent, proves nothing about it: the relationship or child becomes real while the entity stays
   `b4-intended`, and evidence on the slice that names that entity is rejected because the slice
   does not operate on it.
4. **Fork when the design changes.** A new change set that updates, moves or removes the planned
   entities, with `sources` pointing at the decision. Because those entities are intended, the
   change applies at once and the Target views show only the current plan. The `story` of any
   entity keeps the original plan, the fork and the evidence in order.
5. **Record evidence against the latest change set that operated on an entity.** Evidence on an
   earlier one still counts, but the latest is where readers look.

Do not: put the whole roadmap in one change set; leave the plan unpromoted and build "against"
it; re-add an entity that already exists in order to claim it; record a review or a deployment as
if it verified anything; set `implementation` or any `b4-*` tag yourself.

## Day-to-day loops

- **Before changing code**: `locate <id>` when you were handed an entity id, to see it in full,
  what it relates to and every container up to the root; otherwise `search` or `expand` the
  area. Then `element <id> qualify=true` for the parts you will touch. A `pending` list on a row means the entity is not exactly as drawn; read
  `b4_change` to find the change set and `change <id>` for what is still unproven.
- **When the architecture will change**: draft the change set from the requirement, `validate`,
  `project render=dsl` (or `html` for a person), `propose`. Promotion is a reviewer's call.
- **When code lands**: record evidence with the real `code_revision`, an `environment`
  (`local`, `ci-pr`, `staging`, ...), and `targets` for what the run actually exercised.
- **For a review**: `render format=html` for the committed model, `project render=html` for a
  candidate. Both are interactive single-file sites; prefer them to PNG.
- **To explain history**: `story entity=<id> subtree=true`, with `before=<date>` or
  `revision=<sha>` for how things stood then. `releases` for what ran where, from deployment evidence.

Pass `actor` on every write unless the server was started with one, and `expected_head` from your
last read when other agents may be active (`help concurrency`).

## Deriving smaller skills

This document is the full picture; a workspace will usually want shorter, task-shaped skills. Keep
each to the steps and the tool calls, and cite `help topic=...` for details so the skill stays
short and stays current. Natural cuts:

- **plan-feature**: steps 1 and 2 of "Planning before building", plus `help schema` and
  `help operations`.
- **build-slice**: the "Before changing code" loop, then evidence recording with `targets`, plus
  `help evidence`.
- **review-change**: `changes disposition=proposed`, `project render=html`, `set_disposition`,
  `promote`, plus `help workflow`.
- **adopt**: already shipped as `b4-after-adopt`, for bringing an existing codebase in.
