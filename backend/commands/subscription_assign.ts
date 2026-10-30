import { BaseCommand, args, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

export default class SubscriptionAssign extends BaseCommand {
  static commandName = 'subscription:assign'
  static description =
    'Atribui um plano publicado a um tenant (repetir o mesmo pedido é idempotente)'
  static options: CommandOptions = { startApp: true }

  @args.string({ description: 'Código do tenant' })
  declare tenant: string

  @args.string({ description: 'Código do plano' })
  declare plan: string

  @flags.number({ description: 'Revisão (por omissão, a última publicada)' })
  declare revision: number

  @flags.number({ description: 'Dias de período de teste' })
  declare trialDays: number

  async run() {
    const { billingServices } = await import('#platform/billing/index')
    const { LucidTenantStore } = await import('#platform/tenants/index')
    const { ApiError } = await import('#core/http/api_error')
    const tenant = await new LucidTenantStore().findByCode(this.tenant.trim().toLowerCase())
    if (!tenant) throw ApiError.notFound('Tenant não encontrado.')
    const subscription = await billingServices().assignSubscription.execute({
      tenantId: tenant.id,
      planCode: this.plan,
      revision: this.revision,
      trialDays: this.trialDays,
    })
    this.logger.success(`Tenant ${tenant.code}: assinatura ${subscription.status}.`)
  }
}
