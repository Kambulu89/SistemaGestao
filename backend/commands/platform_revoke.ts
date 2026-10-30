import { BaseCommand, args } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

export default class PlatformRevoke extends BaseCommand {
  static commandName = 'platform:revoke'
  static description =
    'Revoga uma permissão de plataforma de um utilizador (a concessão fica no histórico)'
  static options: CommandOptions = { startApp: true }

  @args.string({ description: 'Email da conta' })
  declare email: string

  @args.string({ description: 'Permissão de plataforma' })
  declare permission: string

  async run() {
    const { administrationServices } = await import('#platform/administration/index')
    const { authServices, normalizeEmail } = await import('#core/auth/index')
    const { securityEvents } = await import('#core/audit/index')
    const { ApiError } = await import('#core/http/api_error')
    const user = await authServices().users.findByEmail(normalizeEmail(this.email))
    if (!user) throw ApiError.notFound('Utilizador não encontrado.')
    await administrationServices().revoke.execute(user.id, this.permission)
    await securityEvents.record({
      type: 'PLATFORM_GRANT_CHANGED',
      severity: 'HIGH',
      userId: user.id,
      metadata: { change: 'REVOKED', permission: this.permission },
    })
    this.logger.success(`${this.permission} revogada a ${user.email}.`)
  }
}
