import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * Gera os períodos vencidos dos contratos recorrentes activos de todos os tenants (10.11): só RASCUNHOS de factura,
 * nunca emite. Cada contrato corre no contexto do membro que o criou (auditoria e RLS).
 */
export default class SalesRecurring extends BaseCommand {
  static commandName = 'sales:recurring'
  static description =
    'Gera os rascunhos de factura dos contratos recorrentes vencidos (nunca emite)'
  static options: CommandOptions = { startApp: true }

  async run() {
    const { default: db } = await import('@adonisjs/lucid/services/db')
    const { generateContract } = await import('#modules/sales/index')
    const rows = (
      await db.connection('owner').rawQuery(
        `select c.id, c.tenant_id, m.id as membership_id, m.user_id from sales_recurring_contracts c
           join tenant_memberships m on m.tenant_id = c.tenant_id and m.id = c.owner_membership_id
          where c.status = 'ACTIVE' order by c.tenant_id, c.reference`
      )
    ).rows as { id: string; tenant_id: string; membership_id: string; user_id: string }[]
    let generated = 0
    let failed = 0
    for (const r of rows) {
      const out = await generateContract(
        {
          tenantId: r.tenant_id,
          userId: r.user_id,
          membershipId: r.membership_id,
          requestId: `recurring-${Date.now()}`,
        },
        r.id
      )
      generated += out.filter((x) => x.invoiceId).length
      failed += out.filter((x) => x.failed).length
    }
    this.logger.success(
      `Recorrência: ${generated} rascunho(s) gerado(s), ${failed} período(s) com falha, ${rows.length} contrato(s) activo(s).`
    )
  }
}
