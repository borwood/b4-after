# @like-b4/mcp

Agent-facing MCP server over a model-data repository (`model/`, `changes/`, `evidence/`). It wraps
`@like-b4/ledger`; nothing here reimplements LikeC4 or the ledger.

## Run

```
like-b4-mcp /path/to/model-data-repo --actor planning-agent
```

Claude Code:

```
claude mcp add like-b4 -- npx -y @like-b4/mcp /path/to/repo --actor <agent-name>
```

Env: `LIKE_B4_REPO`, `LIKE_B4_ACTOR`. Stdio transport. Each agent process gets its own server
process; that is fine (see Concurrency).

## Design for agents

- **Fifteen tools, one-line descriptions.** The whole tool list is under 14 KB. Everything an
  agent might need to follow up on is behind `help topic=<name>` (start, ids, schema, operations,
  evidence, workflow, concurrency, queries, policy, errors), fetched only when wanted.
- **Compact JSON responses**, no whitespace, short shas, string-encoded roles (`ent-x:added`),
  and summary modes by default (`story detail=summary`, `qualify detail=counts`). Full detail is a
  flag away.
- **Bounded by default**: overview shows at most 20 roots and 10 open change sets; search limit
  10; expand depth 1 and 50 nodes; story 20 entries with a cursor. Every list says `truncated`.
- **Operational feedback on every call**: `head` (short HEAD sha the answer was computed at),
  `ok`, and on failure a `code` (VALIDATION, NOT_FOUND, REPO_MOVED, LOCK_BUSY, REFUSED,
  PROJECTION, INVALID_MODEL) with `issues[]` carrying JSON-pointer paths into the input.
- **Nothing an agent does not need**: no view internals, no layout data, no LikeC4 hashes (stable
  ids throughout; `fqn:`/`rel:` prefixes mark entities that lack one).

## Tools

| Tool | Purpose |
|---|---|
| help | documentation by topic |
| overview | roots, counts, open change sets, head |
| search | ranked element lookup |
| expand | descendants + touching relationships |
| element | one element in full; `qualify` adds verification |
| story | change sets involving an entity/subtree, oldest first, paged |
| changes | list change sets by disposition/promoted/entity |
| change | one change set, commits, derived verification, evidence |
| validate | dry-run a change set |
| propose | record a change set as proposed/draft |
| set_disposition | governance transition |
| promote | apply an accepted change set to the baseline |
| record_evidence | append evidence; verification follows |
| project | candidate projection, optional dsl/png render |
| qualify | baseline annotated with derived verification |

## Concurrency

Several agents may use the repository at once, through one or several server processes.

- Reads come from a per-process snapshot cached by HEAD plus the mtimes of `model/`, `changes/`
  and `evidence/`, so out-of-band commits or files written by another process are picked up on the
  next call.
- Writes take a cross-process lock (`.git/.like-b4.lock`, atomic mkdir, stale after 120 s, wait up
  to 30 s then `LOCK_BUSY`), then run the library's own `expectedHead` check. Agents that read
  before writing should pass `expected_head` (short sha accepted) and handle `REPO_MOVED` by
  re-reading and retrying.
- Every write returns the new `head`, so an agent can chain writes safely.

## Development

```
npm test -w packages/mcp      # drives the server in-process over a linked transport
```
