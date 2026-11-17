import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import {
  crudFind,
  crudInsert,
  crudUpdate,
  type CrudScope,
  type CrudSpec,
} from '#shared/db/tenant_crud'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { effectivePermissions } from '#modules/rbac/index'
import {
  addContact,
  createPartner,
  partnerByTaxId,
  partnerView,
  updateContact,
  updatePartner,
  validatePartner,
} from '#modules/partners/index'
import { isValidIban, isValidSwift, maskIban, normalizeIban } from '#modules/settings/index'
import {
  CAN_SUBMIT,
  isDate,
  normalizeSupplier,
  qualification,
  reviewIssues,
  SUPPLIER_COLUMNS,
  SUPPLIER_STATUSES,
  SUPPLIER_TYPES,
  type DocumentFact,
  type SupplierStatus,
} from '#modules/procurement/domain/suppliers'

/*
 * Fornecedores (9.1). Permissões no âmbito da empresa: `procurement.suppliers.read` (consultar), `.manage` (ficha,
 * contactos, documentos, contas bancárias, pedir homologação), `.approve` (homologar, recusar, suspender, aprovar
 * contas bancárias — nunca o que a própria pessoa submeteu) e `.bank` (ver os dados bancários por inteiro; sem ela vêm
 * mascarados). Tudo é auditado e o histórico do fornecedor é só de acréscimo; os dados bancários nunca entram inteiros
 * na auditoria nem no histórico.
 */

export const WARNING_DAYS = 30

const SUPPLIER_SPEC: CrudSpec = {
  table: 'suppliers',
  columns: SUPPLIER_COLUMNS,
  searchColumns: [],
  orderBy: 'created_at',
  uniqueErrors: {
    suppliers_partner_unique: {
      code: 'ALREADY_SUPPLIER',
      message: 'Este terceiro já é fornecedor.',
    },
  },
}

