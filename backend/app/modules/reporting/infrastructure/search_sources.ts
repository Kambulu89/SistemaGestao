import { LucidTenantScope, type TenantScope } from '#core/tenancy/index'
import type { SearchItem, SearchSource } from '#modules/reporting/application/ports'

type Bind = never[]
const tenantOf = (scope: TenantScope) => (scope as LucidTenantScope).context.tenantId
async function rows<T>(scope: TenantScope, sql: string, bindings: unknown[]): Promise<T[]> {
  const result = await (scope as LucidTenantScope).trx.rawQuery(sql, bindings as Bind)
  return result.rows as T[]
}

const page = (items: SearchItem[], ids: string[], limit: number) => ({
  items,
  next: ids.length === limit ? (ids[ids.length - 1] as string) : null,
})

/** Percurso de leitura dos clientes (código e nome da Party). */
export async function scanCustomers(scope: TenantScope, after: string | null, limit: number) {
  const found = await rows<{ id: string; code: string; display_name: string; status: string }>(
    scope,
    `select c.id, c.code, p.display_name, c.status from customers c
       join parties p on p.tenant_id = c.tenant_id and p.id = c.party_id
      where c.tenant_id = ? and (?::uuid is null or c.id > ?::uuid) order by c.id limit ?`,
    [tenantOf(scope), after, after, limit]
  )
  return page(
    found.map((r) => ({
      resourceId: r.id,
      title: `${r.code} — ${r.display_name}`,
      text: `${r.code} ${r.display_name} ${r.status}`,
    })),
    found.map((r) => r.id),
    limit
  )
}

export async function scanInvoices(scope: TenantScope, after: string | null, limit: number) {
  const found = await rows<{ id: string; number: string; name: string | null; currency: string }>(
    scope,
    `select i.id, i.number, i.customer_snapshot ->> 'name' as name, i.currency from invoices i
      where i.tenant_id = ? and i.status in ('ISSUED', 'CREDITED') and (?::uuid is null or i.id > ?::uuid)
      order by i.id limit ?`,
    [tenantOf(scope), after, after, limit]
  )
  return page(
    found.map((r) => ({
      resourceId: r.id,
      title: `Factura ${r.number}`,
      text: `Factura ${r.number} ${r.name ?? ''} ${r.currency}`,
    })),
    found.map((r) => r.id),
    limit
  )
}

/** Documentos: título, categoria e nome do ficheiro corrente; o dono guarda-se para a pesquisa o saber. */
export async function scanDocuments(scope: TenantScope, after: string | null, limit: number) {
  const found = await rows<{
    id: string
    title: string
    category_code: string
    file_name: string | null
    owner_membership_id: string
  }>(
    scope,
    `select d.id, d.title, d.category_code, a.original_name as file_name, d.owner_membership_id
       from documents d
       left join document_versions v on v.tenant_id = d.tenant_id and v.id = d.current_version_id
       left join attachments a on a.tenant_id = v.tenant_id and a.id = v.attachment_id
      where d.tenant_id = ? and d.status = 'ACTIVE' and (?::uuid is null or d.id > ?::uuid)
      order by d.id limit ?`,
    [tenantOf(scope), after, after, limit]
  )
  return page(
    found.map((r) => ({
      resourceId: r.id,
      title: r.title,
      text: `${r.title} ${r.category_code} ${r.file_name ?? ''}`,
      ownerMembershipId: r.owner_membership_id,
    })),
    found.map((r) => r.id),
    limit
  )
}

export type { SearchSource }
