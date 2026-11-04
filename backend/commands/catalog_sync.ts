import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/** Sincroniza os catálogos do código (permissões e funcionalidades contratáveis) com a base. Idempotente. */
export default class CatalogSync extends BaseCommand {
  static commandName = 'catalog:sync'
  static description = 'Sincroniza permissões e funcionalidades (correr depois de npm run migrate)'
  static options: CommandOptions = { startApp: true }

  async run() {
    const { syncPermissionCatalog } = await import('#modules/rbac/index')
    const { syncFeatureCatalog } = await import('#modules/subscription/index')
    await syncPermissionCatalog()
    await syncFeatureCatalog()
    this.logger.success('Catálogos de permissões e funcionalidades sincronizados.')
  }
}
