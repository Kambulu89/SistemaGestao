import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { constraintOf, isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import {
  attributesKey,
  checkBarcode,
  fitsDecimals,
  isAccountingClass,
  isSku,
  normalizeAttributes,
  PRODUCT_STATUSES,
  PRODUCT_TYPES,
  productIssues,
  scaled,
  scaledText,
  type ProductType,
} from '#modules/inventory/domain/catalog'

/*
 * Produtos e serviços (8.1). O SKU e o código de barras são únicos na empresa entre produtos e variantes. Os serviços
 * e os kits não movimentam stock (sem rastreio nem limites, garantido também na base). As conversões dizem quantas
 * unidades base tem 1 unidade alternativa; as unidades de compra e venda têm de ser convertíveis. Um kit tem pelo
 * menos um componente armazenável. A classe contabilística efectiva é a do produto ou, sem ela, a da categoria mais
 * próxima. Nada se apaga: produtos e variantes inactivam-se ou descontinuam-se.
 */

const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : v)
const bool = (v: unknown) => v === true

const P_SELECT = `select p.*, p.min_stock::text as min_text, p.max_stock::text as max_text,
    p.sale_price::text as price_text, c.code as category_code, c.name as category_name, b.name as brand_name,
    bu.code as base_uom_code, bu.decimals as base_uom_decimals, pu.code as purchase_uom_code, su.code as sale_uom_code
  from products p
  left join product_categories c on c.tenant_id = p.tenant_id and c.id = p.category_id
  left join brands b on b.tenant_id = p.tenant_id and b.id = p.brand_id
  join uoms bu on bu.tenant_id = p.tenant_id and bu.id = p.base_uom_id
  left join uoms pu on pu.tenant_id = p.tenant_id and pu.id = p.purchase_uom_id
  left join uoms su on su.tenant_id = p.tenant_id and su.id = p.sale_uom_id`

const trim6 = (v: string | null) => (v === null ? null : v.replace(/\.?0+$/, '') || '0')

function productView(p: any) {
  return {
    id: p.id as string,
    version: Number(p.version),
    sku: p.sku as string,
    barcode: (p.barcode as string) ?? null,
    name: p.name as string,
    description: (p.description as string) ?? null,
    productType: p.product_type as ProductType,
    status: p.status as string,
    category: p.category_id
      ? {
          id: p.category_id as string,
          code: p.category_code as string,
          name: p.category_name as string,
        }
      : null,
    brand: p.brand_id ? { id: p.brand_id as string, name: p.brand_name as string } : null,
    baseUom: {
      id: p.base_uom_id as string,
      code: p.base_uom_code as string,
      decimals: Number(p.base_uom_decimals),
    },
    purchaseUom: p.purchase_uom_id
      ? { id: p.purchase_uom_id as string, code: p.purchase_uom_code as string }
      : null,
    saleUom: p.sale_uom_id
      ? { id: p.sale_uom_id as string, code: p.sale_uom_code as string }
      : null,
    trackLots: Boolean(p.track_lots),
    trackSerials: Boolean(p.track_serials),
    trackExpiry: Boolean(p.track_expiry),
    shelfLifeDays: p.shelf_life_days === null ? null : Number(p.shelf_life_days),
    minStock: trim6(p.min_text ?? null),
    maxStock: trim6(p.max_text ?? null),
    currency: (p.currency as string) ?? null,
    salePrice: (p.price_text as string) ?? null,
    accountingClass: (p.accounting_class as string) ?? null,
    hasVariants: Boolean(p.has_variants),
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  }
}

async function findProduct(scope: TenantScope, id: string, lock = false) {
  if (!isUuid(id)) return null
  const r = await scope.trx.rawQuery(
    `${P_SELECT} where p.tenant_id = ? and p.id = ?${lock ? ' for update of p' : ''}`,
    [scope.context.tenantId, id]
  )
  return (r.rows[0] as any) ?? null
}

/** Classe contabilística da categoria mais próxima com classe. */
async function categoryClass(scope: TenantScope, categoryId: string | null) {
  if (!categoryId) return null
  const r = await scope.trx.rawQuery(
    `with recursive up as (
       select id, parent_id, accounting_class, 0 as depth from product_categories where tenant_id = ? and id = ?
       union all
       select c.id, c.parent_id, c.accounting_class, up.depth + 1 from product_categories c
         join up on c.id = up.parent_id where c.tenant_id = ? and up.depth < 20)
     select accounting_class from up where accounting_class is not null order by depth limit 1`,
    [scope.context.tenantId, categoryId, scope.context.tenantId]
  )
  return (r.rows[0] as { accounting_class: string } | undefined)?.accounting_class ?? null
}

