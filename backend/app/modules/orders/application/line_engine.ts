import { ApiError } from '#core/http/api_error'
import type { TenantContext } from '#core/tenancy/index'
import { decimalPlaces, lineAmounts, sumTotals, type Totals } from '#modules/orders/domain/money'
import {
  normalizeLineRequest,
  TAX_RATE,
  type Issue,
  type LineInput,
  type LineRequest,
} from '#modules/orders/domain/sales'
import type { Line, LineValues, PriceOrigin, References } from '#modules/orders/application/ports'

export const salesValidation = (details: Issue[]) =>
  new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', details)

const fail = (path: string, code: string, message: string) =>
  salesValidation([{ path, code, message }])

/** Compara decimais em texto não negativos (sem `number`). */
function compareDecimals(a: string, b: string): number {
  const [ai = '0', af = ''] = a.split('.')
  const [bi = '0', bf = ''] = b.split('.')
  const size = Math.max(af.length, bf.length)
  const x = BigInt(ai + af.padEnd(size, '0'))
  const y = BigInt(bi + bf.padEnd(size, '0'))
  return x === y ? 0 : x < y ? -1 : 1
}

export interface LineContext {
  organizationId: string
  currency: string
  /** A data para a qual se resolve o preço e o imposto. */
  date: string
}

/**
 * Constrói uma linha **a partir do catálogo**: o preço, o desconto máximo e a origem vêm da resolução do servidor (nunca do
 * cliente), o imposto da taxa válida na data para a categoria do produto, e os valores calculam-se com aritmética exacta.
 * O resultado é o instantâneo que fica no documento.
 */
export class LineEngine {
  constructor(private readonly references: References) {}

  /** Valida o pedido e devolve-o completo (para actualizações parciais, `base` traz o que já existe). */
  request(input: LineInput, base: LineRequest | null): LineRequest {
    const issues: Issue[] = []
    const request = normalizeLineRequest(input, base, issues)
    if (!request) throw salesValidation(issues)
    return request
  }

  async build(
    context: TenantContext,
    where: LineContext,
    request: LineRequest
  ): Promise<LineValues> {
    const variant = await this.references.variant(context, request.variantId)
    if (!variant) throw fail('variantId', 'UNKNOWN_VARIANT', 'A variante não existe.')
    if (!variant.active || !variant.product.active) {
      throw fail('variantId', 'VARIANT_INACTIVE', 'A variante ou o produto está desactivado.')
    }
    const precision = await this.references.unitPrecision(context, variant.product.baseUnitId)
    if (precision === null)
      throw fail('variantId', 'UNKNOWN_UNIT', 'A unidade do produto não existe.')
    if (decimalPlaces(request.quantity) > precision) {
      throw fail(
        'quantity',
        'QUANTITY_PRECISION',
        `A unidade do produto admite até ${precision} casas decimais.`
      )
    }

    const price = await this.references
      .resolvePrice(context, {
        variantId: variant.id,
        organizationId: where.organizationId,
        currency: where.currency,
        quantity: request.quantity,
        date: where.date,
      })
      .catch((error: unknown) => {
        // «Não há preço» é um problema do pedido da linha, não um documento inexistente.
        if (error instanceof ApiError && error.code === 'PRICE_NOT_FOUND') {
          throw fail('variantId', 'PRICE_NOT_FOUND', error.message)
        }
        throw error
      })
    if (compareDecimals(request.discountRate, price.maxDiscount) > 0) {
      throw fail(
        'discountRate',
        'DISCOUNT_EXCEEDS',
        `O desconto máximo para este preço é ${price.maxDiscount}.`
      )
    }

    let taxRate = '0'
    if (variant.product.taxCategory) {
      const rates = await this.references.taxRates(context, where.organizationId, where.date)
      const matches = rates.filter((rate) => rate.category === variant.product.taxCategory)
      if (matches.length === 0) {
        throw fail(
          'variantId',
          'NO_TAX_RATE',
          `Não há taxa de imposto «${variant.product.taxCategory}» válida em ${where.date}.`
        )
      }
      if (matches.length > 1) {
        throw ApiError.conflict(
          'TAX_RATE_AMBIGUOUS',
          `Há mais de uma taxa «${variant.product.taxCategory}» válida em ${where.date}.`
        )
      }
      taxRate = (matches[0] as { rate: string }).rate
      if (!TAX_RATE.test(taxRate)) {
        throw fail('variantId', 'INVALID_TAX_RATE', 'A taxa de imposto configurada é inválida.')
      }
    }

    const mode = await this.references.roundingMode(context, where.organizationId)
    const amounts = lineAmounts(
      {
        quantity: request.quantity,
        unitPrice: price.unitPrice,
        discountRate: request.discountRate,
        taxRate,
        taxInclusive: price.taxInclusive,
      },
      mode
    )
    if (!amounts) throw fail('quantity', 'INVALID_AMOUNT', 'Não foi possível calcular a linha.')

    const attributes = Object.entries(variant.attributes)
      .map(([key, value]) => `${key}=${value}`)
      .join(', ')
    const origin: PriceOrigin = {
      priceListId: price.priceListId,
      priceListName: price.priceListName,
      priority: price.priority,
      minQuantity: price.minQuantity,
      maxDiscount: price.maxDiscount,
      taxInclusive: price.taxInclusive,
      validFrom: price.validFrom,
      validTo: price.validTo,
      resolvedOn: where.date,
    }
    return {
      variantId: variant.id,
      descriptionSnapshot:
        `${variant.product.name} — ${variant.sku}${attributes ? ` (${attributes})` : ''}`.slice(
          0,
          500
        ),
      quantity: request.quantity,
      unitId: variant.product.baseUnitId,
      unitPrice: price.unitPrice,
      discountRate: request.discountRate,
      taxRateSnapshot: taxRate,
      taxInclusive: price.taxInclusive,
      netAmount: amounts.net,
      taxAmount: amounts.tax,
      total: amounts.total,
      priceOrigin: origin,
    }
  }

  totals(lines: readonly Line[]): Totals {
    return sumTotals(lines.map((l) => ({ net: l.netAmount, tax: l.taxAmount, total: l.total })))
  }
}
