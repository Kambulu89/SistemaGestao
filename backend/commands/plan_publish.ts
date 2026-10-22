import { BaseCommand, args } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

export default class PlanPublish extends BaseCommand {
  static commandName = 'plan:publish'
  static description = 'Publica uma revisão de plano (passa a imutável)'
  static options: CommandOptions = { startApp: true }

  @args.string({ description: 'Código do plano' })
  declare code: string

  @args.string({ description: 'Revisão (inteiro ≥ 1)' })
  declare revision: string

  async run() {
    const { billingServices } = await import('#platform/billing/index')
    const plan = await billingServices().publishPlan.execute(this.code, Number(this.revision))
    this.logger.success(`Plano ${plan.planCode} revisão ${plan.revision} publicada.`)
  }
}
