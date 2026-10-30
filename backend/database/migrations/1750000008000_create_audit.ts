import { BaseSchema } from '@adonisjs/lucid/schema'
import env from '#start/env'
import {
  auditTable,
  createGlobalTable,
  createTenantTable,
  dropTable,
  unauditTable,
} from '#database/support/tenant_tables'

/**
 * Auditoria mínima (S06).
 *
 *  - `audit_logs` (de tenant, RLS forçada): **imutável** — a conta de runtime só tem SELECT e um trigger
 *    recusa UPDATE/DELETE a qualquer conta (excepto a dona, para retenção e testes, com `app.audit_purge`).
 *    Só os triggers de auditoria (SECURITY DEFINER) escrevem nela, por isso a aplicação não consegue
 *    forjar entradas. O actor, a correlação e o IP vêm de variáveis da transacção (`app.actor_*`).
 *  - `security_events` (global, tenant_id opcional): eventos de segurança sem mutação de domínio
 *    (login falhado, acesso recusado…) e mudanças de `users`/`tenants`. Só INSERT e SELECT.
 */

/** Tabelas de tenant auditadas e as colunas que nunca entram na auditoria. */
const AUDITED: Record<string, readonly string[]> = {
  tenant_domains: [],
  tenant_memberships: [],
  roles: [],
  role_permissions: [],
  role_assignments: [],
  access_policies: [],
  organizations: [],
  organization_units: [],
  cost_centers: [],
  team_members: [],
  membership_scopes: [],
  invitations: ['token_hash'],
  parties: [],
  people: ['birth_date', 'nationality', 'identity_type', 'identity_number', 'identity_key'],
  organization_parties: [],
  contacts: [],
  addresses: [],
  party_relationships: [],
}

