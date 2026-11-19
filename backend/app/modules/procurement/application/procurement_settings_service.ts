import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import {
  crudFind,
  crudInsert,
  crudList,
  crudUpdate,
  type CrudScope,
  type CrudSpec,
} from '#shared/db/tenant_crud'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { effectivePermissions } from '#modules/rbac/index'

/*
 * Configuração das compras (9.1): tipos de documento exigidos aos fornecedores e critérios de homologação. Ler com
 * qualquer permissão de fornecedores (rota); alterar com `procurement.settings`. Nada se apaga: inactiva-se.
 */

export type SettingKind = 'documentTypes' | 'criteria'

const spec = (table: string, label: string): CrudSpec => ({
  table,
  columns: {
    code: 'code',
    name: 'name',
    description: 'description',
    required: 'required',
    status: 'status',
  },
  searchColumns: ['code', 'name'],
  orderBy: 'code',
  uniqueErrors: {
    [`${table}_code_unique`]: {
      code: 'CODE_TAKEN',
      message: `Já existe ${label} com este código.`,
    },
  },
})
const SPECS: Record<SettingKind, CrudSpec> = {
  documentTypes: spec('supplier_document_types', 'um tipo de documento'),
  criteria: spec('supplier_criteria', 'um critério'),
}
const ENTITY: Record<SettingKind, string> = {
  documentTypes: 'supplier_document_type',
  criteria: 'supplier_criterion',
}
const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/
const crud = (scope: TenantScope): CrudScope => ({
  trx: scope.trx,
  tenantId: scope.context.tenantId,
  userId: scope.context.userId,
})

function normalize(input: Record<string, unknown>, creating: boolean) {
  const issues: ErrorDetail[] = []
  const v: Record<string, unknown> = {}
  const t = (x: unknown) => (typeof x === 'string' ? x.trim() : x)
  if ('code' in input || creating) {
    const c = t(input.code)
    if (typeof c !== 'string' || !CODE.test(c))
      issues.push({
        path: 'code',
        code: 'INVALID_CODE',
        message: 'Código: até 30 letras, dígitos ou . _ -.',
      })
    else v.code = c.toUpperCase()
  }
  if ('name' in input || creating) {
    const n = t(input.name)
    if (typeof n !== 'string' || n.length < 2 || n.length > 160)
      issues.push({ path: 'name', code: 'LENGTH', message: 'Nome: 2 a 160 caracteres.' })
    else v.name = n
  }
  if ('description' in input) {
    const d = t(input.description)
    if (d !== null && d !== '' && (typeof d !== 'string' || d.length > 1000))
      issues.push({ path: 'description', code: 'LENGTH', message: 'Até 1000 caracteres.' })
    else v.description = d || null
  }
  if ('required' in input || creating) v.required = input.required === true
  if ('status' in input) {
    if (!['ACTIVE', 'INACTIVE'].includes(input.status as string))
      issues.push({ path: 'status', code: 'INVALID', message: 'Activo ou inactivo.' })
    else v.status = input.status
  }
  if (issues.length) throw ApiError.validation(issues)
  return v
}

export class ProcurementSettingsService {
  list(context: TenantContext, kind: SettingKind, f: { q?: string; status?: string }) {
    return runInTenant(context, async (scope) => {
      const held = (await effectivePermissions(scope)).tenant
      if (
        ![
          'procurement.suppliers.read',
          'procurement.suppliers.manage',
          'procurement.suppliers.approve',
          'procurement.settings',
        ].some((p) => held.has(p))
      )
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não pode consultar a configuração das compras.')
      return crudList(crud(scope), SPECS[kind], {
        equals: {
          status: f.status && ['ACTIVE', 'INACTIVE'].includes(f.status) ? f.status : undefined,
        },
        q: f.q,
        limit: 500,
        offset: 0,
      })
    })
  }

  create(context: TenantContext, kind: SettingKind, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const row = await crudInsert(crud(scope), SPECS[kind], normalize(input, true))
      await audit(scope, {
        action: `${ENTITY[kind]}.created`,
        entityType: ENTITY[kind],
        entityId: row.id,
        changes: Object.fromEntries(
          ['code', 'name', 'description', 'required', 'status'].map((k) => [
            k,
            { from: null, to: row[k] ?? null },
          ])
        ),
      })
      return row
    })
  }

  update(context: TenantContext, kind: SettingKind, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      if (!isUuid(id)) throw ApiError.notFound()
      const { expectedVersion, ...rest } = input
      const v = normalize(rest, false)
      if ('code' in v)
        throw ApiError.validation([{ path: 'code', code: 'FIXED', message: 'O código não muda.' }])
      const before = await crudFind(crud(scope), SPECS[kind], id, true)
      if (!before) throw ApiError.notFound()
      const row = await crudUpdate(crud(scope), SPECS[kind], id, Number(expectedVersion), v)
      await audit(scope, {
        action: `${ENTITY[kind]}.updated`,
        entityType: ENTITY[kind],
        entityId: id,
        changes: Object.fromEntries(
          Object.keys(v)
            .filter((k) => (before[k] ?? null) !== (row[k] ?? null))
            .map((k) => [k, { from: before[k] ?? null, to: row[k] ?? null }])
        ),
      })
      return row
    })
  }
}