const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
const crud = (scope: TenantScope): CrudScope => ({
  trx: scope.trx,
  tenantId: scope.context.tenantId,
  userId: scope.context.userId,
})
const today = () => new Date().toISOString().slice(0, 10)
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const reasonOf = (v: unknown, required: boolean) => {
  const r = text(v)
  if (!r && required) fail([{ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo.' }])
  if (r.length > 500) fail([{ path: 'reason', code: 'LENGTH', message: 'Até 500 caracteres.' }])
  return r || null
}

interface Access {
  read: boolean
  manage: boolean
  approve: boolean
  bank: boolean
}
async function accessOf(scope: TenantScope): Promise<Access> {
  const held = (await effectivePermissions(scope)).tenant
  const manage = held.has('procurement.suppliers.manage')
  const approve = held.has('procurement.suppliers.approve')
  return {
    read: manage || approve || held.has('procurement.suppliers.read'),
    manage,
    approve,
    bank: held.has('procurement.suppliers.bank'),
  }
}
const need = (ok: boolean, message: string) => {
  if (!ok) throw ApiError.forbidden('OUT_OF_SCOPE', message)
}

async function event(
  scope: TenantScope,
  supplierId: string,
  kind: string,
  e: {
    from?: string | null
    to?: string | null
    reason?: string | null
    details?: Record<string, unknown>
  } = {}
) {
  await scope.trx.rawQuery(
    `insert into supplier_events (tenant_id, supplier_id, kind, from_status, to_status, reason, details,
        created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      scope.context.tenantId,
      supplierId,
      kind,
      e.from ?? null,
      e.to ?? null,
      e.reason ?? null,
      e.details ? JSON.stringify(e.details) : null,
      scope.context.userId,
      scope.context.userId,
    ] as never[]
  )
}

async function findSupplier(scope: TenantScope, id: string, lock = false) {
  if (!isUuid(id)) return null
  return crudFind(crud(scope), SUPPLIER_SPEC, id, lock)
}
async function supplierOr404(scope: TenantScope, id: string, lock = false) {
  const s = await findSupplier(scope, id, lock)
  if (!s) throw ApiError.notFound()
  return s
}

async function requiredTypes(scope: TenantScope) {
  const r = await scope.trx.rawQuery(
    `select id, code, name from supplier_document_types
      where tenant_id = ? and required and status = 'ACTIVE' order by code`,
    [scope.context.tenantId]
  )
  return r.rows as { id: string; code: string; name: string }[]
}

async function documentFacts(scope: TenantScope, supplierIds: string[]) {
  if (!supplierIds.length) return new Map<string, DocumentFact[]>()
  const r = await scope.trx.rawQuery(
    `select supplier_id, document_type_id, valid_until::text as valid_until, status from supplier_documents
      where tenant_id = ? and supplier_id = any(?::uuid[])`,
    [scope.context.tenantId, supplierIds] as never[]
  )
  const out = new Map<string, DocumentFact[]>()
  for (const d of r.rows as any[]) {
    const list = out.get(d.supplier_id) ?? []
    list.push({ documentTypeId: d.document_type_id, validUntil: d.valid_until, status: d.status })
    out.set(d.supplier_id, list)
  }
  return out
}

async function qualificationOf(scope: TenantScope, supplierId: string) {
  const docs = (await documentFacts(scope, [supplierId])).get(supplierId) ?? []
  return qualification(await requiredTypes(scope), docs, today(), WARNING_DAYS)
}

const accountView = (a: any, bank: boolean, canDecide: boolean) => ({
  id: a.id as string,
  version: Number(a.version),
  holderName: a.holder_name as string,
  bankName: a.bank_name as string,
  iban: bank ? (a.iban as string | null) : maskIban(a.iban),
  accountNumber: bank
    ? (a.account_number as string | null)
    : a.account_number
      ? `•••• ${String(a.account_number).slice(-4)}`
      : null,
  swiftBic: a.swift_bic as string | null,
  currency: a.currency as string,
  status: a.status as string,
  requestedBy: a.requested_by as string,
  requestedByName: (a.requested_name as string) ?? null,
  decidedBy: (a.decided_by as string) ?? null,
  decidedAt: a.decided_at ? new Date(a.decided_at).toISOString() : null,
  decisionReason: (a.decision_reason as string) ?? null,
  createdAt: new Date(a.created_at).toISOString(),
  masked: !bank,
  /** Pode aprovar ou recusar esta conta: tem `.approve`, está pendente e não foi quem a registou. */
  canDecide: canDecide && a.status === 'PENDING_APPROVAL',
})

/** Ficha completa: terceiro, condições, contas, documentos, homologações, histórico e o que o membro pode fazer. */
async function detail(scope: TenantScope, id: string, access: Access) {
  const s = await supplierOr404(scope, id)
  const t = scope.context.tenantId
  const partner = await partnerView(scope, s.partnerId as string)
  const [accounts, docs, reviews, items, events, criteria, types] = await Promise.all([
    scope.trx.rawQuery(
      `select a.*, u.full_name as requested_name from supplier_bank_accounts a
         left join users u on u.id = a.requested_by
        where a.tenant_id = ? and a.supplier_id = ? order by a.created_at desc`,
      [t, id]
    ),
    scope.trx.rawQuery(
      `select d.id, d.version, d.number, d.issued_on::text as issued_on, d.valid_until::text as valid_until,
          d.attachment_id, d.status, d.inactive_reason, d.created_at, dt.id as type_id, dt.code as type_code,
          dt.name as type_name, dt.required, a.file_name
         from supplier_documents d
         join supplier_document_types dt on dt.tenant_id = d.tenant_id and dt.id = d.document_type_id
         left join attachments a on a.tenant_id = d.tenant_id and a.id = d.attachment_id
        where d.tenant_id = ? and d.supplier_id = ? order by d.status, dt.code, d.valid_until desc nulls first`,
      [t, id]
    ),
    scope.trx.rawQuery(
      `select r.*, su.full_name as submitted_name, du.full_name as decided_name from supplier_reviews r
         left join users su on su.id = r.submitted_by left join users du on du.id = r.decided_by
        where r.tenant_id = ? and r.supplier_id = ? order by r.submitted_at desc`,
      [t, id]
    ),
    scope.trx.rawQuery(
      `select i.* from supplier_review_items i join supplier_reviews r on r.tenant_id = i.tenant_id
          and r.id = i.review_id where i.tenant_id = ? and r.supplier_id = ? order by i.criterion_code`,
      [t, id]
    ),
    scope.trx.rawQuery(
      `select e.kind, e.from_status, e.to_status, e.reason, e.details, e.created_at, u.full_name
         from supplier_events e left join users u on u.id = e.created_by
        where e.tenant_id = ? and e.supplier_id = ? order by e.created_at desc, e.id`,
      [t, id]
    ),
    scope.trx.rawQuery(
      `select id, code, name, description, required from supplier_criteria
        where tenant_id = ? and status = 'ACTIVE' order by code`,
      [t]
    ),
    scope.trx.rawQuery(
      `select id, code, name, required from supplier_document_types
        where tenant_id = ? and status = 'ACTIVE' order by code`,
      [t]
    ),
  ])
  const q = await qualificationOf(scope, id)
  const now = today()
  const me = scope.context.userId
  const pending = (reviews.rows as any[]).find((r) => r.status === 'PENDING')
  return {
    id: s.id,
    version: s.version,
    supplierType: s.supplierType,
    currency: s.currency,
    paymentTermsDays: s.paymentTermsDays,
    paymentMethod: s.paymentMethod,
    leadTimeDays: s.leadTimeDays ?? null,
    minOrderAmount: s.minOrderAmount ?? null,
    incoterm: s.incoterm ?? null,
    notes: s.notes ?? null,
    status: s.status as SupplierStatus,
    approvedAt: s.approvedAt ? new Date(s.approvedAt as string).toISOString() : null,
    createdAt: s.createdAt,
    partner,
    qualification: { ...q, warningDays: WARNING_DAYS },
    bankAccounts: (accounts.rows as any[]).map((a) =>
      accountView(a, access.bank, access.approve && a.requested_by !== me)
    ),
    documents: (docs.rows as any[]).map((d) => ({
      id: d.id as string,
      version: Number(d.version),
      documentType: {
        id: d.type_id as string,
        code: d.type_code as string,
        name: d.type_name as string,
        required: d.required as boolean,
      },
      number: d.number as string | null,
      issuedOn: d.issued_on as string | null,
      validUntil: d.valid_until as string | null,
      attachment: d.attachment_id ? { id: d.attachment_id as string, fileName: d.file_name } : null,
      status: d.status as string,
      inactiveReason: d.inactive_reason as string | null,
      valid: d.status === 'ACTIVE' && (d.valid_until === null || d.valid_until >= now),
      createdAt: new Date(d.created_at).toISOString(),
    })),
    reviews: (reviews.rows as any[]).map((r) => ({
      id: r.id as string,
      status: r.status as string,
      submittedBy: { id: r.submitted_by as string, name: (r.submitted_name as string) ?? null },
      submittedAt: new Date(r.submitted_at).toISOString(),
      notes: r.notes as string | null,
      decidedBy: r.decided_by ? { id: r.decided_by, name: r.decided_name ?? null } : null,
      decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
      decisionReason: r.decision_reason as string | null,
      documents: r.documents,
      items: (items.rows as any[])
        .filter((i) => i.review_id === r.id)
        .map((i) => ({
          criterionId: i.criterion_id as string,
          code: i.criterion_code as string,
          name: i.criterion_name as string,
          required: i.required as boolean,
          result: i.result as string,
          notes: i.notes as string | null,
        })),
    })),
    history: (events.rows as any[]).map((e) => ({
      kind: e.kind as string,
      fromStatus: e.from_status as string | null,
      toStatus: e.to_status as string | null,
      reason: e.reason as string | null,
      details: e.details ?? null,
      at: new Date(e.created_at).toISOString(),
      by: (e.full_name as string) ?? null,
    })),
    criteria: (criteria.rows as any[]).map((c) => ({
      id: c.id as string,
      code: c.code as string,
      name: c.name as string,
      description: c.description as string | null,
      required: c.required as boolean,
    })),
    documentTypes: (types.rows as any[]).map((d) => ({
      id: d.id as string,
      code: d.code as string,
      name: d.name as string,
      required: d.required as boolean,
    })),
    can: {
      manage: access.manage,
      submit: access.manage && CAN_SUBMIT.includes(s.status as SupplierStatus),
      decide: access.approve && !!pending && pending.submitted_by !== me,
      suspend: access.approve && s.status === 'APPROVED',
      approveBank: access.approve,
      seeBank: access.bank,
    },
  }
}

export type SupplierDetail = Awaited<ReturnType<typeof detail>>

/**
 * Contrato para os documentos de compra (9.2+): o fornecedor existe, está homologado e a homologação está válida hoje
 * (documentos obrigatórios em dia). `null` se não existe nesta empresa.
 */
export async function supplierStanding(scope: TenantScope, supplierId: string) {
  const s = await findSupplier(scope, supplierId)
  if (!s) return null
  const q = await qualificationOf(scope, supplierId)
  return {
    id: s.id,
    status: s.status as SupplierStatus,
    currency: s.currency as string,
    approved: s.status === 'APPROVED',
    qualificationValid: q.valid,
    canOrder: s.status === 'APPROVED' && q.valid,
  }
}

export class SupplierService {
  list(
    context: TenantContext,
    f: {
      q?: string
      status?: string
      supplierType?: string
      limit: number
      offset: number
      sort?: { field: string; direction: 'asc' | 'desc' }
    }
  ) {
    return runInTenant(context, async (scope) => {
      need((await accessOf(scope)).read, 'Não pode consultar fornecedores.')
      const where = ['s.tenant_id = ?']
      const params: unknown[] = [context.tenantId]
      if (f.status && (SUPPLIER_STATUSES as readonly string[]).includes(f.status)) {
        where.push('s.status = ?')
        params.push(f.status)
      }
      if (f.supplierType && (SUPPLIER_TYPES as readonly string[]).includes(f.supplierType)) {
        where.push('s.supplier_type = ?')
        params.push(f.supplierType)
      }
      if (f.q) {
        const like = `%${f.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
        where.push(
          `(lower(p.code) like ? or lower(p.name) like ? or lower(coalesce(p.tax_id, '')) like ?)`
        )
        params.push(like, like, like)
      }
      const SORT: Record<string, string> = {
        code: 'p.code',
        name: 'p.name',
        status: 's.status',
        createdAt: 's.created_at',
      }
      const order =
        f.sort && SORT[f.sort.field]
          ? `${SORT[f.sort.field]} ${f.sort.direction === 'desc' ? 'desc' : 'asc'}, s.id`
          : 'p.code, s.id'
      const from = `from suppliers s join business_partners p on p.tenant_id = s.tenant_id and p.id = s.partner_id
        where ${where.join(' and ')}`
      const rows = await scope.trx.rawQuery(
        `select s.id, s.version, s.supplier_type, s.currency, s.payment_terms_days, s.status, s.approved_at,
            s.created_at, p.id as partner_id, p.code, p.name, p.tax_id, p.country_code, p.email, p.phone,
            p.status as partner_status
         ${from} order by ${order} limit ? offset ?`,
        [...params, f.limit, f.offset] as never[]
      )
      const count = await scope.trx.rawQuery(`select count(*)::int as n ${from}`, params as never[])
      const ids = (rows.rows as any[]).map((r) => r.id as string)
      const docs = await documentFacts(scope, ids)
      const required = await requiredTypes(scope)
      const now = today()
      return {
        items: (rows.rows as any[]).map((r) => {
          const q = qualification(required, docs.get(r.id) ?? [], now, WARNING_DAYS)
          return {
            id: r.id as string,
            version: Number(r.version),
            partner: {
              id: r.partner_id as string,
              code: r.code as string,
              name: r.name as string,
              taxId: r.tax_id as string | null,
              countryCode: r.country_code as string,
              email: r.email as string | null,
              phone: r.phone as string | null,
              status: r.partner_status as string,
            },
            supplierType: r.supplier_type as string,
            currency: r.currency as string,
            paymentTermsDays: Number(r.payment_terms_days),
            status: r.status as SupplierStatus,
            approvedAt: r.approved_at ? new Date(r.approved_at).toISOString() : null,
            qualificationValid: q.valid,
            qualificationExpiresOn: q.expiresOn,
            createdAt: new Date(r.created_at).toISOString(),
          }
        }),
        total: Number((count.rows[0] as { n: number }).n),
      }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const access = await accessOf(scope)
      need(access.read, 'Não pode consultar fornecedores.')
      return detail(scope, id, access)
    })
  }

  /** Terceiro com este NIF (para reutilizar a ficha de um cliente ou evitar duplicados). */
  lookup(context: TenantContext, countryCode: string, taxId: string) {
    return runInTenant(context, async (scope) => {
      need((await accessOf(scope)).manage, 'Não pode gerir fornecedores.')
      const partner = await partnerByTaxId(scope, countryCode, taxId)
      if (!partner) return { partner: null, supplierId: null }
      const r = await scope.trx.rawQuery(
        'select id from suppliers where tenant_id = ? and partner_id = ?',
        [context.tenantId, partner.id]
      )
      return {
        partner: { id: partner.id, code: partner.code, name: partner.name, taxId: partner.taxId },
        supplierId: (r.rows[0] as { id: string } | undefined)?.id ?? null,
      }
    })
  }

  /**
   * Novo fornecedor: sobre um terceiro existente (`partnerId`, ex.: já é cliente) ou com a ficha do terceiro nova
   * (`partner`). Fica em rascunho.
   */
  create(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      need((await accessOf(scope)).manage, 'Não pode gerir fornecedores.')
      const { v, issues } = normalizeSupplier(input, true)
      let partnerId: string | null = null
      let partnerValues: Record<string, unknown> | null = null
      if (input.partnerId !== undefined && input.partnerId !== null) {
        if (!isUuid(input.partnerId) || !(await partnerView(scope, input.partnerId)))
          issues.push({ path: 'partnerId', code: 'NOT_FOUND', message: 'Terceiro inexistente.' })
        else partnerId = input.partnerId
      } else {
        const p = validatePartner(
          (input.partner && typeof input.partner === 'object' ? input.partner : {}) as Record<
            string,
            unknown
          >
        )
        issues.push(...p.issues)
        partnerValues = p.values
        if (!issues.length && p.values.taxId) {
          const same = await partnerByTaxId(
            scope,
            p.values.countryCode as string,
            p.values.taxId as string
          )
          if (same)
            throw new ApiError(
              409,
              'TAX_ID_TAKEN',
              `Já existe o terceiro ${same.code} — ${same.name} com este NIF; use-o.`,
              [{ path: 'partner.taxId', code: 'TAX_ID_TAKEN', message: same.id }]
            )
        }
      }
      fail(issues)
      if (partnerValues) partnerId = (await createPartner(scope, partnerValues)).id
      const row = await crudInsert(crud(scope), SUPPLIER_SPEC, {
        ...v,
        partnerId,
        status: 'DRAFT',
      })
      await event(scope, row.id, 'CREATED', { to: 'DRAFT' })
      await audit(scope, {
        action: 'supplier.created',
        entityType: 'supplier',
        entityId: row.id,
        changes: Object.fromEntries(
          Object.entries(row)
            .filter(([k]) => !['id', 'version', 'createdAt', 'updatedAt'].includes(k))
            .map(([k, val]) => [k, { from: null, to: val ?? null }])
        ),
      })
      return detail(scope, row.id, await accessOf(scope))
    })
  }

  /**
   * Altera condições e/ou a ficha do terceiro. Num fornecedor homologado, o NIF e o país não mudam (a homologação foi
   * feita a essa identidade).
   */
  update(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const access = await accessOf(scope)
      need(access.manage, 'Não pode gerir fornecedores.')
      const s = await supplierOr404(scope, id, true)
      if (Number(s.version) !== Number(input.expectedVersion))
        throw ApiError.versionConflict(Number(s.version))
      const { v, issues } = normalizeSupplier(input, false)
      fail(issues)
      const partnerInput =
        input.partner && typeof input.partner === 'object'
          ? (input.partner as Record<string, unknown>)
          : null
      if (partnerInput) {
        if (
          ['APPROVED', 'PENDING_APPROVAL'].includes(s.status as string) &&
          ('taxId' in partnerInput || 'countryCode' in partnerInput)
        ) {
          const current = (await partnerView(scope, s.partnerId as string))!
          const nextTax =
            'taxId' in partnerInput
              ? String(partnerInput.taxId ?? '')
                  .trim()
                  .toUpperCase() || null
              : current.taxId
          const nextCountry =
            'countryCode' in partnerInput
              ? String(partnerInput.countryCode ?? '')
                  .trim()
                  .toUpperCase()
              : current.countryCode
          if (nextTax !== current.taxId || nextCountry !== current.countryCode)
            fail([
              {
                path: 'partner.taxId',
                code: 'FIXED',
                message: 'O NIF e o país de um fornecedor homologado ou em aprovação não mudam.',
              },
            ])
        }
        const { expectedVersion, ...rest } = partnerInput
        await updatePartner(scope, s.partnerId as string, Number(expectedVersion), rest)
      }
      const keys = Object.keys(v).filter((k) => String(s[k] ?? '') !== String(v[k] ?? ''))
      if (keys.length) {
        const row = await crudUpdate(
          crud(scope),
          SUPPLIER_SPEC,
          id,
          Number(s.version),
          Object.fromEntries(keys.map((k) => [k, v[k]]))
        )
        await audit(scope, {
          action: 'supplier.updated',
          entityType: 'supplier',
          entityId: id,
          changes: Object.fromEntries(
            keys.map((k) => [k, { from: s[k] ?? null, to: row[k] ?? null }])
          ),
        })
        await event(scope, id, 'UPDATED', { details: { fields: keys } })
      } else if (partnerInput) await event(scope, id, 'PARTNER_UPDATED')
      return detail(scope, id, access)
    })
  }

  addContact(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const access = await accessOf(scope)
      need(access.manage, 'Não pode gerir fornecedores.')
      const s = await supplierOr404(scope, id)
      await addContact(scope, s.partnerId as string, input)
      return detail(scope, id, access)
    })
  }

  updateContact(
    context: TenantContext,
    id: string,
    contactId: string,
    input: Record<string, unknown>
  ) {
    return runInTenant(context, async (scope) => {
      const access = await accessOf(scope)
      need(access.manage, 'Não pode gerir fornecedores.')
      const s = await supplierOr404(scope, id)
      if (!isUuid(contactId)) throw ApiError.notFound()
      const { expectedVersion, ...rest } = input
      await updateContact(scope, s.partnerId as string, contactId, Number(expectedVersion), rest)
      return detail(scope, id, access)
    })
  }

  /** Conta bancária nova: fica pendente até outra pessoa com `.approve` a aprovar. */
  addBankAccount(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const access = await accessOf(scope)
      need(access.manage, 'Não pode gerir fornecedores.')
      const s = await supplierOr404(scope, id)
      const issues: ErrorDetail[] = []
      const holder = text(input.holderName)
      const bankName = text(input.bankName)
      if (holder.length < 2 || holder.length > 200)
        issues.push({ path: 'holderName', code: 'LENGTH', message: 'Titular: 2 a 200 caracteres.' })
      if (bankName.length < 2 || bankName.length > 160)
        issues.push({ path: 'bankName', code: 'LENGTH', message: 'Banco: 2 a 160 caracteres.' })
      const iban = text(input.iban) ? normalizeIban(text(input.iban)) : null
      const account = text(input.accountNumber) || null
      if (!iban && !account)
        issues.push({
          path: 'iban',
          code: 'REQUIRED',
          message: 'Indique o IBAN ou o número de conta.',
        })
      if (iban && !isValidIban(iban))
        issues.push({
          path: 'iban',
          code: 'INVALID',
          message: 'IBAN inválido (dígitos de controlo).',
        })
      if (account && (account.length > 40 || !/^[A-Za-z0-9 .-]+$/.test(account)))
        issues.push({
          path: 'accountNumber',
          code: 'INVALID',
          message: 'Número de conta inválido.',
        })
      const swift = text(input.swiftBic).toUpperCase() || null
      if (swift && !isValidSwift(swift))
        issues.push({
          path: 'swiftBic',
          code: 'INVALID',
          message: 'SWIFT/BIC: 8 ou 11 caracteres.',
        })
      const currency = text(input.currency).toUpperCase() || (s.currency as string)
      if (!/^[A-Z]{3}$/.test(currency))
        issues.push({
          path: 'currency',
          code: 'INVALID',
          message: 'Moeda: código ISO de 3 letras.',
        })
      fail(issues)
      await scope.trx.rawQuery('savepoint bank_insert')
      let accountId: string
      try {
        const r = await scope.trx.rawQuery(
          `insert into supplier_bank_accounts (tenant_id, supplier_id, holder_name, bank_name, iban, account_number,
              swift_bic, currency, status, requested_by, created_by, updated_by)
           values (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_APPROVAL', ?, ?, ?) returning id`,
          [
            context.tenantId,
            id,
            holder,
            bankName,
            iban,
            account,
            swift,
            currency,
            context.userId,
            context.userId,
            context.userId,
          ] as never[]
        )
        accountId = (r.rows[0] as { id: string }).id
        await scope.trx.rawQuery('release savepoint bank_insert')
      } catch (error) {
        await scope.trx.rawQuery('rollback to savepoint bank_insert')
        if (String((error as Error).message).includes('supplier_bank_accounts_iban_unique'))
          throw ApiError.conflict('IBAN_EXISTS', 'Este IBAN já está registado neste fornecedor.')
        throw error
      }
      const masked = maskIban(iban) ?? `•••• ${account!.slice(-4)}`
      await event(scope, id, 'BANK_ACCOUNT_REQUESTED', { details: { account: masked, bankName } })
      await audit(scope, {
        action: 'supplier.bank_account_requested',
        entityType: 'supplier',
        entityId: id,
        changes: {
          bankAccount: { from: null, to: `${bankName} ${masked}` },
          accountId: { from: null, to: accountId },
        },
      })
      return detail(scope, id, access)
    })
  }

  /** Aprovar, recusar (com motivo) ou desactivar (com motivo) uma conta bancária. */
  bankAccountAction(
    context: TenantContext,
    accountId: string,
    action: 'approve' | 'reject' | 'deactivate',
    input: Record<string, unknown>
  ) {
    return runInTenant(context, async (scope) => {
      const access = await accessOf(scope)
      if (action === 'deactivate') need(access.manage, 'Não pode gerir fornecedores.')
      else need(access.approve, 'Não pode aprovar dados bancários de fornecedores.')
      if (!isUuid(accountId)) throw ApiError.notFound()
      const r = await scope.trx.rawQuery(
        `select * from supplier_bank_accounts where tenant_id = ? and id = ? for update`,
        [context.tenantId, accountId]
      )
      const a = r.rows[0] as any
      if (!a) throw ApiError.notFound()
      if (Number(a.version) !== Number(input.expectedVersion))
        throw ApiError.versionConflict(Number(a.version))
      const reason = reasonOf(input.reason, action !== 'approve')
      const allowed =
        action === 'deactivate' ? ['PENDING_APPROVAL', 'ACTIVE'] : ['PENDING_APPROVAL']
      if (!allowed.includes(a.status))
        throw ApiError.conflict('INVALID_STATE', `Não é possível nesta fase (${a.status}).`)
      if (action !== 'deactivate' && a.requested_by === context.userId)
        throw ApiError.forbidden(
          'SELF_APPROVAL',
          'Quem registou os dados bancários não os pode aprovar.'
        )
      const to = { approve: 'ACTIVE', reject: 'REJECTED', deactivate: 'INACTIVE' }[action]
      const decided = action !== 'deactivate'
      await scope.trx.rawQuery(
        `update supplier_bank_accounts set status = ?, decision_reason = coalesce(?, decision_reason),
            decided_by = case when ? then ? else decided_by end,
            decided_at = case when ? then now() else decided_at end,
            updated_by = ?, updated_at = now(), version = version + 1
          where tenant_id = ? and id = ?`,
        [
          to,
          reason,
          decided,
          context.userId,
          decided,
          context.userId,
          context.tenantId,
          accountId,
        ] as never[]
      )
      const masked = maskIban(a.iban) ?? `•••• ${String(a.account_number).slice(-4)}`
      const kind = {
        approve: 'BANK_ACCOUNT_APPROVED',
        reject: 'BANK_ACCOUNT_REJECTED',
        deactivate: 'BANK_ACCOUNT_DEACTIVATED',
      }[action]
      await event(scope, a.supplier_id, kind, {
        reason,
        details: { account: masked, bankName: a.bank_name },
      })
      await audit(scope, {
        action: `supplier.bank_account_${{ approve: 'approved', reject: 'rejected', deactivate: 'deactivated' }[action]}`,
        entityType: 'supplier',
        entityId: a.supplier_id,
        changes: { accountId: { from: accountId, to: accountId }, status: { from: a.status, to } },
      })
      return detail(scope, a.supplier_id, access)
    })
  }

  /** Documento entregue (certidão, alvará…): tipo activo, datas coerentes e, opcionalmente, o anexo do fornecedor. */
  addDocument(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const access = await accessOf(scope)
      need(access.manage, 'Não pode gerir fornecedores.')
      await supplierOr404(scope, id)
      const t = context.tenantId
      const issues: ErrorDetail[] = []
      const typeId = input.documentTypeId
      if (!isUuid(typeId))
        issues.push({ path: 'documentTypeId', code: 'REQUIRED', message: 'Tipo de documento.' })
      else {
        const dt = await scope.trx.rawQuery(
          `select status from supplier_document_types where tenant_id = ? and id = ?`,
          [t, typeId]
        )
        if ((dt.rows[0] as any)?.status !== 'ACTIVE')
          issues.push({
            path: 'documentTypeId',
            code: 'NOT_FOUND',
            message: 'Tipo inexistente ou inactivo.',
          })
      }
      const number = text(input.number) || null
      if (number && number.length > 60)
        issues.push({ path: 'number', code: 'LENGTH', message: 'Até 60 caracteres.' })
      const issuedOn = input.issuedOn ? input.issuedOn : null
      const validUntil = input.validUntil ? input.validUntil : null
      if (issuedOn !== null && !isDate(issuedOn))
        issues.push({ path: 'issuedOn', code: 'INVALID', message: 'Data AAAA-MM-DD.' })
      if (validUntil !== null && !isDate(validUntil))
        issues.push({ path: 'validUntil', code: 'INVALID', message: 'Data AAAA-MM-DD.' })
      if (isDate(issuedOn) && isDate(validUntil) && validUntil < issuedOn)
        issues.push({
          path: 'validUntil',
          code: 'INVALID',
          message: 'A validade é anterior à emissão.',
        })
      if (isDate(issuedOn) && issuedOn > today())
        issues.push({
          path: 'issuedOn',
          code: 'INVALID',
          message: 'A emissão não pode ser futura.',
        })
      let attachmentId: string | null = null
      if (input.attachmentId) {
        const ok =
          isUuid(input.attachmentId) &&
          (
            await scope.trx.rawQuery(
              `select 1 from attachments where tenant_id = ? and id = ? and subject_type = 'supplier'
                 and subject_id = ? and status = 'ACTIVE'`,
              [t, input.attachmentId, id]
            )
          ).rows.length > 0
        if (!ok)
          issues.push({
            path: 'attachmentId',
            code: 'NOT_FOUND',
            message: 'O anexo tem de ser deste fornecedor.',
          })
        else attachmentId = input.attachmentId as string
      }
      fail(issues)
      const r = await scope.trx.rawQuery(
        `insert into supplier_documents (tenant_id, supplier_id, document_type_id, number, issued_on, valid_until,
            attachment_id, created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          t,
          id,
          typeId,
          number,
          issuedOn,
          validUntil,
          attachmentId,
          context.userId,
          context.userId,
        ] as never[]
      )
      const docId = (r.rows[0] as { id: string }).id
      await event(scope, id, 'DOCUMENT_ADDED', {
        details: { documentId: docId, number, validUntil },
      })
      await audit(scope, {
        action: 'supplier.document_added',
        entityType: 'supplier',
        entityId: id,
        changes: {
          documentId: { from: null, to: docId },
          number: { from: null, to: number },
          validUntil: { from: null, to: validUntil },
        },
      })
      return detail(scope, id, access)
    })
  }

  deactivateDocument(context: TenantContext, documentId: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const access = await accessOf(scope)
      need(access.manage, 'Não pode gerir fornecedores.')
      if (!isUuid(documentId)) throw ApiError.notFound()
      const reason = reasonOf(input.reason, true)
      const r = await scope.trx.rawQuery(
        `select id, supplier_id, version, status from supplier_documents where tenant_id = ? and id = ? for update`,
        [context.tenantId, documentId]
      )
      const d = r.rows[0] as any
      if (!d) throw ApiError.notFound()
      if (Number(d.version) !== Number(input.expectedVersion))
        throw ApiError.versionConflict(Number(d.version))
      if (d.status !== 'ACTIVE')
        throw ApiError.conflict('INVALID_STATE', 'O documento já está inactivo.')
      await scope.trx.rawQuery(
        `update supplier_documents set status = 'INACTIVE', inactive_reason = ?, updated_by = ?, updated_at = now(),
            version = version + 1 where tenant_id = ? and id = ?`,
        [reason, context.userId, context.tenantId, documentId] as never[]
      )
      await event(scope, d.supplier_id, 'DOCUMENT_DEACTIVATED', { reason, details: { documentId } })
      await audit(scope, {
        action: 'supplier.document_deactivated',
        entityType: 'supplier',
        entityId: d.supplier_id,
        changes: {
          documentId: { from: documentId, to: documentId },
          status: { from: 'ACTIVE', to: 'INACTIVE' },
        },
      })
      return detail(scope, d.supplier_id, access)
    })
  }

  /** Pedido de homologação: critérios avaliados e documentos obrigatórios em dia; quem submete não decide. */
  submit(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const access = await accessOf(scope)
      need(access.manage, 'Não pode gerir fornecedores.')
      const s = await supplierOr404(scope, id, true)
      if (Number(s.version) !== Number(input.expectedVersion))
        throw ApiError.versionConflict(Number(s.version))
      if (!CAN_SUBMIT.includes(s.status as SupplierStatus))
        throw ApiError.conflict('INVALID_STATE', `Não é possível pedir homologação (${s.status}).`)
      const partner = (await partnerView(scope, s.partnerId as string))!
      if (partner.status !== 'ACTIVE')
        throw ApiError.conflict('INACTIVE_PARTNER', 'O terceiro está inactivo.')
      const crit = await scope.trx.rawQuery(
        `select id, code, name, required from supplier_criteria where tenant_id = ? and status = 'ACTIVE' order by code`,
        [context.tenantId]
      )
      const criteria = crit.rows as { id: string; code: string; name: string; required: boolean }[]
      const items = (Array.isArray(input.items) ? input.items : []).map((i: any) => ({
        criterionId: String(i?.criterionId ?? ''),
        result: String(i?.result ?? ''),
        notes:
          typeof i?.notes === 'string' && i.notes.trim() ? i.notes.trim().slice(0, 1000) : null,
      }))
      fail(reviewIssues(criteria, items))
      const q = await qualificationOf(scope, id)
      if (!q.valid)
        throw new ApiError(
          409,
          'NOT_QUALIFIED',
          'Faltam documentos obrigatórios ou estão fora de validade.',
          [
            ...q.missing.map((c) => ({ path: 'documents', code: 'MISSING', message: c })),
            ...q.expired.map((c) => ({ path: 'documents', code: 'EXPIRED', message: c })),
          ]
        )
      const notes = text(input.notes).slice(0, 2000) || null
      const docs = await scope.trx.rawQuery(
        `select d.id, dt.code, d.number, d.valid_until::text as valid_until from supplier_documents d
           join supplier_document_types dt on dt.tenant_id = d.tenant_id and dt.id = d.document_type_id
          where d.tenant_id = ? and d.supplier_id = ? and d.status = 'ACTIVE'
            and (d.valid_until is null or d.valid_until >= current_date) order by dt.code`,
        [context.tenantId, id]
      )
      const rv = await scope.trx.rawQuery(
        `insert into supplier_reviews (tenant_id, supplier_id, status, submitted_by, submitted_at, notes, documents,
            created_by, updated_by) values (?, ?, 'PENDING', ?, now(), ?, ?, ?, ?) returning id`,
        [
          context.tenantId,
          id,
          context.userId,
          notes,
          JSON.stringify(docs.rows),
          context.userId,
          context.userId,
        ] as never[]
      )
      const reviewId = (rv.rows[0] as { id: string }).id
      for (const i of items) {
        const c = criteria.find((x) => x.id === i.criterionId)!
        await scope.trx.rawQuery(
          `insert into supplier_review_items (tenant_id, review_id, criterion_id, criterion_code, criterion_name,
              required, result, notes, created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            context.tenantId,
            reviewId,
            c.id,
            c.code,
            c.name,
            c.required,
            i.result,
            i.notes,
            context.userId,
            context.userId,
          ] as never[]
        )
      }
      await crudUpdate(crud(scope), SUPPLIER_SPEC, id, Number(s.version), {
        status: 'PENDING_APPROVAL',
      })
      await event(scope, id, 'SUBMITTED', {
        from: s.status as string,
        to: 'PENDING_APPROVAL',
        details: { reviewId },
      })
      await audit(scope, {
        action: 'supplier.submitted',
        entityType: 'supplier',
        entityId: id,
        changes: { status: { from: s.status, to: 'PENDING_APPROVAL' } },
      })
      return detail(scope, id, access)
    })
  }

  /** Homologar ou recusar o pedido pendente (outra pessoa, com `.approve`). */
  decide(
    context: TenantContext,
    id: string,
    decision: 'approve' | 'reject',
    input: Record<string, unknown>
  ) {
    return runInTenant(context, async (scope) => {
      const access = await accessOf(scope)
      need(access.approve, 'Não pode homologar fornecedores.')
      const s = await supplierOr404(scope, id, true)
      if (Number(s.version) !== Number(input.expectedVersion))
        throw ApiError.versionConflict(Number(s.version))
      const reason = reasonOf(input.reason, decision === 'reject')
      const r = await scope.trx.rawQuery(
        `select id, submitted_by from supplier_reviews where tenant_id = ? and supplier_id = ? and status = 'PENDING'
          for update`,
        [context.tenantId, id]
      )
      const review = r.rows[0] as { id: string; submitted_by: string } | undefined
      if (s.status !== 'PENDING_APPROVAL' || !review)
        throw ApiError.conflict('INVALID_STATE', 'Não há pedido de homologação pendente.')
      if (review.submitted_by === context.userId)
        throw ApiError.forbidden('SELF_APPROVAL', 'Quem pediu a homologação não a pode decidir.')
      if (decision === 'approve') {
        const q = await qualificationOf(scope, id)
        if (!q.valid)
          throw new ApiError(
            409,
            'NOT_QUALIFIED',
            'Entretanto caducou ou foi desactivado um documento obrigatório.',
            [
              ...q.missing.map((c) => ({ path: 'documents', code: 'MISSING', message: c })),
              ...q.expired.map((c) => ({ path: 'documents', code: 'EXPIRED', message: c })),
            ]
          )
      }
      const to = decision === 'approve' ? 'APPROVED' : 'REJECTED'
      await scope.trx.rawQuery(
        `update supplier_reviews set status = ?, decided_by = ?, decided_at = now(), decision_reason = ?,
            updated_by = ?, updated_at = now(), version = version + 1 where tenant_id = ? and id = ?`,
        [to, context.userId, reason, context.userId, context.tenantId, review.id] as never[]
      )
      await crudUpdate(crud(scope), SUPPLIER_SPEC, id, Number(s.version), {
        status: to,
        ...(decision === 'approve' ? { approvedAt: new Date() } : {}),
      })
      await event(scope, id, decision === 'approve' ? 'APPROVED' : 'REJECTED', {
        from: 'PENDING_APPROVAL',
        to,
        reason,
        details: { reviewId: review.id },
      })
      await audit(scope, {
        action: `supplier.${decision === 'approve' ? 'approved' : 'rejected'}`,
        entityType: 'supplier',
        entityId: id,
        changes: { status: { from: 'PENDING_APPROVAL', to } },
      })
      return detail(scope, id, access)
    })
  }

  /** Suspender um fornecedor homologado (com motivo); volta por um novo pedido de homologação. */
  suspend(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const access = await accessOf(scope)
      need(access.approve, 'Não pode suspender fornecedores.')
      const s = await supplierOr404(scope, id, true)
      if (Number(s.version) !== Number(input.expectedVersion))
        throw ApiError.versionConflict(Number(s.version))
      const reason = reasonOf(input.reason, true)
      if (s.status !== 'APPROVED')
        throw ApiError.conflict('INVALID_STATE', 'Só se suspende um fornecedor homologado.')
      await crudUpdate(crud(scope), SUPPLIER_SPEC, id, Number(s.version), { status: 'SUSPENDED' })
      await event(scope, id, 'SUSPENDED', { from: 'APPROVED', to: 'SUSPENDED', reason })
      await audit(scope, {
        action: 'supplier.suspended',
        entityType: 'supplier',
        entityId: id,
        changes: { status: { from: 'APPROVED', to: 'SUSPENDED' } },
      })
      return detail(scope, id, access)
    })
  }
}

/** Existe nesta empresa (para os anexos do fornecedor). */
export async function supplierExists(scope: TenantScope, id: string) {
  return !!(await findSupplier(scope, id))
}
