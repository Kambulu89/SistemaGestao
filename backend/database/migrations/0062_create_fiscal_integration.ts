import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Integração fiscal electrónica (Prompt 10, bloco 10.9) — módulo `sales`. Só SIMULAÇÃO: não há comunicação com a AGT.
 *
 *  - `fiscal_integration_settings`: por entidade legal, o fornecedor de integração (só o simulador local está
 *    disponível; o adaptador oficial está registado mas bloqueado até haver especificação oficial verificada e
 *    certificação), o cenário do simulador, o máximo de tentativas e a contingência (activa com motivo).
 *  - `fiscal_submissions`: fila (outbox) de documentos emitidos a comunicar, um por documento (idempotência), com o
 *    payload fotografado na emissão, o estado, as tentativas, a próxima tentativa, o identificador do pedido devolvido
 *    pelo fornecedor e a resposta.
 *  - `fiscal_submission_attempts`: cada envio ou consulta, com o resultado (só de acréscimo).
 *  - `fiscal_simulator_requests`: o "servidor" do simulador local — guarda os pedidos recebidos por chave de
 *    idempotência (o mesmo pedido devolve o mesmo identificador).
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'fiscal_integration_settings', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.string('provider', 20).notNullable().defaultTo('LOCAL_SIMULATOR')
      table.string('simulator_scenario', 12).notNullable().defaultTo('ACCEPT')
      table.integer('max_attempts').notNullable().defaultTo(5)
      table.boolean('contingency_active').notNullable().defaultTo(false)
      table.string('contingency_reason', 500).nullable()
      table.timestamp('contingency_since', { useTz: true }).nullable()
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      table.unique(['tenant_id', 'legal_entity_id'], {
        indexName: 'fiscal_integration_settings_entity_unique',
      })
      table.check(
        `provider IN ('LOCAL_SIMULATOR','AGT_OFFICIAL')
         AND simulator_scenario IN ('ACCEPT','REJECT','DELAYED','UNAVAILABLE')
         AND max_attempts BETWEEN 1 AND 20
         AND (NOT contingency_active OR (contingency_reason IS NOT NULL AND contingency_since IS NOT NULL))`,
        [],
        'fiscal_integration_settings_values_check'
      )
    })

    createTenantTable(this, 'fiscal_submissions', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.string('document_type', 20).notNullable()
      table.uuid('document_id').notNullable()
      table.string('document_number', 60).notNullable()
      table.string('provider', 20).notNullable()
      table.string('environment', 12).notNullable().defaultTo('SIMULATION')
      table.string('payload_format', 30).notNullable()
      table.jsonb('payload').notNullable()
      table.string('payload_hash', 64).notNullable()
      table.string('idempotency_key', 120).notNullable()
      table.string('status', 12).notNullable().defaultTo('QUEUED')
      table.integer('attempts').notNullable().defaultTo(0)
      table.integer('failures').notNullable().defaultTo(0)
      table.timestamp('next_attempt_at', { useTz: true }).nullable()
      table.string('request_id', 80).nullable()
      table.string('result_code', 40).nullable()
      table.string('result_message', 500).nullable()
      table.jsonb('response').nullable()
      table.jsonb('validation_issues').nullable()
      table.boolean('in_contingency').notNullable().defaultTo(false)
      table.timestamp('sent_at', { useTz: true }).nullable()
      table.timestamp('decided_at', { useTz: true }).nullable()
      table.uuid('requested_membership_id').notNullable()
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      table.unique(['tenant_id', 'document_type', 'document_id'], {
        indexName: 'fiscal_submissions_document_unique',
      })
      table.unique(['tenant_id', 'idempotency_key'], { indexName: 'fiscal_submissions_key_unique' })
      table.index(['tenant_id', 'status', 'next_attempt_at'], 'fiscal_submissions_due_index')
      table.check(
        `document_type IN ('SALES_INVOICE','SALES_NOTE')
         AND provider IN ('LOCAL_SIMULATOR','AGT_OFFICIAL')
         AND environment IN ('SIMULATION')
         AND status IN ('QUEUED','SENDING','AWAITING','ACCEPTED','REJECTED','FAILED','INVALID','CONTINGENCY')
         AND attempts >= 0 AND failures >= 0
         AND (status <> 'AWAITING' OR request_id IS NOT NULL)
         AND (status NOT IN ('ACCEPTED','REJECTED') OR (decided_at IS NOT NULL AND result_code IS NOT NULL))
         AND (status <> 'INVALID' OR validation_issues IS NOT NULL)`,
        [],
        'fiscal_submissions_values_check'
      )
    })

    createTenantTable(this, 'fiscal_submission_attempts', (table) => {
      table.uuid('submission_id').notNullable()
      table.integer('attempt_no').notNullable()
      table.string('action', 12).notNullable()
      table.string('outcome', 12).notNullable()
      table.string('code', 40).nullable()
      table.string('message', 500).nullable()
      table.integer('duration_ms').nullable()
      tenantForeignKey(table, 'submission_id', 'fiscal_submissions')
      table.index(['tenant_id', 'submission_id'], 'fiscal_submission_attempts_submission_index')
      table.check(
        `action IN ('VALIDATE','SUBMIT','POLL','REQUEUE','CONTINGENCY')
         AND outcome IN ('OK','PENDING','ACCEPTED','REJECTED','TRANSIENT','INVALID','HELD','REQUEUED')`,
        [],
        'fiscal_submission_attempts_values_check'
      )
    })

    createTenantTable(this, 'fiscal_simulator_requests', (table) => {
      table.string('idempotency_key', 120).notNullable()
      table.string('request_id', 80).notNullable()
      table.string('payload_hash', 64).notNullable()
      table.string('scenario', 12).notNullable()
      table.integer('polls').notNullable().defaultTo(0)
      table.unique(['tenant_id', 'idempotency_key'], {
        indexName: 'fiscal_simulator_requests_key_unique',
      })
    })

    // Decisão final (aceite/rejeitada) não volta atrás; o payload fotografado nunca muda; tentativas só de acréscimo.
    this.schema.raw(`
      CREATE FUNCTION fiscal_submissions_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'SUBMISSION_FIXED' USING ERRCODE = '23000';
        END IF;
        IF NEW.payload IS DISTINCT FROM OLD.payload OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
           OR NEW.document_id IS DISTINCT FROM OLD.document_id OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
           OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW.environment IS DISTINCT FROM OLD.environment THEN
          RAISE EXCEPTION 'SUBMISSION_FIXED' USING ERRCODE = '23000';
        END IF;
        IF OLD.status IN ('ACCEPTED','REJECTED') AND NEW.status IS DISTINCT FROM OLD.status THEN
          RAISE EXCEPTION 'SUBMISSION_FIXED' USING ERRCODE = '23000';
        END IF;
        IF NEW.attempts < OLD.attempts THEN
          RAISE EXCEPTION 'SUBMISSION_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER fiscal_submissions_fixed BEFORE UPDATE OR DELETE
      ON fiscal_submissions FOR EACH ROW EXECUTE FUNCTION fiscal_submissions_fixed()`)
    this.schema.raw(`
      CREATE FUNCTION fiscal_submission_attempts_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'APPEND_ONLY' USING ERRCODE = '23000';
      END $$`)
    this.schema.raw(`CREATE TRIGGER fiscal_submission_attempts_fixed BEFORE UPDATE OR DELETE
      ON fiscal_submission_attempts FOR EACH ROW EXECUTE FUNCTION fiscal_submission_attempts_fixed()`)
  }

  async down() {
    this.schema.dropTable('fiscal_simulator_requests')
    this.schema.dropTable('fiscal_submission_attempts')
    this.schema.dropTable('fiscal_submissions')
    this.schema.dropTable('fiscal_integration_settings')
    this.schema.raw(`DROP FUNCTION fiscal_submission_attempts_fixed()`)
    this.schema.raw(`DROP FUNCTION fiscal_submissions_fixed()`)
  }
}
