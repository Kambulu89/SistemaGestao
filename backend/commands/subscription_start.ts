import { BaseCommand, args, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { reportCommandError } from '#shared/command_error'

/** Gestão local: inicia a subscrição de um tenant num plano publicado (experimental se o plano tiver dias). */
export default class SubscriptionStart extends BaseCommand {
  static commandName = 'subscription:start'
  static description = 'Inicia a subscrição de um tenant (por código) num plano (por código)'
  static options: CommandOptions = { startApp: true }

  @args.string()
  declare tenantCode: string

  @args.string()
  declare planCode: string

  @flags.boolean({ description: 'Sem período experimental (activa logo)' })
  declare skipTrial: boolean

  async run() {
    try {
      const db = (await import('@adonisjs/lucid/services/db')).default
      const { PlatformSubscriptionService } = await import('#modules/subscription/index')
      const tenant = (
        await db
          .connection('runtime')
          .rawQuery('select id from tenants where code = ?', [this.tenantCode])
      ).rows[0]
      const plan = (
        await db
          .connection('runtime')
          .rawQuery('select id from plans where code = ?', [this.planCode])
      ).rows[0]
      if (!tenant || !plan) {
        this.logger.error(!tenant ? 'O tenant não existe.' : 'O plano não existe.')
        this.exitCode = 1
        return
      }
      const sub = await new PlatformSubscriptionService().start(
        tenant.id,
        {
          planId: plan.id,
          trial: this.skipTrial ? false : undefined,
          reason: 'Gestão local (comando)',
        },
        null
      )
      this.logger.success(`Subscrição ${sub?.status} no plano ${this.planCode}.`)
    } catch (error) {
      reportCommandError(this, error)
    }
  }
}
