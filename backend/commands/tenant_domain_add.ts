import { BaseCommand, args } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

export default class TenantDomainAdd extends BaseCommand {
  static commandName = 'tenant:domain:add'
  static description =
    'Regista um domínio para um tenant e mostra o token de verificação (uma só vez)'
  static options: CommandOptions = { startApp: true }

  @args.string({ description: 'Código do tenant' })
  declare code: string

  @args.string({ description: 'Domínio (ex.: empresa.exemplo.ao)' })
  declare hostname: string

  async run() {
    const { LucidTenantStore, RegisterTenantDomain } = await import('#platform/tenants/index')
    const { domain, verificationToken } = await new RegisterTenantDomain(
      new LucidTenantStore()
    ).execute({ code: this.code, hostname: this.hostname })
    this.logger.success(`Domínio ${domain.hostname} registado (por verificar).`)
    this.logger.info(
      `Token de verificação (guarde-o; não volta a ser mostrado): ${verificationToken}`
    )
  }
}
