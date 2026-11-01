import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

export default class PlanList extends BaseCommand {
  static commandName = 'plan:list'
  static description = 'Lista as versões de planos'
  static options: CommandOptions = { startApp: true }

  async run() {
    const { billingServices } = await import('#platform/billing/index')
    const plans = await billingServices().listPlans.execute()
    this.logger.info(
      plans.length === 0
        ? 'Sem planos.'
        : plans
            .map(
              (p) =>
                `${p.planCode} r${p.revision} ${p.status} ${p.price} ${p.currency}/${p.billingInterval} membros=${p.limits.members ?? 'ilimitado'}`
            )
            .join('\n')
    )
  }
}
