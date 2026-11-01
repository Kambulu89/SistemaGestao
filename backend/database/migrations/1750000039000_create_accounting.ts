import { BaseSchema } from '@adonisjs/lucid/schema'
import {
  auditTable,
  createTenantTable,
  dropTable,
  tenantForeignKey,
} from '#database/support/tenant_tables'

/**
 * Contabilidade geral (ERP E1, D-062): plano de contas por empresa, exercícios e períodos, diários e lançamentos de
 * partidas dobradas. A base de dados garante sozinha o essencial: um lançamento só fica **lançado** se débitos =
 * créditos (restrição diferida, verificada no fim da transacção), num período **aberto**; depois disso é imutável e só
 * se anula por um lançamento inverso. Exercícios da mesma empresa não se sobrepõem. A mesma origem (`source_key`)
 * nunca gera dois lançamentos.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'ledger_accounts', (table) => {
      table.uuid('organization_id').notNullable()
      table.string('code', 20).notNullable()
      table.string('name', 160).notNullable()
      table.smallint('account_class').notNullable()
      table.string('nature', 10).notNullable()
      table.string('kind', 10).notNullable()
      table.uuid('parent_id').nullable()
      table.boolean('requires_cost_center').notNullable().defaultTo(false)
      table.boolean('requires_party').notNullable().defaultTo(false)
      table.boolean('active').notNullable().defaultTo(true)
      tenantForeignKey(table, 'organization_id', 'organizations')
      table.unique(['tenant_id', 'organization_id', 'code'], {
        indexName: 'ledger_accounts_code_unique',
      })
    })
    this.schema.raw(`
      ALTER TABLE ledger_accounts
        ADD CONSTRAINT ledger_accounts_class_check CHECK (account_class BETWEEN 1 AND 9),
        ADD CONSTRAINT ledger_accounts_nature_check CHECK (nature IN ('DEBIT', 'CREDIT')),
        ADD CONSTRAINT ledger_accounts_kind_check CHECK (kind IN ('HEADER', 'POSTING')),
        ADD CONSTRAINT ledger_accounts_code_check CHECK (code ~ '^[1-9][0-9]*(\\.[0-9]+)*$'),
        -- Auto-referência: só depois de a tabela ter a chave (tenant_id, id).
        ADD CONSTRAINT parent_id_tenant_fk FOREIGN KEY (tenant_id, parent_id)
          REFERENCES ledger_accounts (tenant_id, id) ON DELETE RESTRICT
    `)

    createTenantTable(this, 'fiscal_years', (table) => {
      table.uuid('organization_id').notNullable()
      table.string('code', 20).notNullable()
      table.date('starts_on').notNullable()
      table.date('ends_on').notNullable()
      table.string('status', 10).notNullable().defaultTo('OPEN')
      tenantForeignKey(table, 'organization_id', 'organizations')
      table.unique(['tenant_id', 'organization_id', 'code'], {
        indexName: 'fiscal_years_code_unique',
      })
    })
    this.schema.raw(`
      ALTER TABLE fiscal_years
        ADD CONSTRAINT fiscal_years_status_check CHECK (status IN ('OPEN', 'CLOSED')),
        ADD CONSTRAINT fiscal_years_range_check CHECK (ends_on >= starts_on),
        ADD CONSTRAINT fiscal_years_no_overlap EXCLUDE USING gist (
          organization_id WITH =,
          daterange(starts_on, ends_on, '[]') WITH &&
        )
    `)

    createTenantTable(this, 'fiscal_periods', (table) => {
      table.uuid('fiscal_year_id').notNullable()
      table.smallint('number').notNullable()
      table.date('starts_on').notNullable()
      table.date('ends_on').notNullable()
      table.string('status', 10).notNullable().defaultTo('OPEN')
      tenantForeignKey(table, 'fiscal_year_id', 'fiscal_years', { onDelete: 'CASCADE' })
      table.unique(['fiscal_year_id', 'number'], { indexName: 'fiscal_periods_number_unique' })
    })
    this.schema.raw(`
      ALTER TABLE fiscal_periods
        ADD CONSTRAINT fiscal_periods_status_check CHECK (status IN ('OPEN', 'CLOSED')),
        ADD CONSTRAINT fiscal_periods_range_check CHECK (ends_on >= starts_on)
    `)

    createTenantTable(this, 'journals', (table) => {
      table.uuid('organization_id').notNullable()
      table.string('code', 10).notNullable()
      table.string('name', 120).notNullable()
      table.string('type', 12).notNullable()
      table.boolean('active').notNullable().defaultTo(true)
      tenantForeignKey(table, 'organization_id', 'organizations')
      table.unique(['tenant_id', 'organization_id', 'code'], { indexName: 'journals_code_unique' })
    })
    this.schema.raw(`
      ALTER TABLE journals ADD CONSTRAINT journals_type_check
        CHECK (type IN ('GENERAL', 'SALES', 'PURCHASES', 'TREASURY', 'PAYROLL', 'OPENING', 'CLOSING'))
    `)

    createTenantTable(this, 'journal_entries', (table) => {
      table.uuid('organization_id').notNullable()
      table.uuid('journal_id').notNullable()
      table.uuid('fiscal_year_id').notNullable()
      table.uuid('period_id').notNullable()
      table.integer('number').nullable()
      table.date('entry_date').notNullable()
      table.string('description', 240).notNullable()
      table.string('status', 10).notNullable().defaultTo('DRAFT')
      table.string('source_type', 50).nullable()
      table.string('source_id', 64).nullable()
      table.string('source_key', 160).nullable()
      table.uuid('reversal_of_id').nullable()
      table.decimal('total_debit', 19, 4).notNullable().defaultTo(0)
      table.decimal('total_credit', 19, 4).notNullable().defaultTo(0)
      table.timestamp('posted_at', { useTz: true }).nullable()
      table.uuid('posted_by_membership_id').nullable()
      tenantForeignKey(table, 'organization_id', 'organizations')
      tenantForeignKey(table, 'journal_id', 'journals')
      tenantForeignKey(table, 'fiscal_year_id', 'fiscal_years')
      tenantForeignKey(table, 'period_id', 'fiscal_periods')
      table.index(['tenant_id', 'organization_id', 'entry_date'], 'journal_entries_date_index')
    })
    this.schema.raw(`
      ALTER TABLE journal_entries
        ADD CONSTRAINT journal_entries_status_check CHECK (status IN ('DRAFT', 'POSTED', 'REVERSED')),
        ADD CONSTRAINT journal_entries_posted_check
          CHECK (status = 'DRAFT' OR (number IS NOT NULL AND posted_at IS NOT NULL)),
        ADD CONSTRAINT journal_entries_source_check CHECK ((source_type IS NULL) = (source_id IS NULL)),
        ADD CONSTRAINT reversal_of_id_tenant_fk FOREIGN KEY (tenant_id, reversal_of_id)
          REFERENCES journal_entries (tenant_id, id) ON DELETE RESTRICT
    `)
    // A numeração é única por diário e exercício; a origem e a reversão, únicas no tenant.
    this.schema.raw(`
      CREATE UNIQUE INDEX journal_entries_number_unique
        ON journal_entries (journal_id, fiscal_year_id, number) WHERE number IS NOT NULL
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX journal_entries_source_unique
        ON journal_entries (tenant_id, source_key) WHERE source_key IS NOT NULL
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX journal_entries_reversal_unique
        ON journal_entries (reversal_of_id) WHERE reversal_of_id IS NOT NULL
    `)

    createTenantTable(this, 'journal_lines', (table) => {
      table.uuid('entry_id').notNullable()
      table.integer('line_no').notNullable()
      table.uuid('account_id').notNullable()
      table.decimal('debit', 19, 4).notNullable().defaultTo(0)
      table.decimal('credit', 19, 4).notNullable().defaultTo(0)
      table.string('description', 240).nullable()
      table.uuid('cost_center_id').nullable()
      table.uuid('party_id').nullable()
      tenantForeignKey(table, 'entry_id', 'journal_entries', { onDelete: 'CASCADE' })
      tenantForeignKey(table, 'account_id', 'ledger_accounts')
      tenantForeignKey(table, 'cost_center_id', 'cost_centers')
      tenantForeignKey(table, 'party_id', 'parties')
      table.unique(['entry_id', 'line_no'], { indexName: 'journal_lines_number_unique' })
      table.index(['tenant_id', 'account_id'], 'journal_lines_account_index')
    })
    this.schema.raw(`
      ALTER TABLE journal_lines
        ADD CONSTRAINT journal_lines_amount_check
          CHECK (debit >= 0 AND credit >= 0 AND ((debit > 0) <> (credit > 0)))
    `)

    createTenantTable(this, 'posting_rules', (table) => {
      table.uuid('organization_id').notNullable()
      table.string('event_type', 60).notNullable()
      table.string('role', 40).notNullable()
      table.uuid('account_id').notNullable()
      table.uuid('journal_id').notNullable()
      tenantForeignKey(table, 'organization_id', 'organizations')
      tenantForeignKey(table, 'account_id', 'ledger_accounts')
      tenantForeignKey(table, 'journal_id', 'journals')
      table.unique(['tenant_id', 'organization_id', 'event_type', 'role'], {
        indexName: 'posting_rules_role_unique',
      })
    })

    // --- garantias da base de dados ---------------------------------------------------------------------
    // Um lançamento lançado não muda nem se apaga; a única mudança admitida é POSTED → REVERSED (com tudo o resto igual).
    // Lançar exige o período aberto e a data dentro dele.
    this.schema.raw(`
      CREATE FUNCTION journal_entries_guard() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        period record;
      BEGIN
        IF audit_is_owner_session() AND current_setting('app.audit_purge', true) = 'on' THEN
          RETURN COALESCE(NEW, OLD);
        END IF;
        IF TG_OP = 'DELETE' THEN
          IF OLD.status <> 'DRAFT' THEN
            RAISE EXCEPTION 'JOURNAL_ENTRY_IMMUTABLE' USING ERRCODE = '23000';
          END IF;
          RETURN OLD;
        END IF;
        IF TG_OP = 'UPDATE' AND OLD.status <> 'DRAFT' THEN
          IF NOT (OLD.status = 'POSTED' AND NEW.status = 'REVERSED'
                  AND (NEW.organization_id, NEW.journal_id, NEW.fiscal_year_id, NEW.period_id, NEW.number,
                       NEW.entry_date, NEW.description, NEW.source_key, NEW.reversal_of_id, NEW.total_debit,
                       NEW.total_credit, NEW.posted_at)
                      IS NOT DISTINCT FROM
                      (OLD.organization_id, OLD.journal_id, OLD.fiscal_year_id, OLD.period_id, OLD.number,
                       OLD.entry_date, OLD.description, OLD.source_key, OLD.reversal_of_id, OLD.total_debit,
                       OLD.total_credit, OLD.posted_at)) THEN
            RAISE EXCEPTION 'JOURNAL_ENTRY_IMMUTABLE' USING ERRCODE = '23000';
          END IF;
          RETURN NEW;
        END IF;
        IF NEW.status = 'POSTED' THEN
          SELECT p.status, p.starts_on, p.ends_on, p.fiscal_year_id INTO period
            FROM fiscal_periods p WHERE p.id = NEW.period_id;
          IF period.status IS DISTINCT FROM 'OPEN' THEN
            RAISE EXCEPTION 'PERIOD_CLOSED' USING ERRCODE = '23000';
          END IF;
          IF NEW.entry_date < period.starts_on OR NEW.entry_date > period.ends_on
             OR period.fiscal_year_id <> NEW.fiscal_year_id THEN
            RAISE EXCEPTION 'ENTRY_DATE_OUTSIDE_PERIOD' USING ERRCODE = '23000';
          END IF;
        END IF;
        RETURN NEW;
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER journal_entries_guard BEFORE INSERT OR UPDATE OR DELETE ON journal_entries
        FOR EACH ROW EXECUTE FUNCTION journal_entries_guard()
    `)
    // As linhas só mudam enquanto o lançamento é rascunho.
    this.schema.raw(`
      CREATE FUNCTION journal_lines_guard() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        entry_status text;
      BEGIN
        IF audit_is_owner_session() AND current_setting('app.audit_purge', true) = 'on' THEN
          RETURN COALESCE(NEW, OLD);
        END IF;
        SELECT status INTO entry_status FROM journal_entries WHERE id = COALESCE(NEW.entry_id, OLD.entry_id);
        -- Ao apagar um rascunho em cascata a entrada já não existe: nada a proteger.
        IF entry_status IS NOT NULL AND entry_status <> 'DRAFT' THEN
          RAISE EXCEPTION 'JOURNAL_LINES_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        IF TG_OP = 'UPDATE' AND NEW.entry_id <> OLD.entry_id THEN
          RAISE EXCEPTION 'JOURNAL_LINES_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        RETURN COALESCE(NEW, OLD);
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER journal_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
        FOR EACH ROW EXECUTE FUNCTION journal_lines_guard()
    `)
    // Partidas dobradas, verificadas no fim da transacção: lançado = pelo menos duas linhas e débitos = créditos =
    // totais do cabeçalho. Nem por SQL directo um lançamento desequilibrado fica lançado.
    this.schema.raw(`
      CREATE FUNCTION journal_entries_balanced() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        sums record;
      BEGIN
        IF NEW.status <> 'POSTED' THEN
          RETURN NULL;
        END IF;
        SELECT count(*) AS n, coalesce(sum(debit), 0) AS d, coalesce(sum(credit), 0) AS c
          INTO sums FROM journal_lines WHERE entry_id = NEW.id;
        IF sums.n < 2 OR sums.d <> sums.c OR sums.d = 0
           OR sums.d <> NEW.total_debit OR sums.c <> NEW.total_credit THEN
          RAISE EXCEPTION 'JOURNAL_ENTRY_UNBALANCED' USING ERRCODE = '23000';
        END IF;
        RETURN NULL;
      END
      $$
    `)
    this.schema.raw(`
      CREATE CONSTRAINT TRIGGER journal_entries_balanced
        AFTER INSERT OR UPDATE ON journal_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION journal_entries_balanced()
    `)

    for (const table of [
      'ledger_accounts',
      'fiscal_years',
      'fiscal_periods',
      'journals',
      'journal_entries',
      'journal_lines',
      'posting_rules',
    ]) {
      auditTable(this, table)
    }
  }

  async down() {
    for (const table of [
      'posting_rules',
      'journal_lines',
      'journal_entries',
      'journals',
      'fiscal_periods',
      'fiscal_years',
      'ledger_accounts',
    ]) {
      dropTable(this, table)
    }
    this.schema.raw('DROP FUNCTION IF EXISTS journal_entries_guard()')
    this.schema.raw('DROP FUNCTION IF EXISTS journal_lines_guard()')
    this.schema.raw('DROP FUNCTION IF EXISTS journal_entries_balanced()')
  }
}
