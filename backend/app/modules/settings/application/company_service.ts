import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import {
  runInTenant,
  TenantRepository,
  normalizeTenant,
  type TenantContext,
  type TenantScope,
} from '#modules/tenancy/index'
import { audit, diff } from '#modules/audit/index'
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  type TenantSettings,
} from '#modules/settings/domain/settings'
import { isActiveWorkflowFor } from '#modules/approvals/index'

const tenants = new TenantRepository()

/** Campos do perfil (API → coluna). A identidade fiscal de cada entidade legal fica na entidade legal. */
export const PROFILE_FIELDS: Record<
  string,
  { column: string; max: number; pattern?: RegExp; message?: string }
> = {
  displayName: { column: 'display_name', max: 160 },
  legalNameRef: { column: 'legal_name_ref', max: 200 },
  taxIdRef: {
    column: 'tax_id_ref',
    max: 30,
    pattern: /^[A-Za-z0-9./-]{5,30}$/,
    message: 'NIF: 5 a 30 caracteres.',
  },
  sector: { column: 'sector', max: 120 },
  email: {
    column: 'email',
    max: 254,
    pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    message: 'Email inválido.',
  },
  phone: { column: 'phone', max: 40, pattern: /^[+0-9 ()-]{6,40}$/, message: 'Telefone inválido.' },
  website: {
    column: 'website',
    max: 200,
    pattern: /^https?:\/\/\S{3,190}$/,
    message: 'Endereço web (http/https).',
  },
  countryCode: {
    column: 'country_code',
    max: 2,
    pattern: /^[A-Z]{2}$/,
    message: 'País ISO 3166-1 alfa-2.',
  },
  addressLine: { column: 'address_line', max: 200 },
  neighbourhood: { column: 'neighbourhood', max: 120 },
  commune: { column: 'commune', max: 120 },
  municipality: { column: 'municipality', max: 120 },
  province: { column: 'province', max: 120 },
  postalCode: { column: 'postal_code', max: 20 },
}

export interface CompanyProfile extends Record<string, unknown> {
  version: number
  logoAttachmentId: string | null
  tenant: {
    name: string
    code: string
    locale: string
    timezone: string
    defaultCurrency: string
    countryCode: string
  }
}

async function readProfile(scope: TenantScope): Promise<CompanyProfile> {
  const tenant = (await tenants.find(scope.context.tenantId))!
  const r = await scope.trx.rawQuery('select * from tenant_profiles where tenant_id = ?', [
    scope.context.tenantId,
  ])
  const row = r.rows[0] as Record<string, unknown> | undefined
  const profile: CompanyProfile = {
    version: (row?.version as number) ?? 0,
    logoAttachmentId: (row?.logo_attachment_id as string) ?? null,
    tenant: {
      name: tenant.name,
      code: tenant.code,
      locale: tenant.locale,
      timezone: tenant.timezone,
      defaultCurrency: tenant.defaultCurrency,
      countryCode: tenant.countryCode,
    },
  }
  for (const [key, f] of Object.entries(PROFILE_FIELDS))
    profile[key] = row ? (row[f.column] ?? null) : null
  if (!row) profile.displayName = tenant.name
  return profile
}

export class CompanyService {
  profile(context: TenantContext) {
    return runInTenant(context, (scope) => readProfile(scope))
  }

