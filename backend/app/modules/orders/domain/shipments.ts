import { fromScaled, toScaled } from '#modules/orders/domain/money'
import { isPositiveQuantity, type Issue, type OrderStatus } from '#modules/orders/domain/sales'

/**
 * Expedições (M04). Domínio puro: estados, saldo por linha e o estado da encomenda que daí resulta. A quantidade entregue
 * de uma linha é sempre a soma das expedições **lançadas** (e não revertidas) — nunca um campo editável.
 */
export type ShipmentStatus = 'DRAFT' | 'POSTED' | 'REVERSED'

const issue = (path: string, code: string, message: string): Issue => ({ path, code, message })

/** Só se expede uma encomenda confirmada ou já parcialmente expedida (a totalmente expedida não tem saldo). */
export const canShip = (status: OrderStatus): boolean =>
  status === 'CONFIRMED' || status === 'PARTIAL'

export interface ShipmentLineInput {
  orderLineId?: unknown
  quantity?: unknown
}

export interface ShipmentLineValues {
  orderLineId: string
  quantity: string
}

/** Valida o pedido de uma linha (quantidade positiva com até 6 casas); o saldo verifica-se à parte, sob bloqueio. */
export function normalizeShipmentLine(
  input: ShipmentLineInput,
  path: string,
  issues: Issue[]
): ShipmentLineValues | null {
  const before = issues.length
  const orderLineId = typeof input.orderLineId === 'string' ? input.orderLineId : ''
  if (!orderLineId) {
    issues.push(issue(`${path}orderLineId`, 'REQUIRED', 'Indique a linha da encomenda.'))
  }
  if (!isPositiveQuantity(input.quantity)) {
    issues.push(
      issue(`${path}quantity`, 'INVALID_QUANTITY', 'Quantidade positiva com até 6 casas.')
    )
  }
  if (issues.length > before) return null
  return { orderLineId, quantity: input.quantity as string }
}

export interface Balance {
  ordered: bigint
  shipped: bigint
}

/** O que ainda se pode expedir de uma linha (nunca negativo). */
export const remaining = (b: Balance): bigint =>
  b.ordered > b.shipped ? b.ordered - b.shipped : 0n

/** `true` se `quantity` (texto) cabe no saldo da linha. */
export function fits(b: Balance, quantity: string): boolean {
  const q = toScaled(quantity, 6)
  return q !== null && q > 0n && q <= remaining(b)
}

export const quantityText = (value: bigint): string => fromScaled(value, 6)

/**
 * Estado da encomenda depois de lançar ou reverter: `FULFILLED` se todas as linhas estão totalmente expedidas,
 * `PARTIAL` se há alguma quantidade expedida, senão volta a `CONFIRMED`.
 */
export function statusAfterShipping(lines: readonly Balance[]): OrderStatus {
  if (lines.length > 0 && lines.every((l) => l.shipped >= l.ordered)) return 'FULFILLED'
  return lines.some((l) => l.shipped > 0n) ? 'PARTIAL' : 'CONFIRMED'
}
