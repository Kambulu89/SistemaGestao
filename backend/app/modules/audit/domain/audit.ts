/**
 * Evento de auditoria. `action` é estável e pesquisável (`<entidade>.<verbo>`, ex.: `member.suspended`); `changes` só
 * leva os campos alterados (`{ campo: { from, to } }`) e nunca segredos.
 */
export interface AuditInput {
  action: string
  entityType: string
  entityId?: string | null
  changes?: Record<string, { from: unknown; to: unknown }> | null
  metadata?: Record<string, unknown> | null
}

export interface AuditActor {
  tenantId: string
  userId: string | null
  membershipId: string | null
  requestId: string | null
}

const SECRET = /(password|passe|token|secret|hash|cookie|authorization)/i

/** Retira (recursivamente) chaves que possam conter segredos; o valor fica `[REDACTED]`. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SECRET.test(k) ? '[REDACTED]' : redact(v),
      ])
    )
  }
  return value
}

const comparable = (v: unknown) =>
  JSON.stringify(Array.isArray(v) ? [...v].sort() : v instanceof Date ? v.toISOString() : v)

/** Campos que mudaram entre dois estados (só os indicados). Devolve `null` se nada mudou. */
export function diff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
  fields: readonly string[]
): AuditInput['changes'] {
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  for (const field of fields) {
    const from = before ? (before[field] ?? null) : null
    const to = after[field] ?? null
    if (comparable(from) !== comparable(to)) changes[field] = { from, to }
  }
  return Object.keys(changes).length > 0 ? changes : null
}
