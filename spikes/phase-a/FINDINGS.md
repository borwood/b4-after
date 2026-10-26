# Phase A findings: LikeC4 1.60.0 feasibility

**Date:** 2026-10-25
**Scope:** PRD section 12 Phase A and section 11 spike 1 (LikeC4 feasibility). Everything below was observed by running the scripts in `scripts/` against the tiny billing model in `model/`. Reproduce with `npm install` then `npm run introspect|load|candidate|roundtrip|render|mcp`.

**Verdict:** LikeC4 is a workable backend for Phase B and C. The companion-project direction holds. No reason to fork. Several documented behaviours differ from the real API, and three findings change provisional PRD choices (see "Impact on the PRD").

## 1. Loading and querying (AR-03, AR-04, AT-01)

- `LikeC4.fromWorkspace(dir)` loads hand-authored DSL. `computedModel()`, `parsedModel()`, and `layoutedModel()` are all **async** in 1.60.0. The docs show `computedModel()` as synchronous. It is not.
- Progressive discovery works: `roots()`, `element(fqn).children()`, `incoming()`, `outgoing()`, `descendants()`. Nothing forces whole-model retrieval. Bounding is our job; LikeC4 does not paginate.
- Metadata lookup for stable identity works today by linear scan over `elements()` comparing `getMetadata('stable_id')`. Fine for Phase B; index it later.
- Payload sizes for this 7-element model: parsed data 3.0 KB, computed data 7.4 KB, one element 146 bytes. Computed data grows with views, so agent responses should be built from parsed data plus targeted queries.

## 2. Candidate overlays without touching the baseline (AR-07, AR-15, AT-05, AT-08)

| Operation | Path that works | Notes |
|---|---|---|
| `add_element` | `likec4.toBuilder().model(...).toLikeC4Model()` | Returns a new computed model. Baseline untouched (verified byte-identical before and after). |
| `add_relationship` | same | **LikeC4 forbids relationships between an element and its own ancestor or descendant** ("Cannot create relationship between elements in the same hierarchy"). The PRD example `billing-api -> billing-retry-worker` where the worker is a child of the API is invalid. Express it between siblings or restructure. |
| `update_element` | re-declare same FQN and kind in the builder | **Replace, not merge.** Omitted title, technology, and metadata are lost. Our facade must read the existing element and pass back everything it is not changing. Kind change throws, which is good. |
| `remove_element` | data surgery on `builder.build()` then `LikeC4Model.create(computeParsedModelData(data))` | No builder API for removal. Delete the key from `data.elements` and every relation whose `source.model`/`target.model` is the element or a descendant. Views recompute correctly; the removed node simply disappears. |
| `move_element` | same data surgery, rewriting FQN keys, element ids, relation endpoints | Works. View rules that named the old FQN (`include billing.billing_api.*`) silently stop matching the moved element. Our move operation must also rewrite view predicates or warn. |

- **Compute path:** `computeParsedModelData(parsedData)` from `@likec4/core/compute-view` is what the builder calls internally. `computeLikeC4Model()` takes a different input shape and throws "Cannot convert undefined or null to object" on parsed data. `LikeC4Model.fromParsed(data)` yields a parsed-stage model with zero views. Use `computeParsedModelData`.
- **Validation at build time:** unknown target element, unknown parent, and dangling relation all throw with actionable messages. **Unknown relationship kind is accepted silently.** Schema validation against the specification (kinds, allowed endpoints) is ours to implement.
- **Danger:** `likec4.computedModel()` returns the **same shared instance** on every call, and that instance exposes `addElement()` / `addRelation()` which **mutate it in place**. One stray call leaks a candidate into what every later caller sees as the baseline. The facade must never hand that instance to candidate code; always go through `toBuilder()` or a cloned `build()` payload.

## 3. Identity (PRD 5.4, spike 2, AT-07)

- **Element identity:** FQN is the only native id. Stable ids via `metadata { stable_id '...' }` survive every path tested (builder, data surgery, DSL generation, reparse). Confirms the [P] choice to use metadata for stable identity.
- **Relationship identity:** ids are short hashes (`1pzpu5s`). Probed what the hash depends on:
  - Same source re-parsed: same ids. Whitespace or comments added: same ids. Element declared before or after: same ids.
  - Target renamed: ids change (expected; endpoints are hashed).
  - **Two relationships with the same endpoints:** ids are assigned by declaration order, not content. Swapping the two declarations swaps their ids. Moving one into a nested block or a second `model {}` block changes which id it gets. Title is not part of the hash.
  - Consequence: LikeC4 relationship ids are **not durable** for parallel edges. The ledger needs its own relationship identity. Relationships accept `metadata`, so the same `stable_id` approach can apply. This resolves the open question in PRD 5.1 in favour of "endpoints plus kind do not identify an edge; carry an explicit id".
- After a move, relation ids were unchanged because endpoints were rewritten before compute only in the data map, not re-hashed. Do not rely on this; re-hash or use explicit ids.

