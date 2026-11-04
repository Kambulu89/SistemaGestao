import { BaseSchema } from '@adonisjs/lucid/schema'
import { createGlobalTable } from '#database/support/tables'

/**
 * Identidade global: um `User` é uma pessoa que entra no sistema (pode pertencer a várias empresas); não é o colaborador
 * (Employee, RH) nem o parceiro de negócio. Sessões opacas (só o hash do token é guardado) e contadores de tentativas.
 */
export default class extends BaseSchema {
  async up() {
    createGlobalTable(this, 'users', (table) => {
      table.string('email', 254).notNullable()
      table.string('full_name', 160).notNullable()
      table.string('password_hash', 255).nullable()
      table.string('status', 12).notNullable().defaultTo('ACTIVE')
      table.boolean('is_platform_admin').notNullable().defaultTo(false)
      table.timestamp('last_login_at', { useTz: true }).nullable()
      table.integer('version').notNullable().defaultTo(1)
      table.check("status IN ('ACTIVE', 'DISABLED')", [], 'users_status_check')
    })
    this.schema.raw('CREATE UNIQUE INDEX users_email_unique ON users (lower(email))')

    createGlobalTable(this, 'auth_sessions', (table) => {
      table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
      table.string('token_hash', 64).notNullable().unique()
      table.timestamp('expires_at', { useTz: true }).notNullable()
      table.timestamp('last_seen_at', { useTz: true }).notNullable()
      table.timestamp('revoked_at', { useTz: true }).nullable()
      table.string('ip', 64).nullable()
      table.string('user_agent', 300).nullable()
      table.index(['user_id'], 'auth_sessions_user_index')
    })

    createGlobalTable(this, 'rate_limit_counters', (table) => {
      table.string('key', 200).notNullable().unique()
      table.integer('hits').notNullable()
      table.timestamp('window_ends_at', { useTz: true }).notNullable()
    })
  }

  async down() {
    this.schema.dropTable('rate_limit_counters')
    this.schema.dropTable('auth_sessions')
    this.schema.dropTable('users')
  }
}
