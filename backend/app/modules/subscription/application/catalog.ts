import db from '@adonisjs/lucid/services/db'
import { FEATURES } from '#modules/subscription/domain/features'

/** Sincroniza o catálogo de funcionalidades do código para a tabela `features` (idempotente). */
export async function syncFeatureCatalog() {
  await db.connection('owner').transaction(async (trx) => {
    for (const f of FEATURES) {
      await trx.rawQuery(
        `insert into features (code, module, kind, description) values (?, ?, ?, ?)
         on conflict (code) do update set module = excluded.module, kind = excluded.kind,
           description = excluded.description, updated_at = now()`,
        [f.code, f.module, f.kind, f.description]
      )
    }
  })
}
