import { BaseCommand, args, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

export default class UserCreate extends BaseCommand {
  static commandName = 'user:create'
  static description =
    'Cria um utilizador. A palavra-passe vem de USER_PASSWORD (nunca por argumento)'
  static options: CommandOptions = { startApp: true }

  @args.string({ description: 'Email' })
  declare email: string

  @args.string({ description: 'Nome a apresentar' })
  declare displayName: string

  @flags.boolean({ description: 'Conta já verificada e activa (exige USER_PASSWORD)' })
  declare verified: boolean

  async run() {
    const { authServices } = await import('#core/auth/index')
    // A palavra-passe não passa por argumentos para não ficar no histórico da shell nem na lista de processos.
    const password = process.env.USER_PASSWORD
    const user = await authServices().createUser.execute({
      email: this.email,
      displayName: this.displayName,
      password: password || undefined,
      verified: this.verified,
    })
    this.logger.success(`Utilizador ${user.email} criado (${user.status}).`)
  }
}
