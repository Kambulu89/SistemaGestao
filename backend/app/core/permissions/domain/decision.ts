import {
  ConditionError,
  evaluateCondition,
  type Condition,
  type EvalContext,
} from '#core/permissions/domain/condition'
import { splitPermission } from '#core/permissions/domain/catalog'

export type PolicyEffect = 'ALLOW' | 'DENY'
export type PolicyStatus = 'DRAFT' | 'ACTIVE' | 'DISABLED'
export type FieldMode = 'HIDDEN' | 'READ_ONLY'

export interface FieldRule {
  field: string
  mode: FieldMode
  /** Quando existir, a regra só vale se a condição for verdadeira. */
  when?: Condition
}

export interface AccessPolicy {
  id: string
  name: string
  resource: string
  action: string
  effect: PolicyEffect
  condition: Condition | null
  priority: number
  status: PolicyStatus
  fieldRules: FieldRule[]
}

/** Uma permissão concedida por um papel através de uma atribuição válida. */
export interface Grant {
  permissionCode: string
  roleId: string
  roleCode: string
  assignmentId: string
  /** Atribuição limitada a uma unidade: só vale para recursos dessa unidade. */
  unitId: string | null
}

export type DecisionReason =
  | 'NO_PERMISSION'
  | 'UNIT_MISMATCH'
  | 'UNIT_OUT_OF_SCOPE'
  | 'POLICY_DENY'
  | 'POLICY_ERROR'
  | 'NO_ALLOW_POLICY_MATCHED'
  | 'GRANTED'

export interface Decision {
  allowed: boolean
  reason: DecisionReason
  /** Papéis que concedem a permissão e políticas que decidiram: a "origem" mostrada no simulador. */
  grantedBy: { roleId: string; roleCode: string }[]
  policies: { id: string; name: string; effect: PolicyEffect }[]
  hiddenFields: string[]
  readOnlyFields: string[]
}

const matches = (policy: AccessPolicy, resource: string, action: string) =>
  policy.status === 'ACTIVE' &&
  (policy.resource === '*' || policy.resource === resource) &&
  (policy.action === '*' || policy.action === action)

function conditionHolds(condition: Condition | null, context: EvalContext): boolean | 'ERROR' {
  if (condition === null) return true
  try {
    return evaluateCondition(condition, context)
  } catch (error) {
    if (error instanceof ConditionError) return 'ERROR'
    throw error
  }
}

/**
 * Decisão de autorização (RBAC + ABAC), função pura:
 *  0. âmbito: se o recurso indica a unidade, o actor tem de ter essa unidade no seu âmbito (MembershipScope);
 *  1. RBAC: tem de existir uma atribuição válida cujo papel concede a permissão (senão, nega);
 *  2. qualquer política DENY activa aplicável cuja condição seja verdadeira — ou não avaliável — nega;
 *  3. se existirem políticas ALLOW aplicáveis, pelo menos uma tem de ter a condição verdadeira.
 * As regras de campo vêm das políticas ALLOW que se aplicaram; prevalece a mais restritiva.
 */
export type UnitScope =
  { readonly kind: 'ALL' } | { readonly kind: 'UNITS'; readonly unitIds: readonly string[] }

export function decide(input: {
  permission: string
  grants: readonly Grant[]
  policies: readonly AccessPolicy[]
  context: EvalContext
  /** Unidades a que o actor tem acesso (MembershipScope). Um recurso de outra unidade é recusado. */
  unitScope?: UnitScope
}): Decision {
  const { resource, action } = splitPermission(input.permission)
  const base = { grantedBy: [] as Decision['grantedBy'], policies: [] as Decision['policies'] }
  const deny = (reason: DecisionReason, extra: Partial<Decision> = {}): Decision => ({
    allowed: false,
    reason,
    ...base,
    hiddenFields: [],
    readOnlyFields: [],
    ...extra,
  })

  const candidates = input.grants.filter((g) => g.permissionCode === input.permission)
  if (candidates.length === 0) return deny('NO_PERMISSION')

  const resourceUnit = input.context.resource.unitId
  if (
    typeof resourceUnit === 'string' &&
    input.unitScope?.kind === 'UNITS' &&
    !input.unitScope.unitIds.includes(resourceUnit)
  ) {
    return deny('UNIT_OUT_OF_SCOPE')
  }
  const applicable = candidates.filter((g) => g.unitId === null || g.unitId === resourceUnit)
  if (applicable.length === 0) return deny('UNIT_MISMATCH')
  const grantedBy = [
    ...new Map(
      applicable.map((g) => [g.roleId, { roleId: g.roleId, roleCode: g.roleCode }])
    ).values(),
  ]

  const relevant = input.policies
    .filter((p) => matches(p, resource, action))
    .sort((a, b) => b.priority - a.priority)

  for (const policy of relevant.filter((p) => p.effect === 'DENY')) {
    const holds = conditionHolds(policy.condition, input.context)
    if (holds !== false) {
      return deny(holds === 'ERROR' ? 'POLICY_ERROR' : 'POLICY_DENY', {
        grantedBy,
        policies: [{ id: policy.id, name: policy.name, effect: 'DENY' }],
      })
    }
  }

  const allows = relevant.filter((p) => p.effect === 'ALLOW')
  const matched = allows.filter((p) => conditionHolds(p.condition, input.context) === true)
  if (allows.length > 0 && matched.length === 0) {
    return deny('NO_ALLOW_POLICY_MATCHED', { grantedBy })
  }

  const hidden = new Set<string>()
  const readOnly = new Set<string>()
  for (const policy of matched) {
    for (const rule of policy.fieldRules) {
      const applies = rule.when ? conditionHolds(rule.when, input.context) === true : true
      if (!applies) continue
      ;(rule.mode === 'HIDDEN' ? hidden : readOnly).add(rule.field)
    }
  }
  for (const field of hidden) readOnly.delete(field)

  return {
    allowed: true,
    reason: 'GRANTED',
    grantedBy,
    policies: matched.map((p) => ({ id: p.id, name: p.name, effect: p.effect })),
    hiddenFields: [...hidden].sort(),
    readOnlyFields: [...readOnly].sort(),
  }
}

/** Remove os campos ocultos (API, exportações, pesquisa, auditoria visível). */
export function redactFields<T extends Record<string, unknown>>(
  record: T,
  hiddenFields: readonly string[]
): Partial<T> {
  const hidden = new Set(hiddenFields)
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !hidden.has(key))
  ) as Partial<T>
}

/** Campos de `changes` que não podem ser alterados (ocultos ou só de leitura). */
export function forbiddenChanges(
  changes: Record<string, unknown>,
  decision: Pick<Decision, 'hiddenFields' | 'readOnlyFields'>
): string[] {
  const locked = new Set([...decision.hiddenFields, ...decision.readOnlyFields])
  return Object.keys(changes).filter((field) => locked.has(field))
}
