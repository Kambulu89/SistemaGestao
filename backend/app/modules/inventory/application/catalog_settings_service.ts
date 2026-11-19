import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import {
  crudFind,
  crudInsert,
  crudList,
  crudUpdate,
  wouldCreateCycle,
  type CrudScope,
  type CrudSpec,
} from '#shared/db/tenant_crud'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { isAccountingClass, UOM_CATEGORIES } from '#modules/inventory/domain/catalog'

/*
 * Configuração do catálogo (8.1): unidades de medida, categorias (hierarquia, classe contabilística por omissão) e
 * marcas. Permissões nas rotas (`inventory.read` / `inventory.settings`). Nada se apaga: inactiva-se.
 */

const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/
const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
const crud = (scope: TenantScope): CrudScope => ({
  trx: scope.trx,
  tenantId: scope.context.tenantId,
  userId: scope.context.userId,
})

export const UOM_SPEC: CrudSpec = {
  table: 'uoms',
  columns: {
    code: 'code',
    name: 'name',
    category: 'category',
    decimals: 'decimals',
    status: 'status',
  },
  searchColumns: ['code', 'name'],
  orderBy: 'code',
  uniqueErrors: {
    uoms_code_unique: { code: 'CODE_TAKEN', message: 'Já existe uma unidade com este código.' },
  },
}
export const CATEGORY_SPEC: CrudSpec = {
  table: 'product_categories',
  columns: {
    code: 'code',
    name: 'name',
    parentId: 'parent_id',
    accountingClass: 'accounting_class',
    status: 'status',
  },
  searchColumns: ['code', 'name'],
  orderBy: 'code',
  uniqueErrors: {
    product_categories_code_unique: {
      code: 'CODE_TAKEN',
      message: 'Já existe uma categoria com este código.',
    },
  },
}
export const BRAND_SPEC: CrudSpec = {
  table: 'brands',
  columns: { code: 'code', name: 'name', status: 'status' },
  searchColumns: ['code', 'name'],
  orderBy: 'code',
  uniqueErrors: {
    brands_code_unique: { code: 'CODE_TAKEN', message: 'Já existe uma marca com este código.' },
  },
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : v)

/** Validação comum: código e nome (obrigatórios ao criar), estado. */
function base(input: Record<string, unknown>, creating: boolean, nameMax: number) {
  const issues: ErrorDetail[] = []
  const v: Record<string, unknown> = {}
  if ('code' in input || creating) {
    const c = text(input.code)
    if (typeof c !== 'string' || !CODE.test(c))
      issues.push({
        path: 'code',
        code: 'INVALID_CODE',
        message: 'Código: até 30 letras, dígitos ou . _ -.',
      })
    else v.code = c.toUpperCase()
  }
  if ('name' in input || creating) {
    const n = text(input.name)
    if (typeof n !== 'string' || n.length < 1 || n.length > nameMax)
      issues.push({ path: 'name', code: 'LENGTH', message: `Nome: 1 a ${nameMax} caracteres.` })
    else v.name = n
  }
  if ('status' in input) {
    if (!['ACTIVE', 'INACTIVE'].includes(input.status as string))
      issues.push({ path: 'status', code: 'INVALID', message: 'Activo ou inactivo.' })
    else v.status = input.status
  }
  return { v, issues }
}

async function audited(
  scope: TenantScope,
  action: string,
  entityType: string,
  row: Record<string, unknown>,
  before: Record<string, unknown> | null
) {
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  for (const k of Object.keys(row))
    if (
      !['id', 'version', 'createdAt', 'updatedAt'].includes(k) &&
      (before?.[k] ?? null) !== (row[k] ?? null)
    )
      changes[k] = { from: before?.[k] ?? null, to: row[k] ?? null }
  await audit(scope, { action, entityType, entityId: row.id as string, changes })
}

export class CatalogSettingsService {
  list(context: TenantContext, kind: 'uoms' | 'categories' | 'brands') {
    const spec = kind === 'uoms' ? UOM_SPEC : kind === 'categories' ? CATEGORY_SPEC : BRAND_SPEC
    return runInTenant(context, async (scope) => {
      const r = await crudList(crud(scope), spec, { limit: 1000, offset: 0 })
      return r.items
    })
  }

