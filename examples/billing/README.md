# Example model-data repository: billing

Layout of a model-data repository as consumed by `@like-b4/ledger`:

```
model/      LikeC4 DSL. Machine-generated; agents are the only writers.
changes/    One YAML record per logical change set, CHG-<n>.yaml. Versioned over time in git.
```

Every element and relationship in `model/` carries `stable_id` metadata. Change sets refer to
entities only by stable id, never by LikeC4 FQN, so renames and moves do not sever history.

The tests copy this directory into a temporary git repository and commit it in stages to exercise
revision and time cutoffs.
