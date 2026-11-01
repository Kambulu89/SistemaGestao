import { BaseSchema } from '@adonisjs/lucid/schema'
import { createGlobalTable, dropTable } from '#database/support/tenant_tables'

/**
 * Concessões de permissões de **plataforma** (D-033). Tabela global do plano de controlo: um utilizador
 * só ganha `platform.*` por concessão explícita (comando de operação), com motivo e, opcionalmente,
 * prazo. Nunca se apaga: revogar preenche `revoked_at`. Uma concessão não dá acesso a dados de nenhum tenant.
 */
export default class extends BaseSchema {
  async up() {
    createGlobalTable(this, 'platform_grants', (table) => {
      table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('RESTRICT')
      table.string('permission', 60).notNullable()
      table.text('reason').notNullable()
      table.timestamp('expires_at', { useTz: true }).nullable()
      table.timestamp('revoked_at', { useTz: true }).nullable()
      table.index(['user_id'])
    })
    this.schema.raw(`
      ALTER TABLE platform_grants
        ADD CONSTRAINT platform_grants_permission_check CHECK (permission LIKE 'platform.%')
    `)
    this.schema.raw(
      `CREATE UNIQUE INDEX platform_grants_one_open ON platform_grants (user_id, permission) WHERE revoked_at IS NULL`
    )
    this.schema.raw(`
      CREATE FUNCTION platform_grants_guard() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        -- Retenção/testes: só a conta dona, com o interruptor de expurgo (como na auditoria).
        IF audit_is_owner_session() AND current_setting('app.audit_purge', true) = 'on' THEN
          RETURN COALESCE(NEW, OLD);
        END IF;
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'As concessões de plataforma não se apagam; revogue-as' USING ERRCODE = '42501';
        END IF;
        -- Só se pode revogar (uma vez); nada mais muda.
        IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
           AND (NEW.user_id, NEW.permission, NEW.reason, NEW.expires_at)
               IS NOT DISTINCT FROM (OLD.user_id, OLD.permission, OLD.reason, OLD.expires_at) THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'Uma concessão de plataforma só pode ser revogada' USING ERRCODE = '42501';
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER platform_grants_guard BEFORE UPDATE OR DELETE ON platform_grants
        FOR EACH ROW EXECUTE FUNCTION platform_grants_guard()
    `)
  }

  async down() {
    dropTable(this, 'platform_grants')
    this.schema.raw(`DROP FUNCTION IF EXISTS platform_grants_guard()`)
  }
}
