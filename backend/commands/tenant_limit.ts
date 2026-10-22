import { BaseCommand, args } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

export default class TenantLimit extends BaseCommand {
  static commandName = 'tenant:limit'
  static description =
    'Define o limite de membros de um tenant (número ou "none"); provisório até haver planos'
  static options: CommandOptions = { startApp: true }

  @args.string({ description: 'Código do tenant' })
  declare code: string

  @args.string({ description: 'Número máximo de membros ou "none"' })
  declare max: string

  async run() {
    const { LucidTenantStore, SetMemberLimit } = await import('#platform/tenants/index')
    const value = this.max.toLowerCase() === 'none' ? null : Number(this.max)
    const tenant = await new SetMemberLimit(new LucidTenantStore()).execute(this.code, value)
    this.logger.success(
      `Tenant ${tenant.code}: limite de membros ${value === null ? 'removido' : value}.`
    )
  }
}
