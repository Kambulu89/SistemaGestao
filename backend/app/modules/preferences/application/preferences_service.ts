import { ApiError } from '#shared/http/api_error'
import { runInTenant, type TenantContext } from '#modules/tenancy/index'

/**
 * Preferências de interface do membro em contexto (favoritos, painel). Cada chave tem a sua validação; o valor é
 * pequeno e nunca contém dados de negócio, por isso não vai para a auditoria.
 */
export const PREFERENCE_KEYS = ['favorites', 'dashboard'] as const
export type PreferenceKey = (typeof PREFERENCE_KEYS)[number]

const PATH = /^\/[A-Za-z0-9/_\-.%]{0,199}$/
const WIDGET = /^[a-z][a-z0-9-]{1,39}$/

/** Normaliza e valida o valor de uma chave (null = inválido). */
export function normalizePreference(key: PreferenceKey, value: unknown): unknown {
  if (key === 'favorites') {
    if (!Array.isArray(value) || value.length > 30) return null
    const seen = new Set<string>()
    const out: { path: string; title: string }[] = []
    for (const v of value as any[]) {
      const path = typeof v?.path === 'string' ? v.path.trim() : ''
      const title = typeof v?.title === 'string' ? v.title.trim().slice(0, 120) : ''
      if (!PATH.test(path) || !title || seen.has(path)) return null
      seen.add(path)
      out.push({ path, title })
    }
    return out
  }
  const v = value as any
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const list = (x: unknown) =>
    Array.isArray(x) && x.length <= 30 && x.every((w) => typeof w === 'string' && WIDGET.test(w))
      ? [...new Set(x as string[])]
      : null
  const order = list(v.order ?? [])
  const hidden = list(v.hidden ?? [])
  if (!order || !hidden) return null
  return { order, hidden }
}

export class PreferencesService {
  get(context: TenantContext, key: PreferenceKey) {
    return runInTenant(context, async (scope) => {
      const r = await scope.trx.rawQuery(
        'select value from member_preferences where tenant_id = ? and membership_id = ? and key = ?',
        [context.tenantId, context.membershipId, key]
      )
      return (r.rows[0] as { value: unknown } | undefined)?.value ?? null
    })
  }

  set(context: TenantContext, key: PreferenceKey, value: unknown) {
    const normalized = normalizePreference(key, value)
    if (normalized === null)
      throw ApiError.validation([
        { path: 'value', code: 'INVALID', message: 'Valor inválido para esta preferência.' },
      ])
    return runInTenant(context, async (scope) => {
      await scope.trx.rawQuery(
        `insert into member_preferences (tenant_id, created_by, updated_by, membership_id, key, value)
         values (?, ?, ?, ?, ?, ?::jsonb)
         on conflict (tenant_id, membership_id, key)
         do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by, version = member_preferences.version + 1`,
        [
          context.tenantId,
          context.userId,
          context.userId,
          context.membershipId,
          key,
          JSON.stringify(normalized),
        ]
      )
      return normalized
    })
  }
}
