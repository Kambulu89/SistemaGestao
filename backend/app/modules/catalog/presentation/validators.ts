import vine from '@vinejs/vine'

const version = () => vine.number().withoutDecimals().min(1)
const uuid = () => vine.string().trim().uuid()

/** O conteúdo (códigos, decimais, regras) é validado pelo domínio; aqui só o transporte. */
export const createCategoryValidator = vine.compile(
  vine.object({
    code: vine.string().trim().maxLength(50),
    name: vine.string().trim().maxLength(160),
    parentId: uuid().nullable().optional(),
  })
)

export const updateCategoryValidator = vine.compile(
  vine.object({
    expectedVersion: version(),
    name: vine.string().trim().maxLength(160).optional(),
    parentId: uuid().nullable().optional(),
  })
)

export const listProductsValidator = vine.compile(
  vine.object({
    q: vine.string().trim().maxLength(100).optional(),
    type: vine.enum(['GOODS', 'SERVICE']).optional(),
    categoryId: uuid().optional(),
    active: vine.boolean().optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)

export const createProductValidator = vine.compile(
  vine.object({
    code: vine.string().trim().maxLength(50),
    name: vine.string().trim().maxLength(200),
    description: vine.string().trim().maxLength(1000).nullable().optional(),
    type: vine.string().trim().optional(),
    categoryId: uuid().nullable().optional(),
    baseUnitId: uuid(),
    trackStock: vine.boolean().optional(),
    trackingMode: vine.string().trim().optional(),
    active: vine.boolean().optional(),
    taxCategory: vine.string().trim().maxLength(50).nullable().optional(),
    sku: vine.string().trim().maxLength(80).optional(),
    barcode: vine.string().trim().maxLength(80).nullable().optional(),
    attributes: vine.any().optional(),
  })
)

export const updateProductValidator = vine.compile(
  vine.object({
    expectedVersion: version(),
    code: vine.string().trim().maxLength(50).optional(),
    name: vine.string().trim().maxLength(200).optional(),
    description: vine.string().trim().maxLength(1000).nullable().optional(),
    type: vine.string().trim().optional(),
    categoryId: uuid().nullable().optional(),
    baseUnitId: uuid().optional(),
    trackStock: vine.boolean().optional(),
    trackingMode: vine.string().trim().optional(),
    active: vine.boolean().optional(),
    taxCategory: vine.string().trim().maxLength(50).nullable().optional(),
  })
)

export const createVariantValidator = vine.compile(
  vine.object({
    sku: vine.string().trim().maxLength(80),
    barcode: vine.string().trim().maxLength(80).nullable().optional(),
    attributes: vine.any().optional(),
    active: vine.boolean().optional(),
  })
)

export const updateVariantValidator = vine.compile(
  vine.object({
    expectedVersion: version(),
    sku: vine.string().trim().maxLength(80).optional(),
    barcode: vine.string().trim().maxLength(80).nullable().optional(),
    attributes: vine.any().optional(),
    active: vine.boolean().optional(),
  })
)

export const listPriceListsValidator = vine.compile(
  vine.object({ organizationId: uuid().optional() })
)

export const createPriceListValidator = vine.compile(
  vine.object({
    organizationId: uuid(),
    name: vine.string().trim().maxLength(160),
    currency: vine.string().trim().maxLength(3),
    validFrom: vine.string().trim().maxLength(10),
    validTo: vine.string().trim().maxLength(10).nullable().optional(),
    taxInclusive: vine.boolean().optional(),
    priority: vine.number().withoutDecimals().optional(),
  })
)

export const updatePriceListValidator = vine.compile(
  vine.object({
    expectedVersion: version(),
    organizationId: uuid().optional(),
    name: vine.string().trim().maxLength(160).optional(),
    currency: vine.string().trim().maxLength(3).optional(),
    validFrom: vine.string().trim().maxLength(10).optional(),
    validTo: vine.string().trim().maxLength(10).nullable().optional(),
    taxInclusive: vine.boolean().optional(),
    priority: vine.number().withoutDecimals().optional(),
  })
)

/** Os decimais chegam como texto e validam-se no domínio (nunca `number`). */
export const createPriceItemValidator = vine.compile(
  vine.object({
    variantId: uuid(),
    minQuantity: vine.string().trim().maxLength(30).optional(),
    unitPrice: vine.string().trim().maxLength(30),
    maxDiscount: vine.string().trim().maxLength(10).optional(),
  })
)

export const updatePriceItemValidator = vine.compile(
  vine.object({
    expectedVersion: version(),
    unitPrice: vine.string().trim().maxLength(30).optional(),
    maxDiscount: vine.string().trim().maxLength(10).optional(),
  })
)

export const resolvePriceValidator = vine.compile(
  vine.object({
    variantId: uuid(),
    organizationId: uuid(),
    currency: vine.string().trim().maxLength(3),
    quantity: vine.string().trim().maxLength(30),
    date: vine.string().trim().maxLength(10).optional(),
  })
)
