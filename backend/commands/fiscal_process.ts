import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * Processa a fila de comunicação fiscal vencida (10.9, só SIMULAÇÃO) de todos os tenants: é o que o agendador corre
 * periodicamente. Cada submissão é processada no contexto do membro que emitiu o documento (auditoria e RLS).
 */
export default class FiscalProcess extends BaseCommand {
  static commandName = 'fiscal:process'
  static description =
    'Processa a fila de comunicação fiscal (simulação): envios, consultas e repetições'
  static options: CommandOptions = { startApp: true }

  @flags.number({ description: 'Máximo de chamadas por tenant', default: 50 })
  declare limit: number

  async run() {
    const { default: db } = await import('@adonisjs/lucid/services/db')
    const { processFiscalQueue } = await import('#modules/sales/index')
    const due = (
      await db.connection('owner').rawQuery(
        `select distinct on (s.tenant_id) s.tenant_id, m.id as membership_id, m.user_id
           from fiscal_submissions s join tenant_memberships m on m.tenant_id = s.tenant_id and m.id = s.requested_membership_id
          where (s.status in ('QUEUED','AWAITING') and s.next_attempt_at <= now())
             or (s.status = 'SENDING' and s.updated_at < now() - interval '5 minutes')
          order by s.tenant_id, s.next_attempt_at`
      )
    ).rows as { tenant_id: string; membership_id: string; user_id: string }[]
    let total = 0
    for (const d of due) {
      const done = await processFiscalQueue(
        {
          tenantId: d.tenant_id,
          userId: d.user_id,
          membershipId: d.membership_id,
          requestId: `fiscal-process-${Date.now()}`,
        },
        this.limit
      )
      total += done.length
    }
    this.logger.success(`Fila fiscal (simulação): ${total} chamada(s) em ${due.length} empresa(s).`)
  }
}
