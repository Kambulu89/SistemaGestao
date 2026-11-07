import { BaseCommand, args, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { reportCommandError } from '#shared/command_error'

/**
 * Gestão local de planos: cria um plano com funcionalidades e limites; `--publish` publica-o (fica imutável).
 * Ex.: node ace plan:create BASE "Plano base" --feature=organization --limit=members.max=10 --limit=legal_entities.max=1 --trial-days=30 --publish
 */
export default class PlanCreate extends BaseCommand {
  static commandName = 'plan:create'
  static description = 'Cria (e opcionalmente publica) um plano de subscrição'
  static options: CommandOptions = { startApp: true }

  @args.string({ description: 'Código (maiúsculas)' })
  declare code: string

  @args.string({ description: 'Nome' })
  declare name: string

  @flags.array({ description: 'Funcionalidade BOOLEAN incluída (repetível)' })
  declare feature: string[]

  @flags.array({ description: 'Limite no formato codigo=valor (repetível)' })
  declare limit: string[]

  @flags.number({ description: 'Dias de período experimental', default: 0 })
  declare trialDays: number

  @flags.boolean({ description: 'Publica o plano' })
  declare publish: boolean

  async run() {
    try {
      const { PlatformSubscriptionService, syncFeatureCatalog } =
        await import('#modules/subscription/index')
      await syncFeatureCatalog()
      const service = new PlatformSubscriptionService()
      const features = [
        ...(this.feature ?? []).map((featureCode) => ({ featureCode })),
        ...(this.limit ?? []).map((pair) => {
          const [featureCode, value] = pair.split('=')
          return { featureCode, limitValue: Number(value) }
        }),
      ]
      const plan = await service.createPlan({
        code: this.code,
        name: this.name,
        trialDays: this.trialDays,
        features,
      })
      if (this.publish) await service.setPlanStatus(plan.id, 'ACTIVE')
      this.logger.success(
        `Plano ${plan.code} criado${this.publish ? ' e publicado' : ''} (${plan.id}).`
      )
    } catch (error) {
      reportCommandError(this, error)
    }
  }
}
