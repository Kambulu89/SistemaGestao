import { createHash } from 'node:crypto'
import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { constraintOf, isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope, type PermissionScope } from '#modules/rbac/index'
import { contractTermsAt } from '#modules/hr/application/career_service'
import { approvedAbsences } from '#modules/hr/application/leave_service'
import { compensationAt } from '#modules/hr/application/compensation_service'
import { dueLoanInstallments, recordLoanDeduction } from '#modules/hr/application/loan_service'
import { cents, normalizeFields } from '#modules/hr/domain/recruitment'
import { moneyLabel, periodEnd, periodStart } from '#modules/hr/domain/loans'
import {
  bracketIssues,
  type Bracket,
  calculate,
  DAY_BASES,
  difference,
  moneyText,
  overlapDays,
  type PayInput,
  type PayItem,
  type PayLine,
  type Rules,
  RUN_KINDS,
  runCase,
  type RunKind,
  sampleIssues,
  simulate,
  type TestCase,
  testCaseIssues,
  totalsOf,
} from '#modules/hr/domain/payroll'

/*
 * Processamento salarial (7.7). Regras: `hr.payroll.settings` (rota). Lotes por entidade legal: ver `hr.payroll.read`,
 * preparar/calcular/fechar `hr.payroll.manage`, aprovar `hr.payroll.approve` — no âmbito da empresa ou da entidade
 * legal, nunca quem calculou nem quem tem o próprio recibo no lote. Calcular é repetível e sem efeitos (simulação);
 * aprovar e fechar voltam a montar os dados e recusam se mudaram (hash do instantâneo). O fecho regista os descontos
 * dos empréstimos com a referência do lote (idempotente) e fecha o mês no regular. Os montantes individuais nunca vão
 * para a auditoria.
 */

const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
const wrongState = (message: string): never => {
  throw ApiError.conflict('INVALID_STATE', message)
}
const today = () => new Date().toISOString().slice(0, 10)
const m = (c: bigint) => moneyText(c)

// ---------------------------------------------------------------------------------------------------------------
// Âmbito
// ---------------------------------------------------------------------------------------------------------------

interface PayScopes {
  read: PermissionScope
  manage: PermissionScope
  approve: PermissionScope
  pay: PermissionScope
}

export async function payScopes(scope: TenantScope): Promise<PayScopes> {
  const read = await permissionScope(scope, 'hr.payroll.read')
  const manage = await permissionScope(scope, 'hr.payroll.manage')
  const approve = await permissionScope(scope, 'hr.payroll.approve')
  const pay = await permissionScope(scope, 'hr.payroll.pay')
  return { read, manage, approve, pay }
}

/** O processamento é por entidade legal: só o âmbito da empresa ou dessa entidade serve. */
const coversEntity = (s: PermissionScope, legalEntityId: string) =>
  s.tenant || s.legalEntityIds.has(legalEntityId)

export function entityAccess(s: PayScopes, legalEntityId: string) {
  const manage = coversEntity(s.manage, legalEntityId)
  const approve = coversEntity(s.approve, legalEntityId)
  const pay = coversEntity(s.pay, legalEntityId)
  const read = manage || approve || pay || coversEntity(s.read, legalEntityId)
  return { read, manage, approve, pay }
}

const entityClause = (s: PermissionScope, alias: string) => {
  if (s.tenant) return { sql: 'true', params: [] as unknown[] }
  if (!s.legalEntityIds.size) return null
  return { sql: `${alias}.legal_entity_id = any(?::uuid[])`, params: [[...s.legalEntityIds]] }
}

// ---------------------------------------------------------------------------------------------------------------
// Regras (taxas e tabela) versionadas
// ---------------------------------------------------------------------------------------------------------------

async function bracketsOf(scope: TenantScope, ruleSetId: string): Promise<Bracket[]> {
  const r = await scope.trx.rawQuery(
    `select * from payroll_irt_brackets where tenant_id = ? and rule_set_id = ? order by sequence`,
    [scope.context.tenantId, ruleSetId]
  )
  return (r.rows as any[]).map((b) => ({
    lower: b.lower,
    upper: b.upper ?? null,
    fixedAmount: b.fixed_amount,
    rate: b.rate,
    excessOver: b.excess_over,
  }))
}

async function testCasesOf(scope: TenantScope, ruleSetId: string): Promise<TestCase[]> {
  const r = await scope.trx.rawQuery(
    `select * from payroll_rule_test_cases where tenant_id = ? and rule_set_id = ? order by sequence`,
    [scope.context.tenantId, ruleSetId]
  )
  return (r.rows as any[]).map((c) => ({
    description: c.description,
    source: c.source,
    baseSalary: c.base_salary,
    allowancesSubject: c.allowances_subject,
    allowancesIrtOnly: c.allowances_irt_only,
    allowancesExempt: c.allowances_exempt,
    expectedInssEmployee: c.expected_inss_employee,
    expectedIrt: c.expected_irt,
    expectedInssEmployer: c.expected_inss_employer ?? null,
    expectedNet: c.expected_net ?? null,
  }))
}

async function writeTestCases(scope: TenantScope, ruleSetId: string, cases: TestCase[]) {
  await scope.trx.rawQuery(
    `delete from payroll_rule_test_cases where tenant_id = ? and rule_set_id = ?`,
    [scope.context.tenantId, ruleSetId]
  )
  for (const [i, c] of cases.entries())
    await scope.trx.rawQuery(
      `insert into payroll_rule_test_cases (tenant_id, rule_set_id, sequence, description, source, base_salary,
         allowances_subject, allowances_irt_only, allowances_exempt, expected_inss_employee, expected_irt,
         expected_inss_employer, expected_net, created_by, updated_by)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        scope.context.tenantId,
        ruleSetId,
        i + 1,
        c.description,
        c.source,
        c.baseSalary,
        c.allowancesSubject,
        c.allowancesIrtOnly,
        c.allowancesExempt,
        c.expectedInssEmployee,
        c.expectedIrt,
        c.expectedInssEmployer,
        c.expectedNet,
        scope.context.userId,
        scope.context.userId,
      ] as never[]
    )
}

const CASE_LABEL: Record<string, string> = {
  inssEmployee: 'INSS do trabalhador',
  irt: 'IRT',
  inssEmployer: 'INSS da empresa',
  net: 'Líquido',
}
const label = (v: string) => moneyLabel(cents(v) ?? 0n)

/** Corre os casos de teste com as regras da versão. */
function verifyCases(view: ReturnType<typeof ruleSetView>, cases: TestCase[]) {
  const rules = rulesOf(view)
  const results = cases.map((c, i) => ({
    sequence: i + 1,
    description: c.description,
    ...runCase(rules, c),
  }))
  return { total: results.length, passed: results.filter((x) => x.pass).length, results }
}

function ruleSetView(r: any, brackets: Bracket[], testCases: TestCase[] = []) {
  return {
    id: r.id as string,
    version: Number(r.version),
    code: r.code as string,
    name: r.name as string,
    currency: r.currency as string,
    validFrom: r.from_text as string,
    validTo: (r.to_text as string) ?? null,
    inssEmployeeRate: r.inss_employee_rate as string,
    inssEmployerRate: r.inss_employer_rate as string,
    baseIrtSubject: Boolean(r.base_irt_subject),
    baseInssSubject: Boolean(r.base_inss_subject),
    irtBaseDeductsInss: Boolean(r.irt_base_deducts_inss),
    dayBasis: r.day_basis as Rules['dayBasis'],
    legalReference: r.legal_reference as string,
    status: r.status as 'DRAFT' | 'PUBLISHED',
    publishedAt: r.published_at ?? null,
    confirmedBy: (r.confirmed_by_name as string) ?? null,
    confirmedAt: r.confirmed_at ?? null,
    confirmationNote: (r.confirmation_note as string) ?? null,
    brackets,
    testCases,
  }
}

const RS_SELECT = `select r.*, r.valid_from::text as from_text, r.valid_to::text as to_text,
    cu.full_name as confirmed_by_name
  from payroll_rule_sets r left join users cu on cu.id = r.confirmed_by`

async function findRuleSet(scope: TenantScope, id: string, lock = false) {
  if (!isUuid(id)) return null
  const r = await scope.trx.rawQuery(
    `${RS_SELECT} where r.tenant_id = ? and r.id = ?${lock ? ' for update of r' : ''}`,
    [scope.context.tenantId, id]
  )
  return (r.rows[0] as any) ?? null
}

/** Regras publicadas em vigor numa data para uma moeda (`null` se não há). */
export async function ruleSetAt(scope: TenantScope, currency: string, date: string) {
  const r = await scope.trx.rawQuery(
    `${RS_SELECT} where r.tenant_id = ? and r.currency = ? and r.status = 'PUBLISHED' and r.valid_from <= ?::date
      order by r.valid_from desc limit 1`,
    [scope.context.tenantId, currency, date]
  )
  const row = r.rows[0] as any
  // A versão mais recente que começou; se tem fim e a data já passou, não há regras em vigor (nunca se usa uma antiga).
  if (!row || (row.to_text && row.to_text < date)) return null
  return ruleSetView(row, await bracketsOf(scope, row.id))
}

function ruleSetInput(input: Record<string, unknown>, creating: boolean) {
  const { values: v, issues } = normalizeFields(input, {
    code: { kind: 'code', label: 'Código' },
    name: { kind: 'text', min: 3, max: 160, label: 'Nome' },
    currency: { kind: 'currency', label: 'Moeda' },
    validFrom: { kind: 'date', label: 'Início de vigência' },
    validTo: { kind: 'date', label: 'Fim de vigência' },
    legalReference: { kind: 'longtext', min: 5, max: 2000, label: 'Fonte' },
  })
  const pct = (k: string) => {
    if (!(k in input)) return
    const x = input[k]
    if (typeof x !== 'string' || !/^\d{1,3}(\.\d{1,4})?$/.test(x) || Number(x) > 100)
      issues.push({ path: k, code: 'INVALID_PERCENT', message: 'Percentagem entre 0 e 100.' })
    else v[k] = x
  }
  pct('inssEmployeeRate')
  pct('inssEmployerRate')
  for (const k of ['baseIrtSubject', 'baseInssSubject', 'irtBaseDeductsInss'])
    if (k in input) {
      if (typeof input[k] !== 'boolean')
        issues.push({ path: k, code: 'INVALID', message: 'Sim ou não.' })
      else v[k] = input[k]
    }
  if ('dayBasis' in input) {
    if (!DAY_BASES.includes(input.dayBasis as any))
      issues.push({ path: 'dayBasis', code: 'INVALID', message: 'Base de dias inválida.' })
    else v.dayBasis = input.dayBasis
  }
  if ('brackets' in input) issues.push(...bracketIssues(input.brackets))
  if ('testCases' in input) {
    const t = testCaseIssues(input.testCases)
    issues.push(...t.issues)
    v.testCases = t.value
  }
  if (creating)
    for (const k of [
      'code',
      'name',
      'currency',
      'validFrom',
      'legalReference',
      'inssEmployeeRate',
      'inssEmployerRate',
      'baseIrtSubject',
      'baseInssSubject',
      'irtBaseDeductsInss',
      'dayBasis',
      'brackets',
    ])
      if ((v[k] === undefined || v[k] === null) && !(k === 'brackets' && 'brackets' in input))
        if (!issues.some((i) => i.path === k || i.path.startsWith(`${k}.`)))
          issues.push({ path: k, code: 'REQUIRED', message: 'Obrigatório.' })
  return { values: v, issues }
}

async function writeBrackets(scope: TenantScope, ruleSetId: string, brackets: any[]) {
  await scope.trx.rawQuery(
    `delete from payroll_irt_brackets where tenant_id = ? and rule_set_id = ?`,
    [scope.context.tenantId, ruleSetId]
  )
  for (const [i, b] of brackets.entries())
    await scope.trx.rawQuery(
      `insert into payroll_irt_brackets (tenant_id, rule_set_id, sequence, lower, upper, fixed_amount, rate,
         excess_over, created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        scope.context.tenantId,
        ruleSetId,
        i + 1,
        String(b.lower),
        b.upper === null || b.upper === undefined || b.upper === '' ? null : String(b.upper),
        String(b.fixedAmount ?? '0'),
        b.rate,
        String(b.excessOver ?? b.lower),
        scope.context.userId,
        scope.context.userId,
      ] as never[]
    )
}

