import { BaseSchema } from '@adonisjs/lucid/schema'
import { createGlobalTable, dropTable } from '#database/support/tenant_tables'

/**
 * Identidade global (C04): `users`, `auth_sessions` e `one_time_tokens`. O `User` é global; a ligação
 * a cada tenant faz-se por `TenantMembership` (fatia 1.3). Nunca se guardam palavras-passe nem tokens
 * em claro: só o hash da palavra-passe e o SHA-256 dos tokens (de 256 bits aleatórios).
 */
export default class extends BaseSchema {
  async up() {
    createGlobalTable(this, 'users', (table) => {
      table.string('email', 254).notNullable().unique()
      table.string('display_name', 160).notNullable()
      table.string('password_hash', 255).nullable()
      table.timestamp('email_verified_at', { useTz: true }).nullable()
      table
        .enum('status', ['PENDING', 'ACTIVE', 'BLOCKED'], {
          useNative: false,
          enumName: 'users_status_check',
        })
        .notNullable()
        .defaultTo('PENDING')
      table.string('locale', 10).nullable()
      table.uuid('avatar_file_id').nullable()
    })
    // O email guarda-se já normalizado (minúsculas, sem espaços): a unicidade é sobre o valor normalizado.
    this.schema.raw(
      `ALTER TABLE users ADD CONSTRAINT users_email_normalized CHECK (email = lower(btrim(email)))`
    )

    createGlobalTable(this, 'auth_sessions', (table) => {
      table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('RESTRICT')
      table.string('token_hash', 255).notNullable().unique()
      table.timestamp('expires_at', { useTz: true }).notNullable()
      table.timestamp('revoked_at', { useTz: true }).nullable()
      table.timestamp('last_seen_at', { useTz: true }).notNullable()
      table.string('ip', 64).nullable()
      table.string('user_agent', 512).nullable()
      table.timestamp('mfa_verified_at', { useTz: true }).nullable()
      table.index(['user_id'], 'auth_sessions_user_id_index')
    })

    createGlobalTable(this, 'one_time_tokens', (table) => {
      table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('RESTRICT')
      table
        .enum('purpose', ['VERIFY_EMAIL', 'RESET_PASSWORD'], {
          useNative: false,
          enumName: 'one_time_tokens_purpose_check',
        })
        .notNullable()
      table.string('token_hash', 255).notNullable().unique()
      table.timestamp('expires_at', { useTz: true }).notNullable()
      table.timestamp('consumed_at', { useTz: true }).nullable()
      table.index(['user_id', 'purpose'], 'one_time_tokens_user_purpose_index')
    })
  }

  async down() {
    dropTable(this, 'one_time_tokens')
    dropTable(this, 'auth_sessions')
    dropTable(this, 'users')
  }
}
