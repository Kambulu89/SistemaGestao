import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

export default class PlatformList extends BaseCommand {
  static commandName = 'platform:list'
  static description = 'Lista as concessões de plataforma (incluindo as revogadas)'
  static options: CommandOptions = { startApp: true }

  async run() {
    const { administrationServices } = await import('#platform/administration/index')
    const grants = await administrationServices().listGrants.execute()
    this.logger.info(
      grants.length === 0
        ? 'Sem concessões.'
        : grants
            .map(
              (g) =>
                `${g.userId} ${g.permission}${g.revokedAt ? ' (revogada)' : ''}${g.expiresAt ? ` até ${g.expiresAt.toISOString()}` : ''}`
            )
            .join('\n')
    )
  }
}
