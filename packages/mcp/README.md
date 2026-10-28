# @borwood/b4-after

The MCP server and CLI for [b4-after](https://github.com/borwood/b4-after): an agent-facing
facade over a model repository (`model/`, `changes/`, `evidence/`). It wraps
[`@borwood/b4-after-ledger`](https://www.npmjs.com/package/@borwood/b4-after-ledger); nothing
here reimplements LikeC4 or the ledger.

## Install

Claude Code:

```sh
claude mcp add b4-after -- npx -y @borwood/b4-after ./architecture --actor claude
npx -y @borwood/b4-after skill            # -> .claude/skills/b4-after-guide, .claude/skills/b4-after-adopt
```

Codex:

```sh
codex mcp add b4-after -- npx -y @borwood/b4-after ./architecture --actor codex
npx -y @borwood/b4-after skill --codex    # -> .agents/skills/...
```

Any other MCP client, over stdio:

```json
{ "mcpServers": { "b4-after": { "command": "npx", "args": ["-y", "@borwood/b4-after", "/abs/path/architecture", "--actor", "my-agent"] } } }
```

The path is the model repository. It does not need to exist yet: the `bootstrap` tool creates it
as its own git repository on first use. A relative path is anchored to the top level of the
**main worktree** of the git repository the server is launched in, not to the current directory.
That is what makes `./architecture` safe to commit in a project-scoped MCP config: a session or
subagent running in a linked worktree, or in a subdirectory, still reaches the one shared ledger
rather than initialising a second one. Outside any git repository the path is relative to the
current directory; absolute paths are used as given.

## Worktrees and subagents

The model repository is one shared, linear ledger, not a branch of the code. Agents working in
parallel worktrees all write to it directly, and the ledger merges by intent rather than by text:
distinct change sets never conflict, re-proposing an id revises it, overlapping operations without
a `depends_on` fail projection with `E_CONFLICT`, and every write is serialised by the lock with
`expected_head` for optimistic concurrency. A workable division of labour: the planner proposes
the change set; implementing subagents read, record evidence at their branch's `code_revision`
with an `environment` such as `local` or `ci-pr`, which also drives the derived implementation
status; promotion
happens when the work lands on the main branch.

## CLI

```
b4-after [repoDir] [--actor <name>]     MCP server (stdio) over a model repository
b4-after skill [name...] [--codex] [--to <dir>]   install the shipped skills (or the named ones) for your coding agent
```

Environment: `B4_AFTER_REPO`, `B4_AFTER_ACTOR`. `--actor` is the default recorded on writes; a tool
call may name its own. Each agent process gets its own server process; that is fine (see
Concurrency).

## The skills

`b4-after-guide` is the general one: the mental model of the repository, the three states of an
architectural fact (proposed, intended, real), change sets and their lifecycle, what evidence means
and what it derives, how in-progress work looks in the model, how to plan a project in layers
before building it, the day-to-day loops, and how to cut it into shorter task-specific skills for a
workspace. `b4-after-adopt` tells an agent how to bring an existing codebase into the ledger
honestly: survey the repository, decide roots, propose one inferred change set per bounded context
citing what it read, promote, and report counts. `b4-after skill` installs both into
`.claude/skills/`; name one to install only it; `--codex` targets `.agents/skills/`; `--to` names
any skills directory. The skills ship inside this package, so they always match the server they
were installed with.

## Tools

| Tool | Purpose |
|---|---|
| help | documentation by topic (start, ids, schema, operations, evidence, status, workflow, plan, concurrency, queries, policy, errors, adopt) |
| overview | roots, counts, open change sets, head; says so when the repository is not initialised yet |
| search | ranked element lookup by id, fqn, title, kind, tag or metadata; filter by metadata key=value |
| expand | descendants of an entity plus the relationships touching them |
| element | one element in full; `qualify=true` adds derived verification |
| story | change sets involving an entity or subtree, oldest first, paged; as of a revision or date |
| changes | list change sets by disposition, promotion, or entity |
| change | one change set with commits, derived verification, and optionally its evidence |
| validate | dry-run a change set against the baseline and ledger, with unpromoted `depends_on` projected first |
| propose | validate the same way and record a change set as proposed or draft; never touches the model |
| set_disposition | governance transition (draft, proposed, accepted, rejected, superseded) |
| promote | apply an accepted change set to the baseline, marking unverified parts as intended; the only write into `model/` |
| record_evidence | append an evidence record; verification follows from it, and the model is reconciled |
| reconcile | apply verified deferred operations and refresh status tags; idempotent |
| project | candidate projection of change sets, optionally rendered as DSL, HTML or PNG |
| qualify | the committed baseline annotated per entity with derived verification |
| render | the committed baseline for people: interactive HTML site (default), PNG, or DSL |
| releases | deployment timeline per environment, and the released baseline at a time |
| bootstrap | init an empty model repository, or adopt an existing LikeC4 model as an inferred baseline |

## What exists and what is intended

The committed model is faithful to what exists. Promotion applies additions and moves and marks
them; it defers property updates and removals of existing entities until evidence verifies them.
Reserved tags say so on every entity: `b4-intended` (does not exist yet; excluded from As-is
views), `b4-retiring` (still exists; removal awaits verification), `b4-pending-update` (current
values shown; Target views carry the intended ones), `b4-pending-move`, `b4-failed`. Metadata
`b4_change`, `b4_status` and `b4_pending` give the change set, its verification for that entity,
and any deferred operations. Rows returned by `search`, `expand` and `element` carry
`pending: [...]` whenever an entity is not exactly as shown. Inferred change sets, which describe
what was observed during adoption, apply at once without flags, and so does any operation on an
entity that is itself still intended: revising or dropping a plan replaces the plan rather than
waiting for evidence that could never come. `help topic=status` has the rules; `help topic=plan`
covers planning a project in layers before building it.

Views are generated into `model/views.c4` on every promotion and reconciliation: folders As-is and
Target, each with a landscape, an everything view, one view per element with children, and one
per tag. `render` builds the interactive single-file site; that is the format meant for people.

## Design for agents

- **One-line descriptions, help on demand.** The whole tool list is under 14 KB. Anything an
  agent might need to follow up on is behind `help topic=<name>`.
- **Compact JSON**: no whitespace, short shas, string-encoded roles (`ent-x:added`), summary modes
  by default (`story detail=summary`, `qualify detail=counts`), full detail a flag away.
- **Bounded by default**: overview shows at most 20 roots and 10 open change sets; search limit
  10; expand depth 1 and 50 nodes; story 20 entries with a cursor. Every list says `truncated`.
- **Operational feedback on every call**: `head` (short sha the answer was computed at), `ok`,
  and on failure a `code` (`VALIDATION`, `NOT_FOUND`, `REPO_MOVED`, `LOCK_BUSY`, `REFUSED`,
  `PROJECTION`, `INVALID_MODEL`) with `issues[]` carrying JSON-pointer paths into the input.
- **Nothing an agent does not need**: no view internals, no layout data, no LikeC4 hashes.
  Stable ids throughout; `fqn:` marks an element that lacks one.
- **Nothing asserted that evidence can derive**: verification and implementation progress are
  computed from evidence records; an `implementation` field in a change set is accepted and ignored
  with a warning.

## Concurrency

Several agents may use one repository at once, through one or several server processes.

- Reads come from a per-process snapshot cached by HEAD plus the mtimes of `model/`, `changes/`
  and `evidence/`, so commits or files written by another process are picked up on the next call.
- Writes take a cross-process lock (`.git/.b4-after.lock`, atomic mkdir, stale after 120 s, wait up
  to 30 s then `LOCK_BUSY`), then run the library's own `expectedHead` check. Agents that read
  before writing should pass `expected_head` (short sha accepted) and handle `REPO_MOVED` by
  re-reading and retrying.
- Every write returns the new `head`, so an agent can chain writes safely.

## Library use

```ts
import { createServer, RepoContext } from '@borwood/b4-after'

const server = createServer(new RepoContext('/abs/path/architecture', { actor: 'ci' }))
await server.connect(transport)   // any MCP server transport
```

## Changelog

Release notes for both packages live in the repository's
[CHANGELOG.md](https://github.com/borwood/b4-after/blob/main/CHANGELOG.md).

## Development

```sh
npm test -w packages/mcp      # drives the server in-process over a linked transport
```
