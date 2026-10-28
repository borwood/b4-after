// On-demand documentation. Tool descriptions stay one line; anything an agent might need to
// follow up on lives here, by topic, so it costs tokens only when asked for.

export const HELP_TOPICS = ['start', 'ids', 'schema', 'operations', 'evidence', 'status', 'workflow', 'plan', 'concurrency', 'queries', 'policy', 'errors', 'adopt'] as const
export type HelpTopic = typeof HELP_TOPICS[number]

const INDEX = `b4-after: architecture model (LikeC4) + change-set ledger + evidence, in one git repo.
Topics (help topic=<name>):
- start: 5-step quickstart for a new task
- ids: stable ids vs FQNs; how entities are named in every call
- schema: change-set shape (fields, dispositions, references, sources)
- operations: the 7 operations and their fields
- evidence: evidence record shape; how verification is derived
- status: what exists vs what is intended; the b4-* tags, b4_* metadata, As-is and Target views
- workflow: propose -> accept -> promote -> evidence -> reconcile; what each write does and refuses
- plan: planning ahead of building; layering change sets; how in-progress work shows in the model
- concurrency: several agents at once; head, expected_head, locks
- queries: bounded reads (overview, search, expand, element, story, changes, change, project, qualify, render)
- policy: promotion and verification policies
- errors: error codes and what to do
- adopt: bringing an existing system into the ledger`

