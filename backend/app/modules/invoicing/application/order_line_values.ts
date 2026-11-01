import {
  fromScaled,
  lineAmounts,
  roundDiv,
  toScaled,
  type RoundingMode,
} from '#modules/orders/index'
import type { InvoiceLineValues } from '#modules/invoicing/domain/invoicing'

/** A linha da encomenda de onde se factura (o instantâneo que ficou na encomenda). */
export interface OrderLineSource {
  id: string
  variantId: string
  description: string
  unitPrice: string
  discountRate: string
  taxRate: string
  taxInclusive: boolean
}

export const DEFAULT_EXEMPTION = 'Sem imposto aplicável'

/**
 * Linha facturada a partir de uma linha da encomenda: mesmo preço, desconto e taxa do instantâneo, com a quantidade
 * facturada agora e o arredondamento da política da organização. Facturar toda a quantidade dá exactamente os valores da
 * encomenda. `base = quantidade × preço − desconto`.
 */
export function orderLineValues(
  line: OrderLineSource,
  quantity: string,
  mode: RoundingMode
): InvoiceLineValues | null {
  const amounts = lineAmounts(
    {
      quantity,
      unitPrice: line.unitPrice,
      discountRate: line.discountRate,
      taxRate: line.taxRate,
      taxInclusive: line.taxInclusive,
    },
    mode
  )
  const q = toScaled(quantity, 6)
  const price = toScaled(line.unitPrice, 4)
  const discount = toScaled(line.discountRate, 4)
  if (!amounts || q === null || price === null || discount === null) return null
  const gross = roundDiv(q * price * 10_000n, 10n ** 10n, mode)
  const discounted = roundDiv(q * price * (10_000n - discount), 10n ** 10n, mode)
  const exempt = (toScaled(line.taxRate, 4) ?? 0n) === 0n
  return {
    salesOrderLineId: line.id,
    variantId: line.variantId,
    description: line.description,
    quantity,
    unitPrice: line.unitPrice,
    discountAmount: fromScaled(gross - discounted, 4),
    taxCode: exempt ? 'ISENTO' : `IVA-${line.taxRate}`,
    taxRate: line.taxRate,
    exemptionReason: exempt ? DEFAULT_EXEMPTION : null,
    netAmount: amounts.net,
    taxAmount: amounts.tax,
    total: amounts.total,
  }
}
