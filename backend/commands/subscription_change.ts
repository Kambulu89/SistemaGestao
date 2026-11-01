import { BaseCommand, args, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

export default class SubscriptionChange extends BaseCommand {
  static commandName = 'subscription:change'
  static description =
    'Muda o plano de um tenant. Se o consumo exceder os novos limites, exige --adequacy-days (nada é eliminado)'
  static options: CommandOptions = { startApp: true }

  @args.string({ description: 'Código do tenant' })
  declare tenant: string

  @args.string({ description: 'Código do plano' })
  declare plan: string

  @flags.number({ description: 'Revisão (por omissão, a última publicada)' })
  declare revision: number

  @flags.number({ description: 'Dias de adequação se o consumo exceder os limites' })
  declare adequacyDays: number

  async run() {
    const { billingServices } = await import('#platform/billing/index')
    const { LucidTenantStore } = await import('#platform/tenants/index')
    const { ApiError } = await import('#core/http/api_error')
    const tenant = await new LucidTenantStore().findByCode(this.tenant.trim().toLowerCase())
    if (!tenant) throw ApiError.notFound('Tenant não encontrado.')
    const subscription = await billingServices().changePlan.execute({
      tenantId: tenant.id,
      planCode: this.plan,
      revision: this.revision,
      adequacyDays: this.adequacyDays,
    })
    this.logger.success(
      `Tenant ${tenant.code}: plano alterado${subscription.adequacyUntil ? ` (adequação até ${subscription.adequacyUntil.toISOString()})` : ''}.`
    )
  }
}
