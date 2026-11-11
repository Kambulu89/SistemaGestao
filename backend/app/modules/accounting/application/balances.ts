import type { TenantScope } from '#modules/tenancy/index'

/*
 * Leitura de saldos do razão para outros módulos (8.9: reconciliação do inventário com a contabilidade). Só
 * lançamentos lançados (POSTED), na moeda funcional, até à data indicada; uma conta agregadora soma as descendentes.
 */

/** Saldo (débito − crédito) de cada conta, com as descendentes, até `date` (inclusive). */
export async function accountBalancesAt(
  scope: TenantScope,
  legalEntityId: string,
  accountIds: string[],
  date: string
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!accountIds.length) return out
  const r = await scope.trx.rawQuery(
    `with recursive tree as (
        select a.id as root, a.id from accounts a where a.tenant_id = ? and a.id = any(?::uuid[])
        union all
        select t.root, c.id from accounts c join tree t on c.parent_id = t.id where c.tenant_id = ?)
      select t.root, coalesce(sum(l.debit_functional - l.credit_functional), 0)::text as balance
        from tree t
        left join journal_lines l on l.tenant_id = ? and l.account_id = t.id
        left join journal_entries e on e.tenant_id = l.tenant_id and e.id = l.entry_id
       where l.id is null or (e.status = 'POSTED' and e.legal_entity_id = ? and e.entry_date <= ?::date)
       group by t.root`,
    [
      scope.context.tenantId,
      accountIds,
      scope.context.tenantId,
      scope.context.tenantId,
      legalEntityId,
      date,
    ] as never[]
  )
  for (const x of r.rows as any[]) out.set(x.root, x.balance)
  for (const id of accountIds) if (!out.has(id)) out.set(id, '0')
  return out
}

/** Contas activas do plano da entidade legal (para escolher a conta de uma classe). */
export async function accountsOfLegalEntity(scope: TenantScope, legalEntityId: string) {
  const r = await scope.trx.rawQuery(
    `select a.id, a.code, a.name, a.postable from accounts a
       join account_charts c on c.tenant_id = a.tenant_id and c.id = a.chart_id
      where a.tenant_id = ? and c.legal_entity_id = ? and c.status = 'ACTIVE' and a.status = 'ACTIVE'
      order by a.code`,
    [scope.context.tenantId, legalEntityId]
  )
  return (r.rows as any[]).map((a) => ({
    id: a.id as string,
    code: a.code as string,
    name: a.name as string,
    postable: Boolean(a.postable),
  }))
}
