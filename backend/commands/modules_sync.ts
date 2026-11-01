import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

export default class ModulesSync extends BaseCommand {
  static commandName = 'modules:sync'
  static description =
    'Sincroniza o registo de módulos com os manifestos do código (valida ciclos e dependências; nunca apaga)'
  static options: CommandOptions = { startApp: true }

  async run() {
    const { moduleServices, CODE_MANIFESTS } = await import('#platform/modules/index')
    const result = await moduleServices().syncRegistry.execute(CODE_MANIFESTS)
    this.logger.success(
      `Registo sincronizado: ${result.created} criados, ${result.updated} actualizados, ${result.deprecated} descontinuados.`
    )
  }
}
