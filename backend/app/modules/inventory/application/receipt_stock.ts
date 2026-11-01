import { ApiError } from '#core/http/api_error'
import type { TenantScope } from '#core/tenancy/index'
import type {
  LotStore,
  References,
  WarehouseStore,
  LedgerStore,
} from '#modules/inventory/application/ports'
import type { StockUseCases } from '#modules/inventory/application/stock_use_cases'

export interface ReceiptRef {
  id: string
  warehouseId: string | null
}
export interface ReceiptLineRef {
  id: string
  variantId: string
  quantity: string
  unitCost: string
  lotCode: string | null
  expiresOn: string | null
}

export const RECEIPT_SOURCE = 'GOODS_RECEIPT'
const REASON = 'Reversão da recepção'

/**
 * Ligação às recepções de compras (spec 9.3): lançar dá entrada do stock no armazém da recepção (no primeiro local activo),
 * ao custo da linha da encomenda, criando o lote nos produtos por lote; reverter tira-o com movimentos opostos ao custo
 * original (e falha se o stock já foi consumido). Produtos sem controlo de stock não se movem. Tudo na transacção do
 * lançamento: se algo falhar, a recepção não se lança.
 */
export class ReceiptStock {
  constructor(
    private readonly warehouses: WarehouseStore,
    private readonly lots: LotStore,
    private readonly ledger: LedgerStore,
    private readonly stock: StockUseCases,
    private readonly references: References
  ) {}

  async post(scope: TenantScope, receipt: ReceiptRef, lines: readonly ReceiptLineRef[]) {
    // Sempre pela mesma ordem (variante, depois linha) para os bloqueios nunca se cruzarem entre recepções.
    const ordered = lines
      .map((line, index) => ({ line, index }))
      .sort((a, b) =>
        a.line.variantId === b.line.variantId
          ? a.line.id < b.line.id
            ? -1
            : 1
          : a.line.variantId < b.line.variantId
            ? -1
            : 1
      )
    let locationId: string | null = null
    for (const { line, index } of ordered) {
      const variant = await this.references.variant(scope.context, line.variantId)
      if (!variant || !variant.product.trackStock) continue
      const fail = (code: string, message: string) =>
        new ApiError(409, 'GOODS_RECEIPT_NOT_POSTABLE', 'A recepção não pode ser lançada.', [
          { path: `lines[${index}]`, code, message },
        ])
      if (!receipt.warehouseId) {
        throw fail('WAREHOUSE_REQUIRED', 'Indique o armazém: há produtos com controlo de stock.')
      }
      if (!locationId) {
        const locations = await this.warehouses.listLocations(scope, receipt.warehouseId)
        locationId = locations.find((l) => l.active)?.id ?? null
        if (!locationId) throw fail('NO_LOCATION', 'O armazém não tem nenhum local activo.')
      }
      let lotId: string | null = null
      if (variant.product.trackingMode === 'LOT') {
        if (!line.lotCode) throw fail('LOT_REQUIRED', 'Este produto exige o código do lote.')
        const known = await this.lots.list(scope, { variantId: line.variantId })
        const existing = known.find((lot) => lot.code === line.lotCode)
        const lot =
          existing ??
          (await this.lots.insert(scope, {
            variantId: line.variantId,
            code: line.lotCode,
            manufacturedOn: null,
            expiresOn: line.expiresOn,
          }))
        lotId = lot?.id ?? null
      }
      await this.stock.postInScope(scope, {
        kind: 'RECEIPT',
        variantId: line.variantId,
        locationId,
        lotId,
        quantityDelta: line.quantity,
        unitCost: line.unitCost,
        source: { type: RECEIPT_SOURCE, id: receipt.id, lineId: line.id, effect: 'IN' },
      })
    }
  }

  /** Tira o stock das entradas da recepção com movimentos opostos ao custo original. */
  async reverse(scope: TenantScope, receipt: ReceiptRef) {
    const movements = await this.ledger.movementsBySource(scope, RECEIPT_SOURCE, receipt.id)
    for (const movement of movements) {
      await this.stock.reverseInScope(scope, movement, REASON)
    }
  }
}
