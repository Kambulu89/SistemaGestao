import type { TenantScope } from '#core/tenancy/index'
import type { Issue } from '#modules/orders/domain/sales'
import type { Line, Order } from '#modules/orders/application/ports'

/** Uma verificação extra que a confirmação de uma encomenda corre (stock, crédito…); devolve os problemas que encontrar. */
export type ConfirmationCheck = (
  scope: TenantScope,
  order: Order,
  lines: readonly Line[]
) => Promise<Issue[]>

const checks: ConfirmationCheck[] = []

/**
 * O inventário (stock insuficiente, política de backorder) e as finanças (crédito) registam aqui as suas verificações; as
 * encomendas não dependem deles. Sem nenhuma registada, nada mais se verifica (D-048). Devolve a função que a retira.
 */
export function registerConfirmationCheck(check: ConfirmationCheck): () => void {
  checks.push(check)
  return () => {
    const at = checks.indexOf(check)
    if (at >= 0) checks.splice(at, 1)
  }
}

export async function runConfirmationChecks(
  scope: TenantScope,
  order: Order,
  lines: readonly Line[]
): Promise<Issue[]> {
  const issues: Issue[] = []
  for (const check of checks) issues.push(...(await check(scope, order, lines)))
  return issues
}

/** Um efeito que corre **na mesma transacção** da confirmação ou do cancelamento (reservas de stock, de crédito…). */
export interface OrderEffects {
  /** Depois de a encomenda ficar confirmada; lançar um erro anula a confirmação por inteiro. */
  confirmed?(scope: TenantScope, order: Order, lines: readonly Line[]): Promise<void>
  /** Depois de a encomenda ficar cancelada. */
  cancelled?(scope: TenantScope, order: Order, lines: readonly Line[]): Promise<void>
}

const effects: OrderEffects[] = []

/**
 * O inventário regista aqui a reserva (ao confirmar) e a libertação (ao cancelar) de stock. As encomendas não dependem do
 * inventário: sem nenhum efeito registado, confirmar e cancelar só mudam a encomenda. Devolve a função que o retira.
 */
export function registerOrderEffects(effect: OrderEffects): () => void {
  effects.push(effect)
  return () => {
    const at = effects.indexOf(effect)
    if (at >= 0) effects.splice(at, 1)
  }
}

export async function runConfirmedEffects(
  scope: TenantScope,
  order: Order,
  lines: readonly Line[]
): Promise<void> {
  for (const effect of effects) await effect.confirmed?.(scope, order, lines)
}

export async function runCancelledEffects(
  scope: TenantScope,
  order: Order,
  lines: readonly Line[]
): Promise<void> {
  for (const effect of effects) await effect.cancelled?.(scope, order, lines)
}
