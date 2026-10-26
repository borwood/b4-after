# b4-after

**The architecture before and after every change, with the evidence in between.**
A C4 model of your system that coding agents keep honest: every intended change is a reviewed
record, every promoted change is history, and nothing counts as verified until evidence says so.

```sh
# Claude Code
claude mcp add b4-after -- npx -y @borwood/b4-after ./architecture --actor claude
npx -y @borwood/b4-after skill

# Codex
codex mcp add b4-after -- npx -y @borwood/b4-after ./architecture --actor codex
npx -y @borwood/b4-after skill --codex
```

Then ask your agent to **adopt this codebase into b4-after**. The skill walks it through reading
the repository, recording an inferred C4 baseline, and promoting it. From there, any change you
plan, however hypothetical, goes through the same agent-facing tools: propose, inspect, accept,
promote, prove.

`./architecture` is where the model repository will live: its own small git repository, created on
first use, nested in your checkout. Add it to your code repository's `.gitignore`. A relative path
is anchored to the main worktree of your code repository, so sessions and subagents running in
linked git worktrees all share the one ledger instead of starting their own.

## What you get

- **A C4 model that agents build and maintain.** Systems, containers, components, actors, and the
  typed relationships between them, written in [LikeC4](https://likec4.dev) and rendered as diagrams.
  Agents are the only writers; humans get pictures, summaries, and stories.
- **A ledger of intended changes.** Each change set says what should change, why, and what
  requirement or ticket it comes from. It can be a draft, proposed, accepted, rejected, or
  superseded, and the model is never touched until it is promoted.
- **Hypothetical projections.** Apply proposed change sets on top of the baseline and inspect the
  result as a diff, as DSL, or as a diagram, without writing anything.
- **Verification derived from evidence, never asserted.** Test runs and runtime observations with a
  code revision verify. Reviews and deployments are recorded but never verify on their own.
  The qualified baseline colours each entity verified, partial, failed, unverified, or unrecorded,
  per environment.
- **The story of any component.** Which change sets touched it or its subtree, in what role, with
  which other components, pointing at which requirements, with evidence as of any revision or date.
- **Releases from deployment evidence.** What the architecture looked like in an environment at a
  given time, derived from recorded deployments rather than status fields.

## Why C4, why LikeC4

C4 gives agents a hierarchy to drill into: start at the system landscape, expand one container,
see one component's relationships. Retrieval stays bounded instead of loading a whole dependency
graph. LikeC4 adds a small typed specification (your own element kinds, relationship kinds, and
tags), a text DSL that lives in git, a real parser and validator, and a renderer. b4-after does not
reimplement any of that. It owns identity, history, governance, and evidence, and treats the
LikeC4 model as a generated artifact it alone writes.

Two choices make history durable. Every element and relationship carries a **stable id** in its
metadata, so renames and moves do not sever its story. And change sets are **records, not
patches**: a change set keeps its identity through revision, review, rejection, supersession, and
promotion, and the git commits that carry it supply chronology and authorship.

## Golden paths

**Adopt a codebase.** `bootstrap mode=init` creates the model repository with a specification
that fits your system. The agent surveys the code and deployment descriptors and proposes one
change set per bounded context, marked `inferred: true`, citing the files it read. Promoting them
gives you a baseline that honestly shows as *unverified* everywhere until evidence arrives. An
existing LikeC4 model is adopted in one call with `bootstrap mode=adopt`.

**Plan a change.** The agent drafts a change set from a requirement: add a worker here, a queue
there, retire that datastore, point `sources` at the ticket. `validate` checks it against the
baseline and the ledger (unknown parents, duplicate ids, use after remove, LikeC4's own hierarchy
rules, dependency cycles). `project` renders the candidate with additions highlighted. `propose`
records it. Nothing in the model has changed yet.

**Review and promote.** A reviewer, human or agent, moves the change set to `accepted` with
`set_disposition`. `promote` applies the operations, regenerates the model, confirms every stable
id survived, and commits model and promotion record together. Promoted change sets are frozen;
follow-ups depend on them or supersede them.

**Build and prove.** As implementation lands, CI or the agent records evidence: a passing
integration run at code revision `3f2a1c9` in staging, a code review, a deployment. `qualify`
turns that into a coloured baseline per environment. `change` shows exactly which evidence a
verification status rests on and what was ignored and why.

**Ask what happened.** `story entity=ent-billing subtree=true` lists every change set that
involved billing or anything under it, oldest first, with roles (added, updated, relationship
endpoint, referenced), the other participants, the sources, and verification. Add `before=<date>`
or `revision=<sha>` to see the story as it was known then.

## Designed for agents

- **Seventeen tools, one-line descriptions, under 14 KB.** Everything else is behind
  `help topic=<name>`, fetched only when needed.
- **Bounded by default.** Overview shows at most 20 roots; expand is depth 1 and 50 nodes; stories
  page with a cursor. Every list says whether it was truncated.
- **Compact responses** with string-encoded roles and summary modes, full detail a flag away.
- **Safe for several agents at once.** Every response carries `head`; writes accept
  `expected_head` and refuse to proceed on a moved repository, behind a cross-process lock.
- **Actionable failures.** `VALIDATION`, `NOT_FOUND`, `REPO_MOVED`, `LOCK_BUSY`, `REFUSED`,
  `PROJECTION`, `INVALID_MODEL`, each with JSON-pointer paths into the input where that applies.

## The model repository

```
architecture/
  model/      LikeC4 DSL. Generated; written only by promotion and adoption.
  changes/    CHG-<n>.yaml, one record per logical change set, revised in place until promoted.
  evidence/   CHG-<n>.yaml, append-only evidence records; verification is derived from these.
```

A change set, as the agent writes it:

```yaml
id: CHG-042
title: Add asynchronous billing retries
intent: Isolate transient payment failures from synchronous billing requests
sources:
  - { ref: https://tracker.example/issues/238, role: requirement }
depends_on: [CHG-037]
operations:
  - { op: add_element, id: ent-billing-retry-worker, parent: ent-billing, name: retry_worker,
      kind: component, title: Billing Retry Worker, technology: Node.js worker }
  - { op: add_relationship, id: rel-billing-api-publishes-retries, from: ent-billing-api,
      to: ent-billing-retry-worker, kind: publishes_to, title: enqueues retries }
references:
  - { entity: ent-invoice-ui, relation: relates_to, reason: Retry status is user-visible }
```

Seven operations (`add`, `update`, `move`, `remove` for elements; `add`, `update`, `remove` for
relationships) plus non-mutating references. Requirements stay where they live; the ledger points
at them.

## Packages

| Package | What |
|---|---|
| [`@borwood/b4-after`](packages/mcp) | The MCP server and CLI. Also carries the `b4-after-adopt` skill. |
| [`@borwood/b4-after-ledger`](packages/ledger) | The library: change sets, identity, provenance, projections, promotion, evidence, stories, releases. Use it to build your own tooling or CI hooks. |

[`examples/billing`](examples/billing) is a small model repository to explore with. The original
requirements document and the notes from evaluating LikeC4 are in [`docs/`](docs).

## Requirements

Node 22.22 or later and git. Rendering PNG diagrams uses LikeC4's exporter, which needs Playwright
with Chromium available (`npx playwright install chromium`); DSL output and everything else work
without it.

## Development

```sh
npm install
npm run typecheck
npm test
```

Tests build temporary git repositories from `examples/billing` with dated commits, so they take a
minute. The MCP tests drive the server in-process over a linked transport.

## Status

Early. The tool surface, schema, and library API are usable and tested, and are being dogfooded
on real projects. Expect breaking changes before 1.0. Drift detection between the model and the
running system is intentionally not built in; the intended shape is a producer of
`runtime_observation` evidence, built against a concrete signal when one is needed.

## License

MIT
