import { BaseSchema } from '@adonisjs/lucid/schema'
import {
  auditTable,
  createTenantTable,
  dropTable,
  tenantForeignKey,
} from '#database/support/tenant_tables'

/**
 * Conciliação bancária (M09, fatia 5.2). O extracto do banco é **informação externa**: as suas linhas nunca alteram o
 * livro de tesouraria, só se ligam a movimentos já existentes por correspondências que uma pessoa confirma. Linhas
 * importadas são imutáveis; uma correspondência não se apaga, desfaz-se (com motivo) e o estado de cada linha e de cada
 * movimento (por conciliar, parcial, conciliado) deriva sempre da soma das correspondências activas.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'bank_statement_batches', (table) => {
      table.uuid('account_id').notNullable()
      table.string('file_name', 200).nullable()
      table.integer('line_count').notNullable()
      table.integer('skipped_count').notNullable().defaultTo(0)
      tenantForeignKey(table, 'account_id', 'treasury_accounts')
      table.index(['tenant_id', 'account_id', 'created_at'], 'bank_statement_batches_account_index')
    })
    this.schema.raw(`
      ALTER TABLE bank_statement_batches
        ADD CONSTRAINT bank_statement_batches_counts_check CHECK (line_count > 0 AND skipped_count >= 0)
    `)

    createTenantTable(this, 'bank_statement_lines', (table) => {
      table.uuid('account_id').notNullable()
      table.uuid('batch_id').notNullable()
      // Identifica a linha para que importar o mesmo extracto duas vezes não a duplique.
      table.string('fingerprint', 300).notNullable()
      table.string('external_id', 120).nullable()
      table.date('occurred_on').notNullable()
      table.decimal('amount_signed', 19, 4).notNullable()
      table.string('description', 500).nullable()
      table.string('reference', 120).nullable()
      tenantForeignKey(table, 'account_id', 'treasury_accounts')
      tenantForeignKey(table, 'batch_id', 'bank_statement_batches')
      table.unique(['tenant_id', 'account_id', 'fingerprint'], {
        indexName: 'bank_statement_lines_fingerprint_unique',
      })
      table.index(['tenant_id', 'account_id', 'occurred_on'], 'bank_statement_lines_account_index')
    })
    this.schema.raw(`
      ALTER TABLE bank_statement_lines
        ADD CONSTRAINT bank_statement_lines_amount_check CHECK (amount_signed <> 0)
    `)

    createTenantTable(this, 'reconciliation_matches', (table) => {
      table.uuid('account_id').notNullable()
      table.uuid('statement_line_id').notNullable()
      table.uuid('treasury_entry_id').notNullable()
      // Valor absoluto: o sinal é o da linha e do movimento, que têm de coincidir.
      table.decimal('matched_amount', 19, 4).notNullable()
      table.timestamp('confirmed_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('undone_at', { useTz: true }).nullable()
      table.uuid('undone_by_membership_id').nullable()
      table.string('undo_reason', 300).nullable()
      tenantForeignKey(table, 'account_id', 'treasury_accounts')
      tenantForeignKey(table, 'statement_line_id', 'bank_statement_lines')
      tenantForeignKey(table, 'treasury_entry_id', 'treasury_entries')
      table.index(['tenant_id', 'statement_line_id'], 'reconciliation_matches_line_index')
      table.index(['tenant_id', 'treasury_entry_id'], 'reconciliation_matches_entry_index')
    })
    this.schema.raw(`
      ALTER TABLE reconciliation_matches
        ADD CONSTRAINT reconciliation_matches_amount_check CHECK (matched_amount > 0),
        ADD CONSTRAINT reconciliation_matches_undone_check
          CHECK (undone_at IS NOT NULL OR (undone_by_membership_id IS NULL AND undo_reason IS NULL))
    `)
    // Um par linha/movimento só tem uma correspondência activa (somam-se as parciais por pares distintos).
    this.schema.raw(`
      CREATE UNIQUE INDEX reconciliation_matches_active_pair_unique
        ON reconciliation_matches (tenant_id, statement_line_id, treasury_entry_id) WHERE undone_at IS NULL
    `)

    // --- imutabilidade ---------------------------------------------------------------------------
    this.schema.raw(`
      CREATE FUNCTION bank_statement_lines_guard() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION 'STATEMENT_LINE_IMMUTABLE' USING ERRCODE = '23000';
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER bank_statement_lines_guard BEFORE UPDATE OR DELETE ON bank_statement_lines
        FOR EACH ROW EXECUTE FUNCTION bank_statement_lines_guard()
    `)

    // Correspondência: nunca se apaga; só se desfaz uma vez, sem mexer em mais nada.
    this.schema.raw(`
      CREATE FUNCTION reconciliation_matches_guard() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF audit_is_owner_session() AND current_setting('app.audit_purge', true) = 'on' THEN
            RETURN OLD;
          END IF;
          RAISE EXCEPTION 'MATCH_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        IF OLD.undone_at IS NULL AND NEW.undone_at IS NOT NULL
           AND (NEW.tenant_id, NEW.account_id, NEW.statement_line_id, NEW.treasury_entry_id, NEW.matched_amount,
                NEW.confirmed_at, NEW.created_by_membership_id)
              IS NOT DISTINCT FROM
              (OLD.tenant_id, OLD.account_id, OLD.statement_line_id, OLD.treasury_entry_id, OLD.matched_amount,
               OLD.confirmed_at, OLD.created_by_membership_id) THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'MATCH_IMMUTABLE' USING ERRCODE = '23000';
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER reconciliation_matches_guard BEFORE UPDATE OR DELETE ON reconciliation_matches
        FOR EACH ROW EXECUTE FUNCTION reconciliation_matches_guard()
    `)

    for (const table of [
      'bank_statement_batches',
      'bank_statement_lines',
      'reconciliation_matches',
    ]) {
      auditTable(this, table)
    }
  }

  async down() {
    for (const table of [
      'reconciliation_matches',
      'bank_statement_lines',
      'bank_statement_batches',
    ]) {
      dropTable(this, table)
    }
    for (const fn of ['reconciliation_matches_guard', 'bank_statement_lines_guard']) {
      this.schema.raw(`DROP FUNCTION IF EXISTS ${fn}()`)
    }
  }
}
