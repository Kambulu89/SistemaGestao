import { BaseCommand, args } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

export default class MembershipAdd extends BaseCommand {
  static commandName = 'membership:add'
  static description = 'Acrescenta um utilizador existente a um tenant (membership ACTIVE)'
  static options: CommandOptions = { startApp: true }

  @args.string({ description: 'Código do tenant' })
  declare code: string

  @args.string({ description: 'Email do utilizador' })
  declare email: string

  async run() {
    const { addMemberByEmail } = await import('#platform/tenants/index')
    const membership = await addMemberByEmail(this.code, this.email)
    this.logger.success(`Membership ${membership.id} criada (${membership.status}).`)
  }
}
