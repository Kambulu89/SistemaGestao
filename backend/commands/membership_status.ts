import { BaseCommand, args } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

export default class MembershipStatus extends BaseCommand {
  static commandName = 'membership:status'
  static description = 'Muda o estado de uma membership (ACTIVE, SUSPENDED, LEFT)'
  static options: CommandOptions = { startApp: true }

  @args.string({ description: 'Código do tenant' })
  declare code: string

  @args.string({ description: 'Email do utilizador' })
  declare email: string

  @args.string({ description: 'Novo estado' })
  declare status: string

  async run() {
    const { changeMemberStatusByEmail } = await import('#platform/tenants/index')
    const { MEMBERSHIP_STATUSES } = await import('#core/membership/index')
    const target = MEMBERSHIP_STATUSES.find((s) => s === this.status.toUpperCase())
    if (!target) {
      this.logger.error(`Estado inválido. Use: ${MEMBERSHIP_STATUSES.join(', ')}.`)
      this.exitCode = 1
      return
    }
    const membership = await changeMemberStatusByEmail(this.code, this.email, target)
    this.logger.success(
      `Membership agora ${membership.status} (authorizationVersion ${membership.authorizationVersion}).`
    )
  }
}
