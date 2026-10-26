# like-b4

Architecture Change Ledger: an agent-facing architecture model and change-history system built as
a companion to [LikeC4](https://likec4.dev). The mission and requirements are in
`architecture_change_ledger_prd.md`.

| Path | What |
|---|---|
| `packages/ledger` | `@like-b4/ledger`: change-set schema, stable identity, git provenance, `storyOf()`, validation, candidate projections, governed promotion, evidence and derived verification, qualified baseline |
| `packages/mcp` | `@like-b4/mcp`: the agent-facing MCP server over a model-data repository |
| `examples/billing` | a small model-data repository used by the tests |
| `skills/like-b4-adopt` | Claude skill for bringing an existing codebase into the ledger (copy to `.claude/skills/` or `~/.claude/skills/`) |
| `spikes/phase-a` | the LikeC4 feasibility spike and its findings |

```
npm install            # Node >= 22.22, npm >= 12
npm run typecheck
npm test
```

A model-data repository is a git repository with `model/` (LikeC4 DSL, machine-generated),
`changes/` (one YAML record per logical change set) and `evidence/` (append-only evidence per
change set). Agents are the only writers; humans get diagrams and summaries.
