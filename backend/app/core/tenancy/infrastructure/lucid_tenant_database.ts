import { AsyncLocalStorage } from 'node:async_hooks'
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

/** SQLSTATE de uma transacção abortada por um erro anterior (o COMMIT dela é um ROLLBACK). */
const IN_FAILED_SQL_TRANSACTION = '25P02'

/** A transacção aberta por um `run` em curso nesta cadeia assíncrona, para os `run` aninhados a juntarem. */
const activeScope = new AsyncLocalStorage<{ connection: string; scope: LucidTenantScope }>()

/**
 * Executa o trabalho numa transacção da conta de runtime com o tenant definido através de
 * `set_config('app.tenant_id', …, true)`. O valor é local à transacção: termina com o COMMIT/ROLLBACK
 * e nunca fica na ligação do pool para o tenant seguinte. As políticas RLS leem-no por
 * `app_current_tenant_id()`.
 *
 * Um `run` chamado **dentro** de outro `run` do mesmo tenant, actor e ligação **junta-se** à transacção em curso (é assim
 * que um módulo compõe os casos de uso públicos de outro — por exemplo, converter uma lead cria Party, cliente e
 * oportunidade de forma atómica): tudo confirma ou tudo reverte. Um tenant ou actor diferente nunca se junta.
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

    const outer = activeScope.getStore()
    if (
      outer &&
      outer.connection === this.connection &&
      outer.scope.context.tenantId === resolved.tenantId &&
      outer.scope.context.membershipId === resolved.membershipId &&
      outer.scope.context.userId === resolved.userId
    ) {
      return fn(outer.scope)
    }

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
      const scope = new LucidTenantScope(resolved, trx)
      const result = await activeScope.run({ connection: this.connection, scope }, () => fn(scope))
      // As restrições diferidas verificam-se aqui, ainda dentro do callback: se uma falhar, o erro chega ao chamador
      // e a transacção reverte. Deixá-las para o COMMIT faria a transacção gerida do Lucid desfazer em silêncio (R-01).
      // Excepção: uma transacção já abortada (25P02) — um caso de uso tratou um erro dentro dela (p. ex. a violação de
      // unicidade convertida em 409) — não verifica nada e o COMMIT reverte, como sempre.
      try {
        await trx.rawQuery('set constraints all immediate')
      } catch (error) {
        if ((error as { code?: string }).code !== IN_FAILED_SQL_TRANSACTION) throw error
      }
      return result
    })
  }
}
