import { ApiError } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { permissionScope, type PermissionScope } from '#modules/rbac/index'
import { scopeClause } from '#modules/hr/application/employee_service'
import { entityAccess, payScopes } from '#modules/hr/application/payroll_service'
import { initiativeOf, type TerminationReason } from '#modules/hr/domain/termination'
import { headcount, turnover, type StaffFact } from '#modules/hr/domain/reports'
import { daysCents, daysText } from '#modules/hr/domain/leave'

/*
 * Relatórios de RH (7.12). Efectivos, rotatividade e férias: `hr.reports.read` no âmbito da colocação actual dos
 * colaboradores (nunca só OWN). Folha salarial, IRT, INSS e custos: `hr.payroll.read` por entidade legal (como o
 * processamento), só de lotes fechados. Só agregados e totais por colaborador; nunca dados pessoais.
 */

const noOwn = (s: PermissionScope): PermissionScope => ({ ...s, own: false })

async function reportScope(scope: TenantScope) {
  const s = noOwn(await permissionScope(scope, 'hr.reports.read'))
  const c = scopeClause(s, scope.context.membershipId)
  if (!c)
    throw ApiError.forbidden('OUT_OF_SCOPE', 'Não tem acesso a relatórios de recursos humanos.')
  return c
}

/** Factos de pessoal (admissão, saída aprovada, colocações e contratos) no âmbito, opcionalmente por entidade legal. */
async function staffFacts(scope: TenantScope, legalEntityId: string | null): Promise<StaffFact[]> {
  const c = await reportScope(scope)
  const t = scope.context.tenantId
  const where = ['e.tenant_id = ?', c.sql]
  const params: unknown[] = [t, ...c.params]
  if (legalEntityId) {
    where.push('e.legal_entity_id = ?')
    params.push(legalEntityId)
  }
  const rows = await scope.trx.rawQuery(
    `select e.id, e.hire_date::text as hire_text, e.legal_entity_id, e.department_id, e.position_id,
        x.last_text as exit_text, x.reason as exit_reason
       from employees e
       left join lateral (select tm.last_working_day::text as last_text, tm.reason from employee_terminations tm
          where tm.tenant_id = e.tenant_id and tm.employee_id = e.id and tm.status in ('APPROVED','SETTLED')
          order by tm.last_working_day desc limit 1) x on true
      where ${where.join(' and ')}`,
    params as never[]
  )
  const ids = (rows.rows as any[]).map((r) => r.id as string)
  if (!ids.length) return []
  const pl = await scope.trx.rawQuery(
    `select employee_id, valid_from::text as f, valid_to::text as t, legal_entity_id, department_id, position_id
       from employment_assignments where tenant_id = ? and employee_id = any(?::uuid[])`,
    [t, ids] as never[]
  )
  const ct = await scope.trx.rawQuery(
    `select employee_id, contract_type, start_date::text as s,
        coalesce(termination_date, end_date)::text as e
       from employment_contracts where tenant_id = ? and employee_id = any(?::uuid[])
        and status in ('ACTIVE','SUSPENDED','ENDED')`,
    [t, ids] as never[]
  )
  return (rows.rows as any[]).map((r) => ({
    id: r.id,
    hireDate: r.hire_text,
    exitDate: r.exit_text ?? null,
    exitReason: r.exit_reason ?? null,
    exitInitiative: r.exit_reason ? initiativeOf(r.exit_reason as TerminationReason) : null,
    current: {
      legalEntityId: r.legal_entity_id,
      departmentId: r.department_id ?? null,
      positionId: r.position_id ?? null,
    },
    placements: (pl.rows as any[])
      .filter((p) => p.employee_id === r.id)
      .map((p) => ({
        validFrom: p.f,
        validTo: p.t ?? null,
        legalEntityId: p.legal_entity_id,
        departmentId: p.department_id ?? null,
        positionId: p.position_id ?? null,
      })),
    contractTypes: (ct.rows as any[])
      .filter((k) => k.employee_id === r.id)
      .map((k) => ({ start: k.s, end: k.e ?? null, type: k.contract_type })),
  }))
}

/** Nomes legíveis para as chaves dos agrupamentos. */
async function names(scope: TenantScope) {
  const t = scope.context.tenantId
  const q = async (sql: string) =>
    new Map(
      ((await scope.trx.rawQuery(sql, [t])).rows as any[]).map((x) => [x.id, x.label as string])
    )
  return {
    legalEntity: await q(
      `select id, code || ' — ' || legal_name as label from legal_entities where tenant_id = ?`
    ),
    department: await q(`select id, name as label from departments where tenant_id = ?`),
    position: await q(`select id, name as label from positions where tenant_id = ?`),
  }
}

const label =
  (m: Map<string, string>, none: string) =>
  ({ key, count }: { key: string | null; count: number }) => ({
    key,
    label: key ? (m.get(key) ?? key) : none,
    count,
  })

