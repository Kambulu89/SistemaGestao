import type { ErrorDetail } from '#shared/http/api_error'
import type { TenantScope } from '#modules/tenancy/index'
import { costCenterFacts } from '#modules/organization/index'

/** Verificações de referências da entidade legal, partilhadas pelos serviços de contabilidade (6.7+). */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const ISO = /^\d{4}-\d{2}-\d{2}$/
export const CODE = /^[A-Za-z0-9._/-]{1,30}$/
export const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
export const optional = (v: unknown, max: number) => text(v).slice(0, max) || null

export async function legalEntityExists(scope: TenantScope, id: string) {
  if (!UUID.test(id)) return false
  const r = await scope.trx.rawQuery(
    'select 1 from legal_entities where tenant_id = ? and id = ?',
    [scope.context.tenantId, id]
  )
  return r.rows.length > 0
}

/** Diário activo da entidade. */
export async function journalIssue(
  scope: TenantScope,
  legalEntityId: string,
  journalId: unknown,
  path = 'journalId'
): Promise<ErrorDetail | null> {
  const id = text(journalId)
  if (UUID.test(id)) {
    const r = await scope.trx.rawQuery(
      `select 1 from journals where tenant_id = ? and id = ? and legal_entity_id = ? and status = 'ACTIVE'`,
      [scope.context.tenantId, id, legalEntityId]
    )
    if (r.rows.length > 0) return null
  }
  return { path, code: 'NOT_FOUND', message: 'Diário activo da entidade.' }
}

/**
 * Contas movimentáveis e activas do plano activo da entidade. Devolve os problemas por caminho (`paths[i]` para
 * `ids[i]`).
 */
export async function accountIssues(
  scope: TenantScope,
  legalEntityId: string,
  ids: unknown[],
  paths: string[]
): Promise<ErrorDetail[]> {
  const valid = ids.map(text).filter((x) => UUID.test(x))
  const r = valid.length
    ? await scope.trx.rawQuery(
        `select a.id, a.code, a.postable, a.status from accounts a
           join account_charts c on c.tenant_id = a.tenant_id and c.id = a.chart_id
          where a.tenant_id = ? and c.legal_entity_id = ? and c.status = 'ACTIVE' and a.id = any(?::uuid[])`,
        [scope.context.tenantId, legalEntityId, valid]
      )
    : { rows: [] }
  const byId = new Map(
    (r.rows as { id: string; code: string; postable: boolean; status: string }[]).map((a) => [
      a.id,
      a,
    ])
  )
  const issues: ErrorDetail[] = []
  ids.forEach((raw, i) => {
    const a = byId.get(text(raw))
    if (!a)
      issues.push({
        path: paths[i],
        code: 'NOT_FOUND',
        message: 'Conta do plano activo da entidade.',
      })
    else if (!a.postable || a.status !== 'ACTIVE')
      issues.push({
        path: paths[i],
        code: 'NOT_POSTABLE',
        message: `A conta ${a.code} não é movimentável ou está inactiva.`,
      })
  })
  return issues
}

/** Centro de custo activo da entidade (null/vazio é aceite). */
export async function costCenterIssue(
  scope: TenantScope,
  legalEntityId: string,
  raw: unknown,
  path = 'costCenterId'
): Promise<ErrorDetail | null> {
  const id = text(raw)
  if (!id) return null
  const cc = (await costCenterFacts(scope, UUID.test(id) ? [id] : [])).get(id)
  return cc && cc.legalEntityId === legalEntityId && cc.status === 'ACTIVE'
    ? null
    : { path, code: 'NOT_FOUND', message: 'Centro de custo activo desta entidade.' }
}

/** Números e estados dos lançamentos (para mostrar ao lado das ocorrências). */
export async function entryFacts(scope: TenantScope, ids: string[]) {
  if (ids.length === 0)
    return new Map<string, { number: string | null; status: string; reversed: boolean }>()
  const r = await scope.trx.rawQuery(
    `select id, number, status, reversed_by_id is not null as reversed from journal_entries
      where tenant_id = ? and id = any(?::uuid[])`,
    [scope.context.tenantId, [...new Set(ids)]]
  )
  return new Map(
    (r.rows as { id: string; number: string | null; status: string; reversed: boolean }[]).map(
      (x) => [x.id, { number: x.number, status: x.status, reversed: x.reversed }]
    )
  )
}
