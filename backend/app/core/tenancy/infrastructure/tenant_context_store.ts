import { AsyncLocalStorage } from 'node:async_hooks'
import { MissingTenantContextError, type TenantContext } from '#core/tenancy/domain/tenant_context'

/**
 * Propaga o `TenantContext` pela cadeia assíncrona de um pedido, job ou consumidor sem o passar por
 * parâmetro em todo o lado. Cada `run` é isolado: execuções concorrentes de tenants diferentes nunca
 * se vêem umas às outras.
 */
export class TenantContextStore {
  readonly #storage = new AsyncLocalStorage<TenantContext>()

  run<T>(context: TenantContext, fn: () => T): T {
    return this.#storage.run(context, fn)
  }

  /** O contexto actual, ou `undefined` fora de qualquer `run`. */
  find(): TenantContext | undefined {
    return this.#storage.getStore()
  }

  /** O contexto actual. Sem contexto, falha: nunca se assume um tenant. */
  current(): TenantContext {
    const context = this.#storage.getStore()
    if (!context) throw new MissingTenantContextError()
    return context
  }
}

export const tenantContextStore = new TenantContextStore()
