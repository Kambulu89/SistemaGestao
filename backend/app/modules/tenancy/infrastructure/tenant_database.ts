import { AsyncLocalStorage } from 'node:async_hooks'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import {
  MissingTenantContextError,
  type TenantContext,
} from '#modules/tenancy/domain/tenant_context'

/** Transacção de tenant: o contexto e a transacção em que `app.tenant_id` já está definido. */
export interface TenantScope {
  readonly context: TenantContext
  readonly trx: TransactionClientContract
}

const active = new AsyncLocalStorage<TenantScope>()

/**
 * Única porta de acesso a dados de tenant. Abre uma transacção na conta de runtime e define `app.tenant_id` (e o actor,
 * para a auditoria) com `set_config(..., true)`: o valor é local à transacção e nunca fica na ligação do pool. As
 * políticas RLS leem-no por `app_current_tenant_id()`. Um `run` dentro de outro do mesmo tenant e actor junta-se à
 * transacção em curso (composição atómica entre módulos); um tenant diferente nunca se junta.
 */
export async function runInTenant<T>(
  context: TenantContext | undefined,
  fn: (scope: TenantScope) => Promise<T>
): Promise<T> {
  if (!context) throw new MissingTenantContextError()
  const outer = active.getStore()
  if (
    outer &&
    outer.context.tenantId === context.tenantId &&
    outer.context.membershipId === context.membershipId
  ) {
    return fn(outer)
  }
  return db.connection('runtime').transaction(async (trx) => {
    await trx.rawQuery(
      `select set_config('app.tenant_id', ?, true), set_config('app.actor_user_id', ?, true),
              set_config('app.actor_membership_id', ?, true), set_config('app.request_id', ?, true)`,
      [context.tenantId, context.userId, context.membershipId, context.requestId]
    )
    const scope: TenantScope = { context, trx }
    return active.run(scope, () => fn(scope))
  })
}