const TOPICS: Record<HelpTopic, string> = {
  start: `1. overview -> roots, counts, open change sets, head.
2. search / expand / element -> find the entities you need (depth 1 by default; raise depth or max_nodes only if needed). Rows carry pending=[intended|retiring|pending_update|pending_move|failed] when an entity is not exactly as shown (help status).
3. story entity=<id> -> what changed around it and why (change sets, roles, sources). Add subtree=true for a container. Planning a project or a feature before building it: help plan.
4. Draft a change set (help schema, help operations) -> validate -> propose (actor=<your name>).
5. project changes=[<ids>] render=dsl to inspect the candidate; render=html for a person (interactive site). Promotion needs disposition=accepted (set_disposition) and is the only write into model/.
Everything returns head (short sha). Pass it as expected_head on writes when other agents may be active (help concurrency).`,

  ids: `Entities are addressed by STABLE ID (metadata stable_id in the model), e.g. ent-billing-api, rel-charges-cards. Element and relationship ids share one namespace: lowercase, digits, - or _, starting with a letter.
Reads also accept a LikeC4 FQN (billing.billing_api). Change sets and evidence must use stable ids; FQNs change on rename/move, stable ids do not.
Rows show id and fqn. An element without a stable id appears as id "fqn:<fqn>" and cannot be referenced by a change set until it gets one (overview.identity.withoutStableId counts them).
Change sets: CHG-<n>. Evidence records: ev-<slug>.`,

  schema: `Change set (JSON or YAML object):
{ id: "CHG-<n>", title, intent,
  sources?: [{ ref: <url|key>, role: requirement|acceptance_criteria|issue|design|discussion|other, note? }],
  depends_on?: ["CHG-.."], supersedes?: ["CHG-.."],
  disposition?: draft|proposed (writes set it; accepted/rejected/superseded only via set_disposition),
  inferred?: true (declared from observing the code, not designed: applies as existing, unverified),
  effective_at?: ISO datetime (claimed effective time, if it differs from when it is recorded),
  operations?: [...] (help operations),
  references?: [{ entity: <stable id>, relation: "relates_to", reason? }] }
references = "this entity is relevant" with NO change to it and NO architectural edge. Requirements/AC stay external: point to them with sources, do not copy them in.
Unknown fields are rejected. Neither verification nor implementation is a field: both are derived from evidence (implementation: not_started -> in_progress once any observation exists -> implemented once verified; inferred change sets count as implemented).`,

  operations: `Targets are stable ids. Order matters within a change set (later ops see earlier ones).
- add_element { id, parent: <stable id>|null, name: <LikeC4 local name>, kind, title?, description?, technology?, tags?, metadata?, derived_from?: [ids] }
- update_element { id, set: { title?, description?, technology?, tags?, metadata? } }  (merge: metadata keys patched, tags replaced, null clears)
- move_element { id, parent: <stable id>|null, name? }
- remove_element { id, succeeded_by?: [ids] }  (cascades to descendants, attached relationships, view predicates)
- add_relationship { id, from, to, kind?, title?, description?, technology?, tags?, metadata? }
- update_relationship { id, set: {...} }
- remove_relationship { id }
Rules enforced by validate: kinds and tags must exist in the specification; name may not be a LikeC4 keyword (E_RESERVED_WORD: head, tail, title, kind, metadata, link, style, view, ... pick another local name, the stable id is unaffected); tags b4-* and metadata keys b4_* are reserved (help status); a relationship cannot connect an element with its own ancestor/descendant; no duplicate ids or names (moves included); no use after remove; dependencies must exist and not cycle.
add_relationship makes from/to participants of the change set (for story) without editing them. Operating on a retiring element (removal promoted, not yet verified) is allowed and warned (W_RETIRING_TARGET).`,

  evidence: `Evidence record: { id: "ev-<slug>", kind: test|runtime_observation|deployment|code_review|manual_review, result: pass|fail|inconclusive,
  targets?: [<stable ids the change set operates on>] (none = whole change set), source_ref (url/key of the run, PR, trace),
  code_revision? (required for an observation to count), baseline_revision? (model repository commit a deployment ran; else the promotion commit is used), environment?, observed_at (ISO), recorded_by, notes?, amends?: "ev-.." }
Deployments (kind=deployment, environment=<env>, result pass|fail) feed the releases tool; record one per deploy attempt.
Derivation (never asserted): only observations (test, runtime_observation) with code_revision verify. Approvals (code_review, manual_review) and deployments are listed but never verify on their own.
verified = every operation target covered by a passing observation; partial = some passing, not all covered; failed = any applicable failing observation; unverified = none. Per target: failed if a failing record names it (or names nothing), verified if a passing one covers it.
environment=<name> restricts to that environment plus environment-agnostic records. Corrections: new record with amends=<old id>; the old one stays on file.
Recording evidence reconciles the model (help status): verified deferred updates/removals are applied and statuses refreshed, in a follow-up commit when anything changed.`,

  status: `The committed model is faithful to what exists. A promoted change set that is not yet verified is marked, never silently applied as fact:
- add_element / add_relationship -> applied, tagged b4-intended (dashed, faded): does not exist yet. Excluded from As-is views, shown in Target views.
- remove_element / remove_relationship -> deferred, target tagged b4-retiring (dotted, muted): still exists. Removed (with cascade) when the change set is verified for it.
- update_element / update_relationship -> deferred, target tagged b4-pending-update: current values stay; Target views show the intended title/description/technology as overrides. Applied when verified.
- move_element -> applied, tagged b4-pending-move with b4_moved_from=<old fqn> until verified.
- any target whose latest change set has failing evidence for it -> b4-failed.
Inferred change sets (adoption) describe what was observed, so everything applies at once with no flag. Already-verified targets apply at once.
Operations on an intended target (added by a promoted change set, not yet verified) also apply at once: nothing real exists to be faithful to, so a revised plan replaces the plan. Removing an intended element removes it; renaming or moving it leaves no badge. The element stays b4-intended until some change set operating on it is verified.
Every entity carries metadata b4_change (latest promoted change set operating on it), b4_status (verified|unverified|failed for it), and b4_pending (change sets whose deferred op awaits verification). Tags b4-* and metadata b4_* are reserved: validate rejects them in operations, and tag replacement keeps them.
Reads: element/search/expand rows carry pending=[...flags] when any flag is set; absent means exists as shown. Verification per environment is qualify (an overlay); the committed statuses use the default policy (any environment).
Views (model/views.c4, generated on every promote/reconcile): folders "As-is" and "Target", each with Landscape, Everything, one view per element with children, one per user tag. Render with render format=html.
reconcile runs after record_evidence and on demand; it is idempotent and only commits when the model changed. Deferral is abandoned (and reported) when it would leave a change set inconsistent, e.g. a name freed by a deferred removal is reused.`,

  workflow: `propose(change_set, actor): validates against HEAD's baseline + ledger, commits changes/CHG-n.yaml as proposed (draft=true for draft). Never touches model/. Re-propose the same id to revise it (until promoted).
  Unpromoted depends_on change sets (transitively) are projected onto the baseline first, so a chain of related change sets can be proposed and reviewed before any is promoted; the response lists projected_dependencies. If they do not project cleanly, W_DEPENDENCY_NOT_PROJECTED says so and the bare baseline is used.
validate(change_set): same checks, no write.
set_disposition(change_id, to, actor): draft->proposed; proposed->accepted|rejected|draft; accepted->rejected; rejected->proposed; any->superseded (superseded_by required and must declare supersedes).
promote(change_id, actor): requires committed, accepted, not promoted, all depends_on promoted, clean model/ and changes/. Applies additions and moves (marked), defers unverified updates/removals of existing entities (help status), regenerates model/model.c4 and model/views.c4, verifies the result reloads with every stable id, commits model + promotion record together. Promoted change sets are frozen. Returns deferred=[...] and warnings.
record_evidence(change_id, evidence, actor): appends to evidence/CHG-n.yaml and commits, then reconciles the model (second commit only when something changed; result.reconcile).
reconcile(actor): apply verified deferred operations and refresh statuses now. Idempotent. Run it once after upgrading a repository written before statuses existed.
project(changes=[..]): candidate on top of the baseline, nothing written. Dependencies must be included or promoted.
render(format=html|png|dsl): the committed baseline for people; html is the interactive site.`,

  plan: `Planning before building works with the ledger as it is; promote the plan, do not park it.
Why promote: a promoted plan of additions is all b4-intended (dashed, excluded from As-is views, shown in Target views), so the baseline still says what exists while every reader sees the design. An unpromoted plan is invisible to search/expand/element, has no Target view, and is overwritten in place when revised.
Layer it: evidence is recorded per change set and names targets, so verification is per change set and per entity. One change set per bounded context or layer (<=50 operations), chained with depends_on, at container granularity; leave components to later change sets. A single giant plan collects every evidence record for the life of the project and reads as partial for years.
Slices: a task that builds exactly what a plan change set says is evidence, not a new change set: record_evidence on that change set with targets=[ids built], code_revision, environment. The flags drop, the entities move into As-is. A task that refines the plan (components under a planned container, new relationships) is a change set with depends_on the plan; its additions are intended until its own evidence arrives. Make it operate on the planned entities it realises (an update_element on each: real technology, sharper description), not only reference them: an entity stops being intended once any promoted operation on it is verified, so verifying the slice proves those entities too. A relationship to a planned entity or a child under it leaves the entity intended, and evidence on the slice naming it is rejected (the slice does not operate on it).
Forks: a ruled-out or changed design is a new change set that updates, moves or removes the planned entities, with sources pointing at the decision. Promoted change sets cannot be revised or superseded. Operations on intended entities apply at once (help status), so the Target views show only the current plan.
In-progress work, as the model shows it: proposed/accepted but not promoted -> nothing in the model, visible via project. Promoted, no evidence -> b4-intended (adds), b4-retiring (removes), b4-pending-update (updates); change implementation=not_started. Some evidence -> implementation=in_progress, verification=partial; entities covered by passing observations lose their flag, failing ones gain b4-failed. All targets covered -> verified, implemented, no flags. Record evidence against the latest change set that operated on an entity; evidence on an earlier one still counts.
Staging several change sets: propose/validate see unpromoted depends_on (help workflow); promote still goes in dependency order. Review a batch with project changes=[...] render=html.`,

  concurrency: `Several agents (or subagents) may call this server, possibly through separate server processes on the same repo.
- Every response carries head (short sha of HEAD when computed). Reads are consistent for one call.
- Writes take a cross-process lock, then run. Pass expected_head=<head you read> to refuse the write if someone else committed in between (error REPO_MOVED: re-read, re-validate, retry). Without expected_head the write proceeds on whatever HEAD is current.
- Writes return the new head. Chain: read -> propose(expected_head) -> set_disposition(expected_head=new head) -> ...
- Change-set ids: pick an unused CHG-<n> (overview.ledger shows counts; changes lists ids). Two agents proposing the same new id: the second revises the first; use distinct ids per task.
- Lock busy (LOCK_BUSY): another write is in progress; retry after a short wait.
- Git worktrees: the model repository is one shared, linear ledger, not a branch of the code. A relative repoDir resolves against the main worktree of the surrounding code repository, so worktrees and subagents all hit the same ledger; never init a second one from a worktree. Record branch-local evidence with an environment (e.g. local, ci-pr) so qualify can be asked per environment.`,

  queries: `overview(): counts, roots (<=20), open change sets, head, identity problems.
search(query, kinds?, tags?, limit<=50): ranked by id/fqn/title match.
expand(entity, depth<=5, relationships=direct|none, max_nodes<=200): descendants + relationships touching the included set.
element(entity, qualify?): full details, incoming/outgoing, views, change sets touching it, tags and metadata (including b4_* status, help status).
story(entity, subtree?, membership=current|ever, revision?, before?, environment?, limit<=100, cursor?, detail=summary|full): change sets involving the entity, oldest first, one hop of context. before=ISO time resolves to the last commit at or before it. subtree uses current descendants at that snapshot; membership=ever also includes everything a promoted change set ever added or moved under it (ledger-derived; pre-ledger moves are not seen).
Lineage: add_element may carry derived_from=[ids] and remove_element succeeded_by=[ids] (splits, merges, replacements). Story shows these as roles derived_from / succeeded_by via lineage; they are history only, never architectural edges.
changes(disposition?, promoted?, entity?, limit?): list change sets; state = disposition/implementation/verification[/promoted]. change(change_id, revision?, include_evidence?): one change set with commits and derived verification.
project(changes, baseline_revision?, highlight?, render=none|dsl|png|html, out_dir?): candidate diff; png/html write files and return paths.
qualify(environment?, revision?, render?, detail=counts|full): committed baseline annotated per entity with derived verification for an environment.
render(format=html|png|dsl, revision?, out_dir?, views?): the committed baseline as people should see it. html = LikeC4's interactive single-file site (folders As-is and Target); png needs Playwright.
releases(environment?, at?, detail=timeline|baseline): deployment evidence as a timeline; detail=baseline gives the released baseline for an environment at a time (model at the revision of the latest passing deployment; deployed/failed change sets).`,

  policy: `Promotion (default): disposition accepted; all depends_on promoted; committed and clean tree. Implementation status does not gate promotion: the baseline is accepted declared architecture, with unverified parts marked (help status), not proof it is built or correct.
Verification (default): observations need code_revision; approvals never verify alone; status is environment-qualified. Stricter policies (required kinds, required approval) exist in the library; the server uses defaults.`,

  adopt: `Two paths. Both end with everything imported marked inferred and showing as unverified in qualify until evidence arrives.
A. No model yet: bootstrap mode=init name=<project> [kinds, relationship_kinds, tags]. Then survey the codebase and propose change sets with inferred:true, one per bounded context or top-level system (<=50 operations each; parents before children; relationships after both ends). Cite what you read in sources (role other, ref=repo path). set_disposition accepted, promote. Do not invent components you did not see; prefer fewer, truer elements. Pick stable ids you would keep after a rename: ent-<system>-<component>, rel-<from>-<verb>-<to>.
B. Existing LikeC4 model in model/: bootstrap mode=adopt. Assigns missing stable ids (regenerates model/), records one inferred, pre-ledger-promoted change set per root plus one for cross-root relationships. Idempotent.
Afterwards: qualify shows unverified for every imported entity; record_evidence turns it green over time. Specification kinds are fixed at init; choose them to fit the system. Views are generated (help status); render format=html shows them.`,

  errors: `Responses are compact JSON. ok:false carries error, code and often issues[] with path + message.
VALIDATION: fix the listed issues (paths are JSON pointers into the change set). NOT_FOUND: unknown entity/change id (check help ids). REPO_MOVED: HEAD changed since expected_head; re-read and retry. LOCK_BUSY: another write running; retry. REFUSED: policy refused (message says why). PROJECTION: operations do not apply (issues per change set). INVALID_MODEL: regenerated model failed to load; nothing was written.`,
}

export function help(topic?: string): string {
  if (!topic) return INDEX
  const t = topic.toLowerCase() as HelpTopic
  return TOPICS[t] ?? `unknown topic "${topic}". ${INDEX}`
}