export default class extends BaseSchema {
  async up() {
    const runtime = env.get('DB_USER')

    createTenantTable(this, 'audit_logs', (table) => {
      table.uuid('actor_user_id').nullable()
      table.uuid('actor_membership_id').nullable()
      table
        .enum('actor_type', ['USER', 'SERVICE', 'SUPPORT'], {
          useNative: false,
          enumName: 'audit_logs_actor_type_check',
        })
        .notNullable()
      table.string('action', 100).notNullable()
      table.string('resource_type', 60).notNullable()
      table.uuid('resource_id').nullable()
      table.jsonb('before_data').nullable()
      table.jsonb('after_data').nullable()
      table.text('reason').nullable()
      table.string('ip', 64).nullable()
      table.string('correlation_id', 100).nullable()
      table.timestamp('occurred_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.index(['tenant_id', 'occurred_at'], 'audit_logs_tenant_time_index')
      table.index(['tenant_id', 'resource_type', 'resource_id'], 'audit_logs_resource_index')
    })

    createGlobalTable(this, 'security_events', (table) => {
      // Só preenchido quando o evento pertence a um tenant (contexto explícito).
      table.uuid('tenant_id').nullable()
      table.uuid('user_id').nullable()
      table.string('event_type', 60).notNullable()
      table
        .enum('severity', ['INFO', 'WARN', 'HIGH'], {
          useNative: false,
          enumName: 'security_events_severity_check',
        })
        .notNullable()
      table.jsonb('metadata').notNullable().defaultTo('{}')
      table.timestamp('occurred_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.index(['tenant_id', 'occurred_at'], 'security_events_tenant_time_index')
      table.index(['user_id', 'occurred_at'], 'security_events_user_time_index')
    })

    // Só as contas donas (sessão de migrations/retenção) podem suspender a imutabilidade ou a auditoria.
    this.schema.raw(`
      CREATE FUNCTION audit_is_owner_session() RETURNS boolean
      LANGUAGE sql STABLE
      AS $$ SELECT session_user = pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'audit_logs'::regclass $$
    `)

    this.schema.raw(`
      CREATE FUNCTION audit_forbid_change() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF audit_is_owner_session() AND current_setting('app.audit_purge', true) = 'on' THEN
          RETURN COALESCE(OLD, NEW);
        END IF;
        RAISE EXCEPTION 'A auditoria é imutável (%.%)', TG_TABLE_NAME, TG_OP USING ERRCODE = '42501';
      END
      $$
    `)
    for (const table of ['audit_logs', 'security_events']) {
      this.schema.raw(`
        CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION audit_forbid_change()
      `)
    }
    this.schema.raw(`REVOKE INSERT, UPDATE, DELETE ON audit_logs FROM "${runtime}"`)
    this.schema.raw(`REVOKE UPDATE, DELETE ON security_events FROM "${runtime}"`)

    // Trigger genérico de auditoria de linhas de tenant (antes/depois sem as colunas redigidas).
    this.schema.raw(`
      CREATE FUNCTION audit_row_change() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
      AS $$
      DECLARE
        old_row jsonb;
        new_row jsonb;
        col text;
        prev_tenant text;
      BEGIN
        IF current_setting('app.audit_disabled', true) = 'on' AND audit_is_owner_session() THEN
          RETURN NULL;
        END IF;
        IF TG_OP IN ('UPDATE', 'DELETE') THEN old_row := to_jsonb(OLD); END IF;
        IF TG_OP IN ('INSERT', 'UPDATE') THEN new_row := to_jsonb(NEW); END IF;
        IF TG_NARGS > 0 THEN
          FOREACH col IN ARRAY TG_ARGV LOOP
            IF old_row IS NOT NULL AND jsonb_exists(old_row, col) THEN
              old_row := jsonb_set(old_row, ARRAY[col], '"[REDACTED]"');
            END IF;
            IF new_row IS NOT NULL AND jsonb_exists(new_row, col) THEN
              new_row := jsonb_set(new_row, ARRAY[col], '"[REDACTED]"');
            END IF;
          END LOOP;
        END IF;
        -- Tabelas escritas fora de um contexto de tenant (ex.: domínios) também são auditadas: o tenant
        -- da linha vale apenas durante este INSERT e o valor anterior é reposto de seguida.
        prev_tenant := COALESCE(current_setting('app.tenant_id', true), '');
        PERFORM set_config('app.tenant_id', COALESCE(new_row->>'tenant_id', old_row->>'tenant_id'), true);
        INSERT INTO audit_logs
          (tenant_id, actor_type, actor_user_id, actor_membership_id, action, resource_type, resource_id,
           before_data, after_data, reason, ip, correlation_id)
        VALUES (
          COALESCE((new_row->>'tenant_id')::uuid, (old_row->>'tenant_id')::uuid),
          COALESCE(NULLIF(current_setting('app.actor_type', true), ''), 'SERVICE'),
          NULLIF(current_setting('app.actor_user_id', true), '')::uuid,
          NULLIF(current_setting('app.actor_membership_id', true), '')::uuid,
          TG_TABLE_NAME || '.' || TG_OP,
          TG_TABLE_NAME,
          COALESCE((new_row->>'id')::uuid, (old_row->>'id')::uuid),
          old_row,
          new_row,
          NULLIF(current_setting('app.audit_reason', true), ''),
          NULLIF(current_setting('app.client_ip', true), ''),
          NULLIF(current_setting('app.correlation_id', true), '')
        );
        PERFORM set_config('app.tenant_id', prev_tenant, true);
        RETURN NULL;
      END
      $$
    `)

    for (const [table, redact] of Object.entries(AUDITED)) auditTable(this, table, redact)

    // Mudanças em contas e tenants (tabelas globais) → security_events, sem valores sensíveis.
    this.schema.raw(`
      CREATE FUNCTION audit_global_change() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
      AS $$
      DECLARE
        actor jsonb := jsonb_strip_nulls(jsonb_build_object(
          'actorType', NULLIF(current_setting('app.actor_type', true), ''),
          'actorUserId', NULLIF(current_setting('app.actor_user_id', true), ''),
          'correlationId', NULLIF(current_setting('app.correlation_id', true), '')));
      BEGIN
        IF current_setting('app.audit_disabled', true) = 'on' AND audit_is_owner_session() THEN
          RETURN NULL;
        END IF;
        IF TG_TABLE_NAME = 'users' THEN
          IF TG_OP = 'INSERT' THEN
            INSERT INTO security_events (user_id, event_type, severity, metadata)
            VALUES (NEW.id, 'USER_CREATED', 'INFO', actor || jsonb_build_object('status', NEW.status));
          ELSE
            IF NEW.password_hash IS DISTINCT FROM OLD.password_hash THEN
              INSERT INTO security_events (user_id, event_type, severity, metadata)
              VALUES (NEW.id, 'PASSWORD_CHANGED', 'WARN', actor);
            END IF;
            IF NEW.status IS DISTINCT FROM OLD.status THEN
              INSERT INTO security_events (user_id, event_type, severity, metadata)
              VALUES (NEW.id, 'USER_STATUS_CHANGED', 'WARN',
                      actor || jsonb_build_object('from', OLD.status, 'to', NEW.status));
            END IF;
          END IF;
        ELSIF TG_TABLE_NAME = 'tenants' THEN
          IF TG_OP = 'INSERT' THEN
            INSERT INTO security_events (tenant_id, event_type, severity, metadata)
            VALUES (NEW.id, 'TENANT_CREATED', 'INFO', actor || jsonb_build_object('code', NEW.code));
          ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
            INSERT INTO security_events (tenant_id, event_type, severity, metadata)
            VALUES (NEW.id, 'TENANT_STATUS_CHANGED', 'HIGH',
                    actor || jsonb_build_object('from', OLD.status, 'to', NEW.status));
          END IF;
        END IF;
        RETURN NULL;
      END
      $$
    `)
    for (const table of ['users', 'tenants']) {
      this.schema.raw(`
        CREATE TRIGGER ${table}_audit AFTER INSERT OR UPDATE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION audit_global_change()
      `)
    }
  }

  async down() {
    for (const table of ['users', 'tenants']) {
      this.schema.raw(`DROP TRIGGER IF EXISTS ${table}_audit ON ${table}`)
    }
    for (const table of Object.keys(AUDITED)) unauditTable(this, table)
    dropTable(this, 'security_events')
    dropTable(this, 'audit_logs')
    this.schema.raw('DROP FUNCTION IF EXISTS audit_global_change()')
    this.schema.raw('DROP FUNCTION IF EXISTS audit_row_change()')
    this.schema.raw('DROP FUNCTION IF EXISTS audit_forbid_change()')
    this.schema.raw('DROP FUNCTION IF EXISTS audit_is_owner_session()')
  }
}
