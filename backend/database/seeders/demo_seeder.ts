import { BaseSeeder } from '@adonisjs/lucid/seeders'
import { seedDemo } from '#database/seeders/demo'

/** `npm run seed:demo` — só em desenvolvimento e testes (o Lucid recusa noutros ambientes). */
export default class DemoSeeder extends BaseSeeder {
  static environment = ['development', 'testing']

  async run() {
    const summary = await seedDemo()
    if (!summary.created) {
      console.log(`A empresa ${summary.tenantCode} já existe: nada alterado.`)
      return
    }
    console.log(`Empresa ${summary.tenantCode} criada. Contas: ${summary.users.join(', ')}.`)
    console.log(
      summary.generatedPassword
        ? `Palavra-passe gerada (mostrada só agora): ${summary.generatedPassword}`
        : 'Palavra-passe: a de DEMO_PASSWORD.'
    )
  }
}
