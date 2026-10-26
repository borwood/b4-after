---
name: like-b4-adopt
description: Bring an existing codebase into the Architecture Change Ledger (like-b4) as an honest, inferred, unverified baseline. Use when asked to adopt, onboard, bootstrap, or "model the architecture of" a repository with like-b4, or when a model-data repo is empty.
---

# Adopt a codebase into like-b4

You produce a declared architecture that is **inferred**, not asserted. Every element you record
will show as `unverified` until evidence is recorded. Prefer fewer, truer elements over coverage.

## Preconditions

- The `like-b4` MCP server is connected and pointed at the model-data repository (not the codebase).
  If unsure, call `overview`; if it errors with no model, you are on path A.
- You have an actor name for this session (pass `actor` on every write).

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
   - `inferred: true`, `implementation: implemented`, `title: "Inferred baseline: <root>"`
   - `intent`: one sentence on what you inferred it from
   - `sources`: `{ ref: "<repo path you read>", role: "other" }` for the files that justified it
   - operations: parents before children; relationships after both endpoints exist
   - stable ids you would keep after a rename: `ent-<system>-<component>`, `rel-<from>-<verb>-<to>`
   - keep each change set under ~50 operations; split large roots by subsystem
5. A final change set for cross-boundary relationships, if any.
6. For each change set: `validate` -> `propose` -> `set_disposition to=accepted` -> `promote`.
   Pass `expected_head` from the previous response when other agents may be active.
7. `qualify` and report counts. Everything should be `unverified`, nothing `unrecorded`.

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
