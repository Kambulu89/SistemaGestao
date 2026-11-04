import db from '@adonisjs/lucid/services/db'
import type { HttpContext } from '@adonisjs/core/http'

/** Estado da API e da base de dados; responde 503 quando o PostgreSQL não está disponível. */
export default class HealthController {
  async show({ response }: HttpContext) {
    try {
      await db.connection('runtime').rawQuery('select 1')
      return { status: 'ok', database: 'up' }
    } catch {
      return response.serviceUnavailable({ status: 'degraded', database: 'down' })
    }
  }
}
