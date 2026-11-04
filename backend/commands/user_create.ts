import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { reportCommandError } from '#shared/command_error'

/** Administração local: cria uma conta global com palavra-passe pedida no terminal (nunca em argumentos). */
export default class UserCreate extends BaseCommand {
  static commandName = 'user:create'
  static description = 'Cria uma conta de utilizador (a palavra-passe é pedida de forma segura)'
  static options: CommandOptions = { startApp: true }

  @flags.string({ required: true })
  declare email: string

  @flags.string({ required: true })
  declare name: string

  async run() {
    try {
      await this.create()
    } catch (error) {
      reportCommandError(this, error)
    }
  }

  private async create() {
    const password = await this.prompt.secure('Palavra-passe (12 a 128 caracteres)')
    const { createUserWithPassword } = await import('#modules/members/application/tenant_bootstrap')
    const user = await createUserWithPassword(this.email, this.name, password)
    this.logger.success(`Conta criada: ${user.email}`)
  }
}
