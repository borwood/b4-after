// Change-set validation against the declared baseline and the ledger (AR-15, AT-08).
// Phase A findings this covers that LikeC4 does not: unknown relationship kinds are accepted silently
// by the builder; the ancestor/descendant relationship ban surfaces as an opaque error.
import { ChangeSet, type ChangeSet as ChangeSetT } from './schema.js'
import { IdentityRegistry } from './identity.js'
import type { Ledger } from './ledger.js'

export interface ValidationIssue {
  severity: 'error' | 'warning'
  code: string
  /** JSON-pointer-ish path into the change set. */
  path: string
  message: string
}

export interface ValidationContext {
  /** Identity registry built from the baseline the change set targets. Required for entity checks. */
  registry?: IdentityRegistry
  /** Ledger for dependency checks. */
  ledger?: Ledger
}

export interface ValidationResult {
  ok: boolean
  changeSet?: ChangeSetT
  issues: ValidationIssue[]
}

interface VirtualElement { fqn: string; kind: string }

export function validateChangeSet(input: unknown, ctx: ValidationContext = {}): ValidationResult {
  const issues: ValidationIssue[] = []
  const err = (code: string, path: string, message: string) => issues.push({ severity: 'error', code, path, message })
  const warn = (code: string, path: string, message: string) => issues.push({ severity: 'warning', code, path, message })

  const parsed = ChangeSet.safeParse(input)
  if (!parsed.success) {
    for (const i of parsed.error.issues) err('E_SCHEMA', '/' + i.path.join('/'), i.message)
    return { ok: false, issues }
  }
  const cs = parsed.data

  if (cs.operations.length === 0 && cs.references.length === 0) {
    warn('W_NO_PARTICIPANTS', '/', 'change set has no operations and no references; it will not appear in any story')
  }

  // Dependencies.
  const ledger = ctx.ledger
  for (const [i, dep] of cs.depends_on.entries()) {
    if (dep === cs.id) err('E_SELF_DEPENDENCY', `/depends_on/${i}`, `${cs.id} cannot depend on itself`)
    else if (ledger && !ledger.has(dep)) err('E_UNKNOWN_DEPENDENCY', `/depends_on/${i}`, `${dep} is not in the ledger`)
  }
  for (const [i, sup] of cs.supersedes.entries()) {
    if (sup === cs.id) err('E_SELF_SUPERSEDES', `/supersedes/${i}`, `${cs.id} cannot supersede itself`)
    else if (ledger && !ledger.has(sup)) warn('W_UNKNOWN_SUPERSEDES', `/supersedes/${i}`, `${sup} is not in the ledger`)
  }
  if (ledger && cs.depends_on.length) {
    const cycle = findDependencyCycle(cs, ledger)
    if (cycle) err('E_DEPENDENCY_CYCLE', '/depends_on', `dependency cycle: ${cycle.join(' -> ')}`)
  }

  const reg = ctx.registry
  if (!reg) {
    warn('W_NO_BASELINE', '/operations', 'no baseline registry supplied; entity, kind and hierarchy checks skipped')
    return { ok: !issues.some(i => i.severity === 'error'), changeSet: cs, issues }
  }

  const spec = reg.model.$data.specification as { elements: Record<string, unknown>; relationships: Record<string, unknown> }
  const elementKinds = new Set(Object.keys(spec.elements ?? {}))
  const relationshipKinds = new Set(Object.keys(spec.relationships ?? {}))

  // Virtual state while walking operations in order.
  const added = new Map<string, VirtualElement>()
  const addedRels = new Map<string, { from: string; to: string }>()
  const removed = new Set<string>()
  const mutated = new Set<string>()

  const elementFqn = (id: string): string | undefined => added.get(id)?.fqn ?? reg.element(id)?.fqn
  const elementExists = (id: string) => !removed.has(id) && (added.has(id) || !!reg.element(id))
  const relationshipExists = (id: string) => !removed.has(id) && (addedRels.has(id) || !!reg.relationship(id))

  const requireElement = (id: string, path: string, what: string): boolean => {
    if (removed.has(id)) { err('E_AFTER_REMOVE', path, `${what} ${id} was removed earlier in this change set`); return false }
    if (!elementExists(id)) {
      const hint = reg.relationship(id) ? ' (it is a relationship id)' : ''
      err('E_UNKNOWN_ENTITY', path, `${what} ${id} does not exist in the baseline${hint}`)
      return false
    }
    return true
  }

  cs.operations.forEach((op, i) => {
    const p = `/operations/${i}`
    switch (op.op) {
      case 'add_element': {
        if (reg.get(op.id) || added.has(op.id) || addedRels.has(op.id)) err('E_DUPLICATE_ID', `${p}/id`, `${op.id} already exists`)
        if (!elementKinds.has(op.kind)) err('E_UNKNOWN_KIND', `${p}/kind`, `element kind "${op.kind}" is not in the specification (known: ${[...elementKinds].join(', ')})`)
        let parentFqn: string | null = null
        if (op.parent !== null) {
          if (requireElement(op.parent, `${p}/parent`, 'parent')) parentFqn = elementFqn(op.parent)!
        }
        const fqn = parentFqn ? `${parentFqn}.${op.name}` : op.name
        if (reg.elementByFqn(fqn) || [...added.values()].some(v => v.fqn === fqn)) {
          err('E_DUPLICATE_NAME', `${p}/name`, `an element named ${fqn} already exists`)
        }
        added.set(op.id, { fqn, kind: op.kind })
        mutated.add(op.id)
        break
      }
      case 'update_element': {
        if (requireElement(op.id, `${p}/id`, 'element')) mutated.add(op.id)
        if (Object.keys(op.set).length === 0) warn('W_EMPTY_UPDATE', `${p}/set`, 'update has no fields')
        break
      }
      case 'move_element': {
        if (!requireElement(op.id, `${p}/id`, 'element')) break
        mutated.add(op.id)
        const selfFqn = elementFqn(op.id)!
        if (op.parent !== null) {
          if (op.parent === op.id) err('E_MOVE_INTO_SELF', `${p}/parent`, `${op.id} cannot be moved into itself`)
          else if (requireElement(op.parent, `${p}/parent`, 'parent')) {
            const targetFqn = elementFqn(op.parent)!
            if (targetFqn.startsWith(selfFqn + '.')) err('E_MOVE_INTO_DESCENDANT', `${p}/parent`, `${op.id} cannot be moved under its own descendant ${op.parent}`)
          }
        }
        break
      }
      case 'remove_element': {
        if (requireElement(op.id, `${p}/id`, 'element')) { removed.add(op.id); mutated.add(op.id) }
        break
      }
      case 'add_relationship': {
        if (reg.get(op.id) || added.has(op.id) || addedRels.has(op.id)) err('E_DUPLICATE_ID', `${p}/id`, `${op.id} already exists`)
        if (op.kind !== undefined && !relationshipKinds.has(op.kind)) {
          err('E_UNKNOWN_RELATIONSHIP_KIND', `${p}/kind`, `relationship kind "${op.kind}" is not in the specification (known: ${[...relationshipKinds].join(', ')})`)
        }
        const okFrom = requireElement(op.from, `${p}/from`, 'source')
        const okTo = requireElement(op.to, `${p}/to`, 'target')
        if (okFrom && okTo) {
          const a = elementFqn(op.from)!, b = elementFqn(op.to)!
          if (IdentityRegistry.sameHierarchy(a, b)) {
            err('E_SAME_HIERARCHY', p, `LikeC4 does not allow a relationship between ${op.from} (${a}) and ${op.to} (${b}): one contains the other`)
          }
        }
        addedRels.set(op.id, { from: op.from, to: op.to })
        mutated.add(op.id)
        break
      }
      case 'update_relationship':
      case 'remove_relationship': {
        if (removed.has(op.id)) err('E_AFTER_REMOVE', `${p}/id`, `relationship ${op.id} was removed earlier in this change set`)
        else if (!relationshipExists(op.id)) {
          const hint = reg.element(op.id) ? ' (it is an element id)' : ''
          err('E_UNKNOWN_ENTITY', `${p}/id`, `relationship ${op.id} does not exist in the baseline${hint}`)
        } else {
          mutated.add(op.id)
          if (op.op === 'remove_relationship') removed.add(op.id)
        }
        break
      }
    }
  })

  cs.references.forEach((ref, i) => {
    const p = `/references/${i}`
    if (!reg.get(ref.entity) && !added.has(ref.entity)) {
      err('E_UNKNOWN_ENTITY', `${p}/entity`, `referenced entity ${ref.entity} does not exist in the baseline`)
    } else if (mutated.has(ref.entity)) {
      warn('W_REFERENCE_ALSO_OPERATED', `${p}/entity`, `${ref.entity} is both referenced (relates_to) and changed by an operation; the reference is redundant`)
    }
  })

  return { ok: !issues.some(i => i.severity === 'error'), changeSet: cs, issues }
}

function findDependencyCycle(cs: ChangeSetT, ledger: Ledger): string[] | null {
  // DFS from cs through depends_on edges in the ledger; cs itself is not in the ledger yet (or is being revised).
  // Self-dependencies are reported separately; exclude them so they do not also read as a cycle.
  const deps = (id: string): string[] => (id === cs.id ? cs.depends_on : (ledger.get(id)?.changeSet.depends_on ?? [])).filter(d => d !== id)
  const stack: string[] = []
  const visiting = new Set<string>()
  const done = new Set<string>()
  const visit = (id: string): string[] | null => {
    if (done.has(id)) return null
    if (visiting.has(id)) return [...stack.slice(stack.indexOf(id)), id]
    visiting.add(id); stack.push(id)
    for (const d of deps(id)) { const c = visit(d); if (c) return c }
    stack.pop(); visiting.delete(id); done.add(id)
    return null
  }
  return visit(cs.id)
}
