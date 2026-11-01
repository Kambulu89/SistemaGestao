import { BaseCommand, args } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

export default class TenantDomainVerify extends BaseCommand {
  static commandName = 'tenant:domain:verify'
  static description = 'Verifica um domínio com o token recebido ao registá-lo'
  static options: CommandOptions = { startApp: true }

  @args.string({ description: 'Domínio' })
  declare hostname: string

  @args.string({ description: 'Token de verificação' })
  declare token: string

  async run() {
    const { LucidTenantStore, VerifyTenantDomain } = await import('#platform/tenants/index')
    await new VerifyTenantDomain(new LucidTenantStore()).execute({
      hostname: this.hostname,
      verificationToken: this.token,
    })
    this.logger.success(`Domínio ${this.hostname} verificado.`)
  }
}
