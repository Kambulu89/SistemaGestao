import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import {
  crudFind,
  crudInsert,
  crudUpdate,
  type CrudScope,
  type CrudSpec,
  type Row,
} from '#shared/db/tenant_crud'
import type { TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import {
  normalizeContact,
  normalizePartner,
  PARTNER_COLUMNS,
} from '#modules/partners/domain/partners'

/*
 * Terceiros (9.1): contratos usados pelos papéis de negócio (fornecedor; cliente no Prompt 10). Não tem rotas próprias —
 * quem chama (o módulo do papel) decide a permissão e corre na sua transacção; aqui valida-se, grava-se e audita-se.
 */

export const PARTNER_SPEC: CrudSpec = {
  table: 'business_partners',
  columns: PARTNER_COLUMNS,
  searchColumns: ['code', 'name', 'tax_id'],
  orderBy: 'code',
  uniqueErrors: {
    business_partners_code_unique: {
      code: 'CODE_TAKEN',
      message: 'Já existe um terceiro com este código.',
    },
    business_partners_tax_id_unique: {
      code: 'TAX_ID_TAKEN',
      message: 'Já existe um terceiro com este NIF neste país.',
    },
  },
}

const CONTACT_SPEC: CrudSpec = {
  table: 'business_partner_contacts',
  columns: {
    partnerId: 'partner_id',
    name: 'name',
    role: 'role',
    email: 'email',
    phone: 'phone',
    isPrimary: 'is_primary',
    status: 'status',
  },
  searchColumns: ['name'],
  orderBy: 'name',
  uniqueErrors: {},
}

const crud = (scope: TenantScope): CrudScope => ({
  trx: scope.trx,
  tenantId: scope.context.tenantId,
  userId: scope.context.userId,
})
const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
const prefixed = (issues: ErrorDetail[], prefix: string) =>
  issues.map((i) => ({ ...i, path: `${prefix}.${i.path}` }))

function changesOf(before: Row | null, after: Row) {
  const out: Record<string, { from: unknown; to: unknown }> = {}
  for (const k of Object.keys(after))
    if (
      !['id', 'version', 'createdAt', 'updatedAt'].includes(k) &&
      (before?.[k] ?? null) !== (after[k] ?? null)
    )
      out[k] = { from: before?.[k] ?? null, to: after[k] ?? null }
  return out
}

export interface PartnerView {
  id: string
  version: number
  code: string
  name: string
  partnerType: string
  taxId: string | null
  countryCode: string
  email: string | null
  phone: string | null
  website: string | null
  addressLine: string | null
  city: string | null
  province: string | null
  postalCode: string | null
  status: string
  contacts: {
    id: string
    version: number
    name: string
    role: string | null
    email: string | null
    phone: string | null
    isPrimary: boolean
    status: string
  }[]
}

export async function partnerView(scope: TenantScope, id: string): Promise<PartnerView | null> {
  const p = await crudFind(crud(scope), PARTNER_SPEC, id)
  if (!p) return null
  const c = await scope.trx.rawQuery(
    `select id, version, name, role, email, phone, is_primary, status from business_partner_contacts
      where tenant_id = ? and partner_id = ? order by is_primary desc, status, name`,
    [scope.context.tenantId, id]
  )
  return {
    ...(p as any),
    contacts: (c.rows as any[]).map((r) => ({
      id: r.id,
      version: Number(r.version),
      name: r.name,
      role: r.role,
      email: r.email,
      phone: r.phone,
      isPrimary: r.is_primary,
      status: r.status,
    })),
  }
}

/** Valida um terceiro novo (sem gravar), com os caminhos de erro prefixados (ex.: `partner.taxId`). */
export function validatePartner(input: Record<string, unknown>, prefix = 'partner') {
  const { v, issues } = normalizePartner(input, true)
  return { values: v, issues: prefixed(issues, prefix) }
}

export async function createPartner(scope: TenantScope, values: Record<string, unknown>) {
  const row = await crudInsert(crud(scope), PARTNER_SPEC, values)
  await audit(scope, {
    action: 'business_partner.created',
    entityType: 'business_partner',
    entityId: row.id,
    changes: changesOf(null, row),
  })
  return row
}

/** Altera campos do terceiro (versão optimista); devolve se mudou alguma coisa. */
export async function updatePartner(
  scope: TenantScope,
  id: string,
  expectedVersion: number,
  input: Record<string, unknown>,
  prefix = 'partner'
) {
  const { v, issues } = normalizePartner(input, false)
  fail(prefixed(issues, prefix))
  const s = crud(scope)
  const before = await crudFind(s, PARTNER_SPEC, id, true)
  if (!before) throw ApiError.notFound()
  if (Number(before.version) !== expectedVersion)
    throw ApiError.versionConflict(Number(before.version))
  const keys = Object.keys(v).filter((k) => (before[k] ?? null) !== (v[k] ?? null))
  if (!keys.length) return { row: before, changed: [] as string[] }
  const row = await crudUpdate(
    s,
    PARTNER_SPEC,
    id,
    expectedVersion,
    Object.fromEntries(keys.map((k) => [k, v[k]]))
  )
  await audit(scope, {
    action: 'business_partner.updated',
    entityType: 'business_partner',
    entityId: id,
    changes: changesOf(before, row),
  })
  return { row, changed: keys }
}

/** Terceiro com este NIF neste país (para evitar duplicados e reutilizar a ficha noutro papel). */
export async function partnerByTaxId(scope: TenantScope, countryCode: string, taxId: string) {
  const r = await scope.trx.rawQuery(
    `select id from business_partners where tenant_id = ? and country_code = ? and tax_id = ?`,
    [scope.context.tenantId, countryCode.toUpperCase(), taxId.trim().toUpperCase()]
  )
  const id = (r.rows[0] as { id: string } | undefined)?.id
  return id ? partnerView(scope, id) : null
}

async function clearPrimary(scope: TenantScope, partnerId: string, except: string | null) {
  await scope.trx.rawQuery(
    `update business_partner_contacts set is_primary = false, updated_at = now(), updated_by = ?, version = version + 1
      where tenant_id = ? and partner_id = ? and is_primary and id is distinct from ?`,
    [scope.context.userId, scope.context.tenantId, partnerId, except] as never[]
  )
}

export async function addContact(
  scope: TenantScope,
  partnerId: string,
  input: Record<string, unknown>
) {
  const { v, issues } = normalizeContact(input, true)
  fail(issues)
  if (v.isPrimary) await clearPrimary(scope, partnerId, null)
  const row = await crudInsert(crud(scope), CONTACT_SPEC, { ...v, partnerId })
  await audit(scope, {
    action: 'business_partner.contact_added',
    entityType: 'business_partner',
    entityId: partnerId,
    changes: changesOf(null, row),
  })
  return row
}

export async function updateContact(
  scope: TenantScope,
  partnerId: string,
  contactId: string,
  expectedVersion: number,
  input: Record<string, unknown>
) {
  const { v, issues } = normalizeContact(input, false)
  fail(issues)
  const s = crud(scope)
  const before = await crudFind(s, CONTACT_SPEC, contactId, true)
  if (!before || before.partnerId !== partnerId) throw ApiError.notFound()
  if (v.isPrimary === true || (v.status === 'ACTIVE' && before.isPrimary))
    await clearPrimary(scope, partnerId, contactId)
  if (v.status === 'INACTIVE') v.isPrimary = false
  const row = await crudUpdate(s, CONTACT_SPEC, contactId, expectedVersion, v)
  await audit(scope, {
    action: 'business_partner.contact_updated',
    entityType: 'business_partner',
    entityId: partnerId,
    changes: changesOf(before, row),
  })
  return row
}
