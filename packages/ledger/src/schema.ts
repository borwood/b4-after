// Change-set schema (PRD sections 5 and 6.1). Fields are deliberately minimal; everything here is
// Phase B scope. Evidence records (6.2) arrive in Phase D.
import { z } from 'zod'

/** Stable, non-hierarchical entity id (PRD 5.4). Elements and relationships share one namespace. */
export const STABLE_ID = /^[a-z][a-z0-9_-]{0,127}$/
/** Logical change-set id. Identity persists across revisions, review, rejection, supersession. */
export const CHANGE_ID = /^CHG-[0-9]{1,9}$/
/** LikeC4 local name rules: letters, digits, hyphen, underscore; no leading digit; no dots. */
export const LOCAL_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/

const stableId = z.string().regex(STABLE_ID, 'stable id: lowercase letters, digits, "-" or "_", starting with a letter')
const changeId = z.string().regex(CHANGE_ID, 'change id must look like CHG-123')
const localName = z.string().regex(LOCAL_NAME, 'invalid LikeC4 element name')
const metadata = z.record(z.string(), z.string())

export const Disposition = z.enum(['draft', 'proposed', 'accepted', 'rejected', 'superseded'])
export const Implementation = z.enum(['not_started', 'in_progress', 'implemented'])
export const SourceRole = z.enum(['requirement', 'acceptance_criteria', 'issue', 'design', 'discussion', 'other'])

export const ElementProps = z.strictObject({
  title: z.string().optional(),
  description: z.string().nullable().optional(),
  technology: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  metadata: metadata.optional(),
})
export const RelationshipProps = z.strictObject({
  title: z.string().optional(),
  description: z.string().nullable().optional(),
  technology: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  metadata: metadata.optional(),
})

export const AddElement = z.strictObject({
  op: z.literal('add_element'),
  id: stableId,
  parent: stableId.nullable(),
  name: localName,
  kind: z.string().min(1),
  ...ElementProps.shape,
})
export const UpdateElement = z.strictObject({ op: z.literal('update_element'), id: stableId, set: ElementProps })
export const MoveElement = z.strictObject({
  op: z.literal('move_element'),
  id: stableId,
  parent: stableId.nullable(),
  name: localName.optional(),
})
export const RemoveElement = z.strictObject({ op: z.literal('remove_element'), id: stableId })
export const AddRelationship = z.strictObject({
  op: z.literal('add_relationship'),
  id: stableId,
  from: stableId,
  to: stableId,
  kind: z.string().min(1).optional(),
  ...RelationshipProps.shape,
})
export const UpdateRelationship = z.strictObject({ op: z.literal('update_relationship'), id: stableId, set: RelationshipProps })
export const RemoveRelationship = z.strictObject({ op: z.literal('remove_relationship'), id: stableId })

export const Operation = z.discriminatedUnion('op', [
  AddElement, UpdateElement, MoveElement, RemoveElement,
  AddRelationship, UpdateRelationship, RemoveRelationship,
])

/** Non-mutating reference (PRD 5.2). The only operator in Phase B is relates_to. */
export const Reference = z.strictObject({
  entity: stableId,
  relation: z.literal('relates_to'),
  reason: z.string().optional(),
})

/** Resolvable pointer to an external requirement, AC, issue, etc. Contents stay external. */
export const Source = z.strictObject({
  ref: z.string().min(1),
  role: SourceRole,
  note: z.string().optional(),
})

/**
 * Recorded when the change set's operations were applied to the committed baseline (PRD 6.3 promotion).
 * Written only by promoteChangeSet(); its presence means "already in the baseline".
 */
export const Promotion = z.strictObject({
  at: z.iso.datetime({ offset: true }),
  /** Baseline commit the operations were applied on top of, or "pre-ledger" for change sets recorded after the fact. */
  baseline: z.union([z.string().regex(/^[0-9a-f]{7,40}$/), z.literal('pre-ledger')]),
  actor: z.string().min(1),
})

export const ChangeSet = z.strictObject({
  id: changeId,
  title: z.string().min(1),
  intent: z.string().min(1),
  sources: z.array(Source).default([]),
  depends_on: z.array(changeId).default([]),
  supersedes: z.array(changeId).default([]),
  disposition: Disposition.default('draft'),
  implementation: Implementation.default('not_started'),
  /** Claimed effective time, when it differs from the time the record was committed (PRD 7.2). */
  effective_at: z.iso.datetime({ offset: true }).optional(),
  operations: z.array(Operation).default([]),
  references: z.array(Reference).default([]),
  promotion: Promotion.optional(),
  /** Declared architecture inferred during adoption rather than designed: unverified knowledge until evidence says otherwise. */
  inferred: z.boolean().optional(),
})

export type Promotion = z.infer<typeof Promotion>
export type Disposition = z.infer<typeof Disposition>
export type Implementation = z.infer<typeof Implementation>
export type SourceRole = z.infer<typeof SourceRole>
export type Source = z.infer<typeof Source>
export type Reference = z.infer<typeof Reference>
export type Operation = z.infer<typeof Operation>
export type AddElement = z.infer<typeof AddElement>
export type AddRelationship = z.infer<typeof AddRelationship>
export type ChangeSet = z.infer<typeof ChangeSet>
export type ChangeSetInput = z.input<typeof ChangeSet>

export const OPERATION_NAMES = Operation.options.map(o => o.shape.op.value) as readonly Operation['op'][]

export function isElementOp(op: Operation): op is Extract<Operation, { op: `${string}_element` }> {
  return op.op.endsWith('_element')
}
export function isRelationshipOp(op: Operation): op is Extract<Operation, { op: `${string}_relationship` }> {
  return op.op.endsWith('_relationship')
}
