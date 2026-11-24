import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { effectivePermissions } from '#modules/rbac/index'
import {
  dbScaled,
  type Limits,
  LIST_TARGETS,
  normalizeLimit,
  normalizePriceLine,
  normalizePriceList,
  normalizeReason,
  normalizeRule,
  parseScaled,
  PCT_SCALE,
  PRICE_SCALE,
  type PriceCandidate,
  PRICING_STATUSES,
  QTY_SCALE,
  resolveLine,
  type RuleCandidate,
  scaledText,
  snapshotHash,
} from '#modules/sales/domain/pricing'

/*
 * Preços e descontos (10.2). Permissões da empresa: `sales.prices.read`, `.manage` (rascunhos, submeter, inactivar) e
 * `.approve` (activar tabelas e regras de outra pessoa; limites de desconto). Ver as regras de resolução em
 * `domain/pricing.ts`; `resolvePrices` é o contrato para os documentos de venda (10.3+), que guardam o snapshot.
 */

const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
interface Access {
  read: boolean
  manage: boolean
  approve: boolean
}
async function accessOf(scope: TenantScope): Promise<Access> {
  const held = (await effectivePermissions(scope)).tenant
  const manage = held.has('sales.prices.manage')
  const approve = held.has('sales.prices.approve')
  return { read: manage || approve || held.has('sales.prices.read'), manage, approve }
}
const need = (ok: boolean, message: string) => {
  if (!ok) throw ApiError.forbidden('OUT_OF_SCOPE', message)
}
const versionCheck = (row: any, expected: unknown) => {
  if (Number(row.version) !== Number(expected)) throw ApiError.versionConflict(Number(row.version))
}
const inState = (row: any, states: string[], message: string) => {
  if (!states.includes(row.status)) throw ApiError.conflict('INVALID_STATE', message)
}
const num = (v: unknown, scale: number) =>
  v === null || v === undefined ? null : scaledText(dbScaled(v, scale), scale)

type Subject = 'PRICE_LIST' | 'DISCOUNT_RULE'
async function event(
  scope: TenantScope,
  subject: Subject,
  id: string,
  kind: string,
  reason: string | null = null,
  details?: Record<string, unknown>
) {
  await scope.trx.rawQuery(
    `insert into pricing_events (tenant_id, subject_type, subject_id, kind, reason, details, created_by, updated_by)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      scope.context.tenantId,
      subject,
      id,
      kind,
      reason,
      details ? JSON.stringify(details) : null,
      scope.context.userId,
      scope.context.userId,
    ] as never[]
  )
}
async function history(scope: TenantScope, subject: Subject, id: string) {
  const rows = (
    await scope.trx.rawQuery(
      `select e.kind, e.reason, e.created_at, u.full_name from pricing_events e
         left join users u on u.id = e.created_by
        where e.tenant_id = ? and e.subject_type = ? and e.subject_id = ? order by e.created_at, e.id`,
      [scope.context.tenantId, subject, id]
    )
  ).rows as any[]
  return rows.map((e) => ({
    kind: e.kind as string,
    reason: (e.reason as string) ?? null,
    at: new Date(e.created_at).toISOString(),
    by: (e.full_name as string) ?? null,
  }))
}

async function loadRow(
  scope: TenantScope,
  table: 'price_lists' | 'discount_rules',
  id: string,
  lock = false
) {
  if (!isUuid(id)) throw ApiError.notFound()
  const r = (
    await scope.trx.rawQuery(
      `select *, valid_from::text as vf, valid_to::text as vt from ${table} where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
      [scope.context.tenantId, id]
    )
  ).rows[0] as any
  if (!r) throw ApiError.notFound()
  return r
}

/** Referências do destino (segmento activo, cliente, entidade) e do âmbito (produto, categoria) desta empresa. */
async function checkRefs(scope: TenantScope, v: Record<string, unknown>) {
  const t = scope.context.tenantId
  const issues: ErrorDetail[] = []
  const exists = async (sql: string, id: unknown) =>
    !!(await scope.trx.rawQuery(sql, [t, id as string])).rows[0]
  if (
    v.segmentId &&
    !(await exists(
      `select 1 from customer_segments where tenant_id = ? and id = ? and status = 'ACTIVE'`,
      v.segmentId
    ))
  )
    issues.push({ path: 'segmentId', code: 'NOT_FOUND', message: 'Segmento activo inexistente.' })
  if (
    v.customerId &&
    !(await exists(`select 1 from customers where tenant_id = ? and id = ?`, v.customerId))
  )
    issues.push({ path: 'customerId', code: 'NOT_FOUND', message: 'Cliente inexistente.' })
  if (
    v.legalEntityId &&
    !(await exists(`select 1 from legal_entities where tenant_id = ? and id = ?`, v.legalEntityId))
  )
    issues.push({ path: 'legalEntityId', code: 'NOT_FOUND', message: 'Entidade inexistente.' })
  if (
    v.productId &&
    !(await exists(`select 1 from products where tenant_id = ? and id = ?`, v.productId))
  )
    issues.push({ path: 'productId', code: 'NOT_FOUND', message: 'Produto inexistente.' })
  if (
    v.categoryId &&
    !(await exists(`select 1 from product_categories where tenant_id = ? and id = ?`, v.categoryId))
  )
    issues.push({ path: 'categoryId', code: 'NOT_FOUND', message: 'Categoria inexistente.' })
  if (v.variantId) {
    const ok = v.productId
      ? !!(
          await scope.trx.rawQuery(
            `select 1 from product_variants where tenant_id = ? and id = ? and product_id = ?`,
            [t, v.variantId as string, v.productId as string]
          )
        ).rows[0]
      : false
    if (!ok)
      issues.push({
        path: 'variantId',
        code: 'NOT_FOUND',
        message: 'Variante inexistente neste produto.',
      })
  }
  fail(issues)
}

const unique = async <T>(
  fn: () => Promise<T>,
  constraint: string,
  code: string,
  message: string
) => {
  try {
    return await fn()
  } catch (e: any) {
    if (e?.code === '23505' && String(e.constraint ?? '').startsWith(constraint))
      throw ApiError.conflict(code, message)
    throw e
  }
}

function targetView(r: any) {
  return {
    targetType: r.target_type as string,
    segment: r.segment_id
      ? { id: r.segment_id as string, code: r.seg_code as string, name: r.seg_name as string }
      : null,
    customer: r.customer_id
      ? { id: r.customer_id as string, code: r.cus_code as string, name: r.cus_name as string }
      : null,
  }
}
const TARGET_JOINS = (a: string) => `
  left join customer_segments s on s.tenant_id = ${a}.tenant_id and s.id = ${a}.segment_id
  left join customers c on c.tenant_id = ${a}.tenant_id and c.id = ${a}.customer_id
  left join business_partners bp on bp.tenant_id = c.tenant_id and bp.id = c.partner_id`
const TARGET_COLS =
  's.code as seg_code, s.name as seg_name, bp.code as cus_code, bp.name as cus_name'

