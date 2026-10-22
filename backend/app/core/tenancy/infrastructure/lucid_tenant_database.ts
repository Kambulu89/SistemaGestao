import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import type { TenantScope, TenantUnitOfWork } from '#core/tenancy/application/tenant_unit_of_work'
import { MissingTenantContextError, type TenantContext } from '#core/tenancy/domain/tenant_context'
import {
  type TenantContextStore,
  tenantContextStore,
} from '#core/tenancy/infrastructure/tenant_context_store'

/** Âmbito concreto: contexto + transacção PostgreSQL em que `app.tenant_id` já está definido. */
export class LucidTenantScope implements TenantScope {
  constructor(
    readonly context: TenantContext,
    readonly trx: TransactionClientContract
  ) {}
}

/**
 * Executa o trabalho numa transacção da conta de runtime com o tenant definido através de
 * `set_config('app.tenant_id', …, true)`. O valor é local à transacção: termina com o COMMIT/ROLLBACK
 * e nunca fica na ligação do pool para o tenant seguinte. As políticas RLS leem-no por
 * `app_current_tenant_id()`.
 */
export class LucidTenantDatabase implements TenantUnitOfWork {
  constructor(
    private readonly store: TenantContextStore = tenantContextStore,
    private readonly connection = 'runtime'
  ) {}

  async run<T>(fn: (scope: LucidTenantScope) => Promise<T>, context?: TenantContext): Promise<T> {
    // Sem contexto, falha antes de abrir qualquer ligação.
    const resolved = context ?? this.store.find()
    if (!resolved) throw new MissingTenantContextError()

    return db.connection(this.connection).transaction(async (trx) => {
      // Tenant (RLS) e actor/correlação/IP (auditoria): variáveis locais à transacção, nunca do pool.
      await trx.rawQuery(
        `select set_config('app.tenant_id', ?, true),
                set_config('app.actor_type', ?, true),
                set_config('app.actor_user_id', ?, true),
                set_config('app.actor_membership_id', ?, true),
                set_config('app.correlation_id', ?, true),
                set_config('app.client_ip', ?, true)`,
        [
          resolved.tenantId,
          resolved.actorType,
          resolved.userId ?? '',
          resolved.membershipId ?? '',
          resolved.correlationId,
          HttpContext.get()?.request.ip() ?? '',
        ]
      )
      return fn(new LucidTenantScope(resolved, trx))
    })
  }
}