async function details(scope: TenantScope, p: any) {
  const t = scope.context.tenantId
  const conv = await scope.trx.rawQuery(
    `select c.id, c.uom_id, c.factor::text as factor, u.code, u.name from product_uom_conversions c
       join uoms u on u.tenant_id = c.tenant_id and u.id = c.uom_id
      where c.tenant_id = ? and c.product_id = ? order by u.code`,
    [t, p.id]
  )
  const comps = await scope.trx.rawQuery(
    `select k.id, k.component_id, k.quantity::text as qty, x.sku, x.name, u.code as uom_code from product_kit_components k
       join products x on x.tenant_id = k.tenant_id and x.id = k.component_id
       join uoms u on u.tenant_id = x.tenant_id and u.id = x.base_uom_id
      where k.tenant_id = ? and k.kit_id = ? order by x.sku`,
    [t, p.id]
  )
  const vars = await scope.trx.rawQuery(
    `select v.*, v.sale_price::text as price_text from product_variants v
      where v.tenant_id = ? and v.product_id = ? order by v.sku`,
    [t, p.id]
  )
  const own = p.accounting_class ?? null
  return {
    ...productView(p),
    effectiveAccountingClass: own ?? (await categoryClass(scope, p.category_id ?? null)),
    accountingClassSource: own ? 'PRODUCT' : 'CATEGORY',
    conversions: (conv.rows as any[]).map((c) => ({
      id: c.id as string,
      uomId: c.uom_id as string,
      uomCode: c.code as string,
      uomName: c.name as string,
      factor: trim6(c.factor) as string,
    })),
    components: (comps.rows as any[]).map((c) => ({
      id: c.id as string,
      componentId: c.component_id as string,
      sku: c.sku as string,
      name: c.name as string,
      uomCode: c.uom_code as string,
      quantity: trim6(c.qty) as string,
    })),
    variants: (vars.rows as any[]).map(variantView),
  }
}

function variantView(v: any) {
  return {
    id: v.id as string,
    version: Number(v.version),
    productId: v.product_id as string,
    sku: v.sku as string,
    barcode: (v.barcode as string) ?? null,
    attributes: v.attributes as Record<string, string>,
    salePrice: (v.price_text as string) ?? null,
    status: v.status as string,
  }
}

/** SKU e código de barras únicos entre produtos e variantes (serializado por empresa). */
async function assertCodesFree(
  scope: TenantScope,
  codes: { sku?: string | null; barcode?: string | null },
  self: { productId?: string; variantId?: string }
) {
  await scope.trx.rawQuery(`select pg_advisory_xact_lock(hashtext(?))`, [
    `${scope.context.tenantId}:catalog-codes`,
  ])
  const t = scope.context.tenantId
  const issues: ErrorDetail[] = []
  const taken = async (column: 'sku' | 'barcode', value: string) => {
    const r = await scope.trx.rawQuery(
      `select 1 from products where tenant_id = ? and ${column} = ? and id is distinct from ?
       union all
       select 1 from product_variants where tenant_id = ? and ${column} = ? and id is distinct from ? limit 1`,
      [t, value, self.productId ?? null, t, value, self.variantId ?? null] as never[]
    )
    return r.rows.length > 0
  }
  if (codes.sku && (await taken('sku', codes.sku)))
    issues.push({ path: 'sku', code: 'SKU_TAKEN', message: 'Este SKU já está a ser usado.' })
  if (codes.barcode && (await taken('barcode', codes.barcode)))
    issues.push({
      path: 'barcode',
      code: 'BARCODE_TAKEN',
      message: 'Este código de barras já está a ser usado.',
    })
  if (issues.length) throw new ApiError(409, issues[0].code, issues[0].message, issues)
}

async function activeRef(scope: TenantScope, table: string, id: string) {
  const r = await scope.trx.rawQuery(
    `select status${table === 'uoms' ? ', decimals' : ''} from ${table} where tenant_id = ? and id = ?`,
    [scope.context.tenantId, id]
  )
  return (r.rows[0] as { status: string; decimals?: number } | undefined) ?? null
}

interface Normalized {
  values: Record<string, unknown>
  conversions?: { uomId: string; factor: bigint }[]
  components?: { componentId: string; quantity: bigint }[]
}