function decisionView(r: any, a: Access, userId: string) {
  return {
    submittedAt: r.submitted_at ? new Date(r.submitted_at).toISOString() : null,
    approvedAt: r.approved_at ? new Date(r.approved_at).toISOString() : null,
    inactiveReason: (r.inactive_reason as string) ?? null,
    can: {
      edit: a.manage && r.status === 'DRAFT',
      submit: a.manage && r.status === 'DRAFT',
      approve: a.approve && r.status === 'PENDING' && r.submitted_by !== userId,
      reject: a.approve && r.status === 'PENDING',
      deactivate: (a.manage || a.approve) && r.status === 'ACTIVE',
      copy: a.manage,
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Tabelas de preços
// ---------------------------------------------------------------------------------------------------------------

async function listDetail(scope: TenantScope, id: string, a: Access) {
  const t = scope.context.tenantId
  const r = (
    await scope.trx.rawQuery(
      `select l.*, l.valid_from::text as vf, l.valid_to::text as vt, ${TARGET_COLS}, le.code as le_code,
              src.code as src_code
         from price_lists l ${TARGET_JOINS('l')}
         left join legal_entities le on le.tenant_id = l.tenant_id and le.id = l.legal_entity_id
         left join price_lists src on src.tenant_id = l.tenant_id and src.id = l.copied_from_id
        where l.tenant_id = ? and l.id = ?`,
      [t, id]
    )
  ).rows[0] as any
  if (!r) throw ApiError.notFound()
  const lines = (
    await scope.trx.rawQuery(
      `select ln.*, p.sku, p.name as product_name, v.sku as variant_sku
         from price_list_lines ln join products p on p.tenant_id = ln.tenant_id and p.id = ln.product_id
         left join product_variants v on v.tenant_id = ln.tenant_id and v.id = ln.variant_id
        where ln.tenant_id = ? and ln.price_list_id = ? order by p.sku, v.sku nulls first, ln.min_quantity`,
      [t, id]
    )
  ).rows as any[]
  return {
    id: r.id as string,
    version: Number(r.version),
    code: r.code as string,
    name: r.name as string,
    currency: String(r.currency).trim(),
    ...targetView(r),
    legalEntity: r.legal_entity_id
      ? { id: r.legal_entity_id as string, code: r.le_code as string }
      : null,
    validFrom: r.vf as string,
    validTo: (r.vt as string) ?? null,
    priority: Number(r.priority),
    status: r.status as string,
    notes: (r.notes as string) ?? null,
    copiedFrom: r.copied_from_id
      ? { id: r.copied_from_id as string, code: r.src_code as string }
      : null,
    ...decisionView(r, a, scope.context.userId),
    lines: lines.map((l) => ({
      id: l.id as string,
      version: Number(l.version),
      product: { id: l.product_id as string, sku: l.sku as string, name: l.product_name as string },
      variant: l.variant_id ? { id: l.variant_id as string, sku: l.variant_sku as string } : null,
      minQuantity: num(l.min_quantity, QTY_SCALE)!,
      unitPrice: num(l.unit_price, PRICE_SCALE)!,
      maxDiscountPct: num(l.max_discount_pct, PCT_SCALE),
    })),
    history: await history(scope, 'PRICE_LIST', id),
  }
}

/** Duas tabelas activas para o mesmo destino, moeda, entidade e prioridade não podem ter períodos sobrepostos. */
async function listOverlap(scope: TenantScope, l: any) {
  const t = scope.context.tenantId
  await scope.trx.rawQuery('select pg_advisory_xact_lock(hashtext(?))', [`price-lists:${t}`])
  const other = (
    await scope.trx.rawQuery(
      `select code from price_lists where tenant_id = ? and id <> ? and status = 'ACTIVE' and target_type = ?
          and segment_id is not distinct from ? and customer_id is not distinct from ? and currency = ?
          and legal_entity_id is not distinct from ? and priority = ?
          and daterange(valid_from, valid_to, '[]') && daterange(?::date, ?::date, '[]') limit 1`,
      [
        t,
        l.id,
        l.target_type,
        l.segment_id,
        l.customer_id,
        l.currency,
        l.legal_entity_id,
        l.priority,
        l.vf,
        l.vt,
      ] as never[]
    )
  ).rows[0] as any
  if (other)
    throw new ApiError(
      409,
      'OVERLAP',
      `A tabela ${other.code} já está activa para o mesmo destino, moeda, entidade e prioridade num período sobreposto.`,
      [
        {
          path: 'priority',
          code: 'OVERLAP',
          message: `Sobrepõe-se a ${other.code}: mude a prioridade ou o período.`,
        },
      ]
    )
}

export class PriceListService {
  list(
    context: TenantContext,
    f: { q?: string; status?: string; targetType?: string; limit: number; offset: number }
  ) {
    return runInTenant(context, async (scope) => {
      need((await accessOf(scope)).read, 'Não pode consultar preços.')
      const where = ['l.tenant_id = ?']
      const params: unknown[] = [context.tenantId]
      if (f.status && (PRICING_STATUSES as readonly string[]).includes(f.status)) {
        where.push('l.status = ?')
        params.push(f.status)
      }
      if (f.targetType && (LIST_TARGETS as readonly string[]).includes(f.targetType)) {
        where.push('l.target_type = ?')
        params.push(f.targetType)
      }
      if (f.q) {
        const like = `%${f.q.toLowerCase().replace(/[\\%_]/g, (x) => `\\${x}`)}%`
        where.push('(lower(l.code) like ? or lower(l.name) like ?)')
        params.push(like, like)
      }
      const from = `from price_lists l ${TARGET_JOINS('l')} where ${where.join(' and ')}`
      const rows = (
        await scope.trx.rawQuery(
          `select l.*, l.valid_from::text as vf, l.valid_to::text as vt, ${TARGET_COLS},
                  (select count(*)::int from price_list_lines x where x.tenant_id = l.tenant_id and x.price_list_id = l.id) as n
             ${from} order by l.code limit ? offset ?`,
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
        items: rows.map((r) => ({
          id: r.id as string,
          code: r.code as string,
          name: r.name as string,
          currency: String(r.currency).trim(),
          ...targetView(r),
          validFrom: r.vf as string,
          validTo: (r.vt as string) ?? null,
          priority: Number(r.priority),
          status: r.status as string,
          lines: Number(r.n),
        })),
        total,
      }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const a = await accessOf(scope)
      need(a.read, 'Não pode consultar preços.')
      if (!isUuid(id)) throw ApiError.notFound()
      return listDetail(scope, id, a)
    })
  }

  create(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const a = await accessOf(scope)
      need(a.manage, 'Não pode gerir tabelas de preços.')
      const { v, issues } = normalizePriceList(input, true)
      fail(issues)
      await checkRefs(scope, v)
      const ins = await unique(
        () =>
          scope.trx.rawQuery(
            `insert into price_lists (tenant_id, code, name, currency, target_type, segment_id, customer_id,
               legal_entity_id, valid_from, valid_to, priority, notes, created_by, updated_by)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
            [
              context.tenantId,
              v.code,
              v.name,
              v.currency,
              v.targetType,
              v.segmentId,
              v.customerId,
              v.legalEntityId ?? null,
              v.validFrom,
              v.validTo ?? null,
              v.priority ?? 100,
              v.notes ?? null,
              context.userId,
              context.userId,
            ] as never[]
          ),
        'price_lists_code',
        'CODE_TAKEN',
        'Já existe uma tabela com este código.'
      )
      const id = (ins.rows[0] as any).id as string
      await event(scope, 'PRICE_LIST', id, 'CREATED')
      await audit(scope, {
        action: 'price_list.created',
        entityType: 'price_list',
        entityId: id,
        changes: { code: { from: null, to: v.code }, currency: { from: null, to: v.currency } },
      })
      return listDetail(scope, id, a)
    })
  }

  update(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const a = await accessOf(scope)
      need(a.manage, 'Não pode gerir tabelas de preços.')
      const l = await loadRow(scope, 'price_lists', id, true)
      versionCheck(l, input.expectedVersion)
      inState(l, ['DRAFT'], 'Só se altera em rascunho; copie a tabela para mudar preços.')
      const { expectedVersion, code, ...rest } = input
      const { v, issues } = normalizePriceList(rest, false)
      fail(issues)
      const validFrom = (v.validFrom as string) ?? l.vf
      const validTo = 'validTo' in v ? (v.validTo as string | null) : l.vt
      if (validTo && validTo < validFrom)
        fail([{ path: 'validTo', code: 'INVALID', message: 'O fim não pode ser antes do início.' }])
      await checkRefs(scope, v)
      const map: Record<string, string> = {
        name: 'name',
        currency: 'currency',
        targetType: 'target_type',
        segmentId: 'segment_id',
        customerId: 'customer_id',
        legalEntityId: 'legal_entity_id',
        validFrom: 'valid_from',
        validTo: 'valid_to',
        priority: 'priority',
        notes: 'notes',
      }
      const sets: string[] = []
      const params: unknown[] = []
      const changes: Record<string, { from: unknown; to: unknown }> = {}
      for (const [k, col] of Object.entries(map))
        if (k in v) {
          sets.push(`${col} = ?`)
          params.push(v[k])
          changes[k] = {
            from: k === 'validFrom' ? l.vf : k === 'validTo' ? l.vt : l[col],
            to: v[k],
          }
        }
      if (sets.length) {
        await scope.trx.rawQuery(
          `update price_lists set ${sets.join(', ')}, version = version + 1, updated_at = now(), updated_by = ?
            where tenant_id = ? and id = ?`,
          [...params, context.userId, context.tenantId, id] as never[]
        )
        await audit(scope, {
          action: 'price_list.updated',
          entityType: 'price_list',
          entityId: id,
          changes,
        })
      }
      return listDetail(scope, id, a)
    })
  }

  private lineOp(
    context: TenantContext,
    id: string,
    op: (scope: TenantScope, l: any) => Promise<void>
  ) {
    return runInTenant(context, async (scope) => {
      const a = await accessOf(scope)
      need(a.manage, 'Não pode gerir tabelas de preços.')
      const l = await loadRow(scope, 'price_lists', id, true)
      inState(l, ['DRAFT'], 'Só se alteram linhas em rascunho.')
      await op(scope, l)
      await scope.trx.rawQuery(
        `update price_lists set version = version + 1, updated_at = now(), updated_by = ? where tenant_id = ? and id = ?`,
        [context.userId, context.tenantId, id]
      )
      return listDetail(scope, id, a)
    })
  }

  addLine(context: TenantContext, id: string, input: Record<string, unknown>) {
    return this.lineOp(context, id, async (scope) => {
      const { v, issues } = normalizePriceLine(input, true)
      fail(issues)
      await checkRefs(scope, v)
      const ins = await unique(
        () =>
          scope.trx.rawQuery(
            `insert into price_list_lines (tenant_id, price_list_id, product_id, variant_id, min_quantity, unit_price,
               max_discount_pct, created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
            [
              context.tenantId,
              id,
              v.productId,
              v.variantId ?? null,
              v.minQuantity ?? '1',
              v.unitPrice,
              v.maxDiscountPct ?? null,
              context.userId,
              context.userId,
            ] as never[]
          ),
        'price_list_lines_tier',
        'TIER_EXISTS',
        'Este produto já tem preço para esta quantidade mínima nesta tabela.'
      )
      await audit(scope, {
        action: 'price_list.line_added',
        entityType: 'price_list',
        entityId: id,
        changes: {
          productId: { from: null, to: v.productId },
          unitPrice: { from: null, to: v.unitPrice },
          minQuantity: { from: null, to: v.minQuantity ?? '1.000000' },
        },
        metadata: { lineId: (ins.rows[0] as any).id },
      })
    })
  }

  updateLine(context: TenantContext, id: string, lineId: string, input: Record<string, unknown>) {
    return this.lineOp(context, id, async (scope) => {
      const ln = isUuid(lineId)
        ? ((
            await scope.trx.rawQuery(
              `select * from price_list_lines where tenant_id = ? and price_list_id = ? and id = ? for update`,
              [context.tenantId, id, lineId]
            )
          ).rows[0] as any)
        : null
      if (!ln) throw ApiError.notFound()
      versionCheck(ln, input.expectedVersion)
      const { expectedVersion, productId, variantId, ...rest } = input
      const { v, issues } = normalizePriceLine(rest, false)
      fail(issues)
      const cols: Record<string, string> = {
        minQuantity: 'min_quantity',
        unitPrice: 'unit_price',
        maxDiscountPct: 'max_discount_pct',
      }
      const sets: string[] = []
      const params: unknown[] = []
      const changes: Record<string, { from: unknown; to: unknown }> = {}
      for (const [k, col] of Object.entries(cols))
        if (k in v) {
          sets.push(`${col} = ?`)
          params.push(v[k])
          changes[k] = { from: ln[col], to: v[k] }
        }
      if (!sets.length) return
      await unique(
        () =>
          scope.trx.rawQuery(
            `update price_list_lines set ${sets.join(', ')}, version = version + 1, updated_at = now(), updated_by = ?
              where tenant_id = ? and id = ?`,
            [...params, context.userId, context.tenantId, lineId] as never[]
          ),
        'price_list_lines_tier',
        'TIER_EXISTS',
        'Este produto já tem preço para esta quantidade mínima nesta tabela.'
      )
      await audit(scope, {
        action: 'price_list.line_updated',
        entityType: 'price_list',
        entityId: id,
        changes,
        metadata: { lineId },
      })
    })
  }

  removeLine(context: TenantContext, id: string, lineId: string) {
    return this.lineOp(context, id, async (scope) => {
      const ln = isUuid(lineId)
        ? ((
            await scope.trx.rawQuery(
              `select * from price_list_lines where tenant_id = ? and price_list_id = ? and id = ?`,
              [context.tenantId, id, lineId]
            )
          ).rows[0] as any)
        : null
      if (!ln) throw ApiError.notFound()
      await scope.trx.rawQuery(`delete from price_list_lines where tenant_id = ? and id = ?`, [
        context.tenantId,
        lineId,
      ])
      await audit(scope, {
        action: 'price_list.line_removed',
        entityType: 'price_list',
        entityId: id,
        changes: {
          productId: { from: ln.product_id, to: null },
          unitPrice: { from: ln.unit_price, to: null },
        },
        metadata: { lineId },
      })
    })
  }

  submit(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const a = await accessOf(scope)
      need(a.manage, 'Não pode gerir tabelas de preços.')
      const l = await loadRow(scope, 'price_lists', id, true)
      versionCheck(l, input.expectedVersion)
      inState(l, ['DRAFT'], 'Só se submete um rascunho.')
      const n = Number(
        (
          (
            await scope.trx.rawQuery(
              `select count(*)::int as n from price_list_lines where tenant_id = ? and price_list_id = ?`,
              [context.tenantId, id]
            )
          ).rows[0] as any
        ).n
      )
      if (!n) throw ApiError.conflict('NO_LINES', 'A tabela não tem preços.')
      await scope.trx.rawQuery(
        `update price_lists set status = 'PENDING', submitted_by = ?, submitted_at = now(), version = version + 1,
           updated_at = now(), updated_by = ? where tenant_id = ? and id = ?`,
        [context.userId, context.userId, context.tenantId, id]
      )
      await event(scope, 'PRICE_LIST', id, 'SUBMITTED')
      await audit(scope, {
        action: 'price_list.submitted',
        entityType: 'price_list',
        entityId: id,
        changes: { status: { from: 'DRAFT', to: 'PENDING' } },
      })
      return listDetail(scope, id, a)
    })
  }

  approve(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const a = await accessOf(scope)
      need(a.approve, 'Não pode aprovar preços.')
      const l = await loadRow(scope, 'price_lists', id, true)
      versionCheck(l, input.expectedVersion)
      inState(l, ['PENDING'], 'Só se aprova uma tabela submetida.')
      if (l.submitted_by === context.userId)
        throw ApiError.forbidden('SELF_APPROVAL', 'Quem submete não aprova a própria tabela.')
      await listOverlap(scope, l)
      await scope.trx.rawQuery(
        `update price_lists set status = 'ACTIVE', approved_by = ?, approved_at = now(), version = version + 1,
           updated_at = now(), updated_by = ? where tenant_id = ? and id = ?`,
        [context.userId, context.userId, context.tenantId, id]
      )
      await event(scope, 'PRICE_LIST', id, 'APPROVED')
      await audit(scope, {
        action: 'price_list.approved',
        entityType: 'price_list',
        entityId: id,
        changes: { status: { from: 'PENDING', to: 'ACTIVE' } },
      })
      return listDetail(scope, id, a)
    })
  }

  reject(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const a = await accessOf(scope)
      need(a.approve, 'Não pode aprovar preços.')
      const l = await loadRow(scope, 'price_lists', id, true)
      versionCheck(l, input.expectedVersion)
      inState(l, ['PENDING'], 'Só se devolve uma tabela submetida.')
      const { reason, issues } = normalizeReason(input, true)
      fail(issues)
      await scope.trx.rawQuery(
        `update price_lists set status = 'DRAFT', submitted_by = null, submitted_at = null, version = version + 1,
           updated_at = now(), updated_by = ? where tenant_id = ? and id = ?`,
        [context.userId, context.tenantId, id]
      )
      await event(scope, 'PRICE_LIST', id, 'REJECTED', reason)
      await audit(scope, {
        action: 'price_list.rejected',
        entityType: 'price_list',
        entityId: id,
        changes: { status: { from: 'PENDING', to: 'DRAFT' } },
        metadata: { reason },
      })
      return listDetail(scope, id, a)
    })
  }

  deactivate(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const a = await accessOf(scope)
      need(a.manage || a.approve, 'Não pode gerir tabelas de preços.')
      const l = await loadRow(scope, 'price_lists', id, true)
      versionCheck(l, input.expectedVersion)
      inState(l, ['ACTIVE'], 'Só se inactiva uma tabela activa.')
      const { reason, issues } = normalizeReason(input, true)
      fail(issues)
      await scope.trx.rawQuery(
        `update price_lists set status = 'INACTIVE', inactive_reason = ?, version = version + 1, updated_at = now(),
           updated_by = ? where tenant_id = ? and id = ?`,
        [reason, context.userId, context.tenantId, id] as never[]
      )
      await event(scope, 'PRICE_LIST', id, 'DEACTIVATED', reason)
      await audit(scope, {
        action: 'price_list.deactivated',
        entityType: 'price_list',
        entityId: id,
        changes: { status: { from: 'ACTIVE', to: 'INACTIVE' } },
        metadata: { reason },
      })
      return listDetail(scope, id, a)
    })
  }

  /** Copia cabeçalho e linhas para um rascunho novo (é assim que se mudam preços de uma tabela activa). */
  copy(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const a = await accessOf(scope)
      need(a.manage, 'Não pode gerir tabelas de preços.')
      const src = await loadRow(scope, 'price_lists', id)
      const { v, issues } = normalizePriceList(
        {
          code: input.code,
          name: input.name ?? src.name,
          validFrom: input.validFrom,
          validTo: input.validTo ?? null,
        },
        false
      )
      if (!v.code) issues.push({ path: 'code', code: 'REQUIRED', message: 'Código obrigatório.' })
      if (!v.validFrom)
        issues.push({ path: 'validFrom', code: 'REQUIRED', message: 'Data de início obrigatória.' })
      if (v.validTo && v.validFrom && (v.validTo as string) < (v.validFrom as string))
        issues.push({
          path: 'validTo',
          code: 'INVALID',
          message: 'O fim não pode ser antes do início.',
        })
      fail(issues)
      const ins = await unique(
        () =>
          scope.trx.rawQuery(
            `insert into price_lists (tenant_id, code, name, currency, target_type, segment_id, customer_id,
               legal_entity_id, valid_from, valid_to, priority, notes, copied_from_id, created_by, updated_by)
             select tenant_id, ?, ?, currency, target_type, segment_id, customer_id, legal_entity_id, ?, ?, priority,
                    notes, id, ?, ? from price_lists where tenant_id = ? and id = ? returning id`,
            [
              v.code,
              v.name,
              v.validFrom,
              v.validTo ?? null,
              context.userId,
              context.userId,
              context.tenantId,
              id,
            ] as never[]
          ),
        'price_lists_code',
        'CODE_TAKEN',
        'Já existe uma tabela com este código.'
      )
      const newId = (ins.rows[0] as any).id as string
      await scope.trx.rawQuery(
        `insert into price_list_lines (tenant_id, price_list_id, product_id, variant_id, min_quantity, unit_price,
           max_discount_pct, created_by, updated_by)
         select tenant_id, ?, product_id, variant_id, min_quantity, unit_price, max_discount_pct, ?, ?
           from price_list_lines where tenant_id = ? and price_list_id = ?`,
        [newId, context.userId, context.userId, context.tenantId, id]
      )
      await event(scope, 'PRICE_LIST', newId, 'COPIED', null, { from: src.code })
      await audit(scope, {
        action: 'price_list.created',
        entityType: 'price_list',
        entityId: newId,
        changes: { code: { from: null, to: v.code } },
        metadata: { copiedFrom: src.code },
      })
      return listDetail(scope, newId, a)
    })
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Regras de desconto
// ---------------------------------------------------------------------------------------------------------------