## 4. Writing back to DSL (spike 1, PRD 6.3 [O])

- `likec4.toDSL()` and `generate()` from `likec4/generators/likec4` produce valid DSL but **drop all comments** and normalise formatting (confirmed: 5 comments in, 0 out). Treat as one-way generation, exactly as the docs warn.
- **`likec4 format` (CLI) and `likec4.format()` (programmatic, returns a `Map<file, text>`) are source-preserving.** Comments survive; only alignment changes. This is the tool for tidying hand-authored files. It does not help with applying model edits.
- **Generator defect:** a tag declared without a colour gets a default such as `tomato` in the spec data, and the generator writes `color tomato`, which the parser rejects ("Could not resolve reference to CustomColor"). Only theme colour names (`red`, `amber`, ...) or hex are valid. Workaround: declare explicit hex colours on tags in hand-authored specs, or post-process generated output.
- **Generator pitfall:** generating from a **computed** model's `$data` silently emits views with no `include` rules, because computed views hold resolved nodes and edges instead of predicates. The result parses cleanly and renders a single empty container. Always generate from **parsed** data (`builder.build()`).
- Implication for baseline promotion: we cannot patch hand-authored `.c4` files through LikeC4 without losing comments. Options for Phase C: (a) keep the authoritative baseline as generated DSL and forbid hand edits, (b) apply textual patches ourselves using Langium source positions (`docUri` and `sourcePath` are present on parsed records), or (c) keep hand-authored files and store candidate deltas separately, regenerating only projections. (c) is what this spike did and is the narrowest change.

## 5. Rendering (AR-14, AT-10)

- Materialising a candidate as a disposable workspace (`out/candidate-ws/candidate.c4`) and reloading it gives a model identical to the in-memory candidate (elements, relationships, views compared).
- `layoutedModel()` runs Graphviz via WASM with no browser. `likec4 export png` uses Playwright; Chromium was already cached on this machine, and export took about 3 seconds per view.
- Tag colour alone does **not** restyle nodes; it only colours the tag badge. Visual distinction for candidate additions needs element `style: { color, border }` and relation `color`, which the builder accepts. See `samples/baseline-billing.png` versus `samples/candidate-billing.png`: the retry worker and its edge render amber with a dashed border, the removed Ledger DB is absent, the baseline is unchanged.
- No separate diagram source is maintained. Both images come from the model or projection.

## 6. MCP footprint (spike 8, AR-04)

- `likec4 mcp --stdio <dir>` speaks MCP 2025-03-26 and offers **20 tools**. All results arrive as `structuredContent` JSON with **empty `content`**; a client that only reads text content sees nothing.
- `tools/list` alone is **60 KB** of schema. That is the standing cost of exposing LikeC4's MCP directly to an agent.
- Per-call sizes on this tiny model: project summary 1.3 KB, search 1.6 KB, read element 1.2 KB, view 2.4 KB, metadata query 0.3 KB. `read-project-summary` returns every element, so it is unbounded on real models.
- `query-by-metadata` with `stable_id` works out of the box, so stable-id resolution is available to agents today.
- Conclusion for the agent surface: a companion facade with a handful of bounded tools (overview, expand, storyOf, projection) is justified. It can call LikeC4's model API in-process rather than chaining MCP servers.

## Impact on the PRD

1. **Relationship identity (5.1, 5.4 [O]):** decided by evidence. Carry an explicit `stable_id` in relationship metadata. LikeC4's hash is positional for parallel edges.
2. **Hierarchy rule:** relationships cannot cross an ancestor/descendant boundary. Change-set validation must reject these before LikeC4 does, with a clearer message, and the PRD example should be corrected.
3. **Baseline writes (6.3 [O], 9 [P]):** source-preserving model edits through LikeC4 are not available. Phase B can proceed with hand-authored baseline plus separate change-set files, and projections regenerated on demand. Decide the promotion mechanism in Phase C with option (c) above as the default.
4. **Shared mutable model:** facade design constraint, not a PRD change. Record it in the Phase B design.
5. **Docs drift:** `computedModel()` async, `generate` export name, generator colour bug. Pin `likec4` to an exact version and keep these probes as regression checks.

## Files

- `model/` tiny hand-authored baseline with comments on purpose.
- `scripts/00-introspect.mjs` runtime API surface. `01-load-and-query.mjs` queries, sizes, relationship id probe. `01b-identity-and-format.mjs` hash inputs, programmatic format. `02-candidate-overlay.mjs` add, update, remove, move, invalid input, baseline isolation, mutation leak. `02b-compute-paths.mjs` which compute function works. `03-roundtrip.mjs` DSL round-trip loss. `04-render.mjs` candidate materialisation, layout, PNG export. `05-mcp-footprint.mjs` MCP tool sizes.
- `samples/` the two rendered PNGs. `out/` is generated and ignored.
