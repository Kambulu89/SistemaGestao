import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Contabilidade — fundação (Prompt 06, blocos 6.1 e 6.2):
 *  - planos de contas por entidade legal, com contas em árvore (classe → conta → subconta), natureza, saldo normal,
 *    conta movimentável e ligação (código livre) às linhas das demonstrações;
 *  - exercícios e períodos (abertura, mensais, regularizações) com estado OPEN/CLOSED;
 *  - diários, numerados por uma série documental da entidade legal (módulo settings);
 *  - lançamentos (cabeçalho + linhas) com fluxo rascunho → submetido → aprovado → contabilizado; contabilizado é
 *    imutável (garantido por trigger) e corrige-se por estorno.
 * Nenhum plano oficial é pré-carregado: o plano é criado ou importado pela empresa (D-014).
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'account_charts', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.string('code', 30).notNullable()
      table.string('name', 160).notNullable()
      table.specificType('jurisdiction', 'char(2)').notNullable()
      table.string('base_model', 160).nullable()
      table.string('status', 12).notNullable().defaultTo('ACTIVE')
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      table.unique(['tenant_id', 'code'], { indexName: 'account_charts_code_unique' })
      table.check(`status IN ('ACTIVE','INACTIVE')`, [], 'account_charts_status_check')
    })
    // Um único plano activo por entidade legal: é o plano onde os lançamentos dessa entidade são feitos.
    this.schema.raw(
      `CREATE UNIQUE INDEX account_charts_one_active ON account_charts (tenant_id, legal_entity_id) WHERE status = 'ACTIVE'`
    )

    createTenantTable(this, 'accounts', (table) => {
      table.uuid('chart_id').notNullable()
      table.uuid('parent_id').nullable()
      table.string('code', 30).notNullable()
      table.string('name', 200).notNullable()
      table.string('level', 12).notNullable()
      table.string('nature', 16).notNullable()
      table.string('normal_balance', 6).notNullable()
      table.boolean('postable').notNullable().defaultTo(false)
      table.boolean('requires_cost_center').notNullable().defaultTo(false)
      table.boolean('requires_third_party').notNullable().defaultTo(false)
      table.string('statement_line', 40).nullable()
      table.string('status', 12).notNullable().defaultTo('ACTIVE')
      tenantForeignKey(table, 'chart_id', 'account_charts')
      table.unique(['tenant_id', 'chart_id', 'code'], { indexName: 'accounts_code_unique' })
      table.index(['tenant_id', 'chart_id', 'parent_id'], 'accounts_parent_index')
      table.check(`level IN ('CLASS','ACCOUNT','SUBACCOUNT')`, [], 'accounts_level_check')
      table.check(
        `nature IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE','OFF_BALANCE')`,
        [],
        'accounts_nature_check'
      )
      table.check(`normal_balance IN ('DEBIT','CREDIT')`, [], 'accounts_normal_balance_check')
      table.check(`status IN ('ACTIVE','INACTIVE')`, [], 'accounts_status_check')
    })

    this.schema
      .raw(`ALTER TABLE accounts ADD CONSTRAINT parent_id_tenant_fk FOREIGN KEY (tenant_id, parent_id)
      REFERENCES accounts (tenant_id, id) ON DELETE RESTRICT`)
    this.schema.raw(
      `ALTER TABLE accounts ADD CONSTRAINT accounts_not_own_parent_check CHECK (parent_id IS NULL OR parent_id <> id)`
    )

    createTenantTable(this, 'fiscal_years', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.string('code', 20).notNullable()
      table.date('start_date').notNullable()
      table.date('end_date').notNullable()
      table.string('status', 10).notNullable().defaultTo('OPEN')
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      table.unique(['tenant_id', 'legal_entity_id', 'code'], {
        indexName: 'fiscal_years_code_unique',
      })
      table.check('end_date > start_date', [], 'fiscal_years_dates_check')
      table.check(`status IN ('OPEN','CLOSED')`, [], 'fiscal_years_status_check')
    })
    // Exercícios da mesma entidade legal não se sobrepõem.
    this.schema.raw('CREATE EXTENSION IF NOT EXISTS btree_gist')
    this.schema.raw(`ALTER TABLE fiscal_years ADD CONSTRAINT fiscal_years_no_overlap
      EXCLUDE USING gist (tenant_id WITH =, legal_entity_id WITH =, daterange(start_date, end_date, '[]') WITH &&)`)

    createTenantTable(this, 'fiscal_periods', (table) => {
      table.uuid('fiscal_year_id').notNullable()
      table.smallint('number').notNullable()
      table.string('kind', 10).notNullable()
      table.string('name', 40).notNullable()
      table.date('start_date').notNullable()
      table.date('end_date').notNullable()
      table.string('status', 10).notNullable().defaultTo('OPEN')
      tenantForeignKey(table, 'fiscal_year_id', 'fiscal_years', 'CASCADE')
      table.unique(['tenant_id', 'fiscal_year_id', 'number'], {
        indexName: 'fiscal_periods_number_unique',
      })
      table.check(`kind IN ('OPENING','NORMAL','CLOSING')`, [], 'fiscal_periods_kind_check')
      table.check(`status IN ('OPEN','CLOSED')`, [], 'fiscal_periods_status_check')
      table.check('end_date >= start_date', [], 'fiscal_periods_dates_check')
    })

    createTenantTable(this, 'journals', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.string('code', 20).notNullable()
      table.string('name', 120).notNullable()
      table.string('type', 16).notNullable()
      table.uuid('document_series_id').notNullable()
      table.string('status', 12).notNullable().defaultTo('ACTIVE')
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'document_series_id', 'document_series')
      table.unique(['tenant_id', 'legal_entity_id', 'code'], { indexName: 'journals_code_unique' })
      table.check(
        `type IN ('GENERAL','SALES','PURCHASES','CASH','BANK','PAYROLL','INVENTORY','OPENING','ADJUSTMENT')`,
        [],
        'journals_type_check'
      )
      table.check(`status IN ('ACTIVE','INACTIVE')`, [], 'journals_status_check')
    })

    createTenantTable(this, 'journal_entries', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.uuid('chart_id').notNullable()
      table.uuid('fiscal_year_id').notNullable()
      table.uuid('period_id').notNullable()
      table.uuid('journal_id').notNullable()
      table.string('number', 60).nullable()
      table.date('entry_date').notNullable()
      table.date('document_date').nullable()
      table.string('reference', 80).nullable()
      table.string('description', 500).notNullable()
      table.specificType('currency', 'char(3)').notNullable()
      table.specificType('exchange_rate', 'numeric(24,10)').notNullable().defaultTo(1)
      table.string('source', 30).notNullable().defaultTo('MANUAL')
      table.string('source_ref', 120).nullable()
      table.string('idempotency_key', 120).nullable()
      table.string('status', 12).notNullable().defaultTo('DRAFT')
      table.specificType('total_debit', 'numeric(24,6)').notNullable().defaultTo(0)
      table.specificType('total_credit', 'numeric(24,6)').notNullable().defaultTo(0)
      table.uuid('submitted_by').nullable()
      table.timestamp('submitted_at', { useTz: true }).nullable()
      table.uuid('approved_by').nullable()
      table.timestamp('approved_at', { useTz: true }).nullable()
      table.uuid('posted_by').nullable()
      table.timestamp('posted_at', { useTz: true }).nullable()
      table.string('rejection_reason', 500).nullable()
      table.uuid('reversal_of_id').nullable()
      table.uuid('reversed_by_id').nullable()
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'chart_id', 'account_charts')
      tenantForeignKey(table, 'fiscal_year_id', 'fiscal_years')
      tenantForeignKey(table, 'period_id', 'fiscal_periods')
      tenantForeignKey(table, 'journal_id', 'journals')
      table.index(['tenant_id', 'legal_entity_id', 'entry_date'], 'journal_entries_date_index')
      table.index(['tenant_id', 'status'], 'journal_entries_status_index')
      table.check(
        `status IN ('DRAFT','SUBMITTED','APPROVED','POSTED')`,
        [],
        'journal_entries_status_check'
      )
      table.check('exchange_rate > 0', [], 'journal_entries_rate_check')
      table.check(
        `status <> 'POSTED' OR (number IS NOT NULL AND total_debit = total_credit AND total_debit > 0)`,
        [],
        'journal_entries_posted_check'
      )
    })
    for (const column of ['reversal_of_id', 'reversed_by_id'])
      this.schema
        .raw(`ALTER TABLE journal_entries ADD CONSTRAINT ${column}_tenant_fk FOREIGN KEY (tenant_id, ${column})
        REFERENCES journal_entries (tenant_id, id) ON DELETE RESTRICT`)
    this.schema.raw(
      `CREATE UNIQUE INDEX journal_entries_idempotency ON journal_entries (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL`
    )
    this.schema.raw(
      `CREATE UNIQUE INDEX journal_entries_number_unique ON journal_entries (tenant_id, journal_id, number) WHERE number IS NOT NULL`
    )
    // Cada lançamento é estornado no máximo uma vez.
    this.schema.raw(
      `CREATE UNIQUE INDEX journal_entries_one_reversal ON journal_entries (tenant_id, reversal_of_id) WHERE reversal_of_id IS NOT NULL`
    )

    createTenantTable(this, 'journal_lines', (table) => {
      table.uuid('entry_id').notNullable()
      table.smallint('line_no').notNullable()
      table.uuid('account_id').notNullable()
      table.string('description', 300).nullable()
      table.specificType('debit', 'numeric(24,6)').notNullable().defaultTo(0)
      table.specificType('credit', 'numeric(24,6)').notNullable().defaultTo(0)
      table.specificType('debit_functional', 'numeric(24,6)').notNullable().defaultTo(0)
      table.specificType('credit_functional', 'numeric(24,6)').notNullable().defaultTo(0)
      table.uuid('cost_center_id').nullable()
      table.string('third_party_ref', 60).nullable()
      tenantForeignKey(table, 'entry_id', 'journal_entries', 'CASCADE')
      tenantForeignKey(table, 'account_id', 'accounts')
      tenantForeignKey(table, 'cost_center_id', 'cost_centers')
      table.unique(['tenant_id', 'entry_id', 'line_no'], { indexName: 'journal_lines_no_unique' })
      table.index(['tenant_id', 'account_id'], 'journal_lines_account_index')
      // Uma linha só de um lado e com valor positivo.
      table.check(
        '(debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)',
        [],
        'journal_lines_one_side_check'
      )
      table.check(
        'debit_functional >= 0 AND credit_functional >= 0',
        [],
        'journal_lines_functional_check'
      )
    })

    // Lançamento contabilizado é imutável: só se pode ligar o estorno (reversed_by_id, uma vez).
    this.schema.raw(`
      CREATE FUNCTION journal_entries_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF OLD.status = 'POSTED' THEN RAISE EXCEPTION 'JOURNAL_ENTRY_IMMUTABLE' USING ERRCODE = '23000'; END IF;
          RETURN OLD;
        END IF;
        IF OLD.status = 'POSTED' THEN
          IF OLD.reversed_by_id IS NULL AND NEW.reversed_by_id IS NOT NULL
             AND (to_jsonb(NEW) - 'reversed_by_id' - 'updated_at' - 'updated_by' - 'version')
               = (to_jsonb(OLD) - 'reversed_by_id' - 'updated_at' - 'updated_by' - 'version') THEN
            RETURN NEW;
          END IF;
          RAISE EXCEPTION 'JOURNAL_ENTRY_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER journal_entries_guard BEFORE UPDATE OR DELETE ON journal_entries
      FOR EACH ROW EXECUTE FUNCTION journal_entries_guard()`)
    this.schema.raw(`
      CREATE FUNCTION journal_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE entry_status text;
      BEGIN
        SELECT status INTO entry_status FROM journal_entries
         WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id) AND id = COALESCE(NEW.entry_id, OLD.entry_id);
        IF entry_status = 'POSTED' THEN RAISE EXCEPTION 'JOURNAL_ENTRY_IMMUTABLE' USING ERRCODE = '23000'; END IF;
        RETURN COALESCE(NEW, OLD);
      END $$`)
    this.schema
      .raw(`CREATE TRIGGER journal_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
      FOR EACH ROW EXECUTE FUNCTION journal_lines_guard()`)
  }

  async down() {
    this.schema.raw('DROP TRIGGER journal_lines_guard ON journal_lines')
    this.schema.raw('DROP FUNCTION journal_lines_guard()')
    this.schema.raw('DROP TRIGGER journal_entries_guard ON journal_entries')
    this.schema.raw('DROP FUNCTION journal_entries_guard()')
    this.schema.dropTable('journal_lines')
    this.schema.dropTable('journal_entries')
    this.schema.dropTable('journals')
    this.schema.dropTable('fiscal_periods')
    this.schema.dropTable('fiscal_years')
    this.schema.dropTable('accounts')
    this.schema.dropTable('account_charts')
  }
}