async function ruleDetail(scope: TenantScope, id: string, a: Access) {
  const r = (
    await scope.trx.rawQuery(
      `select d.*, d.valid_from::text as vf, d.valid_to::text as vt, ${TARGET_COLS}, p.sku, p.name as product_name,
              pc.code as cat_code, pc.name as cat_name
         from discount_rules d ${TARGET_JOINS('d')}
         left join products p on p.tenant_id = d.tenant_id and p.id = d.product_id
         left join product_categories pc on pc.tenant_id = d.tenant_id and pc.id = d.category_id
        where d.tenant_id = ? and d.id = ?`,
      [scope.context.tenantId, id]
    )
  ).rows[0] as any
  if (!r) throw ApiError.notFound()
  return {
    ...ruleRow(r),
    notes: (r.notes as string) ?? null,
    ...decisionView(r, a, scope.context.userId),
    history: await history(scope, 'DISCOUNT_RULE', id),
  }
}
function ruleRow(r: any) {
  return {
    id: r.id as string,
    version: Number(r.version),
    code: r.code as string,
    name: r.name as string,
    ...targetView(r),
    product: r.product_id
      ? { id: r.product_id as string, sku: r.sku as string, name: r.product_name as string }
      : null,
    category: r.category_id
      ? { id: r.category_id as string, code: r.cat_code as string, name: r.cat_name as string }
      : null,
    minQuantity: num(r.min_quantity, QTY_SCALE)!,
    discountPct: num(r.discount_pct, PCT_SCALE)!,
    validFrom: r.vf as string,
    validTo: (r.vt as string) ?? null,
    priority: Number(r.priority),
    status: r.status as string,
  }
}

