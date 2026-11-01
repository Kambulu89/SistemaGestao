import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Facturação (Prompt 10, bloco 10.1): o cliente existente (M04, condições comerciais sobre a Party) ganha o perfil de
 * facturação — sem criar um segundo «cliente». As moradas e o contacto continuam a ser da Party; o cliente só indica quais
 * usar. Migração só aditiva: os clientes actuais ficam em regime geral, sem escolhas (a factura continua a usar a morada
 * de facturação principal da Party).
 *
 *  - FKs compostas `(tenant_id, …)`; apagar a morada ou o contacto na Party limpa só a escolha (`SET NULL (coluna)`).
 *  - Regime isento exige o motivo (CHECK); nos outros regimes não há motivo.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.raw(`
      ALTER TABLE customers
        ADD COLUMN billing_address_id uuid NULL,
        ADD COLUMN shipping_address_id uuid NULL,
        ADD COLUMN billing_contact_id uuid NULL,
        ADD COLUMN preferred_payment_method text NULL,
        ADD COLUMN tax_regime text NOT NULL DEFAULT 'GENERAL',
        ADD COLUMN tax_exemption_reason varchar(200) NULL,
        ADD CONSTRAINT billing_address_id_tenant_fk FOREIGN KEY (tenant_id, billing_address_id)
          REFERENCES addresses (tenant_id, id) ON DELETE SET NULL (billing_address_id),
        ADD CONSTRAINT shipping_address_id_tenant_fk FOREIGN KEY (tenant_id, shipping_address_id)
          REFERENCES addresses (tenant_id, id) ON DELETE SET NULL (shipping_address_id),
        ADD CONSTRAINT billing_contact_id_tenant_fk FOREIGN KEY (tenant_id, billing_contact_id)
          REFERENCES contacts (tenant_id, id) ON DELETE SET NULL (billing_contact_id),
        ADD CONSTRAINT customers_payment_method_check CHECK (preferred_payment_method IS NULL OR
          preferred_payment_method IN ('CASH', 'BANK_TRANSFER', 'CARD', 'CHEQUE', 'DIRECT_DEBIT', 'OTHER')),
        ADD CONSTRAINT customers_tax_regime_check CHECK (tax_regime IN ('GENERAL', 'SIMPLIFIED', 'EXEMPT')),
        ADD CONSTRAINT customers_tax_exemption_check CHECK (
          (tax_regime = 'EXEMPT') = (tax_exemption_reason IS NOT NULL))
    `)
  }

  async down() {
    this.schema.raw(`
      ALTER TABLE customers
        DROP CONSTRAINT customers_tax_exemption_check,
        DROP CONSTRAINT customers_tax_regime_check,
        DROP CONSTRAINT customers_payment_method_check,
        DROP CONSTRAINT billing_contact_id_tenant_fk,
        DROP CONSTRAINT shipping_address_id_tenant_fk,
        DROP CONSTRAINT billing_address_id_tenant_fk,
        DROP COLUMN tax_exemption_reason, DROP COLUMN tax_regime, DROP COLUMN preferred_payment_method,
        DROP COLUMN billing_contact_id, DROP COLUMN shipping_address_id, DROP COLUMN billing_address_id
    `)
  }
}