const isDate = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v))
const checkEntity = (v: unknown) => {
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string' || !isUuid(v)) throw ApiError.notFound()
  return v
}
const checkYear = (y: unknown) => {
  const n = Number(y)
  if (!Number.isInteger(n) || n < 2000 || n > 2100)
    throw ApiError.validation([{ path: 'year', code: 'INVALID', message: 'Ano inválido.' }])
  return n
}

export class HrReportsService {
  headcount(context: TenantContext, q: { date?: unknown; legalEntityId?: unknown }) {
    return runInTenant(context, async (scope) => {
      const date = q.date === undefined ? new Date().toISOString().slice(0, 10) : q.date
      if (!isDate(date))
        throw ApiError.validation([
          { path: 'date', code: 'INVALID_DATE', message: 'Data inválida.' },
        ])
      const facts = await staffFacts(scope, checkEntity(q.legalEntityId))
      const h = headcount(facts, date)
      const n = await names(scope)
      const year = date.slice(0, 4)
      return {
        ...h,
        byLegalEntity: h.byLegalEntity.map(label(n.legalEntity, 'Sem entidade')),
        byDepartment: h.byDepartment.map(label(n.department, 'Sem departamento')),
        byPosition: h.byPosition.map(label(n.position, 'Sem cargo')),
        byContractType: h.byContractType.map(({ key, count }) => ({
          key,
          label: key ?? 'Sem contrato',
          count,
        })),
        hiresYearToDate: facts.filter((f) => f.hireDate >= `${year}-01-01` && f.hireDate <= date)
          .length,
        exitsYearToDate: facts.filter(
          (f) => f.exitDate && f.exitDate >= `${year}-01-01` && f.exitDate <= date
        ).length,
      }
    })
  }

  turnover(context: TenantContext, q: { year?: unknown; legalEntityId?: unknown }) {
    return runInTenant(context, async (scope) => {
      const year = checkYear(q.year)
      return turnover(await staffFacts(scope, checkEntity(q.legalEntityId)), year)
    })
  }

  /** Férias do ano por colaborador no âmbito: direito, gozadas, pendentes e saldo; totais e por departamento. */
  leave(context: TenantContext, q: { year?: unknown; legalEntityId?: unknown }) {
    return runInTenant(context, async (scope) => {
      const year = checkYear(q.year)
      const le = checkEntity(q.legalEntityId)
      const c = await reportScope(scope)
      const t = context.tenantId
      const where = [
        'e.tenant_id = ?',
        c.sql,
        `e.hire_date <= ?::date`,
        `not exists (select 1 from employee_terminations tm where tm.tenant_id = e.tenant_id and tm.employee_id = e.id
           and tm.status in ('APPROVED','SETTLED') and tm.last_working_day < ?::date)`,
      ]
      const params: unknown[] = [t, ...c.params, `${year}-12-31`, `${year}-01-01`]
      if (le) {
        where.push('e.legal_entity_id = ?')
        params.push(le)
      }
      const r = await scope.trx.rawQuery(
        `select e.id, e.code, e.full_name, d.name as department_name,
            coalesce(sum(l.days) filter (where l.kind in ('ACCRUAL','CARRYOVER','ADJUSTMENT','EXPIRY')), 0)::text as entitled,
            coalesce(-sum(l.days) filter (where l.kind in ('TAKEN','REVERSAL')), 0)::text as taken,
            coalesce(sum(l.days), 0)::text as balance,
            (select coalesce(sum(r.days), 0)::text from leave_requests r
               join leave_types ty on ty.tenant_id = r.tenant_id and ty.id = r.leave_type_id
              where r.tenant_id = e.tenant_id and r.employee_id = e.id and r.year = ? and r.status = 'PENDING'
                and ty.deducts_balance) as pending
           from employees e
           left join departments d on d.tenant_id = e.tenant_id and d.id = e.department_id
           left join leave_ledger l on l.tenant_id = e.tenant_id and l.employee_id = e.id and l.year = ?
          where ${where.join(' and ')}
          group by e.id, d.name order by d.name nulls last, e.full_name`,
        [year, year, ...params] as never[]
      )
      const rows = (r.rows as any[]).map((x) => ({
        employee: { id: x.id as string, code: x.code as string, fullName: x.full_name as string },
        departmentName: (x.department_name as string) ?? null,
        entitled: daysText(daysCents(x.entitled) ?? 0n),
        taken: daysText(daysCents(x.taken) ?? 0n),
        pending: daysText(daysCents(x.pending) ?? 0n),
        balance: daysText(daysCents(x.balance) ?? 0n),
      }))
      const sum = (k: 'entitled' | 'taken' | 'pending' | 'balance', list = rows) =>
        daysText(list.reduce((a, x) => a + (daysCents(x[k]) ?? 0n), 0n))
      const depts = [...new Set(rows.map((x) => x.departmentName))]
      return {
        year,
        rows,
        totals: {
          employees: rows.length,
          entitled: sum('entitled'),
          taken: sum('taken'),
          pending: sum('pending'),
          balance: sum('balance'),
        },
        byDepartment: depts.map((d) => {
          const list = rows.filter((x) => x.departmentName === d)
          return {
            departmentName: d,
            employees: list.length,
            entitled: sum('entitled', list),
            taken: sum('taken', list),
            balance: sum('balance', list),
          }
        }),
      }
    })
  }