/** Normaliza o corpo (parcial na alteração). */
function normalize(
  input: Record<string, unknown>,
  creating: boolean
): { n: Normalized; issues: ErrorDetail[] } {
  const issues: ErrorDetail[] = []
  const v: Record<string, unknown> = {}
  const has = (k: string) => k in input || creating
  if (has('sku')) {
    const s = text(input.sku)
    if (!isSku(s))
      issues.push({
        path: 'sku',
        code: 'INVALID',
        message: 'SKU: até 40 letras, dígitos ou . _ - /.',
      })
    else v.sku = s.toUpperCase()
  }
  if ('barcode' in input) {
    const b = text(input.barcode)
    if (b === '' || b === null || b === undefined) v.barcode = null
    else if (typeof b !== 'string')
      issues.push({ path: 'barcode', code: 'INVALID', message: 'Código de barras inválido.' })
    else {
      const c = checkBarcode(b)
      if ('error' in c) issues.push({ path: 'barcode', code: 'INVALID_BARCODE', message: c.error })
      else v.barcode = c.value
    }
  }
  if (has('name')) {
    const s = text(input.name)
    if (typeof s !== 'string' || s.length < 2 || s.length > 200)
      issues.push({ path: 'name', code: 'LENGTH', message: 'Nome: 2 a 200 caracteres.' })
    else v.name = s
  }
  if ('description' in input) {
    const s = text(input.description)
    if (s === '' || s === null || s === undefined) v.description = null
    else if (typeof s !== 'string' || s.length > 4000)
      issues.push({
        path: 'description',
        code: 'LENGTH',
        message: 'Descrição: até 4000 caracteres.',
      })
    else v.description = s
  }
  if (has('productType')) {
    if (!PRODUCT_TYPES.includes(input.productType as any))
      issues.push({ path: 'productType', code: 'INVALID', message: 'Armazenável, serviço ou kit.' })
    else v.productType = input.productType
  }
  if ('status' in input) {
    if (!PRODUCT_STATUSES.includes(input.status as any))
      issues.push({ path: 'status', code: 'INVALID', message: 'Estado inválido.' })
    else v.status = input.status
  }
  for (const k of ['categoryId', 'brandId', 'purchaseUomId', 'saleUomId'] as const)
    if (k in input) {
      const x = input[k]
      if (x === null || x === '') v[k] = null
      else if (typeof x !== 'string' || !isUuid(x))
        issues.push({ path: k, code: 'INVALID', message: 'Inválido.' })
      else v[k] = x
    }
  if (has('baseUomId')) {
    const x = input.baseUomId
    if (typeof x !== 'string' || !isUuid(x))
      issues.push({ path: 'baseUomId', code: 'REQUIRED', message: 'Indique a unidade base.' })
    else v.baseUomId = x
  }
  for (const k of ['trackLots', 'trackSerials', 'trackExpiry'] as const)
    if (k in input) v[k] = bool(input[k])
  if ('shelfLifeDays' in input) {
    const d = input.shelfLifeDays
    if (d === null || d === '') v.shelfLifeDays = null
    else if (!Number.isInteger(d) || (d as number) < 1 || (d as number) > 36500)
      issues.push({ path: 'shelfLifeDays', code: 'INVALID', message: 'Dias de 1 a 36500.' })
    else v.shelfLifeDays = d
  }
  for (const k of ['minStock', 'maxStock'] as const)
    if (k in input) {
      const x = input[k]
      if (x === null || x === '') v[k] = null
      else {
        const s = scaled(x, 6)
        if (s === null)
          issues.push({ path: k, code: 'INVALID', message: 'Quantidade inválida (até 6 casas).' })
        else v[k] = s
      }
    }
  if ('salePrice' in input || 'currency' in input) {
    const p = input.salePrice
    const c = text(input.currency)
    if (p === null || p === '' || p === undefined) {
      v.salePrice = null
      v.currency = null
    } else {
      const s = scaled(p, 4)
      if (s === null)
        issues.push({
          path: 'salePrice',
          code: 'INVALID',
          message: 'Preço inválido (até 4 casas).',
        })
      else v.salePrice = scaledText(s, 4)
      if (typeof c !== 'string' || !/^[A-Za-z]{3}$/.test(c))
        issues.push({
          path: 'currency',
          code: 'REQUIRED',
          message: 'Indique a moeda do preço (ISO, 3 letras).',
        })
      else v.currency = c.toUpperCase()
    }
  }
  if ('accountingClass' in input) {
    const c = text(input.accountingClass)
    if (c === '' || c === null || c === undefined) v.accountingClass = null
    else if (typeof c !== 'string' || !isAccountingClass(c.toUpperCase()))
      issues.push({
        path: 'accountingClass',
        code: 'INVALID',
        message: 'Classe: 2 a 30 letras maiúsculas, dígitos ou _ (ex.: MERCADORIAS).',
      })
    else v.accountingClass = c.toUpperCase()
  }
  const n: Normalized = { values: v }
  if ('conversions' in input) {
    const list = Array.isArray(input.conversions) ? input.conversions : null
    if (!list || list.length > 20)
      issues.push({
        path: 'conversions',
        code: 'INVALID',
        message: 'Lista de conversões inválida.',
      })
    else {
      n.conversions = []
      list.forEach((c: any, i) => {
        const f = scaled(c?.factor, 6)
        if (typeof c?.uomId !== 'string' || !isUuid(c.uomId) || f === null || f === 0n)
          issues.push({
            path: `conversions.${i}`,
            code: 'INVALID',
            message: 'Cada conversão precisa da unidade e de um factor positivo (até 6 casas).',
          })
        else n.conversions!.push({ uomId: c.uomId, factor: f })
      })
      const ids = n.conversions.map((c) => c.uomId)
      if (new Set(ids).size !== ids.length)
        issues.push({
          path: 'conversions',
          code: 'DUPLICATE',
          message: 'Unidade repetida nas conversões.',
        })
    }
  }
  if ('components' in input) {
    const list = Array.isArray(input.components) ? input.components : null
    if (!list || list.length > 50)
      issues.push({
        path: 'components',
        code: 'INVALID',
        message: 'Lista de componentes inválida.',
      })
    else {
      n.components = []
      list.forEach((c: any, i) => {
        const q = scaled(c?.quantity, 6)
        if (typeof c?.componentId !== 'string' || !isUuid(c.componentId) || q === null || q === 0n)
          issues.push({
            path: `components.${i}`,
            code: 'INVALID',
            message: 'Cada componente precisa do produto e de uma quantidade positiva.',
          })
        else n.components!.push({ componentId: c.componentId, quantity: q })
      })
      const ids = n.components.map((c) => c.componentId)
      if (new Set(ids).size !== ids.length)
        issues.push({ path: 'components', code: 'DUPLICATE', message: 'Componente repetido.' })
    }
  }
  return { n, issues }
}