const RS_COLUMNS: Record<string, string> = {
  code: 'code',
  name: 'name',
  currency: 'currency',
  validFrom: 'valid_from',
  validTo: 'valid_to',
  inssEmployeeRate: 'inss_employee_rate',
  inssEmployerRate: 'inss_employer_rate',
  baseIrtSubject: 'base_irt_subject',
  baseInssSubject: 'base_inss_subject',
  irtBaseDeductsInss: 'irt_base_deducts_inss',
  dayBasis: 'day_basis',
  legalReference: 'legal_reference',
}

function ruleCodeTaken(error: unknown): never {
  const c = constraintOf(error)
  if (c === 'payroll_rule_sets_code_unique')
    throw new ApiError(409, 'CODE_TAKEN', 'Já existe um conjunto de regras com este código.', [
      { path: 'code', code: 'CODE_TAKEN', message: 'Código já usado.' },
    ])
  if (c === 'payroll_rule_sets_published_unique')
    throw new ApiError(
      409,
      'VERSION_EXISTS',
      'Já há regras publicadas nesta moeda com esta data.',
      [
        {
          path: 'validFrom',
          code: 'VERSION_EXISTS',
          message: 'Já há regras publicadas nesta data.',
        },
      ]
    )
  throw error
}

export class PayrollRuleService {
  list(context: TenantContext) {
    return runInTenant(context, async (scope) => {
      const r = await scope.trx.rawQuery(
        `${RS_SELECT} where r.tenant_id = ? order by r.currency, r.valid_from desc, r.code`,
        [context.tenantId]
      )
      const items = []
      for (const x of r.rows as any[])
        items.push(ruleSetView(x, await bracketsOf(scope, x.id), await testCasesOf(scope, x.id)))
      return items
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      if (!(await findRuleSet(scope, id))) throw ApiError.notFound()
      return this.viewIn(scope, id)
    })
  }