async function ruleOverlap(scope: TenantScope, d: any) {
  const t = scope.context.tenantId
  await scope.trx.rawQuery('select pg_advisory_xact_lock(hashtext(?))', [`discount-rules:${t}`])
  const other = (
    await scope.trx.rawQuery(
      `select code from discount_rules where tenant_id = ? and id <> ? and status = 'ACTIVE' and target_type = ?
          and segment_id is not distinct from ? and customer_id is not distinct from ?
          and product_id is not distinct from ? and category_id is not distinct from ? and min_quantity = ?
          and priority = ? and daterange(valid_from, valid_to, '[]') && daterange(?::date, ?::date, '[]') limit 1`,
      [
        t,
        d.id,
        d.target_type,
        d.segment_id,
        d.customer_id,
        d.product_id,
        d.category_id,
        d.min_quantity,
        d.priority,
        d.vf,
        d.vt,
      ] as never[]
    )
  ).rows[0] as any
  if (other)
    throw new ApiError(
      409,
      'OVERLAP',
      `A regra ${other.code} já está activa para o mesmo destino, âmbito, quantidade e prioridade num período sobreposto.`,
      [
        {
          path: 'priority',
          code: 'OVERLAP',
          message: `Sobrepõe-se a ${other.code}: mude a prioridade ou o período.`,
        },
      ]
    )
}

