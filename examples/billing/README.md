# Example model repository: billing

A small, complete model repository to explore cb4 with: a billing platform with a UI, an
API, a component, a datastore, an external payment gateway, and a customer. It has one promoted
change set, one proposed change set that depends on it, one rejected change set, and evidence on
the promoted one.

```
model/      LikeC4 DSL. Generated; agents are the only writers.
changes/    One YAML record per logical change set, CHG-<n>.yaml.
evidence/   One YAML file per change set with appended evidence records.
```

Every element and relationship in `model/` carries `stable_id` metadata. Change sets refer to
entities only by stable id, never by LikeC4 fully-qualified name, so renames and moves do not sever
history.

To explore it with an agent, copy it somewhere, make it a git repository, and point the server
at it:

```sh
cp -r examples/billing /tmp/billing && cd /tmp/billing && git init -q && git add . && git commit -qm baseline
claude mcp add billing -- npx -y cb4-mcp /tmp/billing --actor me
```

Then try `overview`, `story entity=ent-billing subtree=true`, `project changes=[CHG-042] render=dsl`,
and `qualify`.

The test suites copy this directory into a temporary git repository and commit it in stages to
exercise revision and time cutoffs.