  create(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { values: v, issues } = ruleSetInput(input, true)
      fail(issues)
      if (v.validTo && v.validFrom && (v.validTo as string) < (v.validFrom as string))
        fail([{ path: 'validTo', code: 'RANGE', message: 'O fim é anterior ao início.' }])
      const keys = Object.keys(RS_COLUMNS).filter((k) => k in v)
      let id: string
      try {
        const r = await scope.trx.rawQuery(
          `insert into payroll_rule_sets (tenant_id, ${keys.map((k) => RS_COLUMNS[k]).join(', ')}, created_by,
             updated_by) values (?, ${keys.map(() => '?').join(', ')}, ?, ?) returning id`,
          [context.tenantId, ...keys.map((k) => v[k]), context.userId, context.userId] as never[]
        )
        id = (r.rows[0] as { id: string }).id
      } catch (error) {
        ruleCodeTaken(error)
      }
      await writeBrackets(scope, id!, input.brackets as any[])
      if (v.testCases) await writeTestCases(scope, id!, v.testCases as TestCase[])
      await audit(scope, {
        action: 'hr.payroll.rules_created',
        entityType: 'payroll_rule_set',
        entityId: id!,
        metadata: { code: v.code, currency: v.currency, validFrom: v.validFrom },
      })
      return this.viewIn(scope, id!)
    })
  }

  update(
    context: TenantContext,
    id: string,
    input: Record<string, unknown>,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const cur = await findRuleSet(scope, id, true)
      if (!cur) throw ApiError.notFound()
      if (Number(cur.version) !== expectedVersion)
        throw ApiError.versionConflict(Number(cur.version))
      if (cur.status !== 'DRAFT')
        wrongState('Regras publicadas não se alteram: crie uma nova versão com outra data.')
      const { values: v, issues } = ruleSetInput(input, false)
      fail(issues)
      const from = (v.validFrom as string) ?? cur.from_text
      const to = 'validTo' in v ? (v.validTo as string | null) : cur.to_text
      if (to && to < from)
        fail([{ path: 'validTo', code: 'RANGE', message: 'O fim é anterior ao início.' }])
      const keys = Object.keys(RS_COLUMNS).filter((k) => k in v)
      try {
        // Qualquer alteração invalida a confirmação anterior: é preciso voltar a confirmar.
        await scope.trx.rawQuery(
          `update payroll_rule_sets set ${keys.map((k) => `${RS_COLUMNS[k]} = ?, `).join('')}confirmed_by = null,
             confirmed_at = null, confirmation_note = null, version = version + 1,
             updated_by = ?, updated_at = now() where tenant_id = ? and id = ?`,
          [...keys.map((k) => v[k]), context.userId, context.tenantId, id] as never[]
        )
      } catch (error) {
        ruleCodeTaken(error)
      }
      if ('brackets' in input) await writeBrackets(scope, id, input.brackets as any[])
      if (v.testCases) await writeTestCases(scope, id, v.testCases as TestCase[])
      await audit(scope, {
        action: 'hr.payroll.rules_updated',
        entityType: 'payroll_rule_set',
        entityId: id,
        metadata: {
          fields: keys,
          bracketsChanged: 'brackets' in input,
          testCasesChanged: 'testCases' in input,
          confirmationCleared: Boolean(cur.confirmed_at),
        },
      })
      return this.viewIn(scope, id)
    })
  }

  publish(context: TenantContext, id: string, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const cur = await findRuleSet(scope, id, true)
      if (!cur) throw ApiError.notFound()
      if (Number(cur.version) !== expectedVersion)
        throw ApiError.versionConflict(Number(cur.version))
      if (cur.status !== 'DRAFT') wrongState('Estas regras já estão publicadas.')
      const brackets = await bracketsOf(scope, id)
      fail(bracketIssues(brackets))
      await this.assertCasesPass(scope, id)
      if (!cur.confirmed_at)
        throw ApiError.conflict(
          'NOT_CONFIRMED',
          'Confirme primeiro que os valores correspondem às normas em vigor na fonte indicada.'
        )
      try {
        await scope.trx.rawQuery(
          `update payroll_rule_sets set status = 'PUBLISHED', published_by = ?, published_at = now(),
             version = version + 1, updated_by = ?, updated_at = now() where tenant_id = ? and id = ?`,
          [context.userId, context.userId, context.tenantId, id]
        )
      } catch (error) {
        ruleCodeTaken(error)
      }
      await audit(scope, {
        action: 'hr.payroll.rules_published',
        entityType: 'payroll_rule_set',
        entityId: id,
        changes: { status: { from: 'DRAFT', to: 'PUBLISHED' } },
        metadata: {
          code: cur.code,
          currency: cur.currency,
          validFrom: cur.from_text,
          validTo: cur.to_text ?? null,
          legalReference: cur.legal_reference,
          confirmedBy: cur.confirmed_by,
          testCases: (await testCasesOf(scope, id)).length,
        },
      })
      return this.viewIn(scope, id)
    })
  }

  /** Corre os casos de teste da versão (qualquer estado) e devolve o resultado de cada um. */
  verify(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      if (!(await findRuleSet(scope, id))) throw ApiError.notFound()
      const view = await this.viewIn(scope, id)
      return verifyCases(view, view.testCases)
    })
  }

  /** Recibo de um exemplo com estas regras (sem gravar nada): para preparar casos e conferir valores. */
  simulate(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      if (!(await findRuleSet(scope, id))) throw ApiError.notFound()
      const { value, issues } = sampleIssues(input)
      fail(issues)
      const view = await this.viewIn(scope, id)
      const r = simulate(rulesOf(view), value!)
      return {
        errors: r.errors,
        lines: r.lines.map((l) => ({
          code: l.code,
          name: l.name,
          kind: l.kind,
          source: l.source,
          amount: moneyText(l.amount),
        })),
        totals: Object.fromEntries(
          Object.entries(r.totals).map(([k, v]) => [k, moneyText(v as bigint)])
        ),
      }
    })
  }

  /**
   * Confirmação, por uma pessoa e com nota, de que os valores correspondem às normas em vigor na fonte indicada (ex.:
   * diploma e data de publicação consultados). Exige casos de teste e que todos passem; qualquer alteração posterior
   * apaga a confirmação.
   */
  confirm(context: TenantContext, id: string, note: string, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const cur = await findRuleSet(scope, id, true)
      if (!cur) throw ApiError.notFound()
      if (Number(cur.version) !== expectedVersion)
        throw ApiError.versionConflict(Number(cur.version))
      if (cur.status !== 'DRAFT') wrongState('Só um rascunho se confirma.')
      if (note.trim().length < 5)
        fail([{ path: 'note', code: 'REQUIRED', message: 'Indique o que foi confirmado e onde.' }])
      fail(bracketIssues(await bracketsOf(scope, id)))
      await this.assertCasesPass(scope, id)
      await scope.trx.rawQuery(
        `update payroll_rule_sets set confirmed_by = ?, confirmed_at = now(), confirmation_note = ?,
           version = version + 1, updated_by = ?, updated_at = now() where tenant_id = ? and id = ?`,
        [context.userId, note.trim(), context.userId, context.tenantId, id]
      )
      await audit(scope, {
        action: 'hr.payroll.rules_confirmed',
        entityType: 'payroll_rule_set',
        entityId: id,
        metadata: { code: cur.code, note: note.trim() },
      })
      return this.viewIn(scope, id)
    })
  }

  private async assertCasesPass(scope: TenantScope, id: string) {
    const view = await this.viewIn(scope, id)
    if (!view.testCases.length)
      throw ApiError.conflict(
        'NO_TEST_CASES',
        'Registe pelo menos um caso de teste oficial (com a fonte) antes de confirmar ou publicar.'
      )
    const v = verifyCases(view, view.testCases)
    if (v.passed !== v.total)
      throw new ApiError(
        409,
        'CASES_FAILING',
        `${v.total - v.passed} de ${v.total} caso(s) de teste não dão o valor esperado.`,
        v.results
          .filter((x) => !x.pass)
          .map((x) => ({
            path: `testCases.${x.sequence - 1}`,
            code: 'CASE_FAILED',
            message: `${x.description}: ${x.mismatches
              .map(
                (d) =>
                  `${CASE_LABEL[d.field] ?? d.field} esperado ${label(d.expected)}, calculado ${label(d.actual)}`
              )
              .join('; ')}${x.errors.map((e) => e.message).join('; ')}`,
          }))
      )
  }

  private async viewIn(scope: TenantScope, id: string) {
    return ruleSetView(
      await findRuleSet(scope, id),
      await bracketsOf(scope, id),
      await testCasesOf(scope, id)
    )
  }

  remove(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const cur = await findRuleSet(scope, id, true)
      if (!cur) throw ApiError.notFound()
      if (cur.status !== 'DRAFT') wrongState('Regras publicadas não se apagam.')
      await scope.trx.rawQuery(`delete from payroll_rule_sets where tenant_id = ? and id = ?`, [
        context.tenantId,
        id,
      ])
      await audit(scope, {
        action: 'hr.payroll.rules_deleted',
        entityType: 'payroll_rule_set',
        entityId: id,
        metadata: { code: cur.code },
      })
      return { id }
    })
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Montagem dos dados de um colaborador (instantâneo) e cálculo
// ---------------------------------------------------------------------------------------------------------------

interface EmployeeRow {
  id: string
  code: string
  full_name: string
  membership_id: string | null
}

interface Built {
  employee: EmployeeRow
  snapshot: Record<string, unknown>
  lines: PayLine[]
  totals: ReturnType<typeof totalsOf> | null
  currency: string | null
  errors: ErrorDetail[]
  ruleSetId: string | null
  /** Sem nada a processar (ex.: retroactivo sem diferenças): não gera recibo. */
  skip?: boolean
}

const daysIn = (period: string) => Number(periodEnd(period).slice(8, 10))

/** Contrato que cobre o mês (o mais recente), com os dias pagáveis (sem suspensões) e a moeda. */
async function coverage(scope: TenantScope, employeeId: string, period: string) {
  const start = period
  const end = periodEnd(period)
  const r = await scope.trx.rawQuery(
    `select c.id, c.code, c.currency, c.start_date::text as start_text, c.termination_date::text as term_text
       from employment_contracts c
      where c.tenant_id = ? and c.employee_id = ? and c.status in ('ACTIVE','SUSPENDED','ENDED')
        and c.start_date <= ?::date and (c.termination_date is null or c.termination_date >= ?::date)
      order by c.start_date desc limit 1`,
    [scope.context.tenantId, employeeId, end, start]
  )
  const c = r.rows[0] as any
  if (!c) return null
  const from = c.start_text > start ? c.start_text : start
  const first = await contractTermsAt(scope, employeeId, from)
  let to = end
  if (c.term_text && c.term_text < to) to = c.term_text
  if (first?.endDate && first.endDate < to) to = first.endDate
  if (to < from) return null
  const terms = (await contractTermsAt(scope, employeeId, to)) ?? first
  if (!terms) return null
  // Suspensões: de cada SUSPENDED até à véspera do RESUMED seguinte.
  const ev = await scope.trx.rawQuery(
    `select kind, event_date::text as d from employment_contract_events
      where tenant_id = ? and contract_id = ? and kind in ('SUSPENDED','RESUMED') order by event_date, created_at`,
    [scope.context.tenantId, c.id]
  )
  let suspended = 0
  let open: string | null = null
  const dayBefore = (d: string) => {
    const x = new Date(`${d}T00:00:00Z`)
    x.setUTCDate(x.getUTCDate() - 1)
    return x.toISOString().slice(0, 10)
  }
  for (const e of ev.rows as any[]) {
    if (e.kind === 'SUSPENDED' && !open) open = e.d
    else if (e.kind === 'RESUMED' && open) {
      suspended += overlapDays(open, dayBefore(e.d), from, to)
      open = null
    }
  }
  if (open) suspended += overlapDays(open, to, from, to)
  return {
    contractId: c.id as string,
    contractCode: c.code as string,
    currency: c.currency as string,
    from,
    to,
    baseSalary: terms.baseSalary as string,
    coveredDays: overlapDays(from, to, start, end),
    suspendedDays: suspended,
    payableDays: overlapDays(from, to, start, end) - suspended,
  }
}

async function incidenceAt(scope: TenantScope, componentId: string, date: string) {
  const r = await scope.trx.rawQuery(
    `select irt_subject, irt_exempt_amount, inss_subject, valid_from::text as from_text from pay_component_incidences
      where tenant_id = ? and component_id = ? and valid_from <= ?::date order by valid_from desc limit 1`,
    [scope.context.tenantId, componentId, date]
  )
  const x = r.rows[0] as any
  return x
    ? {
        irtSubject: Boolean(x.irt_subject),
        irtExemptAmount: (x.irt_exempt_amount as string) ?? null,
        inssSubject: Boolean(x.inss_subject),
      }
    : null
}

async function runInputs(scope: TenantScope, runId: string, employeeId?: string) {
  const r = await scope.trx.rawQuery(
    `select i.*, c.code, c.name, c.kind, c.status as component_status, e.code as employee_code,
        e.full_name as employee_name
       from payroll_run_inputs i
       join pay_components c on c.tenant_id = i.tenant_id and c.id = i.component_id
       join employees e on e.tenant_id = i.tenant_id and e.id = i.employee_id
      where i.tenant_id = ? and i.run_id = ?${employeeId ? ' and i.employee_id = ?' : ''}
      order by e.code, c.code`,
    [scope.context.tenantId, runId, ...(employeeId ? [employeeId] : [])]
  )
  return r.rows as any[]
}