export class DiscountRuleService {
  list(context: TenantContext, f: { q?: string; status?: string; limit: number; offset: number }) {
    return runInTenant(context, async (scope) => {
      need((await accessOf(scope)).read, 'Não pode consultar preços.')
      const where = ['d.tenant_id = ?']
      const params: unknown[] = [context.tenantId]
      if (f.status && (PRICING_STATUSES as readonly string[]).includes(f.status)) {
        where.push('d.status = ?')
        params.push(f.status)
      }
      if (f.q) {
        const like = `%${f.q.toLowerCase().replace(/[\\%_]/g, (x) => `\\${x}`)}%`
        where.push('(lower(d.code) like ? or lower(d.name) like ?)')
        params.push(like, like)
      }
      const from = `from discount_rules d ${TARGET_JOINS('d')}
         left join products p on p.tenant_id = d.tenant_id and p.id = d.product_id
         left join product_categories pc on pc.tenant_id = d.tenant_id and pc.id = d.category_id
        where ${where.join(' and ')}`
      const rows = (
        await scope.trx.rawQuery(
          `select d.*, d.valid_from::text as vf, d.valid_to::text as vt, ${TARGET_COLS}, p.sku, p.name as product_name,
                  pc.code as cat_code, pc.name as cat_name ${from} order by d.code limit ? offset ?`,
          [...params, f.limit, f.offset] as never[]
        )
      ).rows as any[]
      const total = Number(
        (
          (await scope.trx.rawQuery(`select count(*)::int as n ${from}`, params as never[]))
            .rows[0] as any
        ).n
      )
      return { items: rows.map(ruleRow), total }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const a = await accessOf(scope)
      need(a.read, 'Não pode consultar preços.')
      if (!isUuid(id)) throw ApiError.notFound()
      return ruleDetail(scope, id, a)
    })
  }

