import { BaseCommand, args, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

export default class TenantCreate extends BaseCommand {
  static commandName = 'tenant:create'
  static description = 'Cria um tenant (em PROVISIONING; use tenant:status para o activar)'
  static options: CommandOptions = { startApp: true }

  @args.string({ description: 'Código técnico (a-z, 0-9, _)' })
  declare code: string

  @args.string({ description: 'Nome do tenant' })
  declare name: string

  @flags.boolean({ description: 'Activa o tenant logo a seguir à criação' })
  declare activate: boolean

  async run() {
    const { ChangeTenantStatus, CreateTenant, LucidTenantStore } =
      await import('#platform/tenants/index')
    const store = new LucidTenantStore()
    const tenant = await new CreateTenant(store).execute({ code: this.code, name: this.name })
    if (this.activate) await new ChangeTenantStatus(store).execute(tenant.code, 'ACTIVE')
    this.logger.success(`Tenant ${tenant.code} criado (${tenant.id}).`)
  }
}
