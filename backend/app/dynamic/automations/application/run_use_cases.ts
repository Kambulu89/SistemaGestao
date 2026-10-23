import { ApiError } from '#core/http/api_error'
import type { TenantContext, TenantUnitOfWork } from '#core/tenancy/index'
import { GUARD_CODES, type RunStatus } from '#dynamic/automations/domain/automation'
import type { AutomationRun, RunStore } from '#dynamic/automations/application/ports'

/** Histórico de execuções e reprocessamento manual da fila de falhas (C15). */
export class RunUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly runs: RunStore
  ) {}

  list(
    context: TenantContext,
    filter: { automationId?: string; status?: RunStatus }
  ): Promise<AutomationRun[]> {
    return this.uow.run((scope) => this.runs.list(scope, filter), context)
  }

  async get(context: TenantContext, id: string): Promise<AutomationRun> {
    const run = await this.uow.run((scope) => this.runs.find(scope, id), context)
    if (!run) throw ApiError.notFound()
    return run
  }

  /**
   * Devolve uma execução falhada à fila. Retoma a seguir à última acção concluída (a mesma chave, por isso um envio ou
   * pagamento já feito não se repete). As execuções fechadas pelas regras do motor (profundidade, ciclo, limite) não se
   * reprocessam: voltariam a ser fechadas pela mesma razão.
   */
  retry(context: TenantContext, id: string, expectedVersion: number): Promise<AutomationRun> {
    return this.uow.run(async (scope) => {
      const run = await this.runs.find(scope, id)
      if (!run) throw ApiError.notFound()
      if (run.status !== 'DEAD' && run.status !== 'FAILED') {
        throw ApiError.conflict('RUN_NOT_RETRIABLE', 'Só se reprocessa uma execução falhada.')
      }
      if (run.errorCode && (GUARD_CODES as readonly string[]).includes(run.errorCode)) {
        throw ApiError.conflict(
          'RUN_BLOCKED_BY_RULE',
          'Esta execução foi fechada por uma regra do motor (causalidade ou limite) e não se reprocessa.'
        )
      }
      return this.runs.requeue(scope, id, expectedVersion)
    }, context)
  }
}
