import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Fundação ERP (Prompt 03, bloco 3.3). Migração só aditiva:
 *  - `users`: fornecedor de autenticação (hoje só `PASSWORD`; SSO entrará com a sua própria decisão) e último login;
 *  - `tenant_memberships`: ciclo de vida explícito — convidado por/em, activado em, desactivado em — mantido por um
 *    trigger, para que nenhum caminho de escrita (convite, aceitação, gestão de membros, provisionamento) o esqueça;
 *  - `roles`: estado. Um papel inactivo deixa de conceder permissões, sem perder atribuições nem histórico.
 * Os registos existentes recebem valores coerentes antes de qualquer restrição.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.raw(`
      ALTER TABLE users
        ADD COLUMN authentication_provider text NOT NULL DEFAULT 'PASSWORD',
        ADD COLUMN last_login_at timestamptz NULL,
        ADD CONSTRAINT users_authentication_provider_check CHECK (authentication_provider IN ('PASSWORD'))
    `)

    this.schema.raw(`
      ALTER TABLE tenant_memberships
        ADD COLUMN invited_by_membership_id uuid NULL,
        ADD COLUMN invited_at timestamptz NULL,
        ADD COLUMN activated_at timestamptz NULL,
        ADD COLUMN deactivated_at timestamptz NULL
    `)
    this.schema.raw(`
      ALTER TABLE tenant_memberships
        ADD CONSTRAINT tenant_memberships_invited_by_fk FOREIGN KEY (tenant_id, invited_by_membership_id)
          REFERENCES tenant_memberships (tenant_id, id) ON DELETE RESTRICT
    `)
    this.schema.raw(`
      UPDATE tenant_memberships
         SET activated_at = coalesce(joined_at, created_at)
       WHERE status IN ('ACTIVE', 'SUSPENDED', 'LEFT')
    `)
    this.schema.raw(`
      UPDATE tenant_memberships
         SET deactivated_at = updated_at
       WHERE status IN ('SUSPENDED', 'LEFT')
    `)
    this.schema.raw(`
      UPDATE tenant_memberships
         SET invited_at = created_at, invited_by_membership_id = created_by_membership_id
       WHERE status = 'INVITED'
    `)
    this.schema.raw(`
      CREATE FUNCTION tenant_memberships_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF NEW.status = 'INVITED' THEN
            NEW.invited_at := coalesce(NEW.invited_at, now());
            NEW.invited_by_membership_id := coalesce(NEW.invited_by_membership_id, NEW.created_by_membership_id);
          END IF;
          IF NEW.status = 'ACTIVE' THEN
            NEW.activated_at := coalesce(NEW.activated_at, now());
          END IF;
          RETURN NEW;
        END IF;
        IF NEW.status IS DISTINCT FROM OLD.status THEN
          IF NEW.status = 'ACTIVE' THEN
            NEW.activated_at := coalesce(OLD.activated_at, now());
            NEW.deactivated_at := NULL;
          ELSIF NEW.status IN ('SUSPENDED', 'LEFT') THEN
            NEW.deactivated_at := now();
          END IF;
        END IF;
        RETURN NEW;
      END $$
    `)
    this.schema.raw(`
      CREATE TRIGGER tenant_memberships_lifecycle BEFORE INSERT OR UPDATE ON tenant_memberships
        FOR EACH ROW EXECUTE FUNCTION tenant_memberships_lifecycle()
    `)

    this.schema.raw(`
      ALTER TABLE roles
        ADD COLUMN status text NOT NULL DEFAULT 'ACTIVE',
        ADD CONSTRAINT roles_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'))
    `)
  }

  async down() {
    this.schema.raw(`ALTER TABLE roles DROP CONSTRAINT roles_status_check, DROP COLUMN status`)
    this.schema.raw(`DROP TRIGGER tenant_memberships_lifecycle ON tenant_memberships`)
    this.schema.raw(`DROP FUNCTION tenant_memberships_lifecycle()`)
    this.schema.raw(`
      ALTER TABLE tenant_memberships
        DROP CONSTRAINT tenant_memberships_invited_by_fk,
        DROP COLUMN deactivated_at,
        DROP COLUMN activated_at,
        DROP COLUMN invited_at,
        DROP COLUMN invited_by_membership_id
    `)
    this.schema.raw(`
      ALTER TABLE users
        DROP CONSTRAINT users_authentication_provider_check,
        DROP COLUMN last_login_at,
        DROP COLUMN authentication_provider
    `)
  }
}
