import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
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
import {
  type AddressKind,
  CUSTOMER_STATUSES,
  type CustomerStatus,
  type CustomerVersionData,
  normalizeAddress,
  normalizeCreditLimit,
  normalizeCustomer,
  normalizeSegment,
  normalizeStatusChange,
  versionHash,
} from '#modules/sales/domain/customers'

/*
 * Clientes (10.1). O cliente é da empresa toda (como o fornecedor): `sales.customers.read`, `.manage` (ficha,
 * condições, moradas, contactos, estado) e `.credit` (limite de crédito — separado de quem vende). Segmentos com
 * `sales.settings`. A identidade é do terceiro (`partners`), partilhada com o fornecedor; os documentos de venda usam
 * `customerSnapshot`, que devolve (e cria, se a identidade mudou) a versão imutável dos dados fiscais.
 */

const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
interface Access {
  read: boolean
  manage: boolean
  credit: boolean
  settings: boolean
}
async function accessOf(scope: TenantScope): Promise<Access> {
  const held = (await effectivePermissions(scope)).tenant
  const manage = held.has('sales.customers.manage')
  const credit = held.has('sales.customers.credit')
  return {
    read: manage || credit || held.has('sales.customers.read'),
    manage,
    credit,
    settings: held.has('sales.settings'),
  }
}
const need = (ok: boolean, message: string) => {
  if (!ok) throw ApiError.forbidden('OUT_OF_SCOPE', message)
}
const versionCheck = (row: any, expected: unknown) => {
  if (Number(row.version) !== Number(expected)) throw ApiError.versionConflict(Number(row.version))
}
const money = (v: unknown) => (v === null || v === undefined ? null : Number(v).toFixed(2))

async function event(
  scope: TenantScope,
  customerId: string,
  kind: string,
  e: {
    from?: string | null
    to?: string | null
    reason?: string | null
    details?: Record<string, unknown>
  } = {}
) {
  await scope.trx.rawQuery(
    `insert into customer_events (tenant_id, customer_id, kind, from_status, to_status, reason, details, created_by,
        updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      scope.context.tenantId,
      customerId,
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

async function load(scope: TenantScope, id: string, lock = false) {
  if (!isUuid(id)) throw ApiError.notFound()
  const c = (
    await scope.trx.rawQuery(
      `select * from customers where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
      [scope.context.tenantId, id]
    )
  ).rows[0] as any
  if (!c) throw ApiError.notFound()
  return c
}

async function segmentOk(scope: TenantScope, id: unknown, issues: ErrorDetail[]) {
  if (id === null || id === undefined) return
  const s = isUuid(id)
    ? ((
        await scope.trx.rawQuery(
          `select status from customer_segments where tenant_id = ? and id = ?`,
          [scope.context.tenantId, id]
        )
      ).rows[0] as any)
    : null
  if (!s || s.status !== 'ACTIVE')
    issues.push({ path: 'segmentId', code: 'NOT_FOUND', message: 'Segmento activo inexistente.' })
}

/** Dados actuais para a versão: identidade do terceiro e morada de facturação por omissão (ou a do terceiro). */
async function currentVersionData(scope: TenantScope, c: any): Promise<CustomerVersionData> {
  const p = (await partnerView(scope, c.partner_id))!
  const a = (
    await scope.trx.rawQuery(
      `select * from customer_addresses where tenant_id = ? and customer_id = ? and kind = 'BILLING' and is_default`,
      [scope.context.tenantId, c.id]
    )
  ).rows[0] as any
  return {
    code: p.code,
    name: p.name,
    partnerType: p.partnerType,
    taxId: p.taxId,
    countryCode: p.countryCode,
    email: p.email,
    billingAddress: a
      ? {
          addressLine: a.address_line,
          city: a.city,
          municipality: a.municipality,
          province: a.province,
          postalCode: a.postal_code,
          countryCode: String(a.country_code).trim(),
        }
      : {
          addressLine: p.addressLine,
          city: p.city,
          municipality: null,
          province: p.province,
          postalCode: p.postalCode,
          countryCode: p.countryCode,
        },
  }
}

