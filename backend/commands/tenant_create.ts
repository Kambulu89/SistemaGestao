import { BaseCommand, args, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { reportCommandError } from '#shared/command_error'

/**
 * Administração local (até haver a administração da plataforma na interface): cria um tenant e o seu primeiro
 * administrador. A conta do administrador tem de existir (`node ace user:create`).
 */
export default class TenantCreate extends BaseCommand {
  static commandName = 'tenant:create'
  static description = 'Cria um tenant e dá o perfil de administrador a uma conta existente'
  static options: CommandOptions = { startApp: true }

  @args.string({ description: 'Código (maiúsculas, ex.: ACME)' })
  declare code: string

  @args.string({ description: 'Nome da empresa' })
  declare name: string

  @flags.string({ description: 'Email do administrador (conta existente)', required: true })
  declare adminEmail: string

  @flags.string({ description: 'País ISO (ex.: AO)', default: 'AO' })
  declare country: string

  @flags.string({ description: 'Moeda ISO (ex.: AOA)', default: 'AOA' })
  declare currency: string

  async run() {
    try {
      await this.create()
    } catch (error) {
      reportCommandError(this, error)
    }
  }

  private async create() {
    const { createTenantWithAdmin } = await import('#modules/members/application/tenant_bootstrap')
    const tenant = await createTenantWithAdmin({
      code: this.code,
      name: this.name,
      countryCode: this.country,
      defaultCurrency: this.currency,
      adminEmail: this.adminEmail,
    })
    this.logger.success(
      `Tenant ${tenant.code} criado (${tenant.id}); administrador: ${this.adminEmail}.`
    )
  }
}
