import type { TenantContext } from '#core/tenancy/domain/tenant_context'

/**
 * Âmbito de uma operação de tenant: o contexto validado e (na infraestrutura) a transacção em que a
 * base de dados já tem o tenant definido. Os casos de uso recebem-no e passam-no aos repositórios;
 * sem ele não há acesso a dados de tenant.
 */
export interface TenantScope {
  readonly context: TenantContext
}

/**
 * Porta: executa um caso de uso numa única transacção com o contexto de tenant aplicado.
 * Confirma se `fn` termina; anula se lançar.
 */
export interface TenantUnitOfWork {
  run<T>(fn: (scope: TenantScope) => Promise<T>, context?: TenantContext): Promise<T>
}