/** Grava uma versão nova se os dados mudaram desde a última; devolve a versão em vigor. */
async function syncVersion(scope: TenantScope, c: any) {
  const t = scope.context.tenantId
  await scope.trx.rawQuery('select pg_advisory_xact_lock(hashtext(?))', [
    `customer-version:${t}:${c.id}`,
  ])
  const data = await currentVersionData(scope, c)
  const hash = versionHash(data)
  const last = (
    await scope.trx.rawQuery(
      `select id, version_no, hash, data from customer_versions where tenant_id = ? and customer_id = ?
        order by version_no desc limit 1`,
      [t, c.id]
    )
  ).rows[0] as any
  if (last && last.hash === hash)
    return {
      id: last.id as string,
      versionNo: Number(last.version_no),
      data: last.data as CustomerVersionData,
      created: false,
    }
  const versionNo = (last ? Number(last.version_no) : 0) + 1
  const ins = await scope.trx.rawQuery(
    `insert into customer_versions (tenant_id, customer_id, version_no, data, hash, created_by, updated_by)
     values (?, ?, ?, ?::jsonb, ?, ?, ?) returning id`,
    [
      t,
      c.id,
      versionNo,
      JSON.stringify(data),
      hash,
      scope.context.userId,
      scope.context.userId,
    ] as never[]
  )
  const id = (ins.rows[0] as { id: string }).id
  await event(scope, c.id, 'VERSION', { details: { versionNo } })
  return { id, versionNo, data, created: true }
}

/**
 * Contrato para os documentos de venda (10.3 em diante): versão imutável dos dados fiscais do cliente a usar no
 * documento, com as condições de venda e o estado. Corre na transacção de quem chama (que já autorizou).
 */
export async function customerSnapshot(scope: TenantScope, customerId: string) {
  const c = await load(scope, customerId)
  const v = await syncVersion(scope, c)
  return {
    customerId: c.id as string,
    versionId: v.id,
    versionNo: v.versionNo,
    data: v.data,
    status: c.status as CustomerStatus,
    currency: String(c.currency).trim(),
    paymentTermsDays: Number(c.payment_terms_days),
    creditLimit: money(c.credit_limit),
    segmentId: (c.segment_id as string) ?? null,
  }
}

async function detail(scope: TenantScope, id: string, access: Access) {
  const t = scope.context.tenantId
  const c = await load(scope, id)
  const partner = (await partnerView(scope, c.partner_id))!
  const seg = c.segment_id
    ? ((
        await scope.trx.rawQuery(
          `select id, code, name from customer_segments where tenant_id = ? and id = ?`,
          [t, c.segment_id]
        )
      ).rows[0] as any)
    : null
  const addresses = (
    await scope.trx.rawQuery(
      `select * from customer_addresses where tenant_id = ? and customer_id = ?
        order by kind, is_default desc, status, label`,
      [t, id]
    )
  ).rows as any[]
  const versions = (
    await scope.trx.rawQuery(
      `select v.id, v.version_no, v.data, v.created_at, u.full_name from customer_versions v
         left join users u on u.id = v.created_by where v.tenant_id = ? and v.customer_id = ? order by v.version_no desc`,
      [t, id]
    )
  ).rows as any[]
  const events = (
    await scope.trx.rawQuery(
      `select e.*, u.full_name from customer_events e left join users u on u.id = e.created_by
        where e.tenant_id = ? and e.customer_id = ? order by e.created_at desc, e.id`,
      [t, id]
    )
  ).rows as any[]
  const supplier = (
    await scope.trx.rawQuery(`select id from suppliers where tenant_id = ? and partner_id = ?`, [
      t,
      c.partner_id,
    ])
  ).rows[0] as any
  const status = c.status as CustomerStatus
  return {
    id: c.id as string,
    version: Number(c.version),
    status,
    statusReason: (c.status_reason as string) ?? null,
    partner,
    currency: String(c.currency).trim(),
    paymentTermsDays: Number(c.payment_terms_days),
    creditLimit: money(c.credit_limit),
    segment: seg
      ? { id: seg.id as string, code: seg.code as string, name: seg.name as string }
      : null,
    notes: (c.notes as string) ?? null,
    alsoSupplier: !!supplier,
    addresses: addresses.map((a) => ({
      id: a.id as string,
      version: Number(a.version),
      kind: a.kind as AddressKind,
      label: a.label as string,
      addressLine: a.address_line as string,
      city: (a.city as string) ?? null,
      municipality: (a.municipality as string) ?? null,
      province: (a.province as string) ?? null,
      postalCode: (a.postal_code as string) ?? null,
      countryCode: String(a.country_code).trim(),
      isDefault: !!a.is_default,
      status: a.status as string,
    })),
    versions: versions.map((v) => ({
      id: v.id as string,
      versionNo: Number(v.version_no),
      data: v.data as CustomerVersionData,
      at: new Date(v.created_at).toISOString(),
      by: (v.full_name as string) ?? null,
    })),
    history: events.map((e) => ({
      kind: e.kind as string,
      from: (e.from_status as string) ?? null,
      to: (e.to_status as string) ?? null,
      reason: (e.reason as string) ?? null,
      details: e.details ?? null,
      at: new Date(e.created_at).toISOString(),
      by: (e.full_name as string) ?? null,
    })),
    can: { manage: access.manage, credit: access.credit },
  }
}