/** Faltas não remuneradas do mês, em dias, por tipo (pedidos que atravessam meses repartidos pelos dias). */
async function unpaidAbsences(scope: TenantScope, employeeId: string, period: string) {
  const end = periodEnd(period)
  const list = await approvedAbsences(scope, employeeId, period, end)
  const byType = new Map<string, bigint>()
  for (const a of list) {
    if (a.paid) continue
    const total = overlapDays(a.startDate, a.endDate, a.startDate, a.endDate)
    const inside = overlapDays(a.startDate, a.endDate, period, end)
    const days = cents(a.days) ?? 0n
    const part =
      total === inside ? days : (days * BigInt(inside) * 2n + BigInt(total)) / (2n * BigInt(total))
    byType.set(a.leaveTypeCode, (byType.get(a.leaveTypeCode) ?? 0n) + part)
  }
  return [...byType.entries()].map(([code, d]) => ({ code, days: moneyText(d) }))
}

function rulesOf(rs: Awaited<ReturnType<typeof ruleSetAt>>): Rules {
  return {
    id: rs!.id,
    inssEmployeeRate: rs!.inssEmployeeRate,
    inssEmployerRate: rs!.inssEmployerRate,
    baseIrtSubject: rs!.baseIrtSubject,
    baseInssSubject: rs!.baseInssSubject,
    irtBaseDeductsInss: rs!.irtBaseDeductsInss,
    dayBasis: rs!.dayBasis,
    brackets: rs!.brackets,
  }
}

const rulesSnapshot = (rs: NonNullable<Awaited<ReturnType<typeof ruleSetAt>>>) => ({
  code: rs.code,
  validFrom: rs.validFrom,
  validTo: rs.validTo,
  legalReference: rs.legalReference,
  ...rulesOf(rs),
})

/** Recibo regular de um mês (também a base do retroactivo, sem empréstimos). */
async function buildRegular(
  scope: TenantScope,
  e: EmployeeRow,
  period: string,
  withLoans: boolean,
  runId: string | null = null
): Promise<Built> {
  const out = (partial: Partial<Built>): Built => ({
    employee: e,
    snapshot: {},
    lines: [],
    totals: null,
    currency: null,
    errors: [],
    ruleSetId: null,
    ...partial,
  })
  const cov = await coverage(scope, e.id, period)
  if (!cov || cov.payableDays <= 0)
    return out({
      snapshot: { period, contract: cov },
      errors: [
        {
          path: 'contract',
          code: 'NO_PAYABLE_DAYS',
          message: 'Sem dias pagáveis neste mês (contrato ou suspensão).',
        },
      ],
    })
  const end = periodEnd(period)
  const rs = await ruleSetAt(scope, cov.currency, end)
  const comp = await compensationAt(scope, e.id, cov.to)
  const items: PayItem[] = (comp?.lines ?? []).map((l) => ({
    componentId: l.componentId,
    code: l.code,
    name: l.name,
    kind: l.kind as PayItem['kind'],
    amount: l.amount,
    recurring: true,
    incidence: l.incidence
      ? {
          irtSubject: l.incidence.irtSubject,
          irtExemptAmount: l.incidence.irtExemptAmount,
          inssSubject: l.incidence.inssSubject,
        }
      : null,
  }))
  // Valores variáveis lançados no lote (horas extra, prémios pontuais…), com a incidência do fim do mês.
  if (runId)
    for (const i of await runInputs(scope, runId, e.id))
      items.push({
        componentId: i.component_id,
        code: i.code,
        name: i.name,
        kind: i.kind,
        amount: i.amount,
        recurring: false,
        incidence: await incidenceAt(scope, i.component_id, end),
      })
  const absences = await unpaidAbsences(scope, e.id, period)
  const loans = withLoans
    ? (await dueLoanInstallments(scope, e.id, period)).map((l) => ({
        installmentId: l.installmentId,
        loanCode: l.loanCode,
        amount: l.amount,
        currency: l.currency,
      }))
    : []
  const snapshot = {
    period,
    contract: cov,
    items,
    absences,
    loans,
    rules: rs ? rulesSnapshot(rs) : null,
  }
  if (!rs)
    return out({
      snapshot,
      currency: cov.currency,
      errors: [
        {
          path: 'rules',
          code: 'NO_RULE_SET',
          message: `Sem regras de processamento publicadas em ${cov.currency} em vigor a ${end}.`,
        },
      ],
    })
  const errors: ErrorDetail[] = []
  for (const l of loans)
    if (l.currency !== cov.currency)
      errors.push({
        path: 'loans',
        code: 'CURRENCY_MISMATCH',
        message: `A prestação de ${l.loanCode} é em ${l.currency}.`,
      })
  const input: PayInput = {
    period,
    daysInMonth: daysIn(period),
    base: { amount: cov.baseSalary, payableDays: cov.payableDays },
    items,
    unpaidAbsences: absences,
    loans: loans.filter((l) => l.currency === cov.currency),
    rules: rulesOf(rs),
  }
  const calc = calculate(input)
  return out({
    snapshot,
    lines: calc.lines,
    totals: calc.totals,
    currency: cov.currency,
    errors: [...errors, ...calc.errors],
    ruleSetId: rs.id,
  })
}

/**
 * Condições do último contrato terminado antes do mês (liquidação final paga num mês posterior à cessação, 7.11).
 */
async function endedTermsBefore(scope: TenantScope, employeeId: string, period: string) {
  const r = await scope.trx.rawQuery(
    `select termination_date::text as d from employment_contracts where tenant_id = ? and employee_id = ?
       and status = 'ENDED' and termination_date < ?::date order by termination_date desc limit 1`,
    [scope.context.tenantId, employeeId, period]
  )
  const d = (r.rows[0] as { d: string } | undefined)?.d
  return d ? contractTermsAt(scope, employeeId, d) : null
}

/** Lote de liquidação final de uma cessação: os valores vêm do processo aprovado e não se mexem aqui. */
async function assertNotSettlement(scope: TenantScope, runId: string) {
  const r = await scope.trx.rawQuery(
    `select code from employee_terminations where tenant_id = ? and settlement_run_id = ? limit 1`,
    [scope.context.tenantId, runId]
  )
  const t = r.rows[0] as { code: string } | undefined
  if (t)
    throw ApiError.conflict(
      'SETTLEMENT_RUN',
      `Os valores deste lote vêm da cessação ${t.code} aprovada; altere-os no processo (cancele o lote e gere de novo).`
    )
}

async function buildExtra(scope: TenantScope, e: EmployeeRow, run: any): Promise<Built> {
  const period = run.period_text as string
  const end = periodEnd(period)
  const base: Built = {
    employee: e,
    snapshot: {},
    lines: [],
    totals: null,
    currency: null,
    errors: [],
    ruleSetId: null,
  }
  const terms =
    (await contractTermsAt(scope, e.id, end)) ??
    (await contractTermsAt(scope, e.id, period)) ??
    (await endedTermsBefore(scope, e.id, period))
  const inputs = await runInputs(scope, run.id, e.id)
  const items: PayItem[] = []
  for (const i of inputs)
    items.push({
      componentId: i.component_id,
      code: i.code,
      name: i.name,
      kind: i.kind,
      amount: i.amount,
      recurring: false,
      incidence: await incidenceAt(scope, i.component_id, end),
    })
  if (!terms)
    return {
      ...base,
      snapshot: { period, items },
      errors: [{ path: 'contract', code: 'NO_CONTRACT', message: 'Sem contrato neste mês.' }],
    }
  const rs = await ruleSetAt(scope, terms.currency, end)
  const snapshot = { period, currency: terms.currency, items, rules: rs ? rulesSnapshot(rs) : null }
  if (!rs)
    return {
      ...base,
      snapshot,
      currency: terms.currency,
      errors: [
        {
          path: 'rules',
          code: 'NO_RULE_SET',
          message: `Sem regras de processamento publicadas em ${terms.currency} em vigor a ${end}.`,
        },
      ],
    }
  const calc = calculate({
    period,
    daysInMonth: daysIn(period),
    base: null,
    items,
    unpaidAbsences: [],
    loans: [],
    rules: rulesOf(rs),
  })
  return {
    ...base,
    snapshot,
    lines: calc.lines,
    totals: calc.totals,
    currency: terms.currency,
    errors: calc.errors,
    ruleSetId: rs.id,
  }
}

