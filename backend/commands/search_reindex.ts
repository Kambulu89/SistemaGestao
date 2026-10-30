import { args, BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

export default class SearchReindex extends BaseCommand {
  static commandName = 'search:reindex'
  static description =
    'Reconstrói o índice de pesquisa de um tenant (idempotente; o que desapareceu da origem sai do índice)'
  static options: CommandOptions = { startApp: true }

  @args.string({ description: 'Código do tenant' })
  declare tenant: string

  async run() {
    const { LucidTenantStore } = await import('#platform/tenants/index')
    const { reportingServices } = await import('#modules/reporting/index')
    const all = await new LucidTenantStore().list()
    const found = all.find((t) => t.code === this.tenant)
    if (!found) {
      this.logger.error(`Tenant «${this.tenant}» não encontrado.`)
      this.exitCode = 1
      return
    }
    for (const r of await reportingServices().search.reindex(found.id)) {
      this.logger.info(`${r.type}: ${r.indexed} indexados, ${r.removed} removidos.`)
    }
  }
}
