import db from '@adonisjs/lucid/services/db'
import type { ReadinessProbe } from '#core/health/application/readiness'

/** Verifica a base de dados com a ligação de runtime (a mesma que os pedidos usam). */
export class DatabaseProbe implements ReadinessProbe {
  readonly name = 'database'

  async check() {
    await db.connection('runtime').rawQuery('select 1')
  }
}
