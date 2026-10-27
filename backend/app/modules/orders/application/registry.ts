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