/** Linhas e bases já processadas para um mês fechado (regular e retroactivos anteriores fechados). */
async function processedFor(scope: TenantScope, employeeId: string, targetPeriodId: string) {
  const r = await scope.trx.rawQuery(
    `select l.code, l.name, l.kind, l.source, l.amount from payroll_result_lines l
       join payroll_results p on p.tenant_id = l.tenant_id and p.id = l.result_id
       join payroll_runs u on u.tenant_id = p.tenant_id and u.id = p.run_id
      where l.tenant_id = ? and p.employee_id = ? and p.status = 'OK' and u.status = 'CLOSED'
        and ((u.kind = 'REGULAR' and u.period_id = ?) or (u.kind = 'RETRO' and u.target_period_id = ?))`,
    [scope.context.tenantId, employeeId, targetPeriodId, targetPeriodId]
  )
  const b = await scope.trx.rawQuery(
    `select coalesce(sum(p.inss_base), 0)::text as inss, coalesce(sum(p.irt_base), 0)::text as irt
       from payroll_results p join payroll_runs u on u.tenant_id = p.tenant_id and u.id = p.run_id
      where p.tenant_id = ? and p.employee_id = ? and p.status = 'OK' and u.status = 'CLOSED'
        and ((u.kind = 'REGULAR' and u.period_id = ?) or (u.kind = 'RETRO' and u.target_period_id = ?))`,
    [scope.context.tenantId, employeeId, targetPeriodId, targetPeriodId]
  )
  const bases = b.rows[0] as { inss: string; irt: string }
  return {
    lines: (r.rows as any[]).map((x) => ({
      code: x.code as string,
      name: x.name as string,
      kind: x.kind,
      source: x.source,
      amount: cents(x.amount) ?? 0n,
    })),
    inssBase: cents(bases.inss) ?? 0n,
    irtBase: cents(bases.irt) ?? 0n,
  }
}

async function buildRetro(scope: TenantScope, e: EmployeeRow, run: any): Promise<Built> {
  const re = await buildRegular(scope, e, run.target_text, false)
  if (re.errors.length || !re.totals) return { ...re, snapshot: { retro: true, ...re.snapshot } }
  const prev = await processedFor(scope, e.id, run.target_period_id)
  const lines = difference(re.lines, prev.lines)
  if (!lines.length) return { ...re, skip: true }
  const totals = totalsOf(lines, {
    inss: re.totals.inssBase - prev.inssBase,
    irt: re.totals.irtBase - prev.irtBase,
  })
  return {
    ...re,
    snapshot: { retro: true, targetPeriod: run.target_text, ...re.snapshot },
    lines,
    totals,
  }
}

/** Colaboradores do lote. */
async function population(scope: TenantScope, run: any): Promise<EmployeeRow[]> {
  const t = scope.context.tenantId
  const excluded = (run.excluded_employee_ids ?? []) as string[]
  let r
  if (run.kind === 'REGULAR')
    r = await scope.trx.rawQuery(
      `select e.id, e.code, e.full_name, e.membership_id from employees e
        where e.tenant_id = ? and e.legal_entity_id = ? and exists (select 1 from employment_contracts c
          where c.tenant_id = e.tenant_id and c.employee_id = e.id and c.status in ('ACTIVE','SUSPENDED','ENDED')
            and c.start_date <= ?::date and (c.termination_date is null or c.termination_date >= ?::date))
        order by e.code`,
      [t, run.legal_entity_id, periodEnd(run.period_text), run.period_text]
    )
  else if (run.kind === 'EXTRA')
    r = await scope.trx.rawQuery(
      `select distinct e.id, e.code, e.full_name, e.membership_id from payroll_run_inputs i
         join employees e on e.tenant_id = i.tenant_id and e.id = i.employee_id
        where i.tenant_id = ? and i.run_id = ? order by e.code`,
      [t, run.id]
    )
  else
    r = await scope.trx.rawQuery(
      `select distinct e.id, e.code, e.full_name, e.membership_id from payroll_results p
         join payroll_runs u on u.tenant_id = p.tenant_id and u.id = p.run_id
         join employees e on e.tenant_id = p.tenant_id and e.id = p.employee_id
        where p.tenant_id = ? and u.kind = 'REGULAR' and u.status = 'CLOSED' and u.period_id = ? order by e.code`,
      [t, run.target_period_id]
    )
  return (r.rows as EmployeeRow[]).filter((e) => !excluded.includes(e.id))
}

/** Monta e calcula o lote inteiro sem gravar nada; o hash identifica os dados e regras usados. */
async function buildRun(scope: TenantScope, run: any) {
  const people = await population(scope, run)
  const built: Built[] = []
  for (const e of people) {
    const b =
      run.kind === 'REGULAR'
        ? await buildRegular(scope, e, run.period_text, true, run.id)
        : run.kind === 'EXTRA'
          ? await buildExtra(scope, e, run)
          : await buildRetro(scope, e, run)
    if (!b.skip) built.push(b)
  }
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        kind: run.kind,
        period: run.period_text,
        target: run.target_text ?? null,
        excluded: [...(run.excluded_employee_ids ?? [])].sort(),
        employees: built.map((b) => [b.employee.id, b.snapshot]),
      })
    )
    .digest('hex')
  return { built, hash }
}

// ---------------------------------------------------------------------------------------------------------------
// Lotes
// ---------------------------------------------------------------------------------------------------------------

const RUN_SELECT = `select u.*, p.period::text as period_text, p.legal_entity_id, p.status as period_status,
    tp.period::text as target_text, le.code as legal_entity_code, le.legal_name as legal_entity_name,
    cu.full_name as created_by_name, ku.full_name as calculated_by_name, du.full_name as decided_by_name,
    xu.full_name as closed_by_name, rs.code as rule_set_code
  from payroll_runs u
  join payroll_periods p on p.tenant_id = u.tenant_id and p.id = u.period_id
  join legal_entities le on le.tenant_id = p.tenant_id and le.id = p.legal_entity_id
  left join payroll_periods tp on tp.tenant_id = u.tenant_id and tp.id = u.target_period_id
  left join payroll_rule_sets rs on rs.tenant_id = u.tenant_id and rs.id = u.rule_set_id
  left join users cu on cu.id = u.created_by
  left join users ku on ku.id = u.calculated_by
  left join users xu on xu.id = u.closed_by
  left join tenant_memberships dm on dm.tenant_id = u.tenant_id and dm.id = u.decided_by_membership_id
  left join users du on du.id = dm.user_id`

export async function findRun(scope: TenantScope, id: string, lock = false) {
  if (!isUuid(id)) return null
  const r = await scope.trx.rawQuery(
    `${RUN_SELECT} where u.tenant_id = ? and u.id = ?${lock ? ' for update of u' : ''}`,
    [scope.context.tenantId, id]
  )
  return (r.rows[0] as any) ?? null
}

function runView(u: any) {
  return {
    id: u.id as string,
    version: Number(u.version),
    code: u.code as string,
    kind: u.kind as RunKind,
    description: (u.description as string) ?? null,
    status: u.status as string,
    legalEntity: {
      id: u.legal_entity_id as string,
      code: u.legal_entity_code as string,
      name: u.legal_entity_name as string,
    },
    period: u.period_text as string,
    periodStatus: u.period_status as string,
    targetPeriod: (u.target_text as string) ?? null,
    ruleSet: u.rule_set_id
      ? { id: u.rule_set_id as string, code: u.rule_set_code as string }
      : null,
    excludedEmployeeIds: (u.excluded_employee_ids ?? []) as string[],
    employeesCount: Number(u.employees_count),
    errorsCount: Number(u.errors_count),
    totals: {
      gross: u.gross as string,
      inssEmployee: u.inss_employee as string,
      irt: u.irt as string,
      deductions: u.deductions as string,
      loans: u.loans as string,
      net: u.net as string,
      inssEmployer: u.inss_employer as string,
      employerCost: u.employer_cost as string,
    },
    createdBy: (u.created_by_name as string) ?? null,
    calculatedBy: (u.calculated_by_name as string) ?? null,
    calculatedAt: u.calculated_at ?? null,
    decidedBy: (u.decided_by_name as string) ?? null,
    decidedAt: u.decided_at ?? null,
    decisionComment: (u.decision_comment as string) ?? null,
    closedBy: (u.closed_by_name as string) ?? null,
    closedAt: u.closed_at ?? null,
    createdAt: u.created_at,
  }
}

async function resultsOf(scope: TenantScope, runId: string) {
  const r = await scope.trx.rawQuery(
    `select p.*, e.code as employee_code, e.full_name as employee_name from payroll_results p
       join employees e on e.tenant_id = p.tenant_id and e.id = p.employee_id
      where p.tenant_id = ? and p.run_id = ? order by p.status desc, e.code`,
    [scope.context.tenantId, runId]
  )
  return (r.rows as any[]).map((p) => ({
    id: p.id as string,
    employee: {
      id: p.employee_id as string,
      code: p.employee_code as string,
      fullName: p.employee_name as string,
    },
    status: p.status as 'OK' | 'ERROR',
    currency: (p.currency as string) ?? null,
    gross: (p.gross as string) ?? null,
    inssEmployee: (p.inss_employee as string) ?? null,
    irt: (p.irt as string) ?? null,
    deductions: (p.deductions as string) ?? null,
    loans: (p.loans as string) ?? null,
    net: (p.net as string) ?? null,
    inssEmployer: (p.inss_employer as string) ?? null,
    employerCost: (p.employer_cost as string) ?? null,
    errors: (p.errors ?? []) as ErrorDetail[],
  }))
}

export async function runFor(scope: TenantScope, id: string, lock = false) {
  const u = await findRun(scope, id, lock)
  if (!u) throw ApiError.notFound()
  const s = await payScopes(scope)
  const access = entityAccess(s, u.legal_entity_id)
  if (!access.read) throw ApiError.notFound()
  return { u, access }
}

const needManage = (a: { manage: boolean }) => {
  if (!a.manage)
    throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere o processamento desta entidade legal.')
}

