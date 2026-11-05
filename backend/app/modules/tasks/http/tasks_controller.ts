import type { HttpContext } from '@adonisjs/core/http'
import { ok } from '#shared/http/respond'
import { ApprovalRequestService } from '#modules/approvals/index'
import { entitlementsFor } from '#modules/subscription/index'

const approvals = new ApprovalRequestService()

/**
 * Centro de tarefas: acções pendentes do membro em contexto, derivadas das fontes de verdade (não há tabela de tarefas
 * duplicada). Hoje: etapas de aprovação que pode decidir (por si ou por delegação). Os módulos futuros acrescentam aqui.
 */
export default class TasksController {
  async index(ctx: HttpContext) {
    const context = ctx.tenantContext!
    const { features } = await entitlementsFor(context.tenantId)
    const items = features.get('approvals')?.enabled
      ? (await approvals.pendingTasks(context)).map((slot) => ({
          type: 'APPROVAL',
          subjectType: 'approval_request',
          subjectId: slot.requestId,
          title: slot.title,
          detail: slot.stepName,
          stepSequence: slot.stepSequence,
          onBehalfOf: slot.onBehalfOf,
          since: slot.createdAt,
        }))
      : []
    return ok(ctx, items, { total: items.length })
  }
}
