// On-demand documentation. Tool descriptions stay one line; anything an agent might need to
// follow up on lives here, by topic, so it costs tokens only when asked for.

export const HELP_TOPICS = ['start', 'ids', 'schema', 'operations', 'evidence', 'workflow', 'concurrency', 'queries', 'policy', 'errors'] as const
export type HelpTopic = typeof HELP_TOPICS[number]

const INDEX = `like-b4: architecture model (LikeC4) + change-set ledger + evidence, in one git repo.
Topics (help topic=<name>):
- start: 5-step quickstart for a new task
- ids: stable ids vs FQNs; how entities are named in every call
- schema: change-set shape (fields, dispositions, references, sources)
- operations: the 7 operations and their fields
- evidence: evidence record shape; how verification is derived
- workflow: propose -> accept -> promote; what each write does and refuses
- concurrency: several agents at once; head, expected_head, locks
- queries: bounded reads (overview, search, expand, element, story, changes, change, project, qualify)
- policy: promotion and verification policies
- errors: error codes and what to do`

const TOPICS: Record<HelpTopic, string> = {
  start: `1. overview -> roots, counts, open change sets, head.
2. search / expand / element -> find the entities you need (depth 1 by default; raise depth or max_nodes only if needed).
3. story entity=<id> -> what changed around it and why (change sets, roles, sources). Add subtree=true for a container.
4. Draft a change set (help schema, help operations) -> validate -> propose (actor=<your name>).
5. project changes=[<ids>] render=dsl|png to inspect the candidate. Promotion needs disposition=accepted (set_disposition) and is the only write into model/.
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
  implementation?: not_started|in_progress|implemented,
  effective_at?: ISO datetime (claimed effective time, if it differs from when it is recorded),
  operations?: [...] (help operations),
  references?: [{ entity: <stable id>, relation: "relates_to", reason? }] }
references = "this entity is relevant" with NO change to it and NO architectural edge. Requirements/AC stay external: point to them with sources, do not copy them in.
Unknown fields are rejected. Verification is never a field: it is derived from evidence.`,

  operations: `Targets are stable ids. Order matters within a change set (later ops see earlier ones).
- add_element { id, parent: <stable id>|null, name: <LikeC4 local name>, kind, title?, description?, technology?, tags?, metadata? }
- update_element { id, set: { title?, description?, technology?, tags?, metadata? } }  (merge: metadata keys patched, tags replaced, null clears)
- move_element { id, parent: <stable id>|null, name? }
- remove_element { id }  (cascades to descendants, attached relationships, view predicates)
- add_relationship { id, from, to, kind?, title?, description?, technology?, tags?, metadata? }
- update_relationship { id, set: {...} }
- remove_relationship { id }
Rules enforced by validate: kinds and tags must exist in the specification; a relationship cannot connect an element with its own ancestor/descendant; no duplicate ids or names; no use after remove; dependencies must exist and not cycle.
add_relationship makes from/to participants of the change set (for story) without editing them.`,

  evidence: `Evidence record: { id: "ev-<slug>", kind: test|runtime_observation|deployment|code_review|manual_review, result: pass|fail|inconclusive,
  targets?: [<stable ids the change set operates on>] (none = whole change set), source_ref (url/key of the run, PR, trace),
  code_revision? (required for an observation to count), environment?, observed_at (ISO), recorded_by, notes?, amends?: "ev-.." }
Derivation (never asserted): only observations (test, runtime_observation) with code_revision verify. Approvals (code_review, manual_review) and deployments are listed but never verify on their own.
verified = every operation target covered by a passing observation; partial = some passing, not all covered; failed = any applicable failing observation; unverified = none.
environment=<name> restricts to that environment plus environment-agnostic records. Corrections: new record with amends=<old id>; the old one stays on file.`,

  workflow: `propose(change_set, actor): validates against HEAD's baseline + ledger, commits changes/CHG-n.yaml as proposed (draft=true for draft). Never touches model/. Re-propose the same id to revise it (until promoted).
validate(change_set): same checks, no write.
set_disposition(change_id, to, actor): draft->proposed; proposed->accepted|rejected|draft; accepted->rejected; rejected->proposed; any->superseded (superseded_by required and must declare supersedes).
promote(change_id, actor): requires committed, accepted, not promoted, all depends_on promoted, clean model/ and changes/. Applies the operations, regenerates model/model.c4, verifies it reloads with every stable id, commits model + promotion record together. Promoted change sets are frozen.
record_evidence(change_id, evidence, actor): appends to evidence/CHG-n.yaml and commits. Never changes model/ or changes/.
project(changes=[..]): candidate on top of the baseline, nothing written. Dependencies must be included or promoted.`,

  concurrency: `Several agents (or subagents) may call this server, possibly through separate server processes on the same repo.
- Every response carries head (short sha of HEAD when computed). Reads are consistent for one call.
- Writes take a cross-process lock, then run. Pass expected_head=<head you read> to refuse the write if someone else committed in between (error REPO_MOVED: re-read, re-validate, retry). Without expected_head the write proceeds on whatever HEAD is current.
- Writes return the new head. Chain: read -> propose(expected_head) -> set_disposition(expected_head=new head) -> ...
- Change-set ids: pick an unused CHG-<n> (overview.ledger shows counts; changes lists ids). Two agents proposing the same new id: the second revises the first; use distinct ids per task.
- Lock busy (LOCK_BUSY): another write is in progress; retry after a short wait.`,

  queries: `overview(): counts, roots (<=20), open change sets, head, identity problems.
search(query, kinds?, tags?, limit<=50): ranked by id/fqn/title match.
expand(entity, depth<=5, relationships=direct|none, max_nodes<=200): descendants + relationships touching the included set.
element(entity, qualify?): full details, incoming/outgoing, views, change sets touching it.
story(entity, subtree?, revision?, before?, environment?, limit<=100, cursor?, detail=summary|full): change sets involving the entity, oldest first, one hop of context. before=ISO time resolves to the last commit at or before it. subtree uses current descendants at that snapshot.
changes(disposition?, promoted?, entity?, limit?): list change sets. change(change_id, revision?, include_evidence?): one change set with commits and derived verification.
project(changes, baseline_revision?, highlight?, render=none|dsl|png, out_dir?): candidate diff; png writes files and returns paths.
qualify(environment?, revision?, render?, detail=counts|full): committed baseline annotated per entity with derived verification.`,

  policy: `Promotion (default): disposition accepted; all depends_on promoted; committed and clean tree. Implementation status does not gate promotion: the baseline is accepted declared architecture, not proof it is built or correct.
Verification (default): observations need code_revision; approvals never verify alone; status is environment-qualified. Stricter policies (required kinds, required approval) exist in the library; the server uses defaults.`,

  errors: `Responses are compact JSON. ok:false carries error, code and often issues[] with path + message.
VALIDATION: fix the listed issues (paths are JSON pointers into the change set). NOT_FOUND: unknown entity/change id (check help ids). REPO_MOVED: HEAD changed since expected_head; re-read and retry. LOCK_BUSY: another write running; retry. REFUSED: policy refused (message says why). PROJECTION: operations do not apply (issues per change set). INVALID_MODEL: regenerated model failed to load; nothing was written.`,
}

export function help(topic?: string): string {
  if (!topic) return INDEX
  const t = topic.toLowerCase() as HelpTopic
  return TOPICS[t] ?? `unknown topic "${topic}". ${INDEX}`
}