export async function nextRunCode(scope: TenantScope, period: string) {
  const prefix = `PS-${period.slice(0, 4)}${period.slice(5, 7)}-`
  await scope.trx.rawQuery(`select pg_advisory_xact_lock(hashtext(?))`, [
    `${scope.context.tenantId}:${prefix}`,
  ])
  const r = await scope.trx.rawQuery(
    `select coalesce(max(substring(code from ${prefix.length + 1})::int), 0) + 1 as n from payroll_runs
      where tenant_id = ? and code like ? and substring(code from ${prefix.length + 1}) ~ '^[0-9]+$'`,
    [scope.context.tenantId, `${prefix}%`]
  )
  return `${prefix}${String((r.rows[0] as { n: number }).n).padStart(3, '0')}`
}

export async function periodRow(
  scope: TenantScope,
  legalEntityId: string,
  period: string,
  create: boolean
) {
  const sel = () =>
    scope.trx.rawQuery(
      `select id, status, period::text as period_text from payroll_periods
        where tenant_id = ? and legal_entity_id = ? and period = ?::date for update`,
      [scope.context.tenantId, legalEntityId, period]
    )
  let r = await sel()
  if (!r.rows.length && create) {
    await scope.trx.rawQuery(
      `insert into payroll_periods (tenant_id, legal_entity_id, period, created_by, updated_by)
       values (?, ?, ?, ?, ?) on conflict do nothing`,
      [scope.context.tenantId, legalEntityId, period, scope.context.userId, scope.context.userId]
    )
    r = await sel()
  }
  return (r.rows[0] as { id: string; status: string; period_text: string }) ?? null
}

async function setRunStatus(
  scope: TenantScope,
  u: any,
  status: string,
  extra: Record<string, unknown> = {},
  metadata: Record<string, unknown> = {}
) {
  const cols = Object.keys(extra)
  await scope.trx.rawQuery(
    `update payroll_runs set status = ?${cols.map((c) => `, ${c} = ?`).join('')}, version = version + 1,
       updated_by = ?, updated_at = now() where tenant_id = ? and id = ?`,
    [
      status,
      ...cols.map((c) => extra[c]),
      scope.context.userId,
      scope.context.tenantId,
      u.id,
    ] as never[]
  )
  await audit(scope, {
    action: `hr.payroll.run_${status.toLowerCase()}`,
    entityType: 'payroll_run',
    entityId: u.id,
    changes: { status: { from: u.status, to: status } },
    metadata: { code: u.code, kind: u.kind, period: u.period_text, ...metadata },
  })
}

/** Os dados mudaram desde o cálculo? Então o lote tem de ser recalculado (nada aprovado sobre dados velhos). */
async function assertFresh(scope: TenantScope, u: any) {
  const { hash } = await buildRun(scope, u)
  if (hash !== u.inputs_hash)
    throw ApiError.conflict(
      'STALE_RUN',
      'Os dados mudaram desde o cálculo (contratos, remunerações, ausências, empréstimos ou regras): recalcule.'
    )
}

/**
 * Obrigações que o fecho deixa a pagar, por moeda: líquido aos colaboradores, IRT, INSS (trabalhador + entidade
 * patronal) e outros descontos a entregar a terceiros. As prestações de empréstimos não geram obrigação (são da
 * própria empresa). Totais não positivos (ex.: retroactivo que devolve) não geram obrigação.
 */
export async function createObligations(scope: TenantScope, runId: string) {
  await scope.trx.rawQuery(
    `insert into payroll_obligations (tenant_id, run_id, kind, currency, amount, created_by, updated_by)
     select ?, ?, k.kind, k.currency, k.amount, ?, ? from (
       select currency, 'NET_PAY' as kind, sum(net) as amount from payroll_results
        where tenant_id = ? and run_id = ? and status = 'OK' group by currency
       union all
       select currency, 'IRT', sum(irt) from payroll_results
        where tenant_id = ? and run_id = ? and status = 'OK' group by currency
       union all
       select currency, 'INSS', sum(inss_employee + inss_employer) from payroll_results
        where tenant_id = ? and run_id = ? and status = 'OK' group by currency
       union all
       select currency, 'DEDUCTIONS', sum(deductions) from payroll_results
        where tenant_id = ? and run_id = ? and status = 'OK' group by currency
     ) k where k.amount > 0
     on conflict (tenant_id, run_id, kind, currency) do nothing`,
    [
      scope.context.tenantId,
      runId,
      scope.context.userId,
      scope.context.userId,
      ...Array(4)
        .fill(0)
        .flatMap(() => [scope.context.tenantId, runId]),
    ]
  )
}

export class PayrollRunService {
  list(
    context: TenantContext,
    f: { legalEntityId?: string; status?: string; kind?: string; limit: number; offset: number }
  ) {
    return runInTenant(context, async (scope) => {
      const s = await payScopes(scope)
      const parts: string[] = []
      const params: unknown[] = []
      for (const p of [s.read, s.manage, s.approve, s.pay]) {
        const c = entityClause(p, 'p')
        if (c) {
          parts.push(c.sql)
          params.push(...c.params)
        }
      }
      if (!parts.length) return { items: [], total: 0 }
      const where = ['u.tenant_id = ?', `(${parts.join(' or ')})`]
      const all: unknown[] = [context.tenantId, ...params]
      if (f.legalEntityId) {
        where.push('p.legal_entity_id = ?')
        all.push(f.legalEntityId)
      }
      if (f.status) {
        where.push('u.status = ?')
        all.push(f.status)
      }
      if (f.kind) {
        where.push('u.kind = ?')
        all.push(f.kind)
      }
      const clause = where.join(' and ')
      const rows = await scope.trx.rawQuery(
        `${RUN_SELECT} where ${clause} order by p.period desc, u.created_at desc limit ? offset ?`,
        [...all, f.limit, f.offset] as never[]
      )
      const count = await scope.trx.rawQuery(
        `select count(*)::int as n from payroll_runs u
           join payroll_periods p on p.tenant_id = u.tenant_id and p.id = u.period_id where ${clause}`,
        all as never[]
      )
      return {
        items: (rows.rows as any[]).map(runView),
        total: (count.rows[0] as { n: number }).n,
      }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const { u, access } = await runFor(scope, id)
      const results = await resultsOf(scope, id)
      const own = await scope.trx.rawQuery(
        `select 1 from payroll_results p join employees e on e.tenant_id = p.tenant_id and e.id = p.employee_id
          where p.tenant_id = ? and p.run_id = ? and e.membership_id = ? limit 1`,
        [context.tenantId, id, context.membershipId]
      )
      const editable = ['DRAFT', 'CALCULATED'].includes(u.status)
      return {
        ...runView(u),
        results,
        inputs: (await runInputs(scope, id)).map((i) => ({
          id: i.id as string,
          employee: { id: i.employee_id, code: i.employee_code, fullName: i.employee_name },
          component: { id: i.component_id, code: i.code, name: i.name, kind: i.kind },
          amount: i.amount as string,
          note: (i.note as string) ?? null,
        })),
        access: {
          manage: access.manage,
          edit: access.manage && editable,
          approve:
            access.approve &&
            u.status === 'PENDING_APPROVAL' &&
            u.calculated_by !== context.userId &&
            u.created_by !== context.userId &&
            own.rows.length === 0,
        },
      }
    })
  }

  result(context: TenantContext, runId: string, resultId: string) {
    return runInTenant(context, async (scope) => {
      await runFor(scope, runId)
      if (!isUuid(resultId)) throw ApiError.notFound()
      const r = await scope.trx.rawQuery(
        `select p.*, e.code as employee_code, e.full_name as employee_name from payroll_results p
           join employees e on e.tenant_id = p.tenant_id and e.id = p.employee_id
          where p.tenant_id = ? and p.run_id = ? and p.id = ?`,
        [context.tenantId, runId, resultId]
      )
      const p = r.rows[0] as any
      if (!p) throw ApiError.notFound()
      const lines = await scope.trx.rawQuery(
        `select * from payroll_result_lines where tenant_id = ? and result_id = ? order by sequence`,
        [context.tenantId, resultId]
      )
      return {
        id: p.id as string,
        employee: { id: p.employee_id, code: p.employee_code, fullName: p.employee_name },
        status: p.status,
        currency: p.currency ?? null,
        bases: { inss: p.inss_base ?? null, irt: p.irt_base ?? null },
        totals: {
          gross: p.gross,
          inssEmployee: p.inss_employee,
          irt: p.irt,
          deductions: p.deductions,
          loans: p.loans,
          net: p.net,
          inssEmployer: p.inss_employer,
          employerCost: p.employer_cost,
        },
        errors: p.errors ?? [],
        lines: (lines.rows as any[]).map((l) => ({
          code: l.code as string,
          name: l.name as string,
          kind: l.kind as string,
          source: l.source as string,
          amount: l.amount as string,
          irtSubject: Boolean(l.irt_subject),
          inssSubject: Boolean(l.inss_subject),
        })),
        snapshot: p.snapshot,
      }
    })
  }

