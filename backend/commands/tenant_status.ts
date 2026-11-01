import { BaseCommand, args } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

export default class TenantStatus extends BaseCommand {
  static commandName = 'tenant:status'
  static description = 'Muda o estado de um tenant (ACTIVE, SUSPENDED, CLOSING, CLOSED)'
  static options: CommandOptions = { startApp: true }

  @args.string({ description: 'Código do tenant' })
  declare code: string

  @args.string({ description: 'Novo estado' })
  declare status: string

  async run() {
    const { ChangeTenantStatus, LucidTenantStore, TENANT_STATUSES } =
      await import('#platform/tenants/index')
    const target = TENANT_STATUSES.find((s) => s === this.status.toUpperCase())
    if (!target) {
      this.logger.error(`Estado inválido. Use: ${TENANT_STATUSES.join(', ')}.`)
      this.exitCode = 1
      return
    }
    const tenant = await new ChangeTenantStatus(new LucidTenantStore()).execute(this.code, target)
    this.logger.success(`Tenant ${tenant.code} agora está ${tenant.status}.`)
  }
}