  /**
   * Grava o perfil (cria-o na primeira vez) e, se indicados, o idioma, fuso e moeda da empresa (tabela `tenants`,
   * dona: tenancy). Concorrência optimista pela versão do perfil.
   */
  updateProfile(
    context: TenantContext,
    input: Record<string, unknown> & { expectedVersion: number }
  ) {
    const issues: ErrorDetail[] = []
    const values: Record<string, string | null> = {}
    for (const [key, f] of Object.entries(PROFILE_FIELDS)) {
      if (input[key] === undefined) continue
      let v = input[key]
      if (v === '' || v === null) v = null
      else if (typeof v !== 'string') {
        issues.push({ path: key, code: 'INVALID', message: 'Texto.' })
        continue
      } else v = key === 'countryCode' || key === 'taxIdRef' ? v.trim().toUpperCase() : v.trim()
      if (
        v !== null &&
        ((v as string).length > f.max || (f.pattern && !f.pattern.test(v as string)))
      )
        issues.push({
          path: key,
          code: 'INVALID',
          message: f.message ?? `Até ${f.max} caracteres.`,
        })
      else values[key] = v as string | null
    }
    if (values.displayName === null)
      issues.push({ path: 'displayName', code: 'REQUIRED', message: 'Indique o nome.' })
    const logo = input.logoAttachmentId
    if (logo !== undefined && logo !== null && typeof logo !== 'string')
      issues.push({ path: 'logoAttachmentId', code: 'INVALID', message: 'Anexo inválido.' })
    if (issues.length > 0) throw ApiError.validation(issues)

    return runInTenant(context, async (scope) => {
      const before = await readProfile(scope)
      await scope.trx.rawQuery('select pg_advisory_xact_lock(hashtext(?))', [
        `${context.tenantId}:profile`,
      ])
      const current = await scope.trx.rawQuery(
        'select version from tenant_profiles where tenant_id = ? for update',
        [context.tenantId]
      )
      const version = (current.rows[0] as { version: number } | undefined)?.version ?? 0
      if (version !== input.expectedVersion) throw ApiError.versionConflict(version)
      if (typeof logo === 'string') {
        const ok = await scope.trx.rawQuery(
          `select 1 from attachments where tenant_id = ? and id = ? and status = 'ACTIVE'
              and subject_type = 'tenant_profile' and content_type like 'image/%'`,
          [context.tenantId, logo]
        )
        if (ok.rows.length === 0)
          throw ApiError.validation([
            {
              path: 'logoAttachmentId',
              code: 'NOT_AN_IMAGE',
              message: 'O logótipo tem de ser uma imagem anexada ao perfil.',
            },
          ])
      }
      const merged: Record<string, unknown> = { ...before, ...values }
      const cols = Object.values(PROFILE_FIELDS).map((f) => f.column)
      const params = Object.keys(PROFILE_FIELDS).map((k) => merged[k] ?? null)
      const logoValue = logo === undefined ? before.logoAttachmentId : logo
      if (version === 0) {
        await scope.trx.rawQuery(
          `insert into tenant_profiles (tenant_id, created_by, updated_by, ${cols.join(', ')}, logo_attachment_id)
           values (?, ?, ?, ${cols.map(() => '?').join(', ')}, ?)`,
          [context.tenantId, context.userId, context.userId, ...params, logoValue] as never[]
        )
      } else {
        await scope.trx.rawQuery(
          `update tenant_profiles set ${cols.map((c) => `${c} = ?`).join(', ')}, logo_attachment_id = ?, updated_by = ?,
                  updated_at = now(), version = version + 1 where tenant_id = ?`,
          [...params, logoValue, context.userId, context.tenantId] as never[]
        )
      }
      // Idioma, fuso e moeda por omissão vivem no tenant (dono: tenancy) e são validados pelas regras dele.
      const tenantInput: Record<string, unknown> = {}
      for (const key of ['locale', 'timezone', 'defaultCurrency'] as const)
        if (input[key] !== undefined) tenantInput[key] = input[key]
      if (Object.keys(tenantInput).length > 0) {
        const tenant = (await tenants.find(context.tenantId))!
        const { values: tv, issues: ti } = normalizeTenant(tenantInput, tenant)
        if (!tv) throw ApiError.validation(ti)
        await tenants.update(tenant.id, tenant.version, { ...tv, status: tenant.status })
      }
      const after = await readProfile(scope)
      const changes = diff({ ...before, ...before.tenant }, { ...after, ...after.tenant }, [
        ...Object.keys(PROFILE_FIELDS),
        'logoAttachmentId',
        'locale',
        'timezone',
        'defaultCurrency',
      ])
      if (changes)
        await audit(scope, {
          action: 'company_profile.updated',
          entityType: 'tenant_profile',
          entityId: context.tenantId,
          changes,
        })
      return after
    })
  }

