import type { TenantScope } from '#core/tenancy/index'
import type { MovementGuard } from '#modules/catalog/application/ports'

const guards: MovementGuard[] = []

/**
 * O inventário regista aqui como saber se um produto já tem movimentos de stock. O catálogo não depende do inventário:
 * sem nenhum registado (módulo ausente) não há movimentos e a unidade base ou o rastreio podem mudar; com um, mudar
 * qualquer um dos dois exige uma migração explícita (D-046). Devolve a função que retira a verificação.
 */
export function registerMovementGuard(guard: MovementGuard): () => void {
  guards.push(guard)
  return () => {
    const at = guards.indexOf(guard)
    if (at >= 0) guards.splice(at, 1)
  }
}

export async function hasMovements(scope: TenantScope, productId: string): Promise<boolean> {
  for (const guard of guards) if (await guard(scope, productId)) return true
  return false
}
