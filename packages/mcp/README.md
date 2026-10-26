# @borwood/b4-after

The MCP server and CLI for [b4-after](https://github.com/borwood/b4-after): an agent-facing
facade over a model repository (`model/`, `changes/`, `evidence/`). It wraps
[`@borwood/b4-after-ledger`](https://www.npmjs.com/package/@borwood/b4-after-ledger); nothing
here reimplements LikeC4 or the ledger.

## Install

Claude Code:

```sh
claude mcp add b4-after -- npx -y @borwood/b4-after ./architecture --actor claude
npx -y @borwood/b4-after skill            # -> .claude/skills/b4-after-adopt
```

Codex:

```sh
codex mcp add b4-after -- npx -y @borwood/b4-after ./architecture --actor codex
npx -y @borwood/b4-after skill --codex    # -> .agents/skills/b4-after-adopt
```

Any other MCP client, over stdio:

```json
{ "mcpServers": { "b4-after": { "command": "npx", "args": ["-y", "@borwood/b4-after", "/abs/path/architecture", "--actor", "my-agent"] } } }
```

The path is the model repository. It does not need to exist yet: the `bootstrap` tool creates it
as its own git repository on first use. Relative paths resolve from the directory the client
launches the server in, so prefer an absolute path when in doubt.

## CLI

```
b4-after [repoDir] [--actor <name>]     MCP server (stdio) over a model repository
b4-after skill [--codex] [--to <dir>]   install the b4-after-adopt skill for your coding agent
```

Environment: `B4_AFTER_REPO`, `B4_AFTER_ACTOR`. `--actor` is the default recorded on writes; a tool
call may name its own. Each agent process gets its own server process; that is fine (see
Concurrency).

## The skill

`b4-after-adopt` tells an agent how to bring a codebase into the ledger honestly: survey the
repository, decide roots, propose one inferred change set per bounded context citing what it
read, promote, and report counts. Everything imported shows as *unverified* until evidence is
recorded. `b4-after skill` copies it into `.claude/skills/`; `--codex` targets `.agents/skills/`;
`--to` names any skills directory. The skill ships inside this package, so it always matches the
server it was installed with.

## Tools

| Tool | Purpose |
|---|---|
| help | documentation by topic (start, ids, schema, operations, evidence, workflow, concurrency, queries, policy, errors, adopt) |
| overview | roots, counts, open change sets, head; says so when the repository is not initialised yet |
| search | ranked element lookup by id, fqn, title, kind, tag |
| expand | descendants of an entity plus the relationships touching them |
| element | one element in full; `qualify=true` adds derived verification |
| story | change sets involving an entity or subtree, oldest first, paged; as of a revision or date |
| changes | list change sets by disposition, promotion, or entity |
| change | one change set with commits, derived verification, and optionally its evidence |
| validate | dry-run a change set against the baseline and ledger |
| propose | record a change set as proposed or draft; never touches the model |
| set_disposition | governance transition (draft, proposed, accepted, rejected, superseded) |
| promote | apply an accepted change set to the baseline; the only write into `model/` |
| record_evidence | append an evidence record; verification follows from it |
| project | candidate projection of change sets, optionally rendered as DSL or PNG |
| qualify | the committed baseline annotated per entity with derived verification |
| releases | deployment timeline per environment, and the released baseline at a time |
| bootstrap | init an empty model repository, or adopt an existing LikeC4 model as an inferred baseline |

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

## Development

```sh
npm test -w packages/mcp      # drives the server in-process over a linked transport
```
