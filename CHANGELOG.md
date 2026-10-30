# Changelog

What changes for you when you upgrade. Both packages, `@borwood/b4-after` (the MCP server and
CLI) and `@borwood/b4-after-ledger` (the library), are released together under one version.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow
[Semantic Versioning](https://semver.org/) and will break before 1.0; breaking changes are marked.

## [Unreleased]

### Added

- `locate` tool: one grounding read for an agent handed an entity id. It returns the element in
  full, every entity it has a direct relationship with (medium detail, placed by the nearest shared
  container and the path below it), and each container up to the root with its peers split into
  those whose subtree connects to the entity's subtree (medium detail with the connecting
  relationships) and the rest (id, kind, title). A relationship id works too: the relationship in
  full with its source as the focus. Every list is capped (`max_peers`, `max_relationships`).
- `changes` takes a `source` filter: the ref of an issue, PR, CI run or deployment. It matches
  change-set `sources[].ref` and evidence `source_ref`, so "which change sets relate to this
  link" is one call. Each row says what matched (`matched: [{via: source, role, ref}]` or
  `{via: evidence, evidence, kind, result, ref}`). Matching is exact unless
  `source_match=contains`, for a PR number or issue key inside a URL that may be written in
  several forms.

### Changed

- **Breaking**: `element` no longer lists every change set id that ever touched the entity. That
  list grew with history times connectivity, so a hub element in a long-lived repository could
  carry hundreds of ids on the call agents make most. `changeSets` is now a summary: `total`,
  `promoted`, `byDisposition`, and `open` (proposed or accepted, not promoted, capped at 20
  with `openTruncated`). For the history use `story entity=<id>`, which is paged, or
  `changes entity=<id>`.

## [0.2.1] - 2026-10-28

### Added

- Metadata values may be lists of strings as well as strings, matching LikeC4
  (`metadata: { owners: ['alice', 'bob'] }`).
- `search` matches metadata values and takes a `metadata: { key: value }` filter, so "every
  element owned by the payments team" is one call. Relationships are searched the same way.

### Changed

- In `update_element` and `update_relationship`, a `null` metadata value deletes that key. Other
  keys are still patched in place.
- `b4-after-guide` skill and `help plan`: a slice that refines a planned entity should carry an
  `update_element` on it, so verifying the slice also proves the planned entity; referencing it
  from a relationship or as a parent does not. Reinstall the skill to pick this up:
  `npx -y @borwood/b4-after skill b4-after-guide`.

### Fixed

- An update could overwrite an entity's `stable_id` through `set.metadata`. It is now rejected as
  reserved (`E_RESERVED_METADATA`).

## [0.2.0] - 2026-10-27

### Upgrading

- Run the `reconcile` tool once on each existing model repository. It rewrites `model/model.c4`
  with the new status tags and metadata and generates `model/views.c4`. Until then the model has no
  status information and the As-is and Target views do not exist.
- Any `.c4` file you placed under `model/` by hand is removed on the next promotion or
  reconciliation. `model/` is fully generated now; keep hand-written views elsewhere.
- Change sets that still carry `implementation:` keep working. The field is ignored with a warning
  and can be deleted from your files whenever convenient.
- Agents using the adoption skill should reinstall it: `npx -y @borwood/b4-after skill`. The same
  command now also installs the new `b4-after-guide` skill.

### Changed (breaking)

- **The promoted model no longer claims a change is built.** Promoting an unverified change set
  used to apply every operation as fact. Now additions and moves are applied and tagged
  `b4-intended` or `b4-pending-move`; updates and removals of entities that already exist are held
  back and the target is tagged `b4-pending-update` or `b4-retiring` until evidence verifies them.
  Every element and relationship carries `b4_change` (the change set it comes from), `b4_status`
  (its verification) and, when something is held back, `b4_pending`. Anyone reading `model/`,
  with or without b4-after, can tell what exists from what is planned.
- Tags starting `b4-` and metadata keys starting `b4_` are reserved. Change sets that set them are
  rejected (`E_RESERVED_TAG`, `E_RESERVED_METADATA`).
- Element names that are LikeC4 keywords (`head`, `title`, `kind`, `link`, `style`, `view`, ...)
  are rejected at validation (`E_RESERVED_WORD`) instead of breaking promotion. Rename the element;
  stable ids are unaffected.
