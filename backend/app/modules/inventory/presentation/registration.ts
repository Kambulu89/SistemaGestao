import { registerMovementGuard, catalogServices } from '#modules/catalog/index'
import { registerOrderEffects } from '#modules/orders/index'
import { inventoryServices } from '#modules/inventory/presentation/composition'

let registered = false

/**
 * Liga o inventário aos módulos de que não depende (D-050): o catálogo passa a saber se um produto já tem movimentos e as
 * encomendas reservam e libertam stock na própria transacção. Chamada uma vez no arranque (`start/modules.ts`).
 */
export function registerInventory(): void {
  if (registered) return
  registered = true

  registerMovementGuard(async (scope, productId) => {
    const product = await catalogServices().catalog.getProduct(scope.context, productId)
    return inventoryServices().ledger.hasMovements(
      scope,
      product.variants.map((v) => v.id)
    )
  })

  registerOrderEffects({
    confirmed: (scope, order, lines) =>
      inventoryServices().orderStock.reserveOrder(
        scope,
        { id: order.id, organizationId: order.organizationId, version: order.version },
        lines.map((l) => ({ id: l.id, variantId: l.variantId, quantity: l.quantity }))
      ),
    cancelled: (scope, order) =>
      inventoryServices().orderStock.releaseOrder(scope, {
        id: order.id,
        organizationId: order.organizationId,
        version: order.version,
      }),
  })
}