export type CustomerDetail = Awaited<ReturnType<typeof detail>>

const ADDRESS_COLUMNS: Record<string, string> = {
  kind: 'kind',
  label: 'label',
  addressLine: 'address_line',
  city: 'city',
  municipality: 'municipality',
  province: 'province',
  postalCode: 'postal_code',
  countryCode: 'country_code',
  isDefault: 'is_default',
  status: 'status',
}

async function clearDefault(
  scope: TenantScope,
  customerId: string,
  kind: string,
  except: string | null
) {
  await scope.trx.rawQuery(
    `update customer_addresses set is_default = false, updated_by = ?, updated_at = now(), version = version + 1
      where tenant_id = ? and customer_id = ? and kind = ? and is_default and id is distinct from ?::uuid`,
    [scope.context.userId, scope.context.tenantId, customerId, kind, except] as never[]
  )
}

export class CustomerService {
  list(
    context: TenantContext,
    f: { q?: string; status?: string; segmentId?: string; limit: number; offset: number }
  ) {
    return runInTenant(context, async (scope) => {
      need((await accessOf(scope)).read, 'Não pode consultar clientes.')
      const where = ['c.tenant_id = ?']
      const params: unknown[] = [context.tenantId]
      if (f.status && (CUSTOMER_STATUSES as readonly string[]).includes(f.status)) {
        where.push('c.status = ?')
        params.push(f.status)
      }
      if (f.segmentId && isUuid(f.segmentId)) {
        where.push('c.segment_id = ?')
        params.push(f.segmentId)
      }
      if (f.q) {
        const like = `%${f.q.toLowerCase().replace(/[\\%_]/g, (x) => `\\${x}`)}%`
        where.push(
          `(lower(p.code) like ? or lower(p.name) like ? or lower(coalesce(p.tax_id, '')) like ?)`
        )
        params.push(like, like, like)
      }
      const from = `from customers c join business_partners p on p.tenant_id = c.tenant_id and p.id = c.partner_id
        left join customer_segments s on s.tenant_id = c.tenant_id and s.id = c.segment_id
        where ${where.join(' and ')}`
      const rows = (
        await scope.trx.rawQuery(
          `select c.*, p.code, p.name, p.tax_id, p.country_code, p.partner_type, s.code as seg_code ${from}
            order by p.code limit ? offset ?`,
          [...params, f.limit, f.offset] as never[]
        )
      ).rows as any[]
      const total = Number(
        (
          (await scope.trx.rawQuery(`select count(*)::int as n ${from}`, params as never[]))
            .rows[0] as any
        ).n
      )
      return {
        items: rows.map((c) => ({
          id: c.id as string,
          code: c.code as string,
          name: c.name as string,
          taxId: (c.tax_id as string) ?? null,
          countryCode: String(c.country_code).trim(),
          partnerType: c.partner_type as string,
          currency: String(c.currency).trim(),
          paymentTermsDays: Number(c.payment_terms_days),
          creditLimit: money(c.credit_limit),
          segment: (c.seg_code as string) ?? null,
          status: c.status as CustomerStatus,
        })),
        total,
      }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const access = await accessOf(scope)
      need(access.read, 'Não pode consultar clientes.')
      return detail(scope, id, access)
    })
  }