const COLUMN: Record<string, string> = {
  sku: 'sku',
  barcode: 'barcode',
  name: 'name',
  description: 'description',
  productType: 'product_type',
  status: 'status',
  categoryId: 'category_id',
  brandId: 'brand_id',
  baseUomId: 'base_uom_id',
  purchaseUomId: 'purchase_uom_id',
  saleUomId: 'sale_uom_id',
  trackLots: 'track_lots',
  trackSerials: 'track_serials',
  trackExpiry: 'track_expiry',
  shelfLifeDays: 'shelf_life_days',
  minStock: 'min_stock',
  maxStock: 'max_stock',
  currency: 'currency',
  salePrice: 'sale_price',
  accountingClass: 'accounting_class',
}

/** Estado final (actual + alteração) em forma de factos para as regras do domínio. */
function current(p: any | null) {
  if (!p) return {}
  return {
    productType: p.product_type,
    categoryId: p.category_id,
    brandId: p.brand_id,
    baseUomId: p.base_uom_id,
    purchaseUomId: p.purchase_uom_id,
    saleUomId: p.sale_uom_id,
    trackLots: p.track_lots,
    trackSerials: p.track_serials,
    trackExpiry: p.track_expiry,
    shelfLifeDays: p.shelf_life_days,
    minStock: p.min_text === null ? null : scaled(p.min_text, 6),
    maxStock: p.max_text === null ? null : scaled(p.max_text, 6),
  } as Record<string, any>
}

