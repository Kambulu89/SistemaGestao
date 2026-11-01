import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

export default class NotificationsWork extends BaseCommand {
  static commandName = 'notifications:work'
  static description =
    'Trabalhador das notificações: transforma eventos do outbox em pedidos e entrega as mensagens devidas (todos os tenants operacionais)'
  static options: CommandOptions = { startApp: true }

  @flags.boolean({ description: 'Faz uma só volta e termina' })
  declare once: boolean

  @flags.number({ description: 'Segundos entre voltas', default: 5 })
  declare interval: number

  async run() {
    const { notificationServices } = await import('#modules/notifications/index')
    // Os fornecedores de canal registam-se aqui: só entrega por um canal quem tem o seu conector real configurado.
    const { registerMessagingProviders } = await import('#start/messaging')
    registerMessagingProviders()
    const worker = notificationServices().worker((tenantId, error) => {
      this.logger.error(
        `Tenant ${tenantId}: ${error instanceof Error ? error.message : 'falha desconhecida'}`
      )
    })
    let stop = false
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => (stop = true))
    do {
      const result = await worker.tick()
      if (result.consumed + result.delivered > 0) {
        this.logger.info(
          `Eventos consumidos: ${result.consumed}; entregas tratadas: ${result.delivered}.`
        )
      }
      if (this.once) break
      await new Promise((resolve) => setTimeout(resolve, this.interval * 1000))
    } while (!stop)
  }
}
