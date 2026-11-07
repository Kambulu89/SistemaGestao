import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * Concede ou retira a administração da plataforma a uma conta existente (só gestão local). Dá acesso ao plano de controlo
 * (tenants, planos, subscrições), nunca aos dados de negócio dos tenants.
 */
export default class PlatformAdmin extends BaseCommand {
  static commandName = 'platform:admin'
  static description = 'Concede (ou com --revoke retira) a administração da plataforma a uma conta'
  static options: CommandOptions = { startApp: true }

  @flags.string({ required: true })
  declare email: string

  @flags.boolean({ description: 'Retira em vez de conceder' })
  declare revoke: boolean

  async run() {
    const db = (await import('@adonisjs/lucid/services/db')).default
    const result = await db
      .connection('runtime')
      .rawQuery(
        'update users set is_platform_admin = ?, updated_at = now() where lower(email) = lower(?) returning email',
        [!this.revoke, this.email]
      )
    if (result.rows.length === 0) {
      this.logger.error('A conta não existe.')
      this.exitCode = 1
      return
    }
    this.logger.success(
      `${this.revoke ? 'Retirada' : 'Concedida'} a administração da plataforma a ${this.email}.`
    )
  }
}
