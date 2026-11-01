import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

export default class IamSync extends BaseCommand {
  static commandName = 'iam:sync'
  static description =
    'Sincroniza o catálogo de permissões e o papel tenant_admin de todos os tenants (idempotente)'
  static options: CommandOptions = { startApp: true }

  async run() {
    const { syncIam } = await import('#platform/tenants/index')
    const { tenants } = await syncIam()
    this.logger.success(
      `Catálogo sincronizado; papel tenant_admin garantido em ${tenants} tenant(s).`
    )
  }
}
