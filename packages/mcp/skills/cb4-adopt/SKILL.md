---
name: cb4-adopt
description: Bring an existing codebase into cb4 as an honest, inferred, unverified C4 baseline. Use when asked to adopt, onboard, bootstrap, or "model the architecture of" a repository with cb4, or when the cb4 overview reports the model repository is not initialised yet.
---

# Adopt a codebase into cb4

You produce a declared architecture that is **inferred**, not asserted. Every element you record
will show as `unverified` until evidence is recorded. Prefer fewer, truer elements over coverage.

## Preconditions

- The `cb4` MCP server is connected and pointed at the model repository (not the codebase).
  Call `overview`: `initialized: false` means you are on path A; a model with no change sets
  means path B.
- You have an actor name for this session (pass `actor` on every write unless the server was
  started with `--actor`).

## Path A: no model yet

1. `bootstrap mode=init name=<project>`. Choose `kinds` to fit the system; defaults are
   actor, system, container, component, datastore. Add `tags` you will use (e.g. external).
2. Survey the codebase. Read, in this order, stopping when you have enough:
   - top-level README, docs/ architecture notes, ADRs
   - deployment descriptors: compose files, Helm charts, Terraform, k8s manifests, Procfiles
   - package manifests and workspace layouts (apps/, services/, packages/)
   - entry points and ports: Dockerfiles, main modules, API route tables
   - integration edges: HTTP clients, queue producers/consumers, DB connection config
3. Decide roots: one `system` per deployable boundary or bounded context, external systems as
   their own roots tagged `external`, human roles as `actor`.
4. For each root, build one change set (`help schema`, `help operations`):
   - `inferred: true`, `title: "Inferred baseline: <root>"` (inferred means observed in the code:
     it applies as existing, unverified; never set `implementation`, it is derived from evidence)
   - `intent`: one sentence on what you inferred it from
   - `sources`: `{ ref: "<repo path you read>", role: "other" }` for the files that justified it
   - operations: parents before children; relationships after both endpoints exist
   - stable ids you would keep after a rename: `ent-<system>-<component>`, `rel-<from>-<verb>-<to>`
   - local names must not be LikeC4 keywords (`head`, `title`, `kind`, `link`, `style`, ...);
     `validate` rejects them with `E_RESERVED_WORD`, so pick another name and keep the stable id
   - keep each change set under ~50 operations; split large roots by subsystem
5. A final change set for cross-boundary relationships, if any, with `depends_on` the roots it joins.
6. `validate` and `propose` every change set first; validation projects unpromoted `depends_on`, so
   the whole adoption can be proposed and reviewed as a batch. Then `set_disposition to=accepted`
   and `promote` in dependency order. Pass `expected_head` from the previous response when other
   agents may be active.
7. `qualify` and report counts. Everything should be `unverified`, nothing `unrecorded`. Offer the
   person `render` (interactive HTML, folders As-is and Target) rather than PNGs.

## Path B: an existing LikeC4 model

`bootstrap mode=adopt`. It assigns missing stable ids (regenerating `model/model.c4`) and records
one inferred, pre-ledger-promoted change set per root plus one for cross-root relationships.
Safe to repeat. Then `qualify` and report.

## Rules

- Do not invent components you did not see in the code or its deployment descriptors.
- Do not copy requirements or docs into the model; point at them with `sources`.
- Do not record evidence during adoption. Inferred means unverified; that is the point.
- If the specification lacks a kind you need, stop and say so; kinds are fixed at init.
- Report: roots recorded, change set ids, counts from `qualify`, and anything you were unsure about.

## Afterwards

Any intended change to the architecture goes through the same server: draft a change set from the
requirement, `validate`, `project render=dsl` (or `render=html` for a person) to inspect it,
`propose`, have it accepted, `promote`. Promoting before building is right: unverified additions
are marked `b4-intended`, removals `b4-retiring`, updates `b4-pending-update`, so the model keeps
saying what exists while showing the target (`help status`). Record evidence as implementation
lands; each record reconciles the model and `qualify` turns the baseline green. `story` answers
what happened to any entity and why.
