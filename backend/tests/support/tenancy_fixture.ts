import { BaseSchema } from '@adonisjs/lucid/schema'
import db from '@adonisjs/lucid/services/db'
import env from '#start/env'
import { TenantContext } from '#core/tenancy/index'
import { TenantRepository, type TenantRow } from '#core/tenancy/index'
import { createTenantTable, tenantForeignKey } from '#database/support/tenant_tables'

export const TENANT_A = '11111111-1111-4111-8111-111111111111'
export const TENANT_B = '22222222-2222-4222-8222-222222222222'
const MEMBERSHIP_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const MEMBERSHIP_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

export function contextFor(tenant: 'A' | 'B'): TenantContext {
  return TenantContext.create({
    tenantId: tenant === 'A' ? TENANT_A : TENANT_B,
    userId: USER,
    membershipId: tenant === 'A' ? MEMBERSHIP_A : MEMBERSHIP_B,
    unitScope: { kind: 'ALL' },
    actorType: 'USER',
    permissionsVersion: 1,
    correlationId: `test-${tenant}-0001`,
    locale: 'pt-AO',
  })
}

export const MEMBERSHIPS = { A: MEMBERSHIP_A, B: MEMBERSHIP_B }

export interface CustomerRow extends TenantRow {
  name: string
}
export interface OrderRow extends TenantRow {
  customer_id: string
  title: string
}

export class ProbeCustomers extends TenantRepository<CustomerRow> {
  protected readonly table = 'probe.customers'
}
export class ProbeOrders extends TenantRepository<OrderRow> {
  protected readonly table = 'probe.orders'
}

/**
 * Esquema `probe`: duas tabelas de tenant criadas **com os helpers de migration reais**
 * (`createTenantTable`, `tenantForeignKey`). Fica fora de `public` para não interferir com a
 * verificação do esquema real.
 */
class ProbeSchema extends BaseSchema {
  async up() {
    const runtime = env.get('DB_USER')
    this.schema.raw('CREATE SCHEMA probe')
    this.schema.raw(`GRANT USAGE ON SCHEMA probe TO "${runtime}"`)
    this.schema.raw(`
      ALTER DEFAULT PRIVILEGES FOR ROLE "${env.get('DB_OWNER_USER')}" IN SCHEMA probe
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${runtime}"
    `)

    createTenantTable(
      this,
      'customers',
      (table) => {
        table.string('name').notNullable()
      },
      { schemaName: 'probe', tenantsTable: null }
    )
    createTenantTable(
      this,
      'orders',
      (table) => {
        table.uuid('customer_id').notNullable()
        table.string('title').notNullable()
        tenantForeignKey(table, 'customer_id', 'customers', { targetSchema: 'probe' })
      },
      { schemaName: 'probe', tenantsTable: null }
    )
  }

  async down() {
    this.schema.raw('DROP SCHEMA IF EXISTS probe CASCADE')
  }
}

export async function createProbeSchema() {
  const owner = db.connection('owner')
  await owner.rawQuery('DROP SCHEMA IF EXISTS probe CASCADE')
  await new ProbeSchema(owner, 'probe-fixture').execUp()
}

export async function dropProbeSchema() {
  await db.connection('owner').rawQuery('DROP SCHEMA IF EXISTS probe CASCADE')
}
