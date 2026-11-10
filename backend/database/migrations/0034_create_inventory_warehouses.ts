import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Armazéns (Prompt 08, bloco 8.2).
 *
 *  - `warehouses`: código, entidade legal, filial (da mesma entidade), responsável (membro), morada, tipo e estado; modo
 *    de acesso aberto (quem tem as permissões no âmbito) ou restrito (só os membros da lista).
 *  - `warehouse_locations`: hierarquia zona → corredor → estante → posição; o código completo (caminho) é único no
 *    armazém e não muda (código e superior fixos depois de criada); indica se guarda stock.
 *  - `warehouse_access`: membros com acesso a um armazém restrito, para consultar ou operar.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'warehouses', (table) => {
      table.string('code', 20).notNullable()
      table.string('name', 120).notNullable()
      table.uuid('legal_entity_id').notNullable()
      table.uuid('branch_id').nullable()
      table.uuid('manager_membership_id').nullable()
      table.string('warehouse_type', 12).notNullable()
      table.string('address_line', 200).nullable()
      table.string('city', 80).nullable()
      table.string('province', 80).nullable()
      table.string('country_code', 2).nullable()
      table.string('access_mode', 10).notNullable().defaultTo('OPEN')
      table.string('status', 10).notNullable().defaultTo('ACTIVE')
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'branch_id', 'branches')
      tenantForeignKey(table, 'manager_membership_id', 'tenant_memberships')
      table.unique(['tenant_id', 'code'], { indexName: 'warehouses_code_unique' })
      table.index(['tenant_id', 'legal_entity_id'], 'warehouses_legal_entity_index')
      table.check(
        `warehouse_type IN ('MAIN','STORE','TRANSIT','QUARANTINE','CONSIGNMENT','OTHER')`,
        [],
        'warehouses_type_check'
      )
      table.check(`access_mode IN ('OPEN','RESTRICTED')`, [], 'warehouses_access_mode_check')
      table.check(`status IN ('ACTIVE','INACTIVE')`, [], 'warehouses_status_check')
    })

    createTenantTable(this, 'warehouse_locations', (table) => {
      table.uuid('warehouse_id').notNullable()
      table.uuid('parent_id').nullable()
      table.string('level', 6).notNullable()
      table.string('code', 20).notNullable()
      table.string('path_code', 120).notNullable()
      table.string('name', 120).nullable()
      table.boolean('holds_stock').notNullable().defaultTo(false)
      table.string('status', 10).notNullable().defaultTo('ACTIVE')
      tenantForeignKey(table, 'warehouse_id', 'warehouses')
      table.unique(['tenant_id', 'warehouse_id', 'path_code'], {
        indexName: 'warehouse_locations_path_unique',
      })
      table.index(['tenant_id', 'warehouse_id', 'parent_id'], 'warehouse_locations_parent_index')
      table.check(`level IN ('ZONE','AISLE','RACK','BIN')`, [], 'warehouse_locations_level_check')
      table.check(`status IN ('ACTIVE','INACTIVE')`, [], 'warehouse_locations_status_check')
      table.check('parent_id IS NULL OR parent_id <> id', [], 'warehouse_locations_parent_check')
      table.check(`(level = 'ZONE') = (parent_id IS NULL)`, [], 'warehouse_locations_root_check')
    })
    this.schema.raw(`ALTER TABLE warehouse_locations ADD CONSTRAINT warehouse_locations_parent_fk
      FOREIGN KEY (tenant_id, parent_id) REFERENCES warehouse_locations (tenant_id, id) ON DELETE RESTRICT`)
    // Código e superior fixos: o caminho (usado em etiquetas e documentos) nunca muda.
    this.schema.raw(`
      CREATE FUNCTION warehouse_locations_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR NEW.code IS DISTINCT FROM OLD.code OR NEW.parent_id IS DISTINCT FROM OLD.parent_id
           OR NEW.path_code IS DISTINCT FROM OLD.path_code OR NEW.level IS DISTINCT FROM OLD.level
           OR NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id THEN
          RAISE EXCEPTION 'LOCATION_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema
      .raw(`CREATE TRIGGER warehouse_locations_fixed BEFORE UPDATE OR DELETE ON warehouse_locations
      FOR EACH ROW EXECUTE FUNCTION warehouse_locations_fixed()`)

    createTenantTable(this, 'warehouse_access', (table) => {
      table.uuid('warehouse_id').notNullable()
      table.uuid('membership_id').notNullable()
      table.string('access_level', 8).notNullable()
      tenantForeignKey(table, 'warehouse_id', 'warehouses', 'CASCADE')
      tenantForeignKey(table, 'membership_id', 'tenant_memberships')
      table.unique(['tenant_id', 'warehouse_id', 'membership_id'], {
        indexName: 'warehouse_access_unique',
      })
      table.check(`access_level IN ('VIEW','OPERATE')`, [], 'warehouse_access_level_check')
    })
  }

  async down() {
    this.schema.dropTable('warehouse_access')
    this.schema.dropTable('warehouse_locations')
    this.schema.dropTable('warehouses')
    this.schema.raw('DROP FUNCTION warehouse_locations_fixed()')
  }
}
