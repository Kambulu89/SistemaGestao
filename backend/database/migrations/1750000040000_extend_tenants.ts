import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Fundação ERP (Prompt 03, bloco 3.2): o tenant passa a ter país, moeda por omissão e a data da última suspensão.
 * Migração só aditiva: as colunas novas têm valores por omissão (Angola, kwanza), por isso os tenants existentes ficam
 * válidos sem passo de dados; `suspended_at` dos já suspensos recebe a última alteração conhecida (`updated_at`).
 * O *slug* do URL é o próprio `code` (a-z, 0-9 e _), por isso não se cria outra coluna.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.raw(`
      ALTER TABLE tenants
        ADD COLUMN country_code char(2) NOT NULL DEFAULT 'AO',
        ADD COLUMN default_currency char(3) NOT NULL DEFAULT 'AOA',
        ADD COLUMN suspended_at timestamptz NULL,
        ADD CONSTRAINT tenants_country_code_format CHECK (country_code ~ '^[A-Z]{2}$'),
        ADD CONSTRAINT tenants_default_currency_format CHECK (default_currency ~ '^[A-Z]{3}$')
    `)
    this.schema.raw(`UPDATE tenants SET suspended_at = updated_at WHERE status = 'SUSPENDED'`)
  }

  async down() {
    this.schema.raw(`
      ALTER TABLE tenants
        DROP CONSTRAINT tenants_default_currency_format,
        DROP CONSTRAINT tenants_country_code_format,
        DROP COLUMN suspended_at,
        DROP COLUMN default_currency,
        DROP COLUMN country_code
    `)
  }
}