  settings(context: TenantContext) {
    return runInTenant(context, (scope) => tenantSettings(scope))
  }

  updateSettings(
    context: TenantContext,
    input: Record<string, unknown> & { expectedVersion: number }
  ) {
    return runInTenant(context, async (scope) => {
      await scope.trx.rawQuery('select pg_advisory_xact_lock(hashtext(?))', [
        `${context.tenantId}:settings`,
      ])
      const before = await tenantSettings(scope)
      if (before.version !== input.expectedVersion) throw ApiError.versionConflict(before.version)
      const { values, issues } = normalizeSettings(input, before)
      if (
        values.bankAccountWorkflowId &&
        !(await isActiveWorkflowFor(scope, values.bankAccountWorkflowId, 'bank_account'))
      )
        issues.push({
          path: 'bankAccountWorkflowId',
          code: 'NOT_ACTIVE',
          message: 'Escolha um workflow publicado do tipo "conta bancária".',
        })
      if (issues.length > 0) throw ApiError.validation(issues)
      const cols = {
        amount_scale: values.amountScale,
        quantity_scale: values.quantityScale,
        price_scale: values.priceScale,
        rounding_mode: values.roundingMode,
        invitation_ttl_days: values.invitationTtlDays,
        notify_approval_pending: values.notifyApprovalPending,
        notify_approval_decided: values.notifyApprovalDecided,
        bank_account_workflow_id: values.bankAccountWorkflowId,
      }
      if (before.version === 0) {
        await scope.trx.rawQuery(
          `insert into tenant_settings (tenant_id, created_by, updated_by, ${Object.keys(cols).join(', ')})
           values (?, ?, ?, ${Object.keys(cols)
             .map(() => '?')
             .join(', ')})`,
          [context.tenantId, context.userId, context.userId, ...Object.values(cols)] as never[]
        )
      } else {
        await scope.trx.rawQuery(
          `update tenant_settings set ${Object.keys(cols)
            .map((c) => `${c} = ?`)
            .join(', ')}, updated_by = ?,
                  updated_at = now(), version = version + 1 where tenant_id = ?`,
          [...Object.values(cols), context.userId, context.tenantId] as never[]
        )
      }
      const after = await tenantSettings(scope)
      const changes = diff(
        { ...before },
        { ...after },
        Object.keys(DEFAULT_SETTINGS).filter((k) => k !== 'version')
      )
      if (changes)
        await audit(scope, {
          action: 'settings.updated',
          entityType: 'tenant_settings',
          entityId: context.tenantId,
          changes,
        })
      return after
    })
  }
}

/** Configurações da empresa em contexto (valores por omissão se ainda não gravadas). Usado por outros módulos. */
export async function tenantSettings(scope: TenantScope): Promise<TenantSettings> {
  const r = await scope.trx.rawQuery('select * from tenant_settings where tenant_id = ?', [
    scope.context.tenantId,
  ])
  const row = r.rows[0] as Record<string, any> | undefined
  if (!row) return { ...DEFAULT_SETTINGS }
  return {
    amountScale: row.amount_scale,
    quantityScale: row.quantity_scale,
    priceScale: row.price_scale,
    roundingMode: row.rounding_mode,
    invitationTtlDays: row.invitation_ttl_days,
    notifyApprovalPending: row.notify_approval_pending,
    notifyApprovalDecided: row.notify_approval_decided,
    bankAccountWorkflowId: row.bank_account_workflow_id,
    version: row.version,
  }
}