export class ProductService {
  list(
    context: TenantContext,
    f: {
      q?: string
      categoryId?: string
      brandId?: string
      productType?: string
      status?: string
      sort?: { field: string; direction: 'asc' | 'desc' }
      limit: number
      offset: number
    }
  ) {
    return runInTenant(context, async (scope) => {
      const t = context.tenantId
      const where = ['p.tenant_id = ?']
      const params: unknown[] = [t]
      if (f.q) {
        const like = `%${f.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
        where.push(`(lower(p.sku) like ? or lower(p.name) like ? or p.barcode = ? or exists (
          select 1 from product_variants v where v.tenant_id = p.tenant_id and v.product_id = p.id
            and (lower(v.sku) like ? or v.barcode = ?)))`)
        params.push(like, like, f.q.trim(), like, f.q.trim())
      }
      if (f.categoryId) {
        where.push(`p.category_id in (with recursive d as (
            select id from product_categories where tenant_id = ? and id = ?
            union select c.id from product_categories c join d on c.parent_id = d.id where c.tenant_id = ?)
          select id from d)`)
        params.push(t, f.categoryId, t)
      }
      if (f.brandId) {
        where.push('p.brand_id = ?')
        params.push(f.brandId)
      }
      if (f.productType) {
        where.push('p.product_type = ?')
        params.push(f.productType)
      }
      if (f.status) {
        where.push('p.status = ?')
        params.push(f.status)
      }
      const SORT: Record<string, string> = {
        sku: 'p.sku',
        name: 'p.name',
        createdAt: 'p.created_at',
      }
      const order =
        f.sort && SORT[f.sort.field]
          ? `${SORT[f.sort.field]} ${f.sort.direction === 'desc' ? 'desc' : 'asc'}, p.id`
          : 'p.sku, p.id'
      const clause = where.join(' and ')
      const rows = await scope.trx.rawQuery(
        `${P_SELECT} where ${clause} order by ${order} limit ? offset ?`,
        [...params, f.limit, f.offset] as never[]
      )
      const count = await scope.trx.rawQuery(
        `select count(*)::int as n from products p where ${clause}`,
        params as never[]
      )
      return {
        items: (rows.rows as any[]).map(productView),
        total: (count.rows[0] as { n: number }).n,
      }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const p = await findProduct(scope, id)
      if (!p) throw ApiError.notFound()
      return details(scope, p)
    })
  }

  /** Procura exacta por SKU ou código de barras (produto ou variante). */
  lookup(context: TenantContext, code: string) {
    return runInTenant(context, async (scope) => {
      const c = code.trim()
      const t = context.tenantId
      const r = await scope.trx.rawQuery(
        `select p.id as product_id, null::uuid as variant_id from products p
          where p.tenant_id = ? and (upper(p.sku) = upper(?) or p.barcode = ?)
         union all
         select v.product_id, v.id from product_variants v
          where v.tenant_id = ? and (upper(v.sku) = upper(?) or v.barcode = ?)
         limit 1`,
        [t, c, c, t, c, c]
      )
      const hit = r.rows[0] as { product_id: string; variant_id: string | null } | undefined
      if (!hit) throw ApiError.notFound()
      const d = await details(scope, await findProduct(scope, hit.product_id))
      return { product: d, variant: d.variants.find((v) => v.id === hit.variant_id) ?? null }
    })
  }

  save(
    context: TenantContext,
    id: string | null,
    input: Record<string, unknown>,
    expectedVersion?: number
  ) {
    return runInTenant(context, async (scope) => {
      const t = context.tenantId
      const before = id ? await findProduct(scope, id, true) : null
      if (id && !before) throw ApiError.notFound()
      if (before && Number(before.version) !== expectedVersion)
        throw ApiError.versionConflict(Number(before.version))
      const { n, issues } = normalize(input, !id)
      fail(issues)
      const v = n.values
      const merged = { ...current(before), ...v } as Record<string, any>
      // Referências activas (as que mudam ou são novas).
      const refIssues: ErrorDetail[] = []
      const uomDecimals = new Map<string, number>()
      for (const [k, table, label] of [
        ['categoryId', 'product_categories', 'Categoria'],
        ['brandId', 'brands', 'Marca'],
        ['baseUomId', 'uoms', 'Unidade base'],
        ['purchaseUomId', 'uoms', 'Unidade de compra'],
        ['saleUomId', 'uoms', 'Unidade de venda'],
      ] as const) {
        const ref = merged[k]
        if (!ref) continue
        const row = await activeRef(scope, table, ref)
        if (!row) refIssues.push({ path: k, code: 'NOT_FOUND', message: `${label} inexistente.` })
        else {
          if (row.decimals !== undefined) uomDecimals.set(ref, Number(row.decimals))
          if (row.status !== 'ACTIVE' && k in v)
            refIssues.push({ path: k, code: 'INACTIVE', message: `${label} inactiva.` })
        }
      }
      fail(refIssues)
      // Conversões (as novas ou as gravadas).
      let conversions = n.conversions
      if (!conversions && before) {
        const r = await scope.trx.rawQuery(
          `select uom_id, factor::text as f from product_uom_conversions where tenant_id = ? and product_id = ?`,
          [t, before.id]
        )
        conversions = (r.rows as any[]).map((x) => ({ uomId: x.uom_id, factor: scaled(x.f, 6)! }))
      }
      conversions = conversions ?? []
      const convIssues: ErrorDetail[] = []
      for (const [i, c] of conversions.entries()) {
        if (c.uomId === merged.baseUomId)
          convIssues.push({
            path: `conversions.${i}`,
            code: 'BASE_UOM',
            message: 'A unidade base não precisa de conversão.',
          })
        else if (n.conversions) {
          const row = await activeRef(scope, 'uoms', c.uomId)
          if (!row || row.status !== 'ACTIVE')
            convIssues.push({
              path: `conversions.${i}`,
              code: 'NOT_FOUND',
              message: 'Unidade inexistente ou inactiva.',
            })
        }
      }
      fail(convIssues)
      // Componentes do kit.
      let components = n.components
      if (!components && before) {
        const r = await scope.trx.rawQuery(
          `select component_id, quantity::text as q from product_kit_components where tenant_id = ? and kit_id = ?`,
          [t, before.id]
        )
        components = (r.rows as any[]).map((x) => ({
          componentId: x.component_id,
          quantity: scaled(x.q, 6)!,
        }))
      }
      components = components ?? []
      const kitIssues: ErrorDetail[] = []
      if (merged.productType === 'KIT' && components.length === 0)
        kitIssues.push({
          path: 'components',
          code: 'REQUIRED',
          message: 'Um kit tem pelo menos um componente.',
        })
      if (merged.productType !== 'KIT' && components.length)
        kitIssues.push({
          path: 'components',
          code: 'NOT_KIT',
          message: 'Só os kits têm componentes.',
        })
      if (n.components)
        for (const [i, c] of components.entries()) {
          const r = await scope.trx.rawQuery(
            `select p.product_type, p.status, u.decimals from products p join uoms u on u.tenant_id = p.tenant_id
               and u.id = p.base_uom_id where p.tenant_id = ? and p.id = ?`,
            [t, c.componentId]
          )
          const x = r.rows[0] as
            { product_type: string; status: string; decimals: number } | undefined
          if (!x || c.componentId === id)
            kitIssues.push({
              path: `components.${i}`,
              code: 'NOT_FOUND',
              message: 'Componente inexistente.',
            })
          else if (x.product_type !== 'STOCKABLE' || x.status !== 'ACTIVE')
            kitIssues.push({
              path: `components.${i}`,
              code: 'NOT_STOCKABLE',
              message: 'Os componentes são produtos armazenáveis activos.',
            })
          else if (!fitsDecimals(c.quantity, Number(x.decimals)))
            kitIssues.push({
              path: `components.${i}`,
              code: 'DECIMALS',
              message: `A unidade do componente admite ${x.decimals} casas decimais.`,
            })
        }
      fail(kitIssues)
      if (
        before &&
        'productType' in v &&
        v.productType !== before.product_type &&
        before.has_variants &&
        v.productType === 'KIT'
      )
        fail([
          {
            path: 'productType',
            code: 'KIT_VARIANTS',
            message: 'Um produto com variantes não passa a kit.',
          },
        ])
      fail(
        productIssues({
          type: merged.productType,
          trackLots: bool(merged.trackLots),
          trackSerials: bool(merged.trackSerials),
          trackExpiry: bool(merged.trackExpiry),
          shelfLifeDays: merged.shelfLifeDays ?? null,
          minStock: merged.minStock ?? null,
          maxStock: merged.maxStock ?? null,
          baseUomDecimals: uomDecimals.get(merged.baseUomId) ?? null,
          baseUomId: merged.baseUomId,
          purchaseUomId: merged.purchaseUomId ?? null,
          saleUomId: merged.saleUomId ?? null,
          conversionUomIds: conversions.map((c) => c.uomId),
          hasVariants: before ? Boolean(before.has_variants) : false,
        })
      )
      // Lotes e séries (8.8): com movimentos, o rastreio já não muda (o saldo e as séries dependem dele).
      if (before) {
        const changed = (['trackLots', 'trackSerials'] as const).filter(
          (k) =>
            k in v &&
            bool(v[k]) !== Boolean(before[k === 'trackLots' ? 'track_lots' : 'track_serials'])
        )
        if (changed.length) {
          const moved = await scope.trx.rawQuery(
            'select 1 from stock_movements where tenant_id = ? and product_id = ? limit 1',
            [t, id!]
          )
          if (moved.rows.length)
            fail(
              changed.map((k) => ({
                path: k,
                code: 'TRACKING_LOCKED',
                message:
                  'O produto já tem movimentos de stock: o rastreio por lote/série não muda.',
              }))
            )
        }
      }
      if (
        merged.minStock !== null &&
        merged.minStock !== undefined &&
        !fitsDecimals(merged.minStock, uomDecimals.get(merged.baseUomId) ?? 6)
      )
        fail([
          {
            path: 'minStock',
            code: 'DECIMALS',
            message: 'Mais casas decimais do que a unidade base admite.',
          },
        ])
      if (
        merged.maxStock !== null &&
        merged.maxStock !== undefined &&
        !fitsDecimals(merged.maxStock, uomDecimals.get(merged.baseUomId) ?? 6)
      )
        fail([
          {
            path: 'maxStock',
            code: 'DECIMALS',
            message: 'Mais casas decimais do que a unidade base admite.',
          },
        ])
      if ('sku' in v || 'barcode' in v)
        await assertCodesFree(
          scope,
          { sku: v.sku as string, barcode: v.barcode as string },
          { productId: id ?? undefined }
        )

      const dbv: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v))
        dbv[COLUMN[k]] = typeof val === 'bigint' ? scaledText(val, 6) : val
      let productId = id
      try {
        if (id) {
          const keys = Object.keys(dbv)
          await scope.trx.rawQuery(
            `update products set ${[...keys.map((k) => `${k} = ?`), 'version = version + 1', 'updated_by = ?', 'updated_at = now()'].join(', ')}
              where tenant_id = ? and id = ?`,
            [...keys.map((k) => dbv[k]), context.userId, t, id] as never[]
          )
        } else {
          const keys = Object.keys(dbv)
          const r = await scope.trx.rawQuery(
            `insert into products (tenant_id, ${keys.join(', ')}, created_by, updated_by)
             values (?, ${keys.map(() => '?').join(', ')}, ?, ?) returning id`,
            [t, ...keys.map((k) => dbv[k]), context.userId, context.userId] as never[]
          )
          productId = (r.rows[0] as { id: string }).id
        }
      } catch (error) {
        const c = constraintOf(error)
        if (c === 'products_sku_unique')
          throw new ApiError(409, 'SKU_TAKEN', 'Este SKU já está a ser usado.', [
            { path: 'sku', code: 'SKU_TAKEN', message: 'Este SKU já está a ser usado.' },
          ])
        if (c === 'products_non_stock_check' || c === 'products_stock_limits_check')
          throw ApiError.validation([
            { path: 'productType', code: 'NOT_STOCKABLE', message: 'Dados de stock incoerentes.' },
          ])
        throw error
      }
      if (n.conversions) {
        await scope.trx.rawQuery(
          `delete from product_uom_conversions where tenant_id = ? and product_id = ?`,
          [t, productId] as never[]
        )
        for (const c of n.conversions)
          await scope.trx.rawQuery(
            `insert into product_uom_conversions (tenant_id, product_id, uom_id, factor, created_by, updated_by)
             values (?, ?, ?, ?, ?, ?)`,
            [
              t,
              productId,
              c.uomId,
              scaledText(c.factor, 6),
              context.userId,
              context.userId,
            ] as never[]
          )
      }
      if (n.components || (before && merged.productType !== 'KIT')) {
        await scope.trx.rawQuery(
          `delete from product_kit_components where tenant_id = ? and kit_id = ?`,
          [t, productId] as never[]
        )
        if (merged.productType === 'KIT')
          for (const c of components)
            await scope.trx.rawQuery(
              `insert into product_kit_components (tenant_id, kit_id, component_id, quantity, created_by, updated_by)
               values (?, ?, ?, ?, ?, ?)`,
              [
                t,
                productId,
                c.componentId,
                scaledText(c.quantity, 6),
                context.userId,
                context.userId,
              ] as never[]
            )
      }
      const changes: Record<string, { from: unknown; to: unknown }> = {}
      const was = before ? productView(before) : ({} as Record<string, unknown>)
      for (const k of Object.keys(v)) {
        const to = typeof v[k] === 'bigint' ? scaledText(v[k] as bigint, 6) : v[k]
        const from = (was as any)[k] ?? null
        if (String(from) !== String(to ?? null)) changes[k] = { from, to: to ?? null }
      }
      if (n.conversions) changes.conversions = { from: null, to: n.conversions.length }
      if (n.components) changes.components = { from: null, to: n.components.length }
      await audit(scope, {
        action: id ? 'inventory.product.updated' : 'inventory.product.created',
        entityType: 'product',
        entityId: productId!,
        changes,
      })
      return details(scope, await findProduct(scope, productId!))
    })
  }

  saveVariant(
    context: TenantContext,
    productId: string | null,
    variantId: string | null,
    input: Record<string, unknown>,
    expectedVersion?: number
  ) {
    return runInTenant(context, async (scope) => {
      const t = context.tenantId
      let before: any = null
      if (variantId) {
        if (!isUuid(variantId)) throw ApiError.notFound()
        const r = await scope.trx.rawQuery(
          `select v.*, v.sale_price::text as price_text from product_variants v where v.tenant_id = ? and v.id = ? for update`,
          [t, variantId]
        )
        before = r.rows[0] ?? null
        if (!before) throw ApiError.notFound()
        if (Number(before.version) !== expectedVersion)
          throw ApiError.versionConflict(Number(before.version))
        productId = before.product_id
      }
      const p = await findProduct(scope, productId!, true)
      if (!p) throw ApiError.notFound()
      if (p.product_type === 'KIT')
        throw ApiError.conflict('KIT_VARIANTS', 'Um kit não tem variantes.')
      const issues: ErrorDetail[] = []
      const v: Record<string, unknown> = {}
      if ('sku' in input || !variantId) {
        const s = text(input.sku)
        if (!isSku(s))
          issues.push({
            path: 'sku',
            code: 'INVALID',
            message: 'SKU: até 40 letras, dígitos ou . _ - /.',
          })
        else v.sku = s.toUpperCase()
      }
      if ('barcode' in input) {
        const b = text(input.barcode)
        if (!b) v.barcode = null
        else {
          const c = checkBarcode(String(b))
          if ('error' in c)
            issues.push({ path: 'barcode', code: 'INVALID_BARCODE', message: c.error })
          else v.barcode = c.value
        }
      }
      if ('attributes' in input || !variantId) {
        const a = normalizeAttributes(input.attributes)
        if (!a)
          issues.push({
            path: 'attributes',
            code: 'INVALID',
            message: '1 a 5 atributos (nome até 40, valor até 60 caracteres).',
          })
        else v.attributes = a
      }
      if ('salePrice' in input) {
        const x = input.salePrice
        if (x === null || x === '') v.salePrice = null
        else {
          const s = scaled(x, 4)
          if (s === null)
            issues.push({
              path: 'salePrice',
              code: 'INVALID',
              message: 'Preço inválido (até 4 casas).',
            })
          else if (!p.currency)
            issues.push({
              path: 'salePrice',
              code: 'NO_CURRENCY',
              message: 'Defina primeiro o preço e a moeda do produto.',
            })
          else v.salePrice = scaledText(s, 4)
        }
      }
      if ('status' in input) {
        if (!PRODUCT_STATUSES.includes(input.status as any))
          issues.push({ path: 'status', code: 'INVALID', message: 'Estado inválido.' })
        else v.status = input.status
      }
      fail(issues)
      if (v.attributes) {
        const others = await scope.trx.rawQuery(
          `select attributes from product_variants where tenant_id = ? and product_id = ? and id is distinct from ?`,
          [t, p.id, variantId]
        )
        const key = attributesKey(v.attributes as Record<string, string>)
        if ((others.rows as any[]).some((o) => attributesKey(o.attributes) === key))
          throw new ApiError(409, 'VARIANT_EXISTS', 'Já existe uma variante com estes atributos.', [
            { path: 'attributes', code: 'VARIANT_EXISTS', message: 'Combinação repetida.' },
          ])
      }
      if ('sku' in v || 'barcode' in v)
        await assertCodesFree(
          scope,
          { sku: v.sku as string, barcode: v.barcode as string },
          { variantId: variantId ?? undefined }
        )
      const cols: Record<string, string> = {
        sku: 'sku',
        barcode: 'barcode',
        attributes: 'attributes',
        salePrice: 'sale_price',
        status: 'status',
      }
      const keys = Object.keys(v)
      const vals = keys.map((k) => (k === 'attributes' ? JSON.stringify(v[k]) : v[k]))
      let id = variantId
      if (variantId)
        await scope.trx.rawQuery(
          `update product_variants set ${[...keys.map((k) => `${cols[k]} = ?`), 'version = version + 1', 'updated_by = ?', 'updated_at = now()'].join(', ')}
            where tenant_id = ? and id = ?`,
          [...vals, context.userId, t, variantId] as never[]
        )
      else {
        const r = await scope.trx.rawQuery(
          `insert into product_variants (tenant_id, product_id, ${keys.map((k) => cols[k]).join(', ')}, created_by, updated_by)
           values (?, ?, ${keys.map(() => '?').join(', ')}, ?, ?) returning id`,
          [t, p.id, ...vals, context.userId, context.userId] as never[]
        )
        id = (r.rows[0] as { id: string }).id
        if (!p.has_variants)
          await scope.trx.rawQuery(
            `update products set has_variants = true, version = version + 1, updated_by = ?, updated_at = now()
              where tenant_id = ? and id = ?`,
            [context.userId, t, p.id]
          )
      }
      await audit(scope, {
        action: variantId ? 'inventory.variant.updated' : 'inventory.variant.created',
        entityType: 'product',
        entityId: p.id,
        metadata: { variantId: id, sku: v.sku ?? before?.sku, fields: keys },
      })
      return details(scope, await findProduct(scope, p.id))
    })
  }
}

/** Acesso às imagens/documentos do produto (anexos): ler com `inventory.read`, escrever com `inventory.products.manage`. */
export async function productExists(scope: TenantScope, id: string) {
  return !!(await findProduct(scope, id))
}
