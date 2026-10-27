# Changelog

All notable changes to b4-after. Both packages, `@borwood/b4-after` (MCP server and CLI) and
`@borwood/b4-after-ledger` (library), are versioned together. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) and will break before 1.0.

## [Unreleased]

## [0.2.0] - 2026-10-27

### Changed

- **The committed model is faithful to what exists.** Promotion applies additions and moves and
  tags them (`b4-intended`, `b4-pending-move`); it defers updates and removals of existing
  entities (`b4-pending-update`, `b4-retiring`) until evidence verifies them. Operations on an
  entity that is itself still intended apply at once, so a plan promoted before building can be
  revised or dropped without waiting on evidence. Every entity carries `b4_change`, `b4_status`
  and, when operations are deferred, `b4_pending`. Inferred change sets apply at once with no flag.
- `implementation` is derived from evidence (`not_started`, `in_progress`, `implemented`) and no
  longer recorded on change sets. The field is still accepted in input, dropped, and warned about
  (`W_DEPRECATED_FIELD`). `ChangeRecord.implementation` and the commit trailer carry the derived value.
- `validate` and `propose` project a change set's unpromoted `depends_on` (transitively) onto the
  baseline before validating, and report `projected_dependencies`. Promotion still requires
  dependencies promoted first. (#2)
- `model/` now holds `model.c4` and a generated `views.c4`; both are rewritten by promotion,
  reconciliation and adoption. Hand-written view files under `model/` are removed on the next write.
- `project` and `qualify` accept `render=html` as well as `dsl` and `png`; `materializeProjection`
  writes both model files. `generateDSL` strips views; `roundTripCheck` is gone in favour of
  `generateAndCheck`.
- Search, expand and element rows carry `pending: [...]` whenever an entity is not exactly as drawn.
  `overview.model.tags` excludes reserved tags.
- Promotion refusals truncate LikeC4 parser errors to the first few, cut at the expected-token list. (#1)
- The `b4-after skill` command installs every shipped skill (or the named ones) instead of only the
  adoption skill.

### Added

- `reconcile` tool and `reconcileBaseline`: apply verified deferred operations (removals cascade)
  and refresh every status; runs after `record_evidence` and on demand; idempotent.
- `render` tool: the committed baseline as LikeC4's single-file interactive site (default), PNG,
  or DSL. Views are generated into `model/views.c4`: folders As-is and Target, each with a
  landscape, an everything view, one view per element with children, and one per user tag. (#3)
- `E_RESERVED_WORD`: LikeC4 keywords are rejected as element names on add and rename. The list is
  determined against the pinned LikeC4 grammar and guarded by a test. (#1)
- `E_RESERVED_TAG`, `E_RESERVED_METADATA` (agents cannot set `b4-*` tags or `b4_*` metadata) and
  `W_RETIRING_TARGET` (building on an element whose removal is promoted but unverified).
- Moves are checked for a name clash at their destination (`E_DUPLICATE_NAME`).
- `b4-after-guide` skill: the mental model, change-set lifecycle, evidence semantics, how
  in-progress work appears in the model, planning a project in layers before building it, and how
  to derive shorter task skills. `help plan` condenses the same guidance.
- Library: `status.ts` (`finalizeBaseline`, `annotateStatuses`, `deriveEntityStatus`,
  `planPromotion`, `intendedIds`), `reserved.ts`, `views.ts`, `workspace.ts`, `operations.ts`
  (shared by projection, promotion and reconciliation), `validateInContext`,
  `orderByDependencies`, `targetVerification`, `deriveImplementation`, `Verification.failedTargets`.
  `PromoteResult` gains `deferred`, `reconciled`, `warnings`. `Snapshot` gains `parsedData`.

### Fixed

- Removing an element and adding another with the same name in one change set was rejected as a
  duplicate name.
- Regenerating a model was not idempotent when the specification declared tags out of order.
- The MCP package's `bin` entry used a `./` prefix that npm 12 rewrites on publish with a warning;
  the source now matches the published manifest.

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

[Unreleased]: https://github.com/borwood/b4-after/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/borwood/b4-after/compare/0db645a...v0.2.0
[0.1.0]: https://github.com/borwood/b4-after/commits/0db645a
