import { BaseCommand, args } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

export default class IamBootstrap extends BaseCommand {
  static commandName = 'iam:bootstrap'
  static description = 'Atribui o papel tenant_admin a um membro de um tenant'
  static options: CommandOptions = { startApp: true }

  @args.string({ description: 'Código do tenant' })
  declare code: string

  @args.string({ description: 'Email do membro' })
  declare email: string

  async run() {
    const { bootstrapTenantAdmin } = await import('#platform/tenants/index')
    const role = await bootstrapTenantAdmin(this.code, this.email)
    this.logger.success(`Papel ${role.code} atribuído (${role.permissionCodes.length} permissões).`)
  }
}