  create(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const issues: ErrorDetail[] = []
      const kind = input.kind as RunKind
      if (!RUN_KINDS.includes(kind))
        issues.push({ path: 'kind', code: 'INVALID', message: 'Regular, extra ou retroactivo.' })
      const le = input.legalEntityId
      if (typeof le !== 'string' || !isUuid(le))
        issues.push({ path: 'legalEntityId', code: 'REQUIRED', message: 'Obrigatório.' })
      const period = periodStart(input.period)
      if (!period)
        issues.push({ path: 'period', code: 'INVALID', message: 'Mês inválido (AAAA-MM).' })
      const target = kind === 'RETRO' ? periodStart(input.targetPeriod) : null
      if (kind === 'RETRO' && !target)
        issues.push({
          path: 'targetPeriod',
          code: 'REQUIRED',
          message: 'Indique o mês a rectificar.',
        })
      const desc = normalizeFields(input, {
        description: { kind: 'text', max: 200, label: 'Descrição' },
      })
      issues.push(...desc.issues)
      fail(issues)
      const entity = await scope.trx.rawQuery(
        `select id from legal_entities where tenant_id = ? and id = ?`,
        [context.tenantId, le] as never[]
      )
      if (!entity.rows.length)
        fail([{ path: 'legalEntityId', code: 'NOT_FOUND', message: 'Entidade legal inexistente.' }])
      const s = await payScopes(scope)
      needManage(entityAccess(s, le as string))
      const p = (await periodRow(scope, le as string, period!, true))!
      if (p.status !== 'OPEN')
        throw ApiError.conflict('PERIOD_CLOSED', `O mês ${period!.slice(0, 7)} já está fechado.`)
      let targetId: string | null = null
      if (kind === 'RETRO') {
        const tp = await periodRow(scope, le as string, target!, false)
        if (!tp || tp.status !== 'CLOSED' || target! >= period!)
          fail([
            {
              path: 'targetPeriod',
              code: 'NOT_CLOSED',
              message: 'O retroactivo rectifica um mês anterior já fechado.',
            },
          ])
        targetId = tp!.id
      }
      const code = await nextRunCode(scope, period!)
      let id: string
      try {
        const r = await scope.trx.rawQuery(
          `insert into payroll_runs (tenant_id, period_id, target_period_id, code, kind, description, created_by,
             updated_by) values (?, ?, ?, ?, ?, ?, ?, ?) returning id`,
          [
            context.tenantId,
            p.id,
            targetId,
            code,
            kind,
            desc.values.description ?? null,
            context.userId,
            context.userId,
          ] as never[]
        )
        id = (r.rows[0] as { id: string }).id
      } catch (error) {
        if (constraintOf(error) === 'payroll_runs_regular_unique')
          throw ApiError.conflict('REGULAR_EXISTS', 'Já existe um processamento regular neste mês.')
        throw error
      }
      await audit(scope, {
        action: 'hr.payroll.run_created',
        entityType: 'payroll_run',
        entityId: id!,
        metadata: { code, kind, legalEntityId: le, period, targetPeriod: target },
      })
      return runView(await findRun(scope, id!))
    })
  }

  /** Valor variável de um colaborador no lote (horas extra, prémio pontual…); `amount: null` remove. */
  setInput(
    context: TenantContext,
    id: string,
    input: Record<string, unknown>,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const { u, access } = await runFor(scope, id, true)
      needManage(access)
      if (Number(u.version) !== expectedVersion) throw ApiError.versionConflict(Number(u.version))
      if (!['DRAFT', 'CALCULATED'].includes(u.status))
        wrongState('Só um lote por aprovar recebe valores variáveis.')
      if (u.kind === 'RETRO') wrongState('O retroactivo não recebe valores: recalcula o mês.')
      await assertNotSettlement(scope, id)
      const issues: ErrorDetail[] = []
      const { values: v, issues: i1 } = normalizeFields(input, {
        employeeId: { kind: 'uuid', label: 'Colaborador' },
        componentId: { kind: 'uuid', label: 'Componente' },
        amount: { kind: 'money', label: 'Montante' },
        note: { kind: 'text', max: 200, label: 'Nota' },
      })
      issues.push(...i1)
      for (const k of ['employeeId', 'componentId'])
        if (!v[k] && !issues.some((x) => x.path === k))
          issues.push({ path: k, code: 'REQUIRED', message: 'Obrigatório.' })
      if (v.amount && (cents(v.amount) ?? 0n) <= 0n)
        issues.push({
          path: 'amount',
          code: 'POSITIVE',
          message: 'O montante tem de ser positivo.',
        })
      fail(issues)
      const emp = await scope.trx.rawQuery(
        `select id from employees where tenant_id = ? and id = ? and legal_entity_id = ?`,
        [context.tenantId, v.employeeId, u.legal_entity_id]
      )
      if (!emp.rows.length)
        fail([
          {
            path: 'employeeId',
            code: 'OTHER_LEGAL_ENTITY',
            message: 'O colaborador não é desta entidade legal.',
          },
        ])
      const comp = await scope.trx.rawQuery(
        `select calculation, status from pay_components where tenant_id = ? and id = ?`,
        [context.tenantId, v.componentId] as never[]
      )
      const c = comp.rows[0] as any
      if (!c || c.status !== 'ACTIVE')
        fail([
          { path: 'componentId', code: 'INVALID', message: 'Componente inexistente ou inactivo.' },
        ])
      if (u.kind === 'REGULAR' && c.calculation !== 'VARIABLE')
        fail([
          {
            path: 'componentId',
            code: 'NOT_VARIABLE',
            message: 'No regular só entram componentes variáveis (os fixos vêm da ficha).',
          },
        ])
      if (v.amount)
        await scope.trx.rawQuery(
          `insert into payroll_run_inputs (tenant_id, run_id, employee_id, component_id, amount, note, created_by,
             updated_by) values (?, ?, ?, ?, ?, ?, ?, ?)
           on conflict (tenant_id, run_id, employee_id, component_id)
           do update set amount = excluded.amount, note = excluded.note, version = payroll_run_inputs.version + 1,
             updated_by = excluded.updated_by, updated_at = now()`,
          [
            context.tenantId,
            id,
            v.employeeId,
            v.componentId,
            v.amount,
            v.note ?? null,
            context.userId,
            context.userId,
          ] as never[]
        )
      else
        await scope.trx.rawQuery(
          `delete from payroll_run_inputs where tenant_id = ? and run_id = ? and employee_id = ? and component_id = ?`,
          [context.tenantId, id, v.employeeId, v.componentId] as never[]
        )
      // Qualquer mudança invalida o cálculo anterior.
      await scope.trx.rawQuery(
        `update payroll_runs set status = 'DRAFT', inputs_hash = null, version = version + 1, updated_by = ?,
           updated_at = now() where tenant_id = ? and id = ?`,
        [context.userId, context.tenantId, id]
      )
      await audit(scope, {
        action: 'hr.payroll.run_input',
        entityType: 'payroll_run',
        entityId: id,
        metadata: {
          employeeId: v.employeeId,
          componentId: v.componentId,
          removed: !v.amount,
          amount: '[RESERVADO]',
        },
      })
      return this.getIn(scope, id)
    })
  }

  /** Excluir (ou voltar a incluir) um colaborador do lote, por exemplo enquanto se corrige um erro. */
  setExcluded(
    context: TenantContext,
    id: string,
    employeeId: string,
    excluded: boolean,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const { u, access } = await runFor(scope, id, true)
      needManage(access)
      if (Number(u.version) !== expectedVersion) throw ApiError.versionConflict(Number(u.version))
      if (!['DRAFT', 'CALCULATED'].includes(u.status))
        wrongState('Só um lote por aprovar muda de colaboradores.')
      await assertNotSettlement(scope, id)
      if (!isUuid(employeeId)) throw ApiError.notFound()
      const list = new Set<string>(u.excluded_employee_ids ?? [])
      if (excluded) list.add(employeeId)
      else list.delete(employeeId)
      await scope.trx.rawQuery(
        `update payroll_runs set excluded_employee_ids = ?::uuid[], status = 'DRAFT', inputs_hash = null,
           version = version + 1, updated_by = ?, updated_at = now() where tenant_id = ? and id = ?`,
        [[...list], context.userId, context.tenantId, id] as never[]
      )
      await audit(scope, {
        action: excluded ? 'hr.payroll.run_excluded' : 'hr.payroll.run_included',
        entityType: 'payroll_run',
        entityId: id,
        metadata: { employeeId },
      })
      return this.getIn(scope, id)
    })
  }

  /**
   * Calcula (ou recalcula) o lote: substitui os recibos, guarda o instantâneo de cada colaborador e o hash do
   * conjunto. Sem efeitos fora do lote — é a simulação; repetir dá o mesmo resultado se os dados não mudaram.
   */
  calculate(context: TenantContext, id: string, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const { u, access } = await runFor(scope, id, true)
      needManage(access)
      if (Number(u.version) !== expectedVersion) throw ApiError.versionConflict(Number(u.version))
      if (!['DRAFT', 'CALCULATED'].includes(u.status))
        wrongState('Só um lote por aprovar se calcula.')
      if (u.period_status !== 'OPEN') wrongState('O mês já está fechado.')
      const { built, hash } = await buildRun(scope, u)
      await scope.trx.rawQuery(`delete from payroll_results where tenant_id = ? and run_id = ?`, [
        context.tenantId,
        id,
      ])
      const sum = {
        gross: 0n,
        inssEmployee: 0n,
        irt: 0n,
        deductions: 0n,
        loans: 0n,
        net: 0n,
        inssEmployer: 0n,
        employerCost: 0n,
      }
      let errorsCount = 0
      const ruleSets = new Set<string>()
      for (const b of built) {
        const okay = !b.errors.length && b.totals
        if (!okay) errorsCount++
        if (b.ruleSetId) ruleSets.add(b.ruleSetId)
        const t = okay ? b.totals! : null
        if (t) for (const k of Object.keys(sum) as (keyof typeof sum)[]) sum[k] += t[k]
        const r = await scope.trx.rawQuery(
          `insert into payroll_results (tenant_id, run_id, employee_id, status, currency, gross, inss_base, irt_base,
             inss_employee, irt, deductions, loans, net, inss_employer, employer_cost, errors, snapshot, created_by,
             updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?) returning id`,
          [
            context.tenantId,
            id,
            b.employee.id,
            okay ? 'OK' : 'ERROR',
            b.currency,
            t ? m(t.gross) : null,
            t ? m(t.inssBase) : null,
            t ? m(t.irtBase) : null,
            t ? m(t.inssEmployee) : null,
            t ? m(t.irt) : null,
            t ? m(t.deductions) : null,
            t ? m(t.loans) : null,
            t ? m(t.net) : null,
            t ? m(t.inssEmployer) : null,
            t ? m(t.employerCost) : null,
            JSON.stringify(b.errors),
            JSON.stringify(b.snapshot),
            context.userId,
            context.userId,
          ] as never[]
        )
        const resultId = (r.rows[0] as { id: string }).id
        for (const [i, l] of b.lines.entries())
          await scope.trx.rawQuery(
            `insert into payroll_result_lines (tenant_id, result_id, sequence, code, name, kind, source, amount,
               irt_subject, inss_subject, ref_id, created_by, updated_by)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              context.tenantId,
              resultId,
              i + 1,
              l.code.slice(0, 60),
              l.name.slice(0, 200),
              l.kind,
              l.source,
              m(l.amount),
              l.irtSubject,
              l.inssSubject,
              l.refId,
              context.userId,
              context.userId,
            ] as never[]
          )
      }
      await scope.trx.rawQuery(
        `update payroll_runs set status = 'CALCULATED', inputs_hash = ?, rule_set_id = ?, calculated_by = ?,
           calculated_at = now(), employees_count = ?, errors_count = ?, gross = ?, inss_employee = ?, irt = ?,
           deductions = ?, loans = ?, net = ?, inss_employer = ?, employer_cost = ?, version = version + 1,
           updated_by = ?, updated_at = now() where tenant_id = ? and id = ?`,
        [
          hash,
          ruleSets.size === 1 ? [...ruleSets][0] : null,
          context.userId,
          built.length,
          errorsCount,
          m(sum.gross),
          m(sum.inssEmployee),
          m(sum.irt),
          m(sum.deductions),
          m(sum.loans),
          m(sum.net),
          m(sum.inssEmployer),
          m(sum.employerCost),
          context.userId,
          context.tenantId,
          id,
        ] as never[]
      )
      await audit(scope, {
        action: 'hr.payroll.run_calculated',
        entityType: 'payroll_run',
        entityId: id,
        metadata: {
          code: u.code,
          employees: built.length,
          errors: errorsCount,
          ruleSets: [...ruleSets],
          inputsHash: hash,
        },
      })
      return this.getIn(scope, id)
    })
  }

  submit(context: TenantContext, id: string, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const { u, access } = await runFor(scope, id, true)
      needManage(access)
      if (Number(u.version) !== expectedVersion) throw ApiError.versionConflict(Number(u.version))
      if (u.status !== 'CALCULATED') wrongState('Calcule o lote antes de pedir aprovação.')
      if (Number(u.errors_count) > 0)
        throw ApiError.conflict(
          'RUN_HAS_ERRORS',
          `${u.errors_count} colaborador(es) com erros: corrija os dados ou exclua-os do lote.`
        )
      if (Number(u.employees_count) === 0) wrongState('O lote não tem colaboradores.')
      await assertFresh(scope, u)
      await setRunStatus(scope, u, 'PENDING_APPROVAL')
      return this.getIn(scope, id)
    })
  }

  decide(
    context: TenantContext,
    id: string,
    approve: boolean,
    comment: string | null,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const { u, access } = await runFor(scope, id, true)
      if (!access.approve)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não aprova processamentos desta entidade legal.')
      if (Number(u.version) !== expectedVersion) throw ApiError.versionConflict(Number(u.version))
      if (u.status !== 'PENDING_APPROVAL') wrongState('O lote não aguarda aprovação.')
      if (u.calculated_by === context.userId || u.created_by === context.userId)
        throw ApiError.forbidden('SEGREGATION', 'Quem prepara ou calcula o lote não o aprova.')
      const own = await scope.trx.rawQuery(
        `select 1 from payroll_results p join employees e on e.tenant_id = p.tenant_id and e.id = p.employee_id
          where p.tenant_id = ? and p.run_id = ? and e.membership_id = ? limit 1`,
        [context.tenantId, id, context.membershipId]
      )
      if (own.rows.length)
        throw ApiError.forbidden(
          'SEGREGATION',
          'O seu próprio recibo está neste lote: outra pessoa aprova.'
        )
      if (!approve && !comment)
        fail([{ path: 'comment', code: 'REQUIRED', message: 'Indique o motivo da recusa.' }])
      const decision = {
        decided_by_membership_id: context.membershipId,
        decided_at: new Date().toISOString(),
        decision_comment: comment,
      }
      if (approve) {
        await assertFresh(scope, u)
        await setRunStatus(scope, u, 'APPROVED', decision)
      } else await setRunStatus(scope, u, 'CALCULATED', decision, { rejected: true, comment })
      return this.getIn(scope, id)
    })
  }

  /** Fecha o lote aprovado: regista os descontos dos empréstimos (referência = código do lote) e fecha o mês. */
  close(context: TenantContext, id: string, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const { u, access } = await runFor(scope, id, true)
      needManage(access)
      if (Number(u.version) !== expectedVersion) throw ApiError.versionConflict(Number(u.version))
      if (u.status !== 'APPROVED') wrongState('Só um lote aprovado se fecha.')
      await assertFresh(scope, u)
      const loans = await scope.trx.rawQuery(
        `select l.ref_id from payroll_result_lines l
           join payroll_results p on p.tenant_id = l.tenant_id and p.id = l.result_id
          where l.tenant_id = ? and p.run_id = ? and l.source = 'LOAN' and p.status = 'OK'`,
        [context.tenantId, id]
      )
      const settledOn = today() < periodEnd(u.period_text) ? today() : periodEnd(u.period_text)
      for (const l of loans.rows as any[])
        await recordLoanDeduction(scope, l.ref_id, u.code, settledOn)
      await setRunStatus(
        scope,
        u,
        'CLOSED',
        { closed_by: context.userId, closed_at: new Date().toISOString() },
        { loanDeductions: loans.rows.length }
      )
      await createObligations(scope, id)
      if (u.kind === 'REGULAR') {
        await scope.trx.rawQuery(
          `update payroll_periods set status = 'CLOSED', closed_by = ?, closed_at = now(), version = version + 1,
             updated_by = ?, updated_at = now() where tenant_id = ? and id = ?`,
          [context.userId, context.userId, context.tenantId, u.period_id]
        )
        await audit(scope, {
          action: 'hr.payroll.period_closed',
          entityType: 'payroll_period',
          entityId: u.period_id,
          metadata: { legalEntityId: u.legal_entity_id, period: u.period_text, run: u.code },
        })
      }
      return this.getIn(scope, id)
    })
  }

  cancel(context: TenantContext, id: string, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const { u, access } = await runFor(scope, id, true)
      needManage(access)
      if (Number(u.version) !== expectedVersion) throw ApiError.versionConflict(Number(u.version))
      if (!['DRAFT', 'CALCULATED'].includes(u.status))
        wrongState(
          'Só um lote por aprovar se cancela (os aprovados fecham-se ou recusam-se antes).'
        )
      await setRunStatus(scope, u, 'CANCELLED')
      return this.getIn(scope, id)
    })
  }

  /** Meses da entidade legal (aberto/fechado), para escolher o mês a rectificar. */
  periods(context: TenantContext, legalEntityId: string) {
    return runInTenant(context, async (scope) => {
      if (!isUuid(legalEntityId)) throw ApiError.notFound()
      const s = await payScopes(scope)
      if (!entityAccess(s, legalEntityId).read) throw ApiError.notFound()
      const le = await scope.trx.rawQuery(
        `select 1 from legal_entities where tenant_id = ? and id = ?`,
        [context.tenantId, legalEntityId]
      )
      if (!le.rows.length) throw ApiError.notFound()
      const r = await scope.trx.rawQuery(
        `select id, period::text as period_text, status, closed_at from payroll_periods
          where tenant_id = ? and legal_entity_id = ? order by period desc limit 36`,
        [context.tenantId, legalEntityId]
      )
      return (r.rows as any[]).map((p) => ({
        id: p.id as string,
        period: p.period_text as string,
        status: p.status as string,
        closedAt: p.closed_at ?? null,
      }))
    })
  }

  private async getIn(scope: TenantScope, id: string) {
    const u = await findRun(scope, id)
    return { ...runView(u), results: await resultsOf(scope, id) }
  }
}
