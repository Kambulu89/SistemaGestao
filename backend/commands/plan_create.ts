import { BaseCommand, args, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

export default class PlanCreate extends BaseCommand {
  static commandName = 'plan:create'
  static description =
    'Cria uma nova revisão (rascunho) de um plano; --publish publica-a logo (fica imutável)'
  static options: CommandOptions = { startApp: true }

  @args.string({ description: 'Código do plano (a-z, 0-9, _)' })
  declare code: string

  @args.string({ description: 'Nome do plano' })
  declare name: string

  @flags.string({ description: 'Preço decimal por período (ex.: 49.90)', default: '0' })
  declare price: string

  @flags.string({ description: 'Moeda ISO 4217', default: 'AOA' })
  declare currency: string

  @flags.string({ description: 'MONTH ou YEAR', default: 'MONTH' })
  declare interval: string

  @flags.string({ description: 'Limite de membros: número ou "none" (ilimitado)', default: '5' })
  declare members: string

  @flags.string({ description: 'Módulos licenciados, separados por vírgulas' })
  declare modules: string

  @flags.string({ description: 'Funcionalidades licenciadas, separadas por vírgulas' })
  declare features: string

  @flags.boolean({ description: 'Publica a revisão criada' })
  declare publish: boolean

  async run() {
    const { billingServices } = await import('#platform/billing/index')
    const services = billingServices()
    const split = (value?: string) =>
      value
        ? value
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
        : []
    const plan = await services.createPlan.execute({
      planCode: this.code,
      name: this.name,
      currency: this.currency,
      price: this.price,
      billingInterval: this.interval.toUpperCase(),
      limits: { members: this.members.toLowerCase() === 'none' ? null : Number(this.members) },
      entitlements: { modules: split(this.modules), features: split(this.features) },
    })
    if (this.publish) await services.publishPlan.execute(plan.planCode, plan.revision)
    this.logger.success(
      `Plano ${plan.planCode} revisão ${plan.revision} ${this.publish ? 'publicada' : 'criada (rascunho)'}.`
    )
  }
}
