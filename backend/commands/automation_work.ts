import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

export default class AutomationWork extends BaseCommand {
  static commandName = 'automation:work'
  static description =
    'Trabalhador das automações: despacha eventos do outbox e calendários e executa as execuções devidas (todos os tenants operacionais)'
  static options: CommandOptions = { startApp: true }

  @flags.boolean({ description: 'Faz uma só volta e termina' })
  declare once: boolean

  @flags.number({ description: 'Segundos entre voltas', default: 5 })
  declare interval: number

  async run() {
    const { automationServices } = await import('#dynamic/automations/index')
    const worker = automationServices().worker((tenantId, error) => {
      this.logger.error(
        `Tenant ${tenantId}: ${error instanceof Error ? error.message : 'falha desconhecida'}`
      )
    })
    let stop = false
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => (stop = true))
    do {
      const result = await worker.tick()
      if (result.dispatched + result.scheduled + result.executed > 0) {
        this.logger.info(
          `Eventos despachados: ${result.dispatched}; calendários: ${result.scheduled}; execuções: ${result.executed}.`
        )
      }
      if (this.once) break
      await new Promise((resolve) => setTimeout(resolve, this.interval * 1000))
    } while (!stop)
  }
}