- `implementation` is no longer a change-set field. It is derived from evidence: `not_started`,
  `in_progress` once any observation exists, `implemented` once verified (inferred change sets
  count as implemented). The `changes` and `change` tools and the commit trailer report the
  derived value.
- Library: `validateChangeSet` is unchanged, but `proposeChangeSet` now validates with
  dependencies projected (see below) and returns `validation.projected`. `roundTripCheck` was
  removed; use `generateAndCheck`. `generateDSL` no longer emits views; `generateViews` and
  `workspaceFiles` produce them. `PromoteResult` gained `deferred`, `reconciled` and `warnings`.
  `Snapshot` requires `parsedData`. `ChangeSet` no longer has `implementation`; `ChangeRecord`
  still does, derived.

### Added

- `reconcile` tool: applies held-back updates and removals once their change set is verified for
  that entity, refreshes every status, regenerates the views, and commits only when something
  changed. It also runs automatically after `record_evidence`. Idempotent.
- `render` tool: the committed model for people, as LikeC4's single-file interactive site
  (default), PNG, or DSL. `project` and `qualify` accept `render=html` too.
- Generated views in `model/views.c4`: folders As-is and Target, each with a landscape, an
  everything view, one view per element with children, and one per tag. As-is leaves out intended
  entities; Target shows them, with pending titles, descriptions and technologies as overrides.
- `validate` and `propose` see entities introduced by change sets you depend on that are not yet
  promoted. Declare them in `depends_on` and a whole set of related change sets can be proposed and
  reviewed together; the response lists `projected_dependencies`. Promotion still goes in
  dependency order.
- Operations on an entity that is itself still intended apply at once, so a plan promoted before
  building can be revised, re-parented or dropped by a follow-up change set without waiting on
  evidence.
- `search`, `expand` and `element` rows carry `pending: [...]` whenever an entity is not exactly as
  drawn. `element` and `change` expose the derived verification per entity.
- `W_RETIRING_TARGET` warns when a change set builds on an element whose removal is promoted but
  not yet verified.
- `b4-after-guide` skill and `help plan`: the mental model, the change-set lifecycle, what evidence
  means and derives, how in-progress work looks in the model, how to plan a project in layers
  before building it, and how to derive shorter task-specific skills for a workspace.
- `b4-after skill <name>` installs a single skill; with no name it installs all shipped skills.
- Library: `reconcileBaseline`, `finalizeBaseline`, `annotateStatuses`, `deriveEntityStatus`,
  `planPromotion`, `validateInContext`, `targetVerification`, `deriveImplementation`,
  `generateViews`, `workspaceFiles`, `materializeProjection`, `LIKEC4_RESERVED_WORDS`, and the
  reserved vocabulary (`TAG`, `META`, `flagsOfTags`).

### Fixed

- Removing an element and adding another with the same name in one change set was rejected as a
  duplicate name.
- A move onto a name that already exists at the destination was accepted and failed at promotion;
  it is now rejected at validation.
- Promotion refusals caused by LikeC4 parse errors embedded the parser's full expected-token list,
  hundreds of kilobytes in one tool result. They are truncated to the first few errors.
- Regenerating a model was not stable when the specification declared tags out of order.

## [0.1.0] - 2026-10-26

First public release, renamed from the `like-b4` prototype.

- Change sets as records with stable identity and git provenance; validation against the baseline
  and ledger; proposals, dispositions and governed promotion into a LikeC4 model.
- Candidate projections with highlighted diffs, rendered as DSL or PNG.
- Evidence records with derived, environment-qualified verification; the qualified baseline;
  release timelines and released baselines from deployment evidence.
- Bounded stories per entity or subtree, as of a revision or date, with lineage pointers.
- Adoption: `bootstrap mode=init` and `mode=adopt`, inferred change sets, the `b4-after-adopt` skill.
- MCP server with seventeen bounded, compact tools; a relative model-repository path anchors to the
  main worktree so linked worktrees and subagents share one ledger.

[Unreleased]: https://github.com/borwood/b4-after/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/borwood/b4-after/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/borwood/b4-after/compare/0db645a...v0.2.0
[0.1.0]: https://github.com/borwood/b4-after/commits/0db645a
