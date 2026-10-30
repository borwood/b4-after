// Reserved vocabulary cb4 writes into the model to say what is real and what is intended.
// Agents may not set these themselves: validation rejects them, and operations that replace tags
// keep them. Everything here is derived from the ledger and evidence, never asserted.

export const RESERVED_TAG_PREFIX = 'b4-'
export const RESERVED_METADATA_PREFIX = 'b4_'

/** One flag per kind of pending change. Absence of every flag means "exists as shown". */
export type StatusFlag = 'intended' | 'retiring' | 'pending_update' | 'pending_move' | 'failed'
export const STATUS_FLAGS: readonly StatusFlag[] = ['intended', 'retiring', 'pending_update', 'pending_move', 'failed']

export const TAG: Record<StatusFlag, string> = {
  /** Added by a promoted change set that is not yet verified: it does not exist yet. */
  intended: 'b4-intended',
  /** Removed by a promoted change set that is not yet verified: it still exists. */
  retiring: 'b4-retiring',
  /** One or more promoted property updates await verification; current values are shown. */
  pending_update: 'b4-pending-update',
  /** Moved by a promoted change set that is not yet verified; shown at the new position. */
  pending_move: 'b4-pending-move',
  /** The latest change set operating on it has failing evidence for it. */
  failed: 'b4-failed',
}

export const TAG_COLOR: Record<StatusFlag, string> = {
  intended: '#d97706',
  retiring: '#64748b',
  pending_update: '#2563eb',
  pending_move: '#7c3aed',
  failed: '#b91c1c',
}

export const META = {
  /** Latest promoted change set that operated on the entity. */
  change: 'b4_change',
  /** Per-target verification of that change set: verified | unverified | failed. */
  status: 'b4_status',
  /** Comma-separated change sets whose update/remove of this entity is deferred until verified. */
  pending: 'b4_pending',
  /** FQN before a not-yet-verified move. */
  movedFrom: 'b4_moved_from',
} as const

const flagByTag = new Map<string, StatusFlag>(STATUS_FLAGS.map(f => [TAG[f], f]))

export const isReservedTag = (tag: string): boolean => tag.startsWith(RESERVED_TAG_PREFIX)
export const isReservedMetadataKey = (key: string): boolean => key.startsWith(RESERVED_METADATA_PREFIX)

/** Status flags carried by a tag list, in canonical order. */
export function flagsOfTags(tags: Iterable<string> | undefined): StatusFlag[] {
  const present = new Set<StatusFlag>()
  for (const t of tags ?? []) { const f = flagByTag.get(t); if (f) present.add(f) }
  return STATUS_FLAGS.filter(f => present.has(f))
}

/** Tags without any reserved one. */
export function userTags(tags: Iterable<string> | undefined): string[] {
  return [...(tags ?? [])].filter(t => !isReservedTag(t))
}

/** Change-set fields that are accepted for compatibility but no longer carry meaning. */
export const DEPRECATED_CHANGE_SET_FIELDS: Record<string, string> = {
  implementation: 'implementation is derived from evidence (not_started, in_progress, implemented) and is no longer recorded',
}

/**
 * LikeC4 keywords its grammar refuses as element names. The DSL cannot quote a name, so the generator
 * would emit these bare and the regenerated model would not parse. Determined against LikeC4 1.60.0
 * by parsing a model with each grammar keyword as a root and as a nested element name; keywords the
 * grammar does accept as names (model, element, person, component, ...) are deliberately absent.
 */
export const LIKEC4_RESERVED_WORDS: ReadonlySet<string> = new Set([
  'BottomTop', 'LeftRight', 'RightLeft', 'TopBottom', 'and', 'autoLayout', 'border', 'color', 'deploymentNode', 'description',
  'dynamic', 'dynamicPredicateGroup', 'exclude', 'extend', 'extends', 'from', 'global', 'head', 'icon', 'iconColor', 'iconPosition',
  'iconSize', 'icons', 'import', 'include', 'includeAncestors', 'instanceOf', 'is', 'kind', 'likec4lib', 'line', 'link', 'metadata',
  'multiple', 'navigateTo', 'not', 'notation', 'notes', 'of', 'opacity', 'or', 'order', 'padding', 'predicate', 'predicateGroup',
  'rank', 'rgb', 'rgba', 'shape', 'size', 'sizing', 'specification', 'style', 'styleGroup', 'summary', 'tag', 'tail', 'technology',
  'textSize', 'title', 'variant', 'view', 'views', 'where', 'with',
])

export const isLikeC4ReservedWord = (name: string): boolean => LIKEC4_RESERVED_WORDS.has(name)
