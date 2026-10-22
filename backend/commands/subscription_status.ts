import { BaseCommand, args, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

export default class SubscriptionStatusCommand extends BaseCommand {
  static commandName = 'subscription:status'
  static description = 'Muda o estado da assinatura (ACTIVE, PAST_DUE, SUSPENDED, CANCELLED)'
  static options: CommandOptions = { startApp: true }

  @args.string({ description: 'Código do tenant' })
  declare tenant: string

  @args.string({ description: 'Novo estado' })
  declare status: string

  @flags.number({ description: 'Dias de tolerância (PAST_DUE; por omissão 7)' })
  declare graceDays: number

  async run() {
    const { SUBSCRIPTION_STATUSES, billingServices } = await import('#platform/billing/index')
    const { LucidTenantStore } = await import('#platform/tenants/index')
    const { ApiError } = await import('#core/http/api_error')
    const status = SUBSCRIPTION_STATUSES.find((s) => s === this.status.toUpperCase())
    if (!status) {
      this.logger.error(`Estado inválido. Use: ${SUBSCRIPTION_STATUSES.join(', ')}.`)
      this.exitCode = 1
      return
    }
    const tenant = await new LucidTenantStore().findByCode(this.tenant.trim().toLowerCase())
    if (!tenant) throw ApiError.notFound('Tenant não encontrado.')
    const subscription = await billingServices().setSubscriptionStatus.execute({
      tenantId: tenant.id,
      status,
      graceDays: this.graceDays,
    })
    this.logger.success(`Tenant ${tenant.code}: assinatura ${subscription.status}.`)
  }
}
