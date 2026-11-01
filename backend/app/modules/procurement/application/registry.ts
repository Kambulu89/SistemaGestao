import type { TenantContext, TenantScope } from '#core/tenancy/index'
import type { PurchaseOrder, Receipt } from '#modules/procurement/application/ports'

/** Uma linha de recepção com o que o inventário precisa: a variante, a quantidade, o custo e o lote. */
export interface ReceiptLineRef {
  id: string
  purchaseLineId: string
  variantId: string
  quantity: string
  /** Custo unitário da linha da encomenda (alimenta o custo médio). */
  unitCost: string
  lotCode: string | null
  expiresOn: string | null
}

/** Efeitos de lançar e de reverter uma recepção, na **mesma transacção** (a entrada e a saída de stock). */
export interface ReceiptEffects {
  /** `true` se o armazém existe neste tenant, pertence à organização e está activo (o inventário é o dono dos armazéns). */
  warehouseUsable?(
    context: TenantContext,
    warehouseId: string,
    organizationId: string
  ): Promise<boolean>
  /** Depois de a recepção ficar lançada; lançar um erro anula o lançamento por inteiro. */
  posted?(
    scope: TenantScope,
    receipt: Receipt,
    order: PurchaseOrder,
    lines: readonly ReceiptLineRef[]
  ): Promise<void>
  /** Depois de a recepção ficar revertida; lançar um erro (stock já consumido) impede a reversão. */
  reversed?(
    scope: TenantScope,
    receipt: Receipt,
    order: PurchaseOrder,
    lines: readonly ReceiptLineRef[]
  ): Promise<void>
}

const effects: ReceiptEffects[] = []

/**
 * O inventário regista aqui a entrada de stock ao lançar e a saída ao reverter. As compras não dependem do inventário:
 * sem nenhum efeito registado, lançar só regista a recepção. Devolve a função que o retira.
 */
export function registerReceiptEffects(effect: ReceiptEffects): () => void {
  effects.push(effect)
  return () => {
    const at = effects.indexOf(effect)
    if (at >= 0) effects.splice(at, 1)
  }
}

export async function runPostedEffects(
  scope: TenantScope,
  receipt: Receipt,
  order: PurchaseOrder,
  lines: readonly ReceiptLineRef[]
): Promise<void> {
  for (const effect of effects) await effect.posted?.(scope, receipt, order, lines)
}

export async function runReversedEffects(
  scope: TenantScope,
  receipt: Receipt,
  order: PurchaseOrder,
  lines: readonly ReceiptLineRef[]
): Promise<void> {
  for (const effect of effects) await effect.reversed?.(scope, receipt, order, lines)
}

/** Sem ninguém que confirme o armazém (inventário não registado), nenhum armazém é aceite: nunca se assume. */
export async function runWarehouseCheck(
  context: TenantContext,
  warehouseId: string,
  organizationId: string
): Promise<boolean> {
  let confirmed = false
  for (const effect of effects) {
    if (!effect.warehouseUsable) continue
    if (!(await effect.warehouseUsable(context, warehouseId, organizationId))) return false
    confirmed = true
  }
  return confirmed
}
