import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { effectivePermissions } from '#modules/rbac/index'
import { dbScaled, scaledText } from '#modules/sales/domain/pricing'
import {
  computeTaxes,
  type DocumentKind,
  type EngineLine,
  formatFiscalNumber,
  issueDateIssue,
  normalizeExemption,
  normalizeRate,
  normalizeSeries,
  normalizeTaxCode,
  ROUNDING_LEVELS,
  type RoundingLevel,
} from '#modules/sales/domain/fiscal'

/*
 * Motor fiscal e séries fiscais (10.5). Permissões da empresa: `sales.fiscal.read`, `.manage` (códigos, taxas e
 * isenções em rascunho, séries, arredondamento) e `.confirm` (confirmar ou retirar taxas e isenções preparadas por
 * outra pessoa). Os documentos (10.6+) usam `resolveTaxes` (só valores confirmados e em vigor) e `allocateFiscalNumber`
 * (sequência sem saltos, cronológica, na transacção do documento).
 */

const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
interface Access {
  read: boolean
  manage: boolean
  confirm: boolean
}
async function accessOf(scope: TenantScope): Promise<Access> {
  const held = (await effectivePermissions(scope)).tenant
  const manage = held.has('sales.fiscal.manage')
  const confirm = held.has('sales.fiscal.confirm')
  return { read: manage || confirm || held.has('sales.fiscal.read'), manage, confirm }
}
const need = (ok: boolean, message: string) => {
  if (!ok) throw ApiError.forbidden('OUT_OF_SCOPE', message)
}
const versionCheck = (row: any, expected: unknown) => {
  if (Number(row.version) !== Number(expected)) throw ApiError.versionConflict(Number(row.version))
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
const reasonOf = (v: unknown) => {
  const r = typeof v === 'string' ? v.trim() : ''
  if (r.length < 3 || r.length > 500)
    fail([{ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo (3 a 500).' }])
  return r
}
const num = (v: unknown, scale: number) =>
  v === null || v === undefined ? null : scaledText(dbScaled(v, scale), scale)
const at = (v: unknown) => (v ? new Date(v as string).toISOString() : null)

async function load(scope: TenantScope, table: string, id: string, lock = false) {
  if (!isUuid(id)) throw ApiError.notFound()
  const r = (
    await scope.trx.rawQuery(
      `select *${table === 'tax_rates' ? ', valid_from::text as vf, valid_to::text as vt' : ''}${table === 'fiscal_series' ? ', last_issue_date::text as lid' : ''}
         from ${table} where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
      [scope.context.tenantId, id]
    )
  ).rows[0] as any
  if (!r) throw ApiError.notFound()
  return r
}
async function update(
  scope: TenantScope,
  table: string,
  id: string,
  fields: Record<string, unknown>
) {
  const cols = Object.keys(fields)
  await scope.trx.rawQuery(
    `update ${table} set ${cols.map((c) => `${c} = ?`).join(', ')}, version = version + 1, updated_at = now(), updated_by = ?
      where tenant_id = ? and id = ?`,
    [...cols.map((c) => fields[c]), scope.context.userId, scope.context.tenantId, id] as never[]
  )
}

function rateView(r: any, a: Access, me: string) {
  return {
    id: r.id as string,
    version: Number(r.version),
    legalEntity: r.legal_entity_id
      ? { id: r.legal_entity_id as string, code: r.le_code as string }
      : null,
    validFrom: r.vf as string,
    validTo: (r.vt as string) ?? null,
    rate: num(r.rate, 4)!,
    minBase: num(r.min_base, 2),
    legalSource: r.legal_source as string,
    notes: (r.notes as string) ?? null,
    status: r.status as string,
    createdBy: (r.creator as string) ?? null,
    confirmedBy: (r.confirmer as string) ?? null,
    confirmedAt: at(r.confirmed_at),
    retiredReason: (r.retired_reason as string) ?? null,
    can: {
      edit: a.manage && r.status === 'DRAFT',
      confirm: a.confirm && r.status === 'DRAFT' && r.created_by !== me,
      retire: a.confirm && r.status === 'CONFIRMED',
    },
  }
}
function exemptionView(r: any, a: Access, me: string) {
  return {
    id: r.id as string,
    version: Number(r.version),
    countryCode: String(r.country_code).trim(),
    code: r.code as string,
    description: r.description as string,
    legalSource: r.legal_source as string,
    status: r.status as string,
    createdBy: (r.creator as string) ?? null,
    confirmedBy: (r.confirmer as string) ?? null,
    confirmedAt: at(r.confirmed_at),
    retiredReason: (r.retired_reason as string) ?? null,
    can: {
      edit: a.manage && r.status === 'DRAFT',
      confirm: a.confirm && r.status === 'DRAFT' && r.created_by !== me,
      retire: a.confirm && r.status === 'CONFIRMED',
    },
  }
}
function seriesView(r: any, a: Access) {
  return {
    id: r.id as string,
    version: Number(r.version),
    legalEntity: { id: r.legal_entity_id as string, code: r.le_code as string },
    documentKind: r.document_kind as DocumentKind,
    fiscalCode: r.fiscal_code as string,
    code: r.code as string,
    fiscalYear: Number(r.fiscal_year),
    prefix: r.prefix as string,
    padding: Number(r.padding),
    nextNumber: Number(r.next_number),
    next: formatFiscalNumber(r.prefix, Number(r.next_number), Number(r.padding)),
    lastIssueDate: (r.lid as string) ?? null,
    issued: Number(r.next_number) - 1,
    mode: r.mode as string,
    status: r.status as string,
    authorityReference: (r.authority_reference as string) ?? null,
    closedReason: (r.closed_reason as string) ?? null,
    can: {
      edit: a.manage && r.status === 'DRAFT',
      activate: a.manage && r.status === 'DRAFT',
      close: a.manage && r.status === 'ACTIVE',
    },
  }
}

const RATE_SELECT = `select r.*, r.valid_from::text as vf, r.valid_to::text as vt, le.code as le_code,
    cu.full_name as creator, fu.full_name as confirmer
  from tax_rates r left join legal_entities le on le.tenant_id = r.tenant_id and le.id = r.legal_entity_id
  left join users cu on cu.id = r.created_by left join users fu on fu.id = r.confirmed_by`
const EX_SELECT = `select x.*, cu.full_name as creator, fu.full_name as confirmer from tax_exemptions x
  left join users cu on cu.id = x.created_by left join users fu on fu.id = x.confirmed_by`
const SERIES_SELECT = `select s.*, s.last_issue_date::text as lid, le.code as le_code from fiscal_series s
  join legal_entities le on le.tenant_id = s.tenant_id and le.id = s.legal_entity_id`

async function codeDetail(scope: TenantScope, id: string, a: Access) {
  const c = await load(scope, 'tax_codes', id)
  const rates = (
    await scope.trx.rawQuery(
      `${RATE_SELECT} where r.tenant_id = ? and r.tax_code_id = ? order by r.valid_from desc, r.created_at`,
      [scope.context.tenantId, id]
    )
  ).rows as any[]
  return {
    id: c.id as string,
    version: Number(c.version),
    countryCode: String(c.country_code).trim(),
    code: c.code as string,
    name: c.name as string,
    kind: c.kind as string,
    taxType: c.tax_type as string,
    status: c.status as string,
    rates: rates.map((r) => rateView(r, a, scope.context.userId)),
    can: { manage: a.manage, confirm: a.confirm },
  }
}

export class FiscalService {
  // --- códigos e taxas -------------------------------------------------------------------------------------------
  codes(context: TenantContext) {
    return runInTenant(context, async (scope) => {
      const a = await accessOf(scope)
      need(a.read, 'Não pode consultar a configuração fiscal.')
      const rows = (
        await scope.trx.rawQuery(
          `select c.*, (select count(*)::int from tax_rates r where r.tenant_id = c.tenant_id and r.tax_code_id = c.id and r.status = 'CONFIRMED') as confirmed,
                  (select count(*)::int from tax_rates r where r.tenant_id = c.tenant_id and r.tax_code_id = c.id and r.status = 'DRAFT') as drafts
             from tax_codes c where c.tenant_id = ? order by c.country_code, c.kind, c.code`,
          [context.tenantId]
        )
      ).rows as any[]
      return {
        items: rows.map((c) => ({
          id: c.id as string,
          countryCode: String(c.country_code).trim(),
          code: c.code as string,
          name: c.name as string,
          kind: c.kind as string,
          taxType: c.tax_type as string,
          status: c.status as string,
          confirmedRates: Number(c.confirmed),
          draftRates: Number(c.drafts),
        })),
        can: { manage: a.manage, confirm: a.confirm },
      }
    })
  }

  code(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const a = await accessOf(scope)
      need(a.read, 'Não pode consultar a configuração fiscal.')
      return codeDetail(scope, id, a)
    })
  }

  createCode(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const a = await accessOf(scope)
      need(a.manage, 'Não pode gerir a configuração fiscal.')
      const { v, issues } = normalizeTaxCode(input, true)
      fail(issues)
      const ins = await unique(
        () =>
          scope.trx.rawQuery(
            `insert into tax_codes (tenant_id, country_code, code, name, kind, tax_type, created_by, updated_by)
             values (?, ?, ?, ?, ?, ?, ?, ?) returning id`,
            [
              context.tenantId,
              v.countryCode,
              v.code,
              v.name,
              v.kind,
              v.taxType,
              context.userId,
              context.userId,
            ] as never[]
          ),
        'tax_codes_code',
        'CODE_TAKEN',
        'Já existe este código neste país.'
      )
      const id = (ins.rows[0] as any).id as string
      await audit(scope, {
        action: 'tax_code.created',
        entityType: 'tax_code',
        entityId: id,
        changes: { code: { from: null, to: v.code }, kind: { from: null, to: v.kind } },
      })
      return codeDetail(scope, id, a)
    })
  }

  updateCode(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const a = await accessOf(scope)
      need(a.manage, 'Não pode gerir a configuração fiscal.')
      const c = await load(scope, 'tax_codes', id, true)
      versionCheck(c, input.expectedVersion)
      const { v, issues } = normalizeTaxCode(
        {
          ...('name' in input ? { name: input.name } : {}),
          ...('status' in input ? { status: input.status } : {}),
        },
        false
      )
      fail(issues)
      const fields: Record<string, unknown> = {}
      if ('name' in v) fields.name = v.name
      if ('status' in v) fields.status = v.status
      if (Object.keys(fields).length) {
        await update(scope, 'tax_codes', id, fields)
        await audit(scope, {
          action: 'tax_code.updated',
          entityType: 'tax_code',
          entityId: id,
          changes: Object.fromEntries(
            Object.entries(fields).map(([k, x]) => [k, { from: c[k], to: x }])
          ),
        })
      }
      return codeDetail(scope, id, a)
    })
  }

  addRate(context: TenantContext, codeId: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const a = await accessOf(scope)
      need(a.manage, 'Não pode gerir a configuração fiscal.')
      const c = await load(scope, 'tax_codes', codeId, true)
      const { v, issues } = normalizeRate(input, true)
      fail(issues)
      if (v.legalEntityId) {
        const le = (
          await scope.trx.rawQuery(
            `select country_code from legal_entities where tenant_id = ? and id = ?`,
            [context.tenantId, v.legalEntityId as string]
          )
        ).rows[0] as any
        if (!le)
          fail([{ path: 'legalEntityId', code: 'NOT_FOUND', message: 'Entidade inexistente.' }])
        if (String(le.country_code).trim() !== String(c.country_code).trim())
          fail([
            {
              path: 'legalEntityId',
              code: 'COUNTRY_MISMATCH',
              message: 'A entidade é de outro país.',
            },
          ])
      }
      const ins = await scope.trx.rawQuery(
        `insert into tax_rates (tenant_id, tax_code_id, legal_entity_id, valid_from, valid_to, rate, min_base, legal_source, notes,
           created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          context.tenantId,
          codeId,
          v.legalEntityId ?? null,
          v.validFrom,
          v.validTo ?? null,
          v.rate,
          v.minBase ?? null,
          v.legalSource,
          v.notes ?? null,
          context.userId,
          context.userId,
        ] as never[]
      )
      const id = (ins.rows[0] as any).id as string
      await audit(scope, {
        action: 'tax_rate.created',
        entityType: 'tax_code',
        entityId: codeId,
        changes: { rate: { from: null, to: v.rate } },
        metadata: { rateId: id, validFrom: v.validFrom, legalSource: v.legalSource },
      })
      return codeDetail(scope, codeId, a)
    })
  }

  updateRate(context: TenantContext, rateId: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const a = await accessOf(scope)
      need(a.manage, 'Não pode gerir a configuração fiscal.')
      const r = await load(scope, 'tax_rates', rateId, true)
      versionCheck(r, input.expectedVersion)
      if (r.status !== 'DRAFT')
        throw ApiError.conflict(
          'INVALID_STATE',
          'Só se altera uma taxa em rascunho: confirmada, cria-se uma nova vigência.'
        )
      const { expectedVersion, legalEntityId, ...rest } = input
      const { v, issues } = normalizeRate(rest, false)
      const from = (v.validFrom as string) ?? r.vf
      const to = 'validTo' in v ? (v.validTo as string | null) : r.vt
      if (to && to < from)
        issues.push({
          path: 'validTo',
          code: 'INVALID',
          message: 'O fim não pode ser antes do início.',
        })
      fail(issues)
      const map: Record<string, string> = {
        validFrom: 'valid_from',
        validTo: 'valid_to',
        rate: 'rate',
        minBase: 'min_base',
        legalSource: 'legal_source',
        notes: 'notes',
      }
      const fields = Object.fromEntries(
        Object.entries(map)
          .filter(([k]) => k in v)
          .map(([k, col]) => [col, v[k]])
      )
      if (Object.keys(fields).length) await update(scope, 'tax_rates', rateId, fields)
      await audit(scope, {
        action: 'tax_rate.updated',
        entityType: 'tax_code',
        entityId: r.tax_code_id,
        metadata: { rateId, fields: Object.keys(fields) },
      })
      return codeDetail(scope, r.tax_code_id, a)
    })
  }

  deleteRate(context: TenantContext, rateId: string) {
    return runInTenant(context, async (scope) => {
      const a = await accessOf(scope)
      need(a.manage, 'Não pode gerir a configuração fiscal.')
      const r = await load(scope, 'tax_rates', rateId, true)
      if (r.status !== 'DRAFT')
        throw ApiError.conflict('INVALID_STATE', 'Só se apaga uma taxa em rascunho.')
      await scope.trx.rawQuery(`delete from tax_rates where tenant_id = ? and id = ?`, [
        context.tenantId,
        rateId,
      ])
      await audit(scope, {
        action: 'tax_rate.deleted',
        entityType: 'tax_code',
        entityId: r.tax_code_id,
        metadata: { rateId },
      })
      return codeDetail(scope, r.tax_code_id, a)
    })
  }

  /** Confirmar (outra pessoa): a vigência não pode sobrepor-se a outra confirmada do mesmo código e âmbito. */
  confirmRate(context: TenantContext, rateId: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const a = await accessOf(scope)
      need(a.confirm, 'Não pode confirmar valores fiscais.')
      const r = await load(scope, 'tax_rates', rateId, true)
      versionCheck(r, input.expectedVersion)
      if (r.status !== 'DRAFT')
        throw ApiError.conflict('INVALID_STATE', 'Só se confirma uma taxa em rascunho.')
      if (r.created_by === context.userId)
        throw ApiError.forbidden('SELF_CONFIRMATION', 'Quem prepara não confirma o próprio valor.')
      await scope.trx.rawQuery('select pg_advisory_xact_lock(hashtext(?))', [
        `tax-rates:${context.tenantId}:${r.tax_code_id}`,
      ])
      const other = (
        await scope.trx.rawQuery(
          `select valid_from::text as vf from tax_rates where tenant_id = ? and tax_code_id = ? and id <> ? and status = 'CONFIRMED'
              and legal_entity_id is not distinct from ? and daterange(valid_from, valid_to, '[]') && daterange(?::date, ?::date, '[]') limit 1`,
          [context.tenantId, r.tax_code_id, rateId, r.legal_entity_id, r.vf, r.vt] as never[]
        )
      ).rows[0] as any
      if (other)
        throw new ApiError(
          409,
          'OVERLAP',
          `Já há uma taxa confirmada desde ${other.vf} que se sobrepõe: retire-a ou feche a sua vigência.`,
          [{ path: 'validFrom', code: 'OVERLAP', message: 'Vigência sobreposta.' }]
        )
      await update(scope, 'tax_rates', rateId, {
        status: 'CONFIRMED',
        confirmed_by: context.userId,
        confirmed_at: new Date(),
      })
      await audit(scope, {
        action: 'tax_rate.confirmed',
        entityType: 'tax_code',
        entityId: r.tax_code_id,
        metadata: { rateId, rate: num(r.rate, 4), validFrom: r.vf, legalSource: r.legal_source },
      })
      return codeDetail(scope, r.tax_code_id, a)
    })
  }

  retireRate(context: TenantContext, rateId: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const a = await accessOf(scope)
      need(a.confirm, 'Não pode confirmar valores fiscais.')
      const r = await load(scope, 'tax_rates', rateId, true)
      versionCheck(r, input.expectedVersion)
      if (r.status !== 'CONFIRMED')
        throw ApiError.conflict('INVALID_STATE', 'Só se retira uma taxa confirmada.')
      const reason = reasonOf(input.reason)
      await update(scope, 'tax_rates', rateId, { status: 'RETIRED', retired_reason: reason })
      await audit(scope, {
        action: 'tax_rate.retired',
        entityType: 'tax_code',
        entityId: r.tax_code_id,
        metadata: { rateId, reason },
      })
      return codeDetail(scope, r.tax_code_id, a)
    })
  }

  // --- isenções --------------------------------------------------------------------------------------------------
  exemptions(context: TenantContext) {
    return runInTenant(context, async (scope) => {
      const a = await accessOf(scope)
      need(a.read, 'Não pode consultar a configuração fiscal.')
      const rows = (
        await scope.trx.rawQuery(
          `${EX_SELECT} where x.tenant_id = ? order by x.country_code, x.code`,
          [context.tenantId]
        )
      ).rows as any[]
      return {
        items: rows.map((x) => exemptionView(x, a, context.userId)),
        can: { manage: a.manage, confirm: a.confirm },
      }
    })
  }
  private exemption(scope: TenantScope, id: string, a: Access) {
    return scope.trx
      .rawQuery(`${EX_SELECT} where x.tenant_id = ? and x.id = ?`, [scope.context.tenantId, id])
      .then((r) => exemptionView(r.rows[0], a, scope.context.userId))
  }

  createExemption(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const a = await accessOf(scope)
      need(a.manage, 'Não pode gerir a configuração fiscal.')
      const { v, issues } = normalizeExemption(input, true)
      fail(issues)
      const ins = await unique(
        () =>
          scope.trx.rawQuery(
            `insert into tax_exemptions (tenant_id, country_code, code, description, legal_source, created_by, updated_by)
             values (?, ?, ?, ?, ?, ?, ?) returning id`,
            [
              context.tenantId,
              v.countryCode,
              v.code,
              v.description,
              v.legalSource,
              context.userId,
              context.userId,
            ] as never[]
          ),
        'tax_exemptions_code',
        'CODE_TAKEN',
        'Já existe este motivo de isenção neste país.'
      )
      const id = (ins.rows[0] as any).id as string
      await audit(scope, {
        action: 'tax_exemption.created',
        entityType: 'tax_exemption',
        entityId: id,
        changes: { code: { from: null, to: v.code } },
        metadata: { legalSource: v.legalSource },
      })
      return this.exemption(scope, id, a)
    })
  }

  updateExemption(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const a = await accessOf(scope)
      need(a.manage, 'Não pode gerir a configuração fiscal.')
      const x = await load(scope, 'tax_exemptions', id, true)
      versionCheck(x, input.expectedVersion)
      if (x.status !== 'DRAFT')
        throw ApiError.conflict('INVALID_STATE', 'Só se altera em rascunho.')
      const { v, issues } = normalizeExemption(
        {
          ...('description' in input ? { description: input.description } : {}),
          ...('legalSource' in input ? { legalSource: input.legalSource } : {}),
        },
        false
      )
      fail(issues)
      const fields: Record<string, unknown> = {}
      if ('description' in v) fields.description = v.description
      if ('legalSource' in v) fields.legal_source = v.legalSource
      if (Object.keys(fields).length) await update(scope, 'tax_exemptions', id, fields)
      await audit(scope, {
        action: 'tax_exemption.updated',
        entityType: 'tax_exemption',
        entityId: id,
        metadata: { fields: Object.keys(fields) },
      })
      return this.exemption(scope, id, a)
    })
  }

  decideExemption(
    context: TenantContext,
    id: string,
    input: Record<string, unknown>,
    action: 'confirm' | 'retire'
  ) {
    return runInTenant(context, async (scope) => {
      const a = await accessOf(scope)
      need(a.confirm, 'Não pode confirmar valores fiscais.')
      const x = await load(scope, 'tax_exemptions', id, true)
      versionCheck(x, input.expectedVersion)
      if (action === 'confirm') {
        if (x.status !== 'DRAFT')
          throw ApiError.conflict('INVALID_STATE', 'Só se confirma em rascunho.')
        if (x.created_by === context.userId)
          throw ApiError.forbidden(
            'SELF_CONFIRMATION',
            'Quem prepara não confirma o próprio valor.'
          )
        await update(scope, 'tax_exemptions', id, {
          status: 'CONFIRMED',
          confirmed_by: context.userId,
          confirmed_at: new Date(),
        })
      } else {
        if (x.status !== 'CONFIRMED')
          throw ApiError.conflict('INVALID_STATE', 'Só se retira um motivo confirmado.')
        await update(scope, 'tax_exemptions', id, {
          status: 'RETIRED',
          retired_reason: reasonOf(input.reason),
        })
      }
      await audit(scope, {
        action: `tax_exemption.${action === 'confirm' ? 'confirmed' : 'retired'}`,
        entityType: 'tax_exemption',
        entityId: id,
        metadata: { code: x.code },
      })
      return this.exemption(scope, id, a)
    })
  }

  // --- arredondamento --------------------------------------------------------------------------------------------
  settings(context: TenantContext) {
    return runInTenant(context, async (scope) => {
      const a = await accessOf(scope)
      need(a.read, 'Não pode consultar a configuração fiscal.')
      const rows = (
        await scope.trx.rawQuery(
          `select le.id, le.code, le.legal_name, le.country_code, coalesce(s.rounding_level, 'LINE') as rounding
             from legal_entities le left join tax_settings s on s.tenant_id = le.tenant_id and s.legal_entity_id = le.id
            where le.tenant_id = ? order by le.code`,
          [context.tenantId]
        )
      ).rows as any[]
      return {
        items: rows.map((r) => ({
          legalEntityId: r.id as string,
          code: r.code as string,
          name: r.legal_name as string,
          countryCode: String(r.country_code).trim(),
          roundingLevel: r.rounding as RoundingLevel,
        })),
        can: { manage: a.manage },
      }
    })
  }

  setRounding(context: TenantContext, legalEntityId: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      need((await accessOf(scope)).manage, 'Não pode gerir a configuração fiscal.')
      if (!(ROUNDING_LEVELS as readonly unknown[]).includes(input.roundingLevel))
        fail([{ path: 'roundingLevel', code: 'INVALID', message: 'Por linha ou por documento.' }])
      if (
        !isUuid(legalEntityId) ||
        !(
          await scope.trx.rawQuery(`select 1 from legal_entities where tenant_id = ? and id = ?`, [
            context.tenantId,
            legalEntityId,
          ])
        ).rows[0]
      )
        throw ApiError.notFound()
      const old = (
        await scope.trx.rawQuery(
          `select rounding_level from tax_settings where tenant_id = ? and legal_entity_id = ?`,
          [context.tenantId, legalEntityId]
        )
      ).rows[0] as any
      await scope.trx.rawQuery(
        `insert into tax_settings (tenant_id, legal_entity_id, rounding_level, created_by, updated_by) values (?, ?, ?, ?, ?)
         on conflict (tenant_id, legal_entity_id) do update set rounding_level = excluded.rounding_level, version = tax_settings.version + 1,
           updated_at = now(), updated_by = excluded.updated_by`,
        [
          context.tenantId,
          legalEntityId,
          input.roundingLevel,
          context.userId,
          context.userId,
        ] as never[]
      )
      await audit(scope, {
        action: 'tax_settings.updated',
        entityType: 'legal_entity',
        entityId: legalEntityId,
        changes: {
          roundingLevel: { from: old?.rounding_level ?? 'LINE', to: input.roundingLevel },
        },
      })
      return { legalEntityId, roundingLevel: input.roundingLevel }
    })
  }

  // --- séries fiscais --------------------------------------------------------------------------------------------
  series(context: TenantContext) {
    return runInTenant(context, async (scope) => {
      const a = await accessOf(scope)
      need(a.read, 'Não pode consultar a configuração fiscal.')
      const rows = (
        await scope.trx.rawQuery(
          `${SERIES_SELECT} where s.tenant_id = ? order by s.fiscal_year desc, le.code, s.document_kind, s.code`,
          [context.tenantId]
        )
      ).rows as any[]
      return { items: rows.map((r) => seriesView(r, a)), can: { manage: a.manage } }
    })
  }
  private oneSeries(scope: TenantScope, id: string, a: Access) {
    return scope.trx
      .rawQuery(`${SERIES_SELECT} where s.tenant_id = ? and s.id = ?`, [scope.context.tenantId, id])
      .then((r) => seriesView(r.rows[0], a))
  }

  seriesNumbers(context: TenantContext, id: string, f: { limit: number; offset: number }) {
    return runInTenant(context, async (scope) => {
      need((await accessOf(scope)).read, 'Não pode consultar a configuração fiscal.')
      await load(scope, 'fiscal_series', id)
      const rows = (
        await scope.trx.rawQuery(
          `select number, formatted, issue_date::text as d, document_type, document_id, created_at from fiscal_numbers
            where tenant_id = ? and series_id = ? order by number desc limit ? offset ?`,
          [context.tenantId, id, f.limit, f.offset]
        )
      ).rows as any[]
      const total = Number(
        (
          (
            await scope.trx.rawQuery(
              `select count(*)::int as n from fiscal_numbers where tenant_id = ? and series_id = ?`,
              [context.tenantId, id]
            )
          ).rows[0] as any
        ).n
      )
      return {
        items: rows.map((r) => ({
          number: Number(r.number),
          formatted: r.formatted as string,
          issueDate: r.d as string,
          documentType: r.document_type as string,
          documentId: r.document_id as string,
          at: at(r.created_at),
        })),
        total,
      }
    })
  }

  createSeries(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const a = await accessOf(scope)
      need(a.manage, 'Não pode gerir a configuração fiscal.')
      const { v, issues } = normalizeSeries(input, true)
      fail(issues)
      if (
        !(
          await scope.trx.rawQuery(`select 1 from legal_entities where tenant_id = ? and id = ?`, [
            context.tenantId,
            v.legalEntityId as string,
          ])
        ).rows[0]
      )
        fail([{ path: 'legalEntityId', code: 'NOT_FOUND', message: 'Entidade inexistente.' }])
      const ins = await unique(
        () =>
          scope.trx.rawQuery(
            `insert into fiscal_series (tenant_id, legal_entity_id, document_kind, fiscal_code, code, fiscal_year, prefix, padding,
               authority_reference, created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
            [
              context.tenantId,
              v.legalEntityId,
              v.documentKind,
              v.fiscalCode,
              v.code,
              v.fiscalYear,
              v.prefix,
              v.padding ?? 0,
              v.authorityReference ?? null,
              context.userId,
              context.userId,
            ] as never[]
          ),
        'fiscal_series_code',
        'CODE_TAKEN',
        'Já existe uma série com este código nesta entidade.'
      )
      const id = (ins.rows[0] as any).id as string
      await audit(scope, {
        action: 'fiscal_series.created',
        entityType: 'fiscal_series',
        entityId: id,
        changes: { code: { from: null, to: v.code } },
        metadata: { mode: 'SIMULATION' },
      })
      return this.oneSeries(scope, id, a)
    })
  }

  updateSeries(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const a = await accessOf(scope)
      need(a.manage, 'Não pode gerir a configuração fiscal.')
      const s = await load(scope, 'fiscal_series', id, true)
      versionCheck(s, input.expectedVersion)
      const { expectedVersion, legalEntityId, ...rest } = input
      const { v, issues } = normalizeSeries(rest, false)
      fail(issues)
      if (s.status !== 'DRAFT' && Object.keys(v).some((k) => k !== 'authorityReference'))
        throw ApiError.conflict(
          'INVALID_STATE',
          'Activa, a série só aceita a referência da comunicação à autoridade.'
        )
      const map: Record<string, string> = {
        documentKind: 'document_kind',
        fiscalCode: 'fiscal_code',
        code: 'code',
        fiscalYear: 'fiscal_year',
        prefix: 'prefix',
        padding: 'padding',
        authorityReference: 'authority_reference',
      }
      const fields = Object.fromEntries(
        Object.entries(map)
          .filter(([k]) => k in v)
          .map(([k, col]) => [col, v[k]])
      )
      if (Object.keys(fields).length)
        await unique(
          () => update(scope, 'fiscal_series', id, fields),
          'fiscal_series_code',
          'CODE_TAKEN',
          'Já existe uma série com este código nesta entidade.'
        )
      await audit(scope, {
        action: 'fiscal_series.updated',
        entityType: 'fiscal_series',
        entityId: id,
        metadata: { fields: Object.keys(fields) },
      })
      return this.oneSeries(scope, id, a)
    })
  }

  activateSeries(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const a = await accessOf(scope)
      need(a.manage, 'Não pode gerir a configuração fiscal.')
      const s = await load(scope, 'fiscal_series', id, true)
      versionCheck(s, input.expectedVersion)
      if (s.status !== 'DRAFT')
        throw ApiError.conflict('INVALID_STATE', 'Só se activa uma série em rascunho.')
      await update(scope, 'fiscal_series', id, { status: 'ACTIVE' })
      await audit(scope, {
        action: 'fiscal_series.activated',
        entityType: 'fiscal_series',
        entityId: id,
        metadata: { mode: s.mode },
      })
      return this.oneSeries(scope, id, a)
    })
  }

  closeSeries(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const a = await accessOf(scope)
      need(a.manage, 'Não pode gerir a configuração fiscal.')
      const s = await load(scope, 'fiscal_series', id, true)
      versionCheck(s, input.expectedVersion)
      if (s.status !== 'ACTIVE')
        throw ApiError.conflict('INVALID_STATE', 'Só se fecha uma série activa.')
      const reason = reasonOf(input.reason)
      await update(scope, 'fiscal_series', id, { status: 'CLOSED', closed_reason: reason })
      await audit(scope, {
        action: 'fiscal_series.closed',
        entityType: 'fiscal_series',
        entityId: id,
        metadata: { reason, lastNumber: Number(s.next_number) - 1 },
      })
      return this.oneSeries(scope, id, a)
    })
  }

  // --- simulação do cálculo --------------------------------------------------------------------------------------
  simulate(context: TenantContext, input: TaxRequest) {
    return runInTenant(context, async (scope) => {
      need((await accessOf(scope)).read, 'Não pode consultar a configuração fiscal.')
      return resolveTaxes(scope, input)
    })
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Contratos para os documentos de venda
// ---------------------------------------------------------------------------------------------------------------

export interface TaxRequest {
  legalEntityId: string
  date: string
  lines: { key: string; netAmount: string; taxCodeIds: string[]; exemptionCode?: string | null }[]
}

/**
 * Impostos de um documento: para cada código, a taxa confirmada em vigor na data (a da entidade antes da do país);
 * uma taxa de imposto a 0 % exige um motivo de isenção confirmado. Devolve o cálculo do motor e as taxas usadas.
 */
export async function resolveTaxes(scope: TenantScope, req: TaxRequest) {
  const t = scope.context.tenantId
  const issues: ErrorDetail[] = []
  if (typeof req.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(req.date))
    issues.push({ path: 'date', code: 'INVALID', message: 'Data inválida.' })
  const le = isUuid(req.legalEntityId)
    ? ((
        await scope.trx.rawQuery(
          `select id, country_code from legal_entities where tenant_id = ? and id = ?`,
          [t, req.legalEntityId]
        )
      ).rows[0] as any)
    : null
  if (!le)
    issues.push({ path: 'legalEntityId', code: 'NOT_FOUND', message: 'Entidade inexistente.' })
  if (!Array.isArray(req.lines) || !req.lines.length || req.lines.length > 500)
    issues.push({ path: 'lines', code: 'INVALID', message: 'De 1 a 500 linhas.' })
  fail(issues)
  const country = String(le.country_code).trim()
  const rounding = ((
    (
      await scope.trx.rawQuery(
        `select rounding_level from tax_settings where tenant_id = ? and legal_entity_id = ?`,
        [t, le.id]
      )
    ).rows[0] as any
  )?.rounding_level ?? 'LINE') as RoundingLevel
  const ids = [
    ...new Set(req.lines.flatMap((l) => (Array.isArray(l.taxCodeIds) ? l.taxCodeIds : []))),
  ].filter((x) => isUuid(x))
  const rates = ids.length
    ? ((
        await scope.trx.rawQuery(
          `select distinct on (c.id) c.id as code_id, c.code, c.kind, c.country_code, c.status as code_status, r.id as rate_id, r.rate, r.min_base, r.legal_source
             from tax_codes c join tax_rates r on r.tenant_id = c.tenant_id and r.tax_code_id = c.id
            where c.tenant_id = ? and c.id in (${ids.map(() => '?').join(', ')}) and r.status = 'CONFIRMED'
              and r.valid_from <= ?::date and (r.valid_to is null or r.valid_to >= ?::date)
              and (r.legal_entity_id is null or r.legal_entity_id = ?)
            order by c.id, (r.legal_entity_id is null), r.valid_from desc`,
          [t, ...ids, req.date, req.date, le.id]
        )
      ).rows as any[])
    : []
  const exemptions = new Set(
    (
      (
        await scope.trx.rawQuery(
          `select code from tax_exemptions where tenant_id = ? and country_code = ? and status = 'CONFIRMED'`,
          [t, country]
        )
      ).rows as any[]
    ).map((x) => x.code as string)
  )
  const lines: EngineLine[] = []
  req.lines.forEach((l, i) => {
    const p = (k: string) => `lines.${i}.${k}`
    const at0 = issues.length
    if (typeof l?.netAmount !== 'string' || !/^\d{1,14}(\.\d{1,2})?$/.test(l.netAmount))
      issues.push({
        path: p('netAmount'),
        code: 'INVALID',
        message: 'Base ≥ 0, 2 casas, em texto.',
      })
    const codeIds = Array.isArray(l?.taxCodeIds) ? l.taxCodeIds : []
    if (!codeIds.length)
      issues.push({
        path: p('taxCodeIds'),
        code: 'REQUIRED',
        message: 'Indique o imposto da linha (pode ser isento).',
      })
    const taxes = codeIds.map((id) => {
      const r = rates.find((x) => x.code_id === id)
      if (!r) {
        issues.push({
          path: p('taxCodeIds'),
          code: 'NO_RATE',
          message: 'Imposto sem taxa confirmada em vigor nesta data para esta entidade.',
        })
        return null
      }
      if (String(r.country_code).trim() !== country || r.code_status !== 'ACTIVE')
        issues.push({
          path: p('taxCodeIds'),
          code: 'NOT_APPLICABLE',
          message: `O imposto ${r.code} não se aplica a esta entidade.`,
        })
      const zero = dbScaled(r.rate, 4) === 0n
      const ex =
        typeof l.exemptionCode === 'string' && l.exemptionCode.trim()
          ? l.exemptionCode.trim().toUpperCase()
          : null
      if (r.kind === 'TAX' && zero && (!ex || !exemptions.has(ex)))
        issues.push({
          path: p('exemptionCode'),
          code: 'EXEMPTION_REQUIRED',
          message: 'Taxa 0 %: indique um motivo de isenção confirmado.',
        })
      return {
        codeId: r.code_id,
        code: r.code,
        kind: r.kind,
        rate: num(r.rate, 4)!,
        minBase: num(r.min_base, 2),
        exemptionCode: r.kind === 'TAX' && zero ? ex : null,
        rateId: r.rate_id,
        legalSource: r.legal_source,
      }
    })
    if (issues.length > at0) return
    lines.push({
      key: String(l.key ?? i),
      netAmount: scaledText(dbScaled(l.netAmount, 2), 2),
      taxes: taxes as any,
    })
  })
  fail(issues)
  const result = computeTaxes(lines, rounding)
  return {
    ...result,
    mode: 'SIMULATION' as const,
    ratesUsed: rates.map((r) => ({
      codeId: r.code_id as string,
      code: r.code as string,
      rateId: r.rate_id as string,
      rate: num(r.rate, 4)!,
      legalSource: r.legal_source as string,
    })),
  }
}

/**
 * Atribui o número seguinte de uma série fiscal activa, na transacção do documento: bloqueia a série (concorrência),
 * exige a data não anterior à do último documento e dentro do ano fiscal, regista o número (único por série e por
 * documento). Se a transacção falhar, o número não fica gasto (não há saltos).
 */
export async function allocateFiscalNumber(
  scope: TenantScope,
  req: {
    seriesId: string
    legalEntityId: string
    documentKind: DocumentKind
    issueDate: string
    documentType: string
    documentId: string
  }
) {
  const s = await load(scope, 'fiscal_series', req.seriesId, true)
  if (s.legal_entity_id !== req.legalEntityId || s.document_kind !== req.documentKind)
    throw ApiError.conflict(
      'SERIES_MISMATCH',
      'A série não é desta entidade ou deste tipo de documento.'
    )
  if (s.status !== 'ACTIVE')
    throw ApiError.conflict('SERIES_NOT_ACTIVE', 'A série não está activa.')
  const problem = issueDateIssue(req.issueDate, s.lid, Number(s.fiscal_year))
  if (problem) throw ApiError.conflict('ISSUE_DATE', problem)
  const number = Number(s.next_number)
  const formatted = formatFiscalNumber(s.prefix, number, Number(s.padding))
  await update(scope, 'fiscal_series', s.id, {
    next_number: number + 1,
    last_issue_date: req.issueDate,
  })
  try {
    await scope.trx.rawQuery(
      `insert into fiscal_numbers (tenant_id, series_id, number, formatted, issue_date, document_type, document_id, created_by, updated_by)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        scope.context.tenantId,
        s.id,
        number,
        formatted,
        req.issueDate,
        req.documentType,
        req.documentId,
        scope.context.userId,
        scope.context.userId,
      ]
    )
  } catch (e: any) {
    if (e?.code === '23505')
      throw ApiError.conflict('ALREADY_NUMBERED', 'Este documento já tem número fiscal.')
    throw e
  }
  return {
    seriesId: s.id as string,
    number,
    formatted,
    fiscalCode: s.fiscal_code as string,
    mode: s.mode as string,
  }
}