  create(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const a = await accessOf(scope)
      need(a.manage, 'Não pode gerir descontos.')
      const { v, issues } = normalizeRule(input, true)
      fail(issues)
      await checkRefs(scope, v)
      const ins = await unique(
        () =>
          scope.trx.rawQuery(
            `insert into discount_rules (tenant_id, code, name, target_type, segment_id, customer_id, product_id,
               category_id, min_quantity, discount_pct, valid_from, valid_to, priority, notes, created_by, updated_by)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
            [
              context.tenantId,
              v.code,
              v.name,
              v.targetType,
              v.segmentId,
              v.customerId,
              v.productId ?? null,
              v.categoryId ?? null,
              v.minQuantity ?? '0',
              v.discountPct,
              v.validFrom,
              v.validTo ?? null,
              v.priority ?? 100,
              v.notes ?? null,
              context.userId,
              context.userId,
            ] as never[]
          ),
        'discount_rules_code',
        'CODE_TAKEN',
        'Já existe uma regra com este código.'
      )
      const id = (ins.rows[0] as any).id as string
      await event(scope, 'DISCOUNT_RULE', id, 'CREATED')
      await audit(scope, {
        action: 'discount_rule.created',
        entityType: 'discount_rule',
        entityId: id,
        changes: {
          code: { from: null, to: v.code },
          discountPct: { from: null, to: v.discountPct },
        },
      })
      return ruleDetail(scope, id, a)
    })
  }

  update(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const a = await accessOf(scope)
      need(a.manage, 'Não pode gerir descontos.')
      const d = await loadRow(scope, 'discount_rules', id, true)
      versionCheck(d, input.expectedVersion)
      inState(d, ['DRAFT'], 'Só se altera em rascunho.')
      const { expectedVersion, code, ...rest } = input
      const { v, issues } = normalizeRule(rest, false)
      const productId = 'productId' in v ? v.productId : d.product_id
      const categoryId = 'categoryId' in v ? v.categoryId : d.category_id
      if (productId && categoryId)
        issues.push({
          path: 'categoryId',
          code: 'INVALID',
          message: 'Produto ou categoria, não os dois.',
        })
      const validFrom = (v.validFrom as string) ?? d.vf
      const validTo = 'validTo' in v ? (v.validTo as string | null) : d.vt
      if (validTo && validTo < validFrom)
        issues.push({
          path: 'validTo',
          code: 'INVALID',
          message: 'O fim não pode ser antes do início.',
        })
      fail(issues)
      await checkRefs(scope, v)
      const map: Record<string, string> = {
        name: 'name',
        targetType: 'target_type',
        segmentId: 'segment_id',
        customerId: 'customer_id',
        productId: 'product_id',
        categoryId: 'category_id',
        minQuantity: 'min_quantity',
        discountPct: 'discount_pct',
        validFrom: 'valid_from',
        validTo: 'valid_to',
        priority: 'priority',
        notes: 'notes',
      }
      const sets: string[] = []
      const params: unknown[] = []
      const changes: Record<string, { from: unknown; to: unknown }> = {}
      for (const [k, col] of Object.entries(map))
        if (k in v) {
          sets.push(`${col} = ?`)
          params.push(v[k])
          changes[k] = {
            from: k === 'validFrom' ? d.vf : k === 'validTo' ? d.vt : d[col],
            to: v[k],
          }
        }
      if (sets.length) {
        await scope.trx.rawQuery(
          `update discount_rules set ${sets.join(', ')}, version = version + 1, updated_at = now(), updated_by = ?
            where tenant_id = ? and id = ?`,
          [...params, context.userId, context.tenantId, id] as never[]
        )
        await audit(scope, {
          action: 'discount_rule.updated',
          entityType: 'discount_rule',
          entityId: id,
          changes,
        })
      }
      return ruleDetail(scope, id, a)
    })
  }

  private transition(
    context: TenantContext,
    id: string,
    input: Record<string, unknown>,
    kind: 'submit' | 'approve' | 'reject' | 'deactivate'
  ) {
    return runInTenant(context, async (scope) => {
      const a = await accessOf(scope)
      if (kind === 'submit') need(a.manage, 'Não pode gerir descontos.')
      else if (kind === 'deactivate') need(a.manage || a.approve, 'Não pode gerir descontos.')
      else need(a.approve, 'Não pode aprovar descontos.')
      const d = await loadRow(scope, 'discount_rules', id, true)
      versionCheck(d, input.expectedVersion)
      const t = [context.userId, context.tenantId, id]
      let to: string
      let reason: string | null = null
      if (kind === 'submit') {
        inState(d, ['DRAFT'], 'Só se submete um rascunho.')
        to = 'PENDING'
        await scope.trx.rawQuery(
          `update discount_rules set status = 'PENDING', submitted_by = ?, submitted_at = now(), version = version + 1,
             updated_at = now(), updated_by = ? where tenant_id = ? and id = ?`,
          [context.userId, ...t]
        )
      } else if (kind === 'approve') {
        inState(d, ['PENDING'], 'Só se aprova uma regra submetida.')
        if (d.submitted_by === context.userId)
          throw ApiError.forbidden('SELF_APPROVAL', 'Quem submete não aprova a própria regra.')
        await ruleOverlap(scope, d)
        to = 'ACTIVE'
        await scope.trx.rawQuery(
          `update discount_rules set status = 'ACTIVE', approved_by = ?, approved_at = now(), version = version + 1,
             updated_at = now(), updated_by = ? where tenant_id = ? and id = ?`,
          [context.userId, ...t]
        )
      } else if (kind === 'reject') {
        inState(d, ['PENDING'], 'Só se devolve uma regra submetida.')
        const r = normalizeReason(input, true)
        fail(r.issues)
        reason = r.reason
        to = 'DRAFT'
        await scope.trx.rawQuery(
          `update discount_rules set status = 'DRAFT', submitted_by = null, submitted_at = null, version = version + 1,
             updated_at = now(), updated_by = ? where tenant_id = ? and id = ?`,
          t
        )
      } else {
        inState(d, ['ACTIVE'], 'Só se inactiva uma regra activa.')
        const r = normalizeReason(input, true)
        fail(r.issues)
        reason = r.reason
        to = 'INACTIVE'
        await scope.trx.rawQuery(
          `update discount_rules set status = 'INACTIVE', inactive_reason = ?, version = version + 1, updated_at = now(),
             updated_by = ? where tenant_id = ? and id = ?`,
          [reason, ...t] as never[]
        )
      }
      const past = {
        submit: 'SUBMITTED',
        approve: 'APPROVED',
        reject: 'REJECTED',
        deactivate: 'DEACTIVATED',
      }[kind]
      await event(scope, 'DISCOUNT_RULE', id, past, reason)
      await audit(scope, {
        action: `discount_rule.${past.toLowerCase()}`,
        entityType: 'discount_rule',
        entityId: id,
        changes: { status: { from: d.status, to } },
        metadata: reason ? { reason } : undefined,
      })
      return ruleDetail(scope, id, a)
    })
  }
  submit(c: TenantContext, id: string, i: Record<string, unknown>) {
    return this.transition(c, id, i, 'submit')
  }
  approve(c: TenantContext, id: string, i: Record<string, unknown>) {
    return this.transition(c, id, i, 'approve')
  }
  reject(c: TenantContext, id: string, i: Record<string, unknown>) {
    return this.transition(c, id, i, 'reject')
  }
  deactivate(c: TenantContext, id: string, i: Record<string, unknown>) {
    return this.transition(c, id, i, 'deactivate')
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Limites de desconto manual
// ---------------------------------------------------------------------------------------------------------------

export class DiscountLimitService {
  list(context: TenantContext) {
    return runInTenant(context, async (scope) => {
      const a = await accessOf(scope)
      need(a.read, 'Não pode consultar preços.')
      const rows = (
        await scope.trx.rawQuery(
          `select dl.*, ${TARGET_COLS} from discount_limits dl ${TARGET_JOINS('dl')}
            where dl.tenant_id = ?
            order by case dl.target_type when 'GENERAL' then 0 when 'SEGMENT' then 1 else 2 end, s.code, bp.code`,
          [context.tenantId]
        )
      ).rows as any[]
      return {
        items: rows.map((r) => ({
          id: r.id as string,
          ...targetView(r),
          maxPct: num(r.max_pct, PCT_SCALE)!,
        })),
        canEdit: a.approve,
      }
    })
  }

  /** Define (ou substitui) o limite de um destino. */
  set(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      need((await accessOf(scope)).approve, 'Só quem aprova preços define limites de desconto.')
      const { v, issues } = normalizeLimit(input)
      fail(issues)
      await checkRefs(scope, v)
      await scope.trx.rawQuery('select pg_advisory_xact_lock(hashtext(?))', [
        `discount-limits:${context.tenantId}`,
      ])
      const old = (
        await scope.trx.rawQuery(
          `select id, max_pct from discount_limits where tenant_id = ? and target_type = ?
              and segment_id is not distinct from ? and customer_id is not distinct from ?`,
          [context.tenantId, v.targetType, v.segmentId, v.customerId] as never[]
        )
      ).rows[0] as any
      let id: string
      if (old) {
        id = old.id
        await scope.trx.rawQuery(
          `update discount_limits set max_pct = ?, version = version + 1, updated_at = now(), updated_by = ?
            where tenant_id = ? and id = ?`,
          [v.maxPct, context.userId, context.tenantId, id] as never[]
        )
      } else {
        id = (
          (
            await scope.trx.rawQuery(
              `insert into discount_limits (tenant_id, target_type, segment_id, customer_id, max_pct, created_by, updated_by)
               values (?, ?, ?, ?, ?, ?, ?) returning id`,
              [
                context.tenantId,
                v.targetType,
                v.segmentId,
                v.customerId,
                v.maxPct,
                context.userId,
                context.userId,
              ] as never[]
            )
          ).rows[0] as any
        ).id
      }
      await audit(scope, {
        action: 'discount_limit.set',
        entityType: 'discount_limit',
        entityId: id,
        changes: { maxPct: { from: old ? num(old.max_pct, PCT_SCALE) : null, to: v.maxPct } },
        metadata: { targetType: v.targetType, segmentId: v.segmentId, customerId: v.customerId },
      })
      return { id }
    })
  }

  remove(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      need((await accessOf(scope)).approve, 'Só quem aprova preços define limites de desconto.')
      if (!isUuid(id)) throw ApiError.notFound()
      const old = (
        await scope.trx.rawQuery(
          `delete from discount_limits where tenant_id = ? and id = ? returning *`,
          [context.tenantId, id]
        )
      ).rows[0] as any
      if (!old) throw ApiError.notFound()
      await audit(scope, {
        action: 'discount_limit.removed',
        entityType: 'discount_limit',
        entityId: id,
        changes: { maxPct: { from: num(old.max_pct, PCT_SCALE), to: null } },
        metadata: {
          targetType: old.target_type,
          segmentId: old.segment_id,
          customerId: old.customer_id,
        },
      })
      return { id }
    })
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Resolução (contrato para os documentos de venda)
// ---------------------------------------------------------------------------------------------------------------

export interface PriceRequest {
  customerId: string
  currency: string
  date: string
  legalEntityId?: string | null
  lines: {
    productId: string
    variantId?: string | null
    quantity: string
    manualDiscountPct?: string | null
    manualUnitPrice?: string | null
  }[]
}

/**
 * Resolve preços e descontos e devolve o snapshot que os documentos guardam (com impressão digital). Não escreve nada;
 * erros de dados em 422 com o caminho da linha.
 */
export async function resolvePrices(scope: TenantScope, req: PriceRequest) {
  const t = scope.context.tenantId
  const issues: ErrorDetail[] = []
  const currency = typeof req.currency === 'string' ? req.currency.trim().toUpperCase() : ''
  if (!/^[A-Z]{3}$/.test(currency))
    issues.push({ path: 'currency', code: 'INVALID', message: 'Moeda inválida.' })
  if (typeof req.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(req.date))
    issues.push({ path: 'date', code: 'INVALID', message: 'Data inválida.' })
  const legalEntityId = req.legalEntityId ?? null
  const customer = isUuid(req.customerId)
    ? ((
        await scope.trx.rawQuery(
          `select c.id, c.status, c.segment_id, p.code, p.name from customers c
             join business_partners p on p.tenant_id = c.tenant_id and p.id = c.partner_id
            where c.tenant_id = ? and c.id = ?`,
          [t, req.customerId]
        )
      ).rows[0] as any)
    : null
  if (!customer)
    issues.push({ path: 'customerId', code: 'NOT_FOUND', message: 'Cliente inexistente.' })
  if (legalEntityId !== null) {
    const le = isUuid(legalEntityId)
      ? (
          await scope.trx.rawQuery(`select 1 from legal_entities where tenant_id = ? and id = ?`, [
            t,
            legalEntityId,
          ])
        ).rows[0]
      : null
    if (!le)
      issues.push({ path: 'legalEntityId', code: 'NOT_FOUND', message: 'Entidade inexistente.' })
  }
  if (!Array.isArray(req.lines) || req.lines.length < 1 || req.lines.length > 200)
    issues.push({ path: 'lines', code: 'INVALID', message: 'De 1 a 200 linhas.' })
  fail(issues)

  const limitRows = (
    await scope.trx.rawQuery(
      `select target_type, max_pct from discount_limits where tenant_id = ?
          and (target_type = 'GENERAL' or (target_type = 'SEGMENT' and segment_id = ?) or (target_type = 'CUSTOMER' and customer_id = ?))`,
      [t, customer.segment_id, customer.id] as never[]
    )
  ).rows as any[]
  const lim = (k: string) => {
    const r = limitRows.find((x) => x.target_type === k)
    return r ? dbScaled(r.max_pct, PCT_SCALE) : null
  }
  const limits: Limits = {
    customer: lim('CUSTOMER'),
    segment: lim('SEGMENT'),
    general: lim('GENERAL'),
  }

  const lines = []
  for (const [i, l] of req.lines.entries()) {
    const li: ErrorDetail[] = []
    const qty = parseScaled(l?.quantity, QTY_SCALE)
    if (qty === null || qty === 0n)
      li.push({
        path: `lines.${i}.quantity`,
        code: 'INVALID',
        message: 'Quantidade maior que 0, até 6 casas.',
      })
    const mdp =
      l?.manualDiscountPct === null ||
      l?.manualDiscountPct === undefined ||
      l.manualDiscountPct === ''
        ? null
        : parseScaled(l.manualDiscountPct, PCT_SCALE)
    if (mdp === null && l?.manualDiscountPct && l.manualDiscountPct !== '')
      li.push({
        path: `lines.${i}.manualDiscountPct`,
        code: 'INVALID',
        message: 'Desconto de 0 a 100, 2 casas.',
      })
    if (mdp !== null && mdp > 10_000n)
      li.push({
        path: `lines.${i}.manualDiscountPct`,
        code: 'INVALID',
        message: 'Desconto de 0 a 100, 2 casas.',
      })
    const mup =
      l?.manualUnitPrice === null || l?.manualUnitPrice === undefined || l.manualUnitPrice === ''
        ? null
        : parseScaled(l.manualUnitPrice, PRICE_SCALE)
    if (mup === null && l?.manualUnitPrice && l.manualUnitPrice !== '')
      li.push({
        path: `lines.${i}.manualUnitPrice`,
        code: 'INVALID',
        message: 'Preço ≥ 0, até 4 casas.',
      })
    if (mdp !== null && mup !== null)
      li.push({
        path: `lines.${i}.manualUnitPrice`,
        code: 'INVALID',
        message: 'Desconto ou preço manual, não os dois.',
      })
    const product = isUuid(l?.productId)
      ? ((
          await scope.trx.rawQuery(
            `select id, sku, name, status, category_id, currency, sale_price from products where tenant_id = ? and id = ?`,
            [t, l.productId]
          )
        ).rows[0] as any)
      : null
    if (!product)
      li.push({ path: `lines.${i}.productId`, code: 'NOT_FOUND', message: 'Produto inexistente.' })
    const variantId = l?.variantId ?? null
    const variant =
      product && variantId !== null
        ? isUuid(variantId)
          ? ((
              await scope.trx.rawQuery(
                `select id, sku, sale_price from product_variants where tenant_id = ? and id = ? and product_id = ?`,
                [t, variantId, product.id]
              )
            ).rows[0] as any)
          : null
        : null
    if (variantId !== null && !variant)
      li.push({
        path: `lines.${i}.variantId`,
        code: 'NOT_FOUND',
        message: 'Variante inexistente neste produto.',
      })
    if (li.length) {
      issues.push(...li)
      continue
    }
    const candidates: PriceCandidate[] = (
      (
        await scope.trx.rawQuery(
          `select l.id as list_id, l.code, l.target_type, l.priority, l.valid_from::text as vf, ln.id as line_id,
                  ln.variant_id, ln.min_quantity, ln.unit_price, ln.max_discount_pct
             from price_list_lines ln join price_lists l on l.tenant_id = ln.tenant_id and l.id = ln.price_list_id
            where ln.tenant_id = ? and ln.product_id = ? and l.status = 'ACTIVE' and l.currency = ?
              and l.valid_from <= ?::date and (l.valid_to is null or l.valid_to >= ?::date)
              and (l.legal_entity_id is null or l.legal_entity_id = ?)
              and (l.target_type = 'GENERAL' or (l.target_type = 'SEGMENT' and l.segment_id = ?)
                   or (l.target_type = 'CUSTOMER' and l.customer_id = ?))`,
          [
            t,
            product.id,
            currency,
            req.date,
            req.date,
            legalEntityId,
            customer.segment_id,
            customer.id,
          ] as never[]
        )
      ).rows as any[]
    ).map((r) => ({
      listId: r.list_id,
      listCode: r.code,
      targetType: r.target_type,
      priority: Number(r.priority),
      validFrom: r.vf,
      lineId: r.line_id,
      variantId: r.variant_id ?? null,
      minQuantity: dbScaled(r.min_quantity, QTY_SCALE),
      unitPrice: dbScaled(r.unit_price, PRICE_SCALE),
      maxDiscountPct: r.max_discount_pct === null ? null : dbScaled(r.max_discount_pct, PCT_SCALE),
    }))
    const rules: RuleCandidate[] = (
      (
        await scope.trx.rawQuery(
          `with recursive up as (
             select id, parent_id, 0 as depth from product_categories where tenant_id = ? and id = ?
             union all
             select c.id, c.parent_id, up.depth + 1 from product_categories c join up on c.id = up.parent_id
              where c.tenant_id = ? and up.depth < 20)
           select d.id, d.code, d.target_type, d.priority, d.min_quantity, d.discount_pct, d.product_id, d.category_id
             from discount_rules d
            where d.tenant_id = ? and d.status = 'ACTIVE' and d.valid_from <= ?::date
              and (d.valid_to is null or d.valid_to >= ?::date)
              and (d.target_type = 'ALL' or (d.target_type = 'SEGMENT' and d.segment_id = ?)
                   or (d.target_type = 'CUSTOMER' and d.customer_id = ?))
              and (d.product_id = ? or d.category_id in (select id from up)
                   or (d.product_id is null and d.category_id is null))`,
          [
            t,
            product.category_id,
            t,
            t,
            req.date,
            req.date,
            customer.segment_id,
            customer.id,
            product.id,
          ] as never[]
        )
      ).rows as any[]
    ).map((r) => ({
      ruleId: r.id,
      code: r.code,
      targetType: r.target_type,
      scope: r.product_id ? 'PRODUCT' : r.category_id ? 'CATEGORY' : 'ALL',
      priority: Number(r.priority),
      minQuantity: dbScaled(r.min_quantity, QTY_SCALE),
      pct: dbScaled(r.discount_pct, PCT_SCALE),
    }))
    const catalogRaw = variant?.sale_price ?? product.sale_price
    const catalogPrice =
      catalogRaw !== null &&
      catalogRaw !== undefined &&
      String(product.currency ?? '')
        .trim()
        .toUpperCase() === currency
        ? dbScaled(catalogRaw, PRICE_SCALE)
        : null
    const resolved = resolveLine(
      {
        quantity: qty!,
        variantId: variant?.id ?? null,
        manualDiscountPct: mdp,
        manualUnitPrice: mup,
        catalogPrice,
      },
      candidates,
      rules,
      limits
    )
    lines.push({
      index: i,
      productId: product.id as string,
      sku: product.sku as string,
      name: product.name as string,
      variantId: (variant?.id as string) ?? null,
      variantSku: (variant?.sku as string) ?? null,
      quantity: scaledText(qty!, QTY_SCALE),
      ...resolved,
    })
  }
  fail(issues)
  const data = {
    customer: {
      id: customer.id as string,
      code: customer.code as string,
      name: customer.name as string,
      status: customer.status as string,
      segmentId: (customer.segment_id as string) ?? null,
    },
    currency,
    date: req.date,
    legalEntityId,
    lines,
    requiresApproval: lines.some((l) => l.requiresApproval),
    missingPrices: lines.some((l) => l.source === 'NONE'),
  }
  return { ...data, hash: snapshotHash(data), resolvedAt: new Date().toISOString() }
}

export class PricingService {
  resolve(context: TenantContext, input: PriceRequest) {
    return runInTenant(context, async (scope) => {
      need((await accessOf(scope)).read, 'Não pode consultar preços.')
      return resolvePrices(scope, input)
    })
  }

  /** Pesquisa de clientes e produtos para os formulários de preços (só identificação, sem dados comerciais). */
  search(context: TenantContext, kind: 'customers' | 'products', q: string) {
    return runInTenant(context, async (scope) => {
      need((await accessOf(scope)).read, 'Não pode consultar preços.')
      return searchSalesRefs(scope, kind, q)
    })
  }

  /** Opções para os formulários (segmentos activos, entidades, categorias). Produtos e clientes têm pesquisa própria. */
  options(context: TenantContext) {
    return runInTenant(context, async (scope) => {
      const a = await accessOf(scope)
      need(a.read, 'Não pode consultar preços.')
      const t = context.tenantId
      const q = async (sql: string) => (await scope.trx.rawQuery(sql, [t])).rows as any[]
      return {
        segments: (
          await q(
            `select id, code, name from customer_segments where tenant_id = ? and status = 'ACTIVE' order by code`
          )
        ).map((r) => ({ id: r.id, code: r.code, name: r.name })),
        legalEntities: (
          await q(
            `select id, code, legal_name as name from legal_entities where tenant_id = ? order by code`
          )
        ).map((r) => ({ id: r.id, code: r.code, name: r.name })),
        categories: (
          await q(
            `select id, code, name from product_categories where tenant_id = ? and status = 'ACTIVE' order by code`
          )
        ).map((r) => ({ id: r.id, code: r.code, name: r.name })),
        can: { manage: a.manage, approve: a.approve },
      }
    })
  }
}

/** Pesquisa de clientes e produtos activos (só identificação) para os formulários de vendas. */
export async function searchSalesRefs(
  scope: TenantScope,
  kind: 'customers' | 'products',
  q: string
) {
  const t = scope.context.tenantId
  const like = `%${q.toLowerCase().replace(/[\\%_]/g, (x) => `\\${x}`)}%`
  if (kind === 'customers')
    return (
      (
        await scope.trx.rawQuery(
          `select c.id, p.code, p.name, c.status from customers c
             join business_partners p on p.tenant_id = c.tenant_id and p.id = c.partner_id
            where c.tenant_id = ? and (lower(p.code) like ? or lower(p.name) like ?) order by p.code limit 20`,
          [t, like, like]
        )
      ).rows as any[]
    ).map((r) => ({
      id: r.id as string,
      code: r.code as string,
      name: r.name as string,
      status: r.status as string,
    }))
  const rows = (
    await scope.trx.rawQuery(
      `select p.id, p.sku, p.name, p.currency, p.sale_price::text as price,
              coalesce((select json_agg(json_build_object('id', v.id, 'sku', v.sku) order by v.sku)
                 from product_variants v where v.tenant_id = p.tenant_id and v.product_id = p.id and v.status = 'ACTIVE'), '[]') as variants
         from products p where p.tenant_id = ? and p.status = 'ACTIVE' and (lower(p.sku) like ? or lower(p.name) like ?)
        order by p.sku limit 20`,
      [t, like, like]
    )
  ).rows as any[]
  return rows.map((r) => ({
    id: r.id as string,
    sku: r.sku as string,
    name: r.name as string,
    currency: r.currency ? String(r.currency).trim() : null,
    salePrice: r.price === null ? null : scaledText(dbScaled(r.price, PRICE_SCALE), PRICE_SCALE),
    variants: r.variants as { id: string; sku: string }[],
  }))
}