  /**
   * Folha salarial do ano (lotes fechados): por mês e tipo de lote, bruto, INSS do trabalhador e da empresa, IRT,
   * descontos, empréstimos, líquido e custo para a empresa; por departamento (colocação no fim do mês). Só nas
   * entidades legais com `hr.payroll.read`.
   */
  payroll(context: TenantContext, q: { year?: unknown; legalEntityId?: unknown }) {
    return runInTenant(context, async (scope) => {
      const year = checkYear(q.year)
      const le = checkEntity(q.legalEntityId)
      const s = await payScopes(scope)
      const entities = await scope.trx.rawQuery(
        `select id, code, legal_name from legal_entities where tenant_id = ? order by code`,
        [context.tenantId]
      )
      const allowed = (entities.rows as any[]).filter((x) => entityAccess(s, x.id).read)
      if (!allowed.length)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não tem acesso ao processamento salarial.')
      if (le && !allowed.some((x) => x.id === le)) throw ApiError.notFound()
      const ids = le ? [le] : allowed.map((x) => x.id as string)
      const base = `from payroll_results p
         join payroll_runs u on u.tenant_id = p.tenant_id and u.id = p.run_id
         join payroll_periods pp on pp.tenant_id = u.tenant_id and pp.id = u.period_id
        where p.tenant_id = ? and u.status = 'CLOSED' and pp.legal_entity_id = any(?::uuid[])
          and extract(year from pp.period) = ? and p.gross is not null`
      const sums = `count(distinct p.employee_id)::int as employees, coalesce(sum(p.gross), 0)::text as gross,
          coalesce(sum(p.inss_employee), 0)::text as inss_employee,
          coalesce(sum(p.inss_employer), 0)::text as inss_employer, coalesce(sum(p.irt), 0)::text as irt,
          coalesce(sum(p.deductions), 0)::text as deductions, coalesce(sum(p.loans), 0)::text as loans,
          coalesce(sum(p.net), 0)::text as net, coalesce(sum(p.employer_cost), 0)::text as employer_cost`
      const params = [context.tenantId, ids, year]
      const map = (x: any) => ({
        employees: Number(x.employees),
        gross: x.gross as string,
        inssEmployee: x.inss_employee as string,
        inssEmployer: x.inss_employer as string,
        irt: x.irt as string,
        deductions: x.deductions as string,
        loans: x.loans as string,
        net: x.net as string,
        employerCost: x.employer_cost as string,
      })
      const months = await scope.trx.rawQuery(
        `select to_char(pp.period, 'YYYY-MM') as month, p.currency, ${sums} ${base}
          group by 1, 2 order by 1, 2`,
        params as never[]
      )
      const kinds = await scope.trx.rawQuery(
        `select u.kind, p.currency, ${sums} ${base} group by 1, 2 order by 1, 2`,
        params as never[]
      )
      const totals = await scope.trx.rawQuery(
        `select p.currency, ${sums} ${base} group by 1 order by 1`,
        params as never[]
      )
      const depts = await scope.trx.rawQuery(
        `select coalesce(d.name, 'Sem departamento') as department_name, p.currency, ${sums} ${base.replace(
          'where p.tenant_id = ?',
          `left join lateral (select a.department_id from employment_assignments a
              where a.tenant_id = p.tenant_id and a.employee_id = p.employee_id
                and a.valid_from <= (pp.period + interval '1 month - 1 day')::date
              order by a.valid_from desc limit 1) a on true
           left join departments d on d.tenant_id = p.tenant_id and d.id = a.department_id
           where p.tenant_id = ?`
        )} group by 1, 2 order by 1, 2`,
        params as never[]
      )
      return {
        year,
        legalEntities: allowed
          .filter((x) => ids.includes(x.id))
          .map((x) => ({
            id: x.id as string,
            code: x.code as string,
            name: x.legal_name as string,
          })),
        months: (months.rows as any[]).map((x) => ({
          month: x.month as string,
          currency: x.currency as string,
          ...map(x),
        })),
        byKind: (kinds.rows as any[]).map((x) => ({
          kind: x.kind as string,
          currency: x.currency as string,
          ...map(x),
        })),
        byDepartment: (depts.rows as any[]).map((x) => ({
          departmentName: x.department_name as string,
          currency: x.currency as string,
          ...map(x),
        })),
        totals: (totals.rows as any[]).map((x) => ({ currency: x.currency as string, ...map(x) })),
      }
    })
  }
}