  saveUom(
    context: TenantContext,
    id: string | null,
    input: Record<string, unknown>,
    version?: number
  ) {
    return runInTenant(context, async (scope) => {
      const before = id ? await crudFind(crud(scope), UOM_SPEC, id, true) : null
      if (id && !before) throw ApiError.notFound()
      const { v, issues } = base(input, !id, 60)
      if ('category' in input || !id) {
        if (!UOM_CATEGORIES.includes(input.category as any))
          issues.push({ path: 'category', code: 'INVALID', message: 'Categoria inválida.' })
        else v.category = input.category
      }
      if ('decimals' in input || !id) {
        const d = input.decimals ?? 0
        if (!Number.isInteger(d) || (d as number) < 0 || (d as number) > 6)
          issues.push({ path: 'decimals', code: 'INVALID', message: 'Casas decimais de 0 a 6.' })
        else v.decimals = d
      }
      fail(issues)
      if (before && v.decimals !== undefined && v.decimals !== before.decimals) {
        const used = await scope.trx.rawQuery(
          `select 1 from products where tenant_id = ? and ? in (base_uom_id, purchase_uom_id, sale_uom_id)
           union all select 1 from product_uom_conversions where tenant_id = ? and uom_id = ? limit 1`,
          [context.tenantId, id, context.tenantId, id] as never[]
        )
        if (used.rows.length)
          throw ApiError.conflict(
            'UOM_IN_USE',
            'A unidade já é usada por produtos: as casas decimais não mudam.'
          )
      }
      const row = id
        ? await crudUpdate(crud(scope), UOM_SPEC, id, version ?? -1, v)
        : await crudInsert(crud(scope), UOM_SPEC, v)
      await audited(
        scope,
        id ? 'inventory.uom.updated' : 'inventory.uom.created',
        'uom',
        row,
        before
      )
      return row
    })
  }

  saveCategory(
    context: TenantContext,
    id: string | null,
    input: Record<string, unknown>,
    version?: number
  ) {
    return runInTenant(context, async (scope) => {
      const before = id ? await crudFind(crud(scope), CATEGORY_SPEC, id, true) : null
      if (id && !before) throw ApiError.notFound()
      const { v, issues } = base(input, !id, 120)
      if ('accountingClass' in input) {
        const c = text(input.accountingClass)
        if (c === '' || c === null || c === undefined) v.accountingClass = null
        else if (!isAccountingClass(typeof c === 'string' ? c.toUpperCase() : c))
          issues.push({
            path: 'accountingClass',
            code: 'INVALID',
            message: 'Classe: 2 a 30 letras maiúsculas, dígitos ou _ (ex.: MERCADORIAS).',
          })
        else v.accountingClass = (c as string).toUpperCase()
      }
      if ('parentId' in input) {
        const p = input.parentId
        if (p === null || p === '') v.parentId = null
        else if (typeof p !== 'string' || !isUuid(p))
          issues.push({
            path: 'parentId',
            code: 'INVALID',
            message: 'Categoria superior inválida.',
          })
        else {
          const parent = await crudFind(crud(scope), CATEGORY_SPEC, p)
          if (!parent)
            issues.push({
              path: 'parentId',
              code: 'NOT_FOUND',
              message: 'Categoria superior inexistente.',
            })
          else if (id && (await wouldCreateCycle(crud(scope), 'product_categories', id, p)))
            issues.push({
              path: 'parentId',
              code: 'CYCLE',
              message: 'Uma categoria não pode ficar debaixo de si própria.',
            })
          else v.parentId = p
        }
      }
      fail(issues)
      const row = id
        ? await crudUpdate(crud(scope), CATEGORY_SPEC, id, version ?? -1, v)
        : await crudInsert(crud(scope), CATEGORY_SPEC, v)
      await audited(
        scope,
        id ? 'inventory.category.updated' : 'inventory.category.created',
        'product_category',
        row,
        before
      )
      return row
    })
  }

  saveBrand(
    context: TenantContext,
    id: string | null,
    input: Record<string, unknown>,
    version?: number
  ) {
    return runInTenant(context, async (scope) => {
      const before = id ? await crudFind(crud(scope), BRAND_SPEC, id, true) : null
      if (id && !before) throw ApiError.notFound()
      const { v, issues } = base(input, !id, 120)
      fail(issues)
      const row = id
        ? await crudUpdate(crud(scope), BRAND_SPEC, id, version ?? -1, v)
        : await crudInsert(crud(scope), BRAND_SPEC, v)
      await audited(
        scope,
        id ? 'inventory.brand.updated' : 'inventory.brand.created',
        'brand',
        row,
        before
      )
      return row
    })
  }
}