  /** Terceiro com este NIF (reutilizar a ficha de um fornecedor ou evitar duplicados). */
  lookup(context: TenantContext, countryCode: string, taxId: string) {
    return runInTenant(context, async (scope) => {
      need((await accessOf(scope)).manage, 'Não pode gerir clientes.')
      const partner = await partnerByTaxId(scope, countryCode, taxId)
      if (!partner) return { partner: null, customerId: null }
      const r = await scope.trx.rawQuery(
        'select id from customers where tenant_id = ? and partner_id = ?',
        [context.tenantId, partner.id]
      )
      return {
        partner: { id: partner.id, code: partner.code, name: partner.name, taxId: partner.taxId },
        customerId: (r.rows[0] as { id: string } | undefined)?.id ?? null,
      }
    })
  }

  /** Novo cliente: sobre um terceiro existente (`partnerId`, ex.: já é fornecedor) ou com a ficha nova (`partner`). */
  create(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const access = await accessOf(scope)
      need(access.manage, 'Não pode gerir clientes.')
      const { v, issues } = normalizeCustomer(input, true)
      await segmentOk(scope, v.segmentId, issues)
      let partnerId: string | null = null
      let partnerValues: Record<string, unknown> | null = null
      if (input.partnerId !== undefined && input.partnerId !== null) {
        // Inexistente (ou de outra empresa): 404, como os restantes registos.
        if (!isUuid(input.partnerId) || !(await partnerView(scope, input.partnerId)))
          throw ApiError.notFound()
        partnerId = input.partnerId
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
      // O limite de crédito só com a permissão própria.
      let credit: string | null = null
      if (
        input.creditLimit !== undefined &&
        input.creditLimit !== null &&
        input.creditLimit !== ''
      ) {
        if (!access.credit)
          issues.push({
            path: 'creditLimit',
            code: 'OUT_OF_SCOPE',
            message: 'O limite de crédito é definido por quem gere o crédito.',
          })
        else {
          const cl = normalizeCreditLimit(input.creditLimit)
          issues.push(...cl.issues)
          credit = cl.value
        }
      }
      fail(issues)
      if (partnerId) {
        const dup = (
          await scope.trx.rawQuery(
            'select id from customers where tenant_id = ? and partner_id = ?',
            [context.tenantId, partnerId]
          )
        ).rows[0] as any
        if (dup) throw ApiError.conflict('ALREADY_CUSTOMER', 'Este terceiro já é cliente.')
      }
      if (partnerValues) partnerId = (await createPartner(scope, partnerValues)).id
      let id: string
      try {
        const ins = await scope.trx.rawQuery(
          `insert into customers (tenant_id, partner_id, currency, payment_terms_days, credit_limit, segment_id, notes,
              created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
          [
            context.tenantId,
            partnerId,
            v.currency,
            v.paymentTermsDays ?? 0,
            credit,
            v.segmentId ?? null,
            v.notes ?? null,
            context.userId,
            context.userId,
          ] as never[]
        )
        id = (ins.rows[0] as { id: string }).id
      } catch (e: any) {
        if (
          e?.code === '23505' &&
          String(e?.constraint ?? e?.message).includes('customers_partner_unique')
        )
          throw ApiError.conflict('ALREADY_CUSTOMER', 'Este terceiro já é cliente.')
        throw e
      }
      await event(scope, id, 'CREATED', { to: 'ACTIVE' })
      await syncVersion(scope, await load(scope, id))
      await audit(scope, {
        action: 'customer.created',
        entityType: 'customer',
        entityId: id,
        changes: {
          partnerId: { from: null, to: partnerId },
          currency: { from: null, to: v.currency },
          creditLimit: { from: null, to: credit },
        },
      })
      return detail(scope, id, access)
    })
  }

  /** Condições de venda e/ou a ficha do terceiro; se a identidade mudar, nasce uma versão nova. */
  update(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const access = await accessOf(scope)
      need(access.manage, 'Não pode gerir clientes.')
      const c = await load(scope, id, true)
      versionCheck(c, input.expectedVersion)
      const { v, issues } = normalizeCustomer(input, false)
      if ('segmentId' in v) await segmentOk(scope, v.segmentId, issues)
      if ('creditLimit' in input)
        issues.push({
          path: 'creditLimit',
          code: 'NOT_ALLOWED',
          message: 'O limite de crédito altera-se à parte.',
        })
      fail(issues)
      const partnerInput =
        input.partner && typeof input.partner === 'object'
          ? (input.partner as Record<string, unknown>)
          : null
      if (partnerInput) {
        const { expectedVersion, ...rest } = partnerInput
        await updatePartner(scope, c.partner_id, Number(expectedVersion), rest)
      }
      const cols: Record<string, string> = {
        currency: 'currency',
        paymentTermsDays: 'payment_terms_days',
        segmentId: 'segment_id',
        notes: 'notes',
      }
      const keys = Object.keys(v).filter(
        (k) => String(c[cols[k]] ?? '').trim() !== String(v[k] ?? '')
      )
      if (keys.length) {
        await scope.trx.rawQuery(
          `update customers set ${keys.map((k) => `${cols[k]} = ?, `).join('')}updated_by = ?, updated_at = now(),
              version = version + 1 where tenant_id = ? and id = ?`,
          [...keys.map((k) => v[k]), context.userId, context.tenantId, id] as never[]
        )
        await audit(scope, {
          action: 'customer.updated',
          entityType: 'customer',
          entityId: id,
          changes: Object.fromEntries(
            keys.map((k) => [k, { from: c[cols[k]] ?? null, to: v[k] ?? null }])
          ),
        })
        await event(scope, id, 'UPDATED', { details: { fields: keys } })
      } else if (partnerInput) {
        await scope.trx.rawQuery(
          `update customers set updated_by = ?, updated_at = now(), version = version + 1 where tenant_id = ? and id = ?`,
          [context.userId, context.tenantId, id]
        )
        await event(scope, id, 'PARTNER_UPDATED')
      }
      await syncVersion(scope, await load(scope, id))
      return detail(scope, id, access)
    })
  }

  /** Limite de crédito (permissão própria, com motivo). Vazio = sem limite. */
  setCredit(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const access = await accessOf(scope)
      if (!access.read) throw ApiError.notFound()
      need(access.credit, 'Não gere o crédito de clientes.')
      const c = await load(scope, id, true)
      versionCheck(c, input.expectedVersion)
      const cl = normalizeCreditLimit(input.creditLimit)
      const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
      if (reason.length < 3 || reason.length > 500)
        cl.issues.push({ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo (3 a 500).' })
      fail(cl.issues)
      const before = money(c.credit_limit)
      await scope.trx.rawQuery(
        `update customers set credit_limit = ?, updated_by = ?, updated_at = now(), version = version + 1
          where tenant_id = ? and id = ?`,
        [cl.value, context.userId, context.tenantId, id] as never[]
      )
      await event(scope, id, 'CREDIT_LIMIT', { reason, details: { from: before, to: cl.value } })
      await audit(scope, {
        action: 'customer.credit_limit_changed',
        entityType: 'customer',
        entityId: id,
        changes: { creditLimit: { from: before, to: cl.value } },
        metadata: { reason },
      })
      return detail(scope, id, access)
    })
  }

  setStatus(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const access = await accessOf(scope)
      need(access.manage, 'Não pode gerir clientes.')
      const c = await load(scope, id, true)
      versionCheck(c, input.expectedVersion)
      const { status, reason, issues } = normalizeStatusChange(input)
      fail(issues)
      if (status === c.status)
        throw ApiError.conflict('INVALID_STATE', 'O cliente já está neste estado.')
      await scope.trx.rawQuery(
        `update customers set status = ?, status_reason = ?, updated_by = ?, updated_at = now(), version = version + 1
          where tenant_id = ? and id = ?`,
        [
          status,
          status === 'ACTIVE' ? null : reason,
          context.userId,
          context.tenantId,
          id,
        ] as never[]
      )
      await event(scope, id, 'STATUS', { from: c.status, to: status, reason })
      await audit(scope, {
        action: 'customer.status_changed',
        entityType: 'customer',
        entityId: id,
        changes: { status: { from: c.status, to: status } },
        metadata: { reason },
      })
      return detail(scope, id, access)
    })
  }

  addAddress(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const access = await accessOf(scope)
      need(access.manage, 'Não pode gerir clientes.')
      const c = await load(scope, id, true)
      const { v, issues } = normalizeAddress(input, true)
      fail(issues)
      // A primeira de cada tipo é a por omissão.
      const first = !(
        await scope.trx.rawQuery(
          `select 1 from customer_addresses where tenant_id = ? and customer_id = ? and kind = ? and status = 'ACTIVE'`,
          [context.tenantId, id, v.kind] as never[]
        )
      ).rows.length
      const isDefault = v.isDefault === true || first
      if (isDefault) await clearDefault(scope, id, v.kind as string, null)
      const keys = Object.keys(v).filter((k) => k !== 'isDefault' && k !== 'status')
      const ins = await scope.trx.rawQuery(
        `insert into customer_addresses (tenant_id, customer_id, ${keys.map((k) => ADDRESS_COLUMNS[k]).join(', ')},
            is_default, created_by, updated_by) values (?, ?, ${keys.map(() => '?').join(', ')}, ?, ?, ?) returning id`,
        [
          context.tenantId,
          id,
          ...keys.map((k) => v[k]),
          isDefault,
          context.userId,
          context.userId,
        ] as never[]
      )
      await event(scope, id, 'ADDRESS_ADDED', {
        details: { addressId: (ins.rows[0] as any).id, kind: v.kind },
      })
      await audit(scope, {
        action: 'customer.address_added',
        entityType: 'customer',
        entityId: id,
        changes: { address: { from: null, to: v.label } },
      })
      await syncVersion(scope, c)
      return detail(scope, id, access)
    })
  }

  updateAddress(
    context: TenantContext,
    id: string,
    addressId: string,
    input: Record<string, unknown>
  ) {
    return runInTenant(context, async (scope) => {
      const access = await accessOf(scope)
      need(access.manage, 'Não pode gerir clientes.')
      const c = await load(scope, id, true)
      if (!isUuid(addressId)) throw ApiError.notFound()
      const a = (
        await scope.trx.rawQuery(
          `select * from customer_addresses where tenant_id = ? and id = ? and customer_id = ? for update`,
          [context.tenantId, addressId, id]
        )
      ).rows[0] as any
      if (!a) throw ApiError.notFound()
      versionCheck(a, input.expectedVersion)
      const { v, issues } = normalizeAddress(input, false)
      if ('kind' in v && v.kind !== a.kind)
        issues.push({
          path: 'kind',
          code: 'FIXED',
          message: 'O tipo da morada não muda (crie outra).',
        })
      fail(issues)
      if (v.status === 'INACTIVE') v.isDefault = false
      if (v.isDefault === true) await clearDefault(scope, id, a.kind, addressId)
      const keys = Object.keys(v).filter((k) => k !== 'kind')
      if (keys.length)
        await scope.trx.rawQuery(
          `update customer_addresses set ${keys.map((k) => `${ADDRESS_COLUMNS[k]} = ?, `).join('')}updated_by = ?,
              updated_at = now(), version = version + 1 where tenant_id = ? and id = ?`,
          [...keys.map((k) => v[k]), context.userId, context.tenantId, addressId] as never[]
        )
      await event(scope, id, 'ADDRESS_UPDATED', { details: { addressId, fields: keys } })
      await audit(scope, {
        action: 'customer.address_updated',
        entityType: 'customer',
        entityId: id,
        changes: Object.fromEntries(
          keys.map((k) => [
            `address.${k}`,
            { from: a[ADDRESS_COLUMNS[k]] ?? null, to: v[k] ?? null },
          ])
        ),
      })
      await syncVersion(scope, c)
      return detail(scope, id, access)
    })
  }

  addContact(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const access = await accessOf(scope)
      need(access.manage, 'Não pode gerir clientes.')
      const c = await load(scope, id)
      await addContact(scope, c.partner_id, input)
      await event(scope, id, 'CONTACT_ADDED')
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
      need(access.manage, 'Não pode gerir clientes.')
      const c = await load(scope, id)
      if (!isUuid(contactId)) throw ApiError.notFound()
      const { expectedVersion, ...rest } = input
      await updateContact(scope, c.partner_id, contactId, Number(expectedVersion), rest)
      await event(scope, id, 'CONTACT_UPDATED')
      return detail(scope, id, access)
    })
  }

  /** Versão em vigor dos dados fiscais (cria-a se a identidade mudou por outro papel, p. ex. pelo fornecedor). */
  currentVersion(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      need((await accessOf(scope)).read, 'Não pode consultar clientes.')
      return customerSnapshot(scope, id)
    })
  }
}

export class SegmentService {
  list(context: TenantContext) {
    return runInTenant(context, async (scope) => {
      const a = await accessOf(scope)
      need(a.read || a.settings, 'Não pode consultar segmentos.')
      const rows = (
        await scope.trx.rawQuery(
          `select s.*, (select count(*)::int from customers c where c.tenant_id = s.tenant_id and c.segment_id = s.id) as n
             from customer_segments s where s.tenant_id = ? order by s.status, s.code`,
          [context.tenantId]
        )
      ).rows as any[]
      return rows.map((s) => ({
        id: s.id as string,
        version: Number(s.version),
        code: s.code as string,
        name: s.name as string,
        description: (s.description as string) ?? null,
        status: s.status as string,
        customers: Number(s.n),
      }))
    })
  }

  create(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { v, issues } = normalizeSegment(input, true)
      fail(issues)
      try {
        const ins = await scope.trx.rawQuery(
          `insert into customer_segments (tenant_id, code, name, description, created_by, updated_by)
           values (?, ?, ?, ?, ?, ?) returning id`,
          [
            context.tenantId,
            v.code,
            v.name,
            v.description ?? null,
            context.userId,
            context.userId,
          ] as never[]
        )
        const id = (ins.rows[0] as { id: string }).id
        await audit(scope, {
          action: 'customer_segment.created',
          entityType: 'customer_segment',
          entityId: id,
          changes: { code: { from: null, to: v.code }, name: { from: null, to: v.name } },
        })
        return { id }
      } catch (e: any) {
        if (e?.code === '23505')
          throw ApiError.conflict('CODE_TAKEN', 'Já existe um segmento com este código.')
        throw e
      }
    })
  }

  update(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      if (!isUuid(id)) throw ApiError.notFound()
      const s = (
        await scope.trx.rawQuery(
          `select * from customer_segments where tenant_id = ? and id = ? for update`,
          [context.tenantId, id]
        )
      ).rows[0] as any
      if (!s) throw ApiError.notFound()
      versionCheck(s, input.expectedVersion)
      const { v, issues } = normalizeSegment(input, false)
      if ('code' in v && v.code !== s.code)
        issues.push({ path: 'code', code: 'FIXED', message: 'O código não muda.' })
      fail(issues)
      const cols: Record<string, string> = {
        name: 'name',
        description: 'description',
        status: 'status',
      }
      const keys = Object.keys(v).filter((k) => k in cols)
      if (keys.length)
        await scope.trx.rawQuery(
          `update customer_segments set ${keys.map((k) => `${cols[k]} = ?, `).join('')}updated_by = ?, updated_at = now(),
              version = version + 1 where tenant_id = ? and id = ?`,
          [...keys.map((k) => v[k]), context.userId, context.tenantId, id] as never[]
        )
      await audit(scope, {
        action: 'customer_segment.updated',
        entityType: 'customer_segment',
        entityId: id,
        changes: Object.fromEntries(
          keys.map((k) => [k, { from: s[cols[k]] ?? null, to: v[k] ?? null }])
        ),
      })
      return { id }
    })
  }
}

/** Existe nesta empresa e o membro pode ler (anexos do cliente): `null` sem acesso. */
export async function customerAccess(scope: TenantScope, id: string) {
  if (!isUuid(id)) return null
  const r = (
    await scope.trx.rawQuery(`select 1 from customers where tenant_id = ? and id = ?`, [
      scope.context.tenantId,
      id,
    ])
  ).rows[0]
  if (!r) return null
  const a = await accessOf(scope)
  return a.read ? { read: true, write: a.manage } : null
}
