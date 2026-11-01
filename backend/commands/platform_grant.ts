import { BaseCommand, args, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

export default class PlatformGrant extends BaseCommand {
  static commandName = 'platform:grant'
  static description =
    'Concede uma permissão de plataforma (platform.tenant.manage | platform.billing.manage) a um utilizador'
  static options: CommandOptions = { startApp: true }

  @args.string({ description: 'Email da conta' })
  declare email: string

  @args.string({ description: 'Permissão de plataforma' })
  declare permission: string

  @flags.string({ description: 'Motivo da concessão (obrigatório)' })
  declare reason: string

  @flags.number({ description: 'Validade em dias (por omissão, sem prazo)' })
  declare days: number

  async run() {
    const { administrationServices } = await import('#platform/administration/index')
    const { authServices, normalizeEmail } = await import('#core/auth/index')
    const { securityEvents } = await import('#core/audit/index')
    const { ApiError } = await import('#core/http/api_error')
    const user = await authServices().users.findByEmail(normalizeEmail(this.email))
    if (!user) throw ApiError.notFound('Utilizador não encontrado.')
    const grant = await administrationServices().grant.execute({
      userId: user.id,
      permission: this.permission,
      reason: this.reason ?? '',
      expiresInDays: this.days,
    })
    await securityEvents.record({
      type: 'PLATFORM_GRANT_CHANGED',
      severity: 'HIGH',
      userId: user.id,
      metadata: { change: 'GRANTED', permission: grant.permission, expiresAt: grant.expiresAt },
    })
    this.logger.success(`${grant.permission} concedida a ${user.email}.`)
  }
}
