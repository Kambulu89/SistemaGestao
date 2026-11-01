import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

export default class ExportsWork extends BaseCommand {
  static commandName = 'exports:work'
  static description =
    'Trabalhador das exportações: gera os CSV pedidos (revalidando os direitos de quem pediu) e limpa os expirados'
  static options: CommandOptions = { startApp: true }

  @flags.boolean({ description: 'Faz uma só volta e termina' })
  declare once: boolean

  @flags.number({ description: 'Segundos entre voltas', default: 5 })
  declare interval: number

  async run() {
    const { reportingServices } = await import('#modules/reporting/index')
    const { exports, resolver } = reportingServices()
    let stop = false
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => (stop = true))
    do {
      let done = 0
      for (const tenantId of await resolver.tenantIds()) {
        try {
          while (await exports.processNext(tenantId, resolver)) done += 1
          await exports.sweep(tenantId, resolver)
        } catch (error) {
          this.logger.error(
            `Tenant ${tenantId}: ${error instanceof Error ? error.message : 'falha desconhecida'}`
          )
        }
      }
      if (done > 0) this.logger.info(`Exportações tratadas: ${done}.`)
      if (this.once) break
      await new Promise((resolve) => setTimeout(resolve, this.interval * 1000))
    } while (!stop)
  }
}
