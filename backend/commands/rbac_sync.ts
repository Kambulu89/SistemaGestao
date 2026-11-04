import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/** Sincroniza o catálogo de permissões do código com a base e actualiza os perfis de administrador. Idempotente. */
export default class RbacSync extends BaseCommand {
  static commandName = 'rbac:sync'
  static description = 'Sincroniza o catálogo de permissões (correr depois de npm run migrate)'
  static options: CommandOptions = { startApp: true }

  async run() {
    const { syncPermissionCatalog } = await import('#modules/rbac/index')
    await syncPermissionCatalog()
    this.logger.success('Catálogo de permissões sincronizado.')
  }
}
