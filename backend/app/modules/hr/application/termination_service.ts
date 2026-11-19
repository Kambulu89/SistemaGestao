import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { constraintOf, isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope, type PermissionScope } from '#modules/rbac/index'
import { covers, findRow, placementOf, scopeClause } from '#modules/hr/application/employee_service'
import { contractEvent, contractTermsAt } from '#modules/hr/application/career_service'
import { closeLeaveBalance, leaveBalanceOf } from '#modules/hr/application/leave_service'
import {
  entityAccess,
  nextRunCode,
  payScopes,
  periodRow,
} from '#modules/hr/application/payroll_service'
import { normalizeFields } from '#modules/hr/domain/recruitment'
import { daysText } from '#modules/hr/domain/leave'
import { moneyText } from '#modules/hr/domain/compensation'
import { addMonths, moneyLabel, monthLabel } from '#modules/hr/domain/loans'
import {
  initiativeOf,
  noticeFacts,
  prorate,
  scaled,
  scaledText,
  serviceLength,
  settlementLineIssues,
  settlementTotals,
  TASK_CATEGORIES,
  TASK_STATUSES,
  TERMINATION_REASONS,
  VACATION_KINDS,
  yearFraction,
  type TerminationReason,
} from '#modules/hr/domain/termination'

/*
 * Cessação do contrato (7.11). Processo por colaborador: motivo, aviso prévio, último dia, indemnização só quando
 * aplicável (com a base legal indicada pela empresa), liquidação final em linhas com componente salarial, e checklist
 * de saída (acessos, equipamentos, documentos, finanças).
 *
 *  - Âmbito `hr.terminations.read|manage|approve` sobre a colocação do colaborador; ninguém trata a própria cessação.
 *  - Aprovação segregada (nem quem criou nem quem submeteu). A aprovação termina o contrato, fecha a colocação, passa o
 *    colaborador a "cessou funções" e encerra o saldo de férias do ano, tudo na mesma transacção.
 *  - A liquidação final é paga por um lote EXTRA do processamento salarial (IRT/INSS pela incidência de cada componente);
 *    os valores do lote vêm do processo aprovado e não se alteram no lote.
 *  - Montantes nunca vão para a auditoria.
 */

const noOwn = (s: PermissionScope): PermissionScope => ({ ...s, own: false })
const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
const wrongState = (message: string): never => {
  throw ApiError.conflict('INVALID_STATE', message)
}
const today = () => new Date().toISOString().slice(0, 10)
const RESERVED = '[RESERVADO]'

const REASON_LABEL: Record<TerminationReason, string> = {
  RESIGNATION: 'Denúncia pelo trabalhador',
  MUTUAL_AGREEMENT: 'Acordo entre as partes',
  DISMISSAL_DISCIPLINARY: 'Despedimento disciplinar',
  DISMISSAL_OBJECTIVE: 'Despedimento por causas objectivas',
  END_OF_TERM: 'Caducidade (fim do termo)',
  PROBATION: 'Denúncia no período experimental',
  RETIREMENT: 'Reforma',
  DEATH: 'Falecimento',
  OTHER: 'Outro motivo',
}

interface TermScopes {
  read: PermissionScope
  manage: PermissionScope
  approve: PermissionScope
}

async function termScopes(scope: TenantScope): Promise<TermScopes> {
  return {
    read: noOwn(await permissionScope(scope, 'hr.terminations.read')),
    manage: noOwn(await permissionScope(scope, 'hr.terminations.manage')),
    approve: noOwn(await permissionScope(scope, 'hr.terminations.approve')),
  }
}

function accessTo(s: TermScopes, e: any, me: string) {
  if (e.membership_id && e.membership_id === me) return null
  const place = placementOf(e)
  const manage = covers(s.manage, place, me)
  const approve = covers(s.approve, place, me)
  const read = manage || approve || covers(s.read, place, me)
  return read ? { read, manage, approve } : null
}

const T_SELECT = `select t.*, t.notice_given_on::text as notice_text, t.last_working_day::text as last_text,
    e.code as employee_code, e.full_name as employee_name, e.legal_entity_id, e.branch_id, e.department_id,
    e.membership_id, e.hire_date::text as hire_text, e.status as employee_status,
    c.code as contract_code, dc.code as case_code, cu.full_name as created_by_name,
    su.full_name as submitted_by_name, du.full_name as decided_by_name,
    r.code as run_code, r.status as run_status
  from employee_terminations t
  join employees e on e.tenant_id = t.tenant_id and e.id = t.employee_id
  join employment_contracts c on c.tenant_id = t.tenant_id and c.id = t.contract_id
  left join disciplinary_cases dc on dc.tenant_id = t.tenant_id and dc.id = t.disciplinary_case_id
  left join users cu on cu.id = t.created_by
  left join users su on su.id = t.submitted_by
  left join tenant_memberships dm on dm.tenant_id = t.tenant_id and dm.id = t.decided_by_membership_id
  left join users du on du.id = dm.user_id
  left join payroll_runs r on r.tenant_id = t.tenant_id and r.id = t.settlement_run_id`

async function findTermination(scope: TenantScope, id: string, lock = false) {
  if (!isUuid(id)) return null
  const r = await scope.trx.rawQuery(
    `${T_SELECT} where t.tenant_id = ? and t.id = ?${lock ? ' for update of t' : ''}`,
    [scope.context.tenantId, id]
  )
  return (r.rows[0] as any) ?? null
}

async function terminationFor(scope: TenantScope, id: string, lock = false) {
  const t = await findTermination(scope, id, lock)
  if (!t) throw ApiError.notFound()
  const a = accessTo(await termScopes(scope), t, scope.context.membershipId)
  if (!a) throw ApiError.notFound()
  return { t, access: a }
}

const needManage = (a: { manage: boolean }) => {
  if (!a.manage) throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere cessações deste colaborador.')
}

function terminationView(t: any) {
  return {
    id: t.id as string,
    version: Number(t.version),
    code: t.code as string,
    employee: {
      id: t.employee_id as string,
      code: t.employee_code as string,
      fullName: t.employee_name as string,
      status: t.employee_status as string,
    },
    contract: { id: t.contract_id as string, code: t.contract_code as string },
    reason: t.reason as TerminationReason,
    initiative: initiativeOf(t.reason),
    details: t.details as string,
    disciplinaryCase: t.disciplinary_case_id
      ? { id: t.disciplinary_case_id as string, code: t.case_code as string }
      : null,
    noticeGivenOn: (t.notice_text as string) ?? null,
    lastWorkingDay: t.last_text as string,
    noticeRequiredDays: t.notice_required_days === null ? null : Number(t.notice_required_days),
    noticeBasis: (t.notice_basis as string) ?? null,
    indemnityApplicable: Boolean(t.indemnity_applicable),
    indemnityBasis: (t.indemnity_basis as string) ?? null,
    currency: t.currency as string,
    status: t.status as string,
    createdBy: (t.created_by_name as string) ?? null,
    createdAt: t.created_at,
    submittedBy: (t.submitted_by_name as string) ?? null,
    submittedAt: t.submitted_at ?? null,
    decidedBy: (t.decided_by_name as string) ?? null,
    decidedAt: t.decided_at ?? null,
    decisionNote: (t.decision_note as string) ?? null,
    settlementRun: t.settlement_run_id
      ? { id: t.settlement_run_id as string, code: t.run_code as string, status: t.run_status }
      : null,
    settledAt: t.settled_at ?? null,
    cancelReason: (t.cancel_reason as string) ?? null,
  }
}

async function linesOf(scope: TenantScope, id: string) {
  const r = await scope.trx.rawQuery(
    `select l.*, l.quantity::text as qty, l.rate::text as rate_text, l.amount::text as amount_text,
        c.code as component_code, c.name as component_name, c.kind as component_kind
       from termination_settlement_lines l
       join pay_components c on c.tenant_id = l.tenant_id and c.id = l.component_id
      where l.tenant_id = ? and l.termination_id = ? order by l.created_at`,
    [scope.context.tenantId, id]
  )
  return (r.rows as any[]).map((l) => ({
    id: l.id as string,
    kind: l.kind as string,
    component: {
      id: l.component_id as string,
      code: l.component_code as string,
      name: l.component_name as string,
      kind: l.component_kind as string,
    },
    description: l.description as string,
    quantity: (l.qty as string) ?? null,
    rate: (l.rate_text as string) ?? null,
    amount: l.amount_text as string,
    basis: l.basis as string,
  }))
}

async function tasksOf(scope: TenantScope, id: string) {
  const r = await scope.trx.rawQuery(
    `select k.*, u.full_name as completed_by_name from termination_tasks k
       left join users u on u.id = k.completed_by
      where k.tenant_id = ? and k.termination_id = ? order by k.created_at, k.title`,
    [scope.context.tenantId, id]
  )
  return (r.rows as any[]).map((k) => ({
    id: k.id as string,
    version: Number(k.version),
    category: k.category as string,
    kind: k.kind as string,
    title: k.title as string,
    status: k.status as string,
    notes: (k.notes as string) ?? null,
    completedBy: (k.completed_by_name as string) ?? null,
    completedAt: k.completed_at ?? null,
  }))
}

/** Empréstimos e adiantamentos com prestações por liquidar. */
async function outstandingLoans(scope: TenantScope, employeeId: string) {
  const r = await scope.trx.rawQuery(
    `select l.id, l.code, l.kind, l.status, coalesce(sum(i.amount) filter (where i.status = 'PENDING'), 0)::text as due
       from employee_loans l
       left join employee_loan_installments i on i.tenant_id = l.tenant_id and i.loan_id = l.id
      where l.tenant_id = ? and l.employee_id = ? and l.status in ('DRAFT','PENDING_APPROVAL','ACTIVE')
      group by l.id order by l.code`,
    [scope.context.tenantId, employeeId]
  )
  return (r.rows as any[]).map((l) => ({
    id: l.id as string,
    code: l.code as string,
    kind: l.kind as string,
    status: l.status as string,
    outstanding: l.due as string,
  }))
}

/** Processamentos com este colaborador por fechar ou por pagar (remunerações pendentes). */
async function pendingPay(scope: TenantScope, t: any) {
  const period = `${(t.last_text as string).slice(0, 7)}-01`
  const regular = await scope.trx.rawQuery(
    `select u.code, u.status from payroll_runs u
       join payroll_periods p on p.tenant_id = u.tenant_id and p.id = u.period_id
      where u.tenant_id = ? and p.legal_entity_id = ? and p.period = ?::date and u.kind = 'REGULAR'
        and u.status <> 'CANCELLED' limit 1`,
    [scope.context.tenantId, t.legal_entity_id, period]
  )
  const open = await scope.trx.rawQuery(
    `select u.id, u.code, u.kind, u.status, p.period::text as period_text, r.net::text as net,
        o.amount::text as due, o.paid_amount::text as paid
       from payroll_results r
       join payroll_runs u on u.tenant_id = r.tenant_id and u.id = r.run_id
       join payroll_periods p on p.tenant_id = u.tenant_id and p.id = u.period_id
       left join payroll_obligations o on o.tenant_id = u.tenant_id and o.run_id = u.id and o.kind = 'NET_PAY'
      where r.tenant_id = ? and r.employee_id = ? and u.status <> 'CANCELLED'
        and (u.status <> 'CLOSED' or (o.id is not null and o.paid_amount < o.amount))
      order by p.period, u.code`,
    [scope.context.tenantId, t.employee_id]
  )
  const reg = regular.rows[0] as { code: string; status: string } | undefined
  return {
    period: period.slice(0, 7),
    regularRun: reg ? { code: reg.code, status: reg.status } : null,
    runs: (open.rows as any[]).map((u) => ({
      id: u.id as string,
      code: u.code as string,
      kind: u.kind as string,
      status: u.status as string,
      period: (u.period_text as string).slice(0, 7),
      paid: u.status === 'CLOSED' ? false : null,
    })),
  }
}

/**
 * O que impede a aprovação (e a submissão): contrato já não em vigor, indemnização marcada sem linha, despedimento
 * disciplinar sem processo encerrado com essa decisão, ausências por decidir ou depois do último dia, pedidos de
 * adiantamento por decidir e meses posteriores já fechados com este colaborador.
 */
async function blockers(scope: TenantScope, t: any): Promise<ErrorDetail[]> {
  const issues: ErrorDetail[] = []
  const tenant = scope.context.tenantId
  const c = await scope.trx.rawQuery(
    `select status, start_date::text as start_text from employment_contracts where tenant_id = ? and id = ?`,
    [tenant, t.contract_id]
  )
  const contract = c.rows[0] as { status: string; start_text: string }
  if (!['ACTIVE', 'SUSPENDED'].includes(contract.status))
    issues.push({
      path: 'contract',
      code: 'CONTRACT_NOT_OPEN',
      message: 'O contrato já não está em vigor.',
    })
  else if (t.last_text < contract.start_text)
    issues.push({
      path: 'lastWorkingDay',
      code: 'BEFORE_START',
      message: 'O último dia é anterior ao início do contrato.',
    })
  const lines = await linesOf(scope, t.id)
  if (t.indemnity_applicable && !lines.some((l) => l.kind === 'INDEMNITY'))
    issues.push({
      path: 'lines',
      code: 'INDEMNITY_MISSING',
      message: 'A indemnização está marcada como aplicável: inclua a linha na liquidação.',
    })
  if (t.reason === 'DISMISSAL_DISCIPLINARY') {
    const dc = await scope.trx.rawQuery(
      `select status, outcome from disciplinary_cases where tenant_id = ? and id = ?`,
      [tenant, t.disciplinary_case_id]
    )
    const k = dc.rows[0] as { status: string; outcome: string | null } | undefined
    if (!k || k.status !== 'CLOSED' || k.outcome !== 'DISMISSAL')
      issues.push({
        path: 'disciplinaryCaseId',
        code: 'CASE_NOT_DECIDED',
        message:
          'O despedimento disciplinar exige o processo encerrado com decisão de despedimento.',
      })
  }
  const leave = await scope.trx.rawQuery(
    `select count(*)::int as n from leave_requests where tenant_id = ? and employee_id = ?
       and (status = 'PENDING' or (status = 'APPROVED' and end_date > ?::date))`,
    [tenant, t.employee_id, t.last_text]
  )
  if ((leave.rows[0] as { n: number }).n)
    issues.push({
      path: 'leave',
      code: 'LEAVE_OPEN',
      message:
        'Há pedidos de ausência por decidir ou depois do último dia: decida-os ou cancele-os primeiro.',
    })
  const loans = await scope.trx.rawQuery(
    `select count(*)::int as n from employee_loans where tenant_id = ? and employee_id = ?
       and status in ('DRAFT','PENDING_APPROVAL')`,
    [tenant, t.employee_id]
  )
  if ((loans.rows[0] as { n: number }).n)
    issues.push({
      path: 'loans',
      code: 'LOAN_REQUEST_OPEN',
      message: 'Há pedidos de adiantamento ou empréstimo por decidir: decida-os ou cancele-os.',
    })
  const later = await scope.trx.rawQuery(
    `select p.period::text as period_text from payroll_results r
       join payroll_runs u on u.tenant_id = r.tenant_id and u.id = r.run_id
       join payroll_periods p on p.tenant_id = u.tenant_id and p.id = u.period_id
      where r.tenant_id = ? and r.employee_id = ? and u.kind = 'REGULAR' and u.status = 'CLOSED'
        and p.period > date_trunc('month', ?::date) order by p.period limit 1`,
    [tenant, t.employee_id, t.last_text]
  )
  const l = later.rows[0] as { period_text: string } | undefined
  if (l)
    issues.push({
      path: 'lastWorkingDay',
      code: 'PROCESSED_AFTER',
      message: `O mês ${monthLabel(l.period_text)} já foi processado e fechado com este colaborador: o último dia não pode ser anterior (um mês fechado não se reabre).`,
    })
  return issues
}

/** Factos de apoio à liquidação (sugestões; a empresa decide os montantes e a base legal). */
async function factsOf(scope: TenantScope, t: any) {
  const last = t.last_text as string
  const year = Number(last.slice(0, 4))
  const terms = await contractTermsAt(scope, t.employee_id, last)
  const b = await leaveBalanceOf(scope, t.employee_id, year)
  const frac = yearFraction(t.hire_text, last)
  const accrued = scaled(b.accrued, 2) ?? 0n
  const reports = await scope.trx.rawQuery(
    `select count(*)::int as n from employees where tenant_id = ? and manager_id = ? and status <> 'TERMINATED'`,
    [scope.context.tenantId, t.employee_id]
  )
  return {
    hireDate: t.hire_text as string,
    contract: terms
      ? {
          baseSalary: (terms as any).baseSalary ?? null,
          currency: terms.currency,
          status: terms.status as string,
        }
      : null,
    service: serviceLength(t.hire_text, last),
    notice: noticeFacts(
      t.notice_text ?? null,
      last,
      t.notice_required_days === null ? null : Number(t.notice_required_days)
    ),
    vacation: {
      year,
      accrued: b.accrued,
      carriedOver: b.carriedOver,
      entitled: b.entitled,
      taken: b.taken,
      pending: b.pending,
      balance: b.balance,
      daysWorkedInYear: frac.worked,
      daysInYear: frac.total,
      proportionalHint: daysText(prorate(accrued, frac.worked, frac.total)),
    },
    pendingPay: await pendingPay(scope, t),
    loans: await outstandingLoans(scope, t.employee_id),
    directReports: (reports.rows[0] as { n: number }).n,
  }
}

async function nextCode(scope: TenantScope) {
  const prefix = `CES-${today().slice(0, 4)}-`
  await scope.trx.rawQuery(`select pg_advisory_xact_lock(hashtext(?))`, [
    `${scope.context.tenantId}:${prefix}`,
  ])
  const r = await scope.trx.rawQuery(
    `select coalesce(max(substring(code from ${prefix.length + 1})::int), 0) + 1 as n from employee_terminations
      where tenant_id = ? and code like ? and substring(code from ${prefix.length + 1}) ~ '^[0-9]+$'`,
    [scope.context.tenantId, `${prefix}%`]
  )
  return `${prefix}${String((r.rows[0] as { n: number }).n).padStart(4, '0')}`
}

async function addTask(
  scope: TenantScope,
  terminationId: string,
  task: { category: string; kind: string; title: string; onboardingTaskId?: string | null }
) {
  await scope.trx.rawQuery(
    `insert into termination_tasks (tenant_id, termination_id, category, kind, title, onboarding_task_id, created_by,
       updated_by) values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      scope.context.tenantId,
      terminationId,
      task.category,
      task.kind,
      task.title.slice(0, 200),
      task.onboardingTaskId ?? null,
      scope.context.userId,
      scope.context.userId,
    ] as never[]
  )
}

/**
 * Checklist inicial: acesso à empresa (se o colaborador tem conta), o que foi entregue ou atribuído no acolhimento
 * (equipamentos e acessos concluídos), recolha geral, documentos de saída e, havendo, empréstimos em curso.
 */
async function seedTasks(scope: TenantScope, terminationId: string, e: any) {
  if (e.membership_id)
    await addTask(scope, terminationId, {
      category: 'ACCESS',
      kind: 'SYSTEM_ACCESS',
      title: 'Suspender o acesso do colaborador à empresa (conta da aplicação)',
    })
  const onboarding = await scope.trx.rawQuery(
    `select id, category, title from onboarding_tasks where tenant_id = ? and employee_id = ?
       and category in ('ACCESS','EQUIPMENT') and status = 'DONE' order by created_at`,
    [scope.context.tenantId, e.id]
  )
  for (const o of onboarding.rows as any[])
    await addTask(scope, terminationId, {
      category: o.category,
      kind: 'RETURN_ITEM',
      title: `${o.category === 'ACCESS' ? 'Revogar' : 'Recolher'}: ${o.title}`,
      onboardingTaskId: o.id,
    })
  await addTask(scope, terminationId, {
    category: 'EQUIPMENT',
    kind: 'MANUAL',
    title: 'Recolher equipamentos, cartões e chaves atribuídos',
  })
  await addTask(scope, terminationId, {
    category: 'DOCUMENTS',
    kind: 'MANUAL',
    title: 'Entregar a declaração de cessação e o certificado de trabalho',
  })
  if ((await outstandingLoans(scope, e.id)).length)
    await addTask(scope, terminationId, {
      category: 'FINANCE',
      kind: 'LOANS',
      title: 'Liquidar os adiantamentos e empréstimos em curso',
    })
}

const FIELDS = {
  details: { kind: 'longtext' as const, min: 3, max: 4000, label: 'Descrição' },
  noticeGivenOn: { kind: 'date' as const, label: 'Data do aviso' },
  lastWorkingDay: { kind: 'date' as const, label: 'Último dia de trabalho' },
  noticeRequiredDays: { kind: 'int' as const, min: 0, max: 365, label: 'Dias de aviso exigidos' },
  noticeBasis: { kind: 'longtext' as const, min: 3, max: 1000, label: 'Base do aviso' },
  indemnityBasis: {
    kind: 'longtext' as const,
    min: 3,
    max: 2000,
    label: 'Base legal da indemnização',
  },
  disciplinaryCaseId: { kind: 'uuid' as const, label: 'Processo disciplinar' },
}

/** Valida o estado final dos campos (registo actual + alteração). */
async function fieldIssues(scope: TenantScope, v: Record<string, any>, employeeId: string) {
  const issues: ErrorDetail[] = []
  if (!TERMINATION_REASONS.includes(v.reason))
    issues.push({ path: 'reason', code: 'INVALID', message: 'Motivo inválido.' })
  for (const k of ['details', 'lastWorkingDay'])
    if (!v[k]) issues.push({ path: k, code: 'REQUIRED', message: 'Obrigatório.' })
  if (v.noticeGivenOn && v.lastWorkingDay && v.noticeGivenOn > v.lastWorkingDay)
    issues.push({
      path: 'noticeGivenOn',
      code: 'AFTER_LAST_DAY',
      message: 'O aviso não pode ser posterior ao último dia.',
    })
  if (v.noticeGivenOn && v.noticeGivenOn > today())
    issues.push({ path: 'noticeGivenOn', code: 'FUTURE', message: 'O aviso não pode ser futuro.' })
  if (v.noticeRequiredDays !== null && v.noticeRequiredDays !== undefined && !v.noticeBasis)
    issues.push({
      path: 'noticeBasis',
      code: 'REQUIRED',
      message: 'Indique a fonte dos dias de aviso (contrato, lei ou convenção).',
    })
  if (typeof v.indemnityApplicable !== 'boolean')
    issues.push({ path: 'indemnityApplicable', code: 'REQUIRED', message: 'Indique se se aplica.' })
  else if (v.indemnityApplicable && !v.indemnityBasis)
    issues.push({
      path: 'indemnityBasis',
      code: 'REQUIRED',
      message: 'Indique a base legal e o critério da indemnização.',
    })
  if (v.reason === 'DISMISSAL_DISCIPLINARY') {
    if (!v.disciplinaryCaseId)
      issues.push({
        path: 'disciplinaryCaseId',
        code: 'REQUIRED',
        message: 'Indique o processo disciplinar.',
      })
    else {
      const r = await scope.trx.rawQuery(
        `select 1 from disciplinary_cases where tenant_id = ? and id = ? and employee_id = ?`,
        [scope.context.tenantId, v.disciplinaryCaseId, employeeId]
      )
      if (!r.rows.length)
        issues.push({
          path: 'disciplinaryCaseId',
          code: 'NOT_FOUND',
          message: 'Processo disciplinar inexistente para este colaborador.',
        })
    }
  }
  return issues
}

const dbValues = (v: Record<string, any>) => ({
  reason: v.reason,
  details: v.details,
  disciplinary_case_id: v.reason === 'DISMISSAL_DISCIPLINARY' ? v.disciplinaryCaseId : null,
  notice_given_on: v.noticeGivenOn ?? null,
  last_working_day: v.lastWorkingDay,
  notice_required_days: v.noticeRequiredDays ?? null,
  notice_basis:
    v.noticeRequiredDays === null || v.noticeRequiredDays === undefined ? null : v.noticeBasis,
  indemnity_applicable: v.indemnityApplicable,
  indemnity_basis: v.indemnityApplicable ? v.indemnityBasis : null,
})

async function bump(scope: TenantScope, id: string) {
  await scope.trx.rawQuery(
    `update employee_terminations set version = version + 1, updated_by = ?, updated_at = now()
      where tenant_id = ? and id = ?`,
    [scope.context.userId, scope.context.tenantId, id]
  )
}

function locked(error: unknown): never {
  const msg = (error as { message?: string })?.message ?? ''
  if (msg.includes('TERMINATION_FINAL') || msg.includes('TERMINATION_LOCKED'))
    throw ApiError.conflict('TERMINATION_LOCKED', 'O processo já não aceita alterações.')
  if (constraintOf(error) === 'employee_terminations_open_unique')
    throw ApiError.conflict(
      'TERMINATION_EXISTS',
      'Este colaborador já tem um processo de cessação.'
    )
  throw error
}

export class TerminationService {
  list(
    context: TenantContext,
    f: { status?: string; employeeId?: string; limit: number; offset: number }
  ) {
    return runInTenant(context, async (scope) => {
      const s = await termScopes(scope)
      const parts: string[] = []
      const params: unknown[] = []
      for (const p of [s.read, s.manage, s.approve]) {
        const c = scopeClause(p, context.membershipId)
        if (c) {
          parts.push(c.sql)
          params.push(...c.params)
        }
      }
      if (!parts.length) return { items: [], total: 0 }
      const where = [
        't.tenant_id = ?',
        `(${parts.join(' or ')})`,
        '(e.membership_id is null or e.membership_id <> ?)',
      ]
      const all: unknown[] = [context.tenantId, ...params, context.membershipId]
      if (f.status) {
        where.push('t.status = ?')
        all.push(f.status)
      }
      if (f.employeeId) {
        where.push('t.employee_id = ?')
        all.push(f.employeeId)
      }
      const clause = where.join(' and ')
      const rows = await scope.trx.rawQuery(
        `${T_SELECT} where ${clause} order by t.last_working_day desc, t.created_at desc limit ? offset ?`,
        [...all, f.limit, f.offset] as never[]
      )
      const count = await scope.trx.rawQuery(
        `select count(*)::int as n from employee_terminations t join employees e on e.tenant_id = t.tenant_id
           and e.id = t.employee_id where ${clause}`,
        all as never[]
      )
      return {
        items: (rows.rows as any[]).map(terminationView),
        total: (count.rows[0] as { n: number }).n,
      }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => this.view(scope, id))
  }

  private async view(scope: TenantScope, id: string) {
    const { t, access } = await terminationFor(scope, id)
    const lines = await linesOf(scope, id)
    const totals = settlementTotals(lines)
    const me = scope.context.userId
    const open = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(t.status)
    return {
      ...terminationView(t),
      lines,
      totals: {
        earnings: moneyText(totals.earnings),
        deductions: moneyText(totals.deductions),
        net: moneyText(totals.net),
      },
      tasks: await tasksOf(scope, id),
      facts: await factsOf(scope, t),
      blockers:
        t.status === 'DRAFT' || t.status === 'PENDING_APPROVAL' ? await blockers(scope, t) : [],
      access: {
        manage: access.manage && open,
        edit: access.manage && t.status === 'DRAFT',
        approve:
          access.approve &&
          t.status === 'PENDING_APPROVAL' &&
          t.created_by !== me &&
          t.submitted_by !== me,
        settle: access.manage && t.status === 'APPROVED',
      },
    }
  }

  create(context: TenantContext, employeeId: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const e = isUuid(employeeId) ? await findRow(scope, employeeId, true) : null
      if (!e) throw ApiError.notFound()
      if (e.membership_id && e.membership_id === context.membershipId)
        throw ApiError.forbidden('SELF_TERMINATION', 'Ninguém trata a própria cessação.')
      const a = accessTo(await termScopes(scope), e, context.membershipId)
      if (!a) throw ApiError.notFound()
      needManage(a)
      if (e.status === 'TERMINATED') wrongState('O colaborador já cessou funções.')
      const contract = await scope.trx.rawQuery(
        `select id, currency from employment_contracts where tenant_id = ? and employee_id = ?
           and status in ('ACTIVE','SUSPENDED') limit 1`,
        [context.tenantId, e.id]
      )
      const c = contract.rows[0] as { id: string; currency: string } | undefined
      if (!c)
        throw ApiError.conflict(
          'NO_OPEN_CONTRACT',
          'O colaborador não tem contrato em vigor para fazer cessar.'
        )
      const { values, issues } = normalizeFields(input, FIELDS)
      const v: Record<string, any> = {
        ...values,
        reason: input.reason,
        indemnityApplicable: input.indemnityApplicable ?? false,
      }
      issues.push(...(await fieldIssues(scope, v, e.id)))
      fail(issues)
      const code = await nextCode(scope)
      const d = dbValues(v)
      let id: string
      try {
        const r = await scope.trx.rawQuery(
          `insert into employee_terminations (tenant_id, employee_id, contract_id, code, reason, details,
             disciplinary_case_id, notice_given_on, last_working_day, notice_required_days, notice_basis,
             indemnity_applicable, indemnity_basis, currency, created_by, updated_by)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
          [
            context.tenantId,
            e.id,
            c.id,
            code,
            d.reason,
            d.details,
            d.disciplinary_case_id,
            d.notice_given_on,
            d.last_working_day,
            d.notice_required_days,
            d.notice_basis,
            d.indemnity_applicable,
            d.indemnity_basis,
            c.currency,
            context.userId,
            context.userId,
          ] as never[]
        )
        id = (r.rows[0] as { id: string }).id
      } catch (error) {
        locked(error)
      }
      await seedTasks(scope, id!, e)
      await audit(scope, {
        action: 'hr.termination.created',
        entityType: 'employee_termination',
        entityId: id!,
        metadata: { code, employeeId: e.id, reason: d.reason, lastWorkingDay: d.last_working_day },
      })
      return this.view(scope, id!)
    })
  }

  update(
    context: TenantContext,
    id: string,
    input: Record<string, unknown>,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const { t, access } = await terminationFor(scope, id, true)
      needManage(access)
      if (Number(t.version) !== expectedVersion) throw ApiError.versionConflict(Number(t.version))
      if (t.status !== 'DRAFT') wrongState('Só um processo em rascunho se altera.')
      const { values, issues } = normalizeFields(input, FIELDS)
      const before: Record<string, any> = {
        reason: t.reason,
        details: t.details,
        disciplinaryCaseId: t.disciplinary_case_id,
        noticeGivenOn: t.notice_text,
        lastWorkingDay: t.last_text,
        noticeRequiredDays: t.notice_required_days === null ? null : Number(t.notice_required_days),
        noticeBasis: t.notice_basis,
        indemnityApplicable: Boolean(t.indemnity_applicable),
        indemnityBasis: t.indemnity_basis,
      }
      const v: Record<string, any> = { ...before, ...values }
      if ('reason' in input) v.reason = input.reason
      if ('indemnityApplicable' in input) v.indemnityApplicable = input.indemnityApplicable
      issues.push(...(await fieldIssues(scope, v, t.employee_id)))
      if (!v.indemnityApplicable) {
        const ind = await scope.trx.rawQuery(
          `select 1 from termination_settlement_lines where tenant_id = ? and termination_id = ? and kind = 'INDEMNITY'`,
          [context.tenantId, id]
        )
        if (ind.rows.length)
          issues.push({
            path: 'indemnityApplicable',
            code: 'INDEMNITY_LINES',
            message: 'Retire primeiro a linha de indemnização da liquidação.',
          })
      }
      fail(issues)
      const d = dbValues(v)
      await scope.trx.rawQuery(
        `update employee_terminations set reason = ?, details = ?, disciplinary_case_id = ?, notice_given_on = ?,
           last_working_day = ?, notice_required_days = ?, notice_basis = ?, indemnity_applicable = ?,
           indemnity_basis = ?, version = version + 1, updated_by = ?, updated_at = now()
         where tenant_id = ? and id = ?`,
        [
          d.reason,
          d.details,
          d.disciplinary_case_id,
          d.notice_given_on,
          d.last_working_day,
          d.notice_required_days,
          d.notice_basis,
          d.indemnity_applicable,
          d.indemnity_basis,
          context.userId,
          context.tenantId,
          id,
        ] as never[]
      )
      const changes: Record<string, { from: unknown; to: unknown }> = {}
      for (const k of Object.keys(before))
        if ((before[k] ?? null) !== (v[k] ?? null) && k !== 'details')
          changes[k] = { from: before[k] ?? null, to: v[k] ?? null }
      await audit(scope, {
        action: 'hr.termination.updated',
        entityType: 'employee_termination',
        entityId: id,
        changes,
        metadata: { code: t.code },
      })
      return this.view(scope, id)
    })
  }

  /** Linha da liquidação (nova ou alterada); só em rascunho. */
  saveLine(
    context: TenantContext,
    id: string,
    lineId: string | null,
    input: Record<string, unknown>,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const { t, access } = await terminationFor(scope, id, true)
      needManage(access)
      if (Number(t.version) !== expectedVersion) throw ApiError.versionConflict(Number(t.version))
      if (t.status !== 'DRAFT') wrongState('A liquidação só se altera em rascunho.')
      if (lineId) {
        const ex = await scope.trx.rawQuery(
          `select 1 from termination_settlement_lines where tenant_id = ? and termination_id = ? and id = ?`,
          [context.tenantId, id, lineId]
        )
        if (!isUuid(lineId) || !ex.rows.length) throw ApiError.notFound()
      }
      const { values: v, issues } = normalizeFields(input, {
        componentId: { kind: 'uuid', label: 'Componente' },
        description: { kind: 'text', min: 3, max: 160, label: 'Descrição' },
        amount: { kind: 'money', label: 'Montante' },
        basis: { kind: 'longtext', min: 3, max: 2000, label: 'Fundamentação' },
      })
      for (const k of ['componentId', 'description', 'amount', 'basis'])
        if (!v[k] && !issues.some((i) => i.path === k))
          issues.push({ path: k, code: 'REQUIRED', message: 'Obrigatório.' })
      const qRaw = input.quantity === '' ? null : (input.quantity ?? null)
      const rRaw = input.rate === '' ? null : (input.rate ?? null)
      const quantity = qRaw === null ? null : scaled(qRaw, 2)
      const rate = rRaw === null ? null : scaled(rRaw, 4)
      if (qRaw !== null && quantity === null)
        issues.push({
          path: 'quantity',
          code: 'INVALID',
          message: 'Quantidade inválida (2 casas).',
        })
      if (rRaw !== null && rate === null)
        issues.push({
          path: 'rate',
          code: 'INVALID',
          message: 'Valor unitário inválido (4 casas).',
        })
      let componentKind: string | null = null
      if (v.componentId) {
        const comp = await scope.trx.rawQuery(
          `select kind, status from pay_components where tenant_id = ? and id = ?`,
          [context.tenantId, v.componentId] as never[]
        )
        const c = comp.rows[0] as { kind: string; status: string } | undefined
        if (!c || c.status !== 'ACTIVE')
          issues.push({
            path: 'componentId',
            code: 'INVALID',
            message: 'Componente inexistente ou inactivo.',
          })
        else componentKind = c.kind
      }
      issues.push(
        ...settlementLineIssues({
          kind: input.kind,
          componentKind,
          quantity: qRaw === null ? null : quantity,
          rate: rRaw === null ? null : rate,
          amount: v.amount ? scaled(v.amount, 2) : null,
          indemnityApplicable: Boolean(t.indemnity_applicable),
        }).filter((i) => !issues.some((x) => x.path === i.path))
      )
      if (qRaw !== null && quantity === 0n)
        issues.push({
          path: 'quantity',
          code: 'POSITIVE',
          message: 'A quantidade tem de ser positiva.',
        })
      if (rRaw !== null && rate === 0n)
        issues.push({
          path: 'rate',
          code: 'POSITIVE',
          message: 'O valor unitário tem de ser positivo.',
        })
      fail(issues)
      const params = [
        input.kind,
        v.componentId,
        v.description,
        quantity === null ? null : scaledText(quantity, 2),
        rate === null ? null : scaledText(rate, 4),
        v.amount,
        v.basis,
        context.userId,
      ]
      try {
        if (lineId)
          await scope.trx.rawQuery(
            `update termination_settlement_lines set kind = ?, component_id = ?, description = ?, quantity = ?,
               rate = ?, amount = ?, basis = ?, updated_by = ?, version = version + 1, updated_at = now()
             where tenant_id = ? and id = ?`,
            [...params, context.tenantId, lineId] as never[]
          )
        else
          await scope.trx.rawQuery(
            `insert into termination_settlement_lines (kind, component_id, description, quantity, rate, amount,
               basis, updated_by, created_by, tenant_id, termination_id) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [...params, context.userId, context.tenantId, id] as never[]
          )
      } catch (error) {
        locked(error)
      }
      await bump(scope, id)
      await audit(scope, {
        action: lineId ? 'hr.termination.line_updated' : 'hr.termination.line_added',
        entityType: 'employee_termination',
        entityId: id,
        metadata: { code: t.code, kind: input.kind, amount: RESERVED },
      })
      return this.view(scope, id)
    })
  }

  removeLine(context: TenantContext, id: string, lineId: string) {
    return runInTenant(context, async (scope) => {
      const { t, access } = await terminationFor(scope, id, true)
      needManage(access)
      if (t.status !== 'DRAFT') wrongState('A liquidação só se altera em rascunho.')
      if (!isUuid(lineId)) throw ApiError.notFound()
      const r = await scope.trx.rawQuery(
        `delete from termination_settlement_lines where tenant_id = ? and termination_id = ? and id = ?
          returning kind`,
        [context.tenantId, id, lineId]
      )
      if (!r.rows.length) throw ApiError.notFound()
      await bump(scope, id)
      await audit(scope, {
        action: 'hr.termination.line_removed',
        entityType: 'employee_termination',
        entityId: id,
        metadata: { code: t.code, kind: (r.rows[0] as { kind: string }).kind },
      })
      return this.view(scope, id)
    })
  }

  submit(context: TenantContext, id: string, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const { t, access } = await terminationFor(scope, id, true)
      needManage(access)
      if (Number(t.version) !== expectedVersion) throw ApiError.versionConflict(Number(t.version))
      if (t.status !== 'DRAFT') wrongState('Só um processo em rascunho se submete.')
      fail(await blockers(scope, t))
      await scope.trx.rawQuery(
        `update employee_terminations set status = 'PENDING_APPROVAL', submitted_by = ?, submitted_at = now(),
           decision_note = null, version = version + 1, updated_by = ?, updated_at = now()
         where tenant_id = ? and id = ?`,
        [context.userId, context.userId, context.tenantId, id]
      )
      await audit(scope, {
        action: 'hr.termination.submitted',
        entityType: 'employee_termination',
        entityId: id,
        changes: { status: { from: 'DRAFT', to: 'PENDING_APPROVAL' } },
        metadata: { code: t.code },
      })
      return this.view(scope, id)
    })
  }

  /**
   * Decisão. Aprovar termina o contrato, fecha a colocação em vigor, passa o colaborador a "cessou funções" e encerra
   * o saldo de férias do ano (os dias pagos estão na liquidação). Rejeitar devolve o processo a rascunho com a nota.
   */
  decide(
    context: TenantContext,
    id: string,
    input: { approve: boolean; note?: string | null },
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const { t, access } = await terminationFor(scope, id, true)
      if (!access.approve)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não aprova cessações deste colaborador.')
      if (Number(t.version) !== expectedVersion) throw ApiError.versionConflict(Number(t.version))
      if (t.status !== 'PENDING_APPROVAL') wrongState('O processo não está por aprovar.')
      if (t.created_by === context.userId || t.submitted_by === context.userId)
        throw ApiError.forbidden(
          'SEGREGATION',
          'Quem preparou ou submeteu a cessação não a pode decidir.'
        )
      const note = input.note?.trim() || null
      if (!input.approve) {
        if (!note)
          fail([{ path: 'note', code: 'REQUIRED', message: 'Indique o motivo da devolução.' }])
        await scope.trx.rawQuery(
          `update employee_terminations set status = 'DRAFT', submitted_by = null, submitted_at = null,
             decision_note = ?, version = version + 1, updated_by = ?, updated_at = now()
           where tenant_id = ? and id = ?`,
          [note, context.userId, context.tenantId, id] as never[]
        )
        await audit(scope, {
          action: 'hr.termination.returned',
          entityType: 'employee_termination',
          entityId: id,
          changes: { status: { from: 'PENDING_APPROVAL', to: 'DRAFT' } },
          metadata: { code: t.code },
        })
        return this.view(scope, id)
      }
      fail(await blockers(scope, t))
      const tenant = context.tenantId
      const last = t.last_text as string
      const reasonText = `Cessação ${t.code}: ${REASON_LABEL[t.reason as TerminationReason]}`
      // Contrato: termina no último dia.
      const c = await scope.trx.rawQuery(
        `select status from employment_contracts where tenant_id = ? and id = ? for update`,
        [tenant, t.contract_id]
      )
      await scope.trx.rawQuery(
        `update employment_contracts set status = 'ENDED', termination_date = ?, termination_reason = ?,
           suspended_from = null, version = version + 1, updated_by = ?, updated_at = now()
         where tenant_id = ? and id = ?`,
        [last, reasonText, context.userId, tenant, t.contract_id]
      )
      await contractEvent(scope, t.contract_id, 'TERMINATED', last, reasonText)
      await audit(scope, {
        action: 'hr.contract.terminated',
        entityType: 'employment_contract',
        entityId: t.contract_id,
        changes: { status: { from: (c.rows[0] as { status: string }).status, to: 'ENDED' } },
        metadata: { date: last, terminationId: id, code: t.code },
      })
      // Colocação em vigor: fecha no último dia (as futuras, se houver, deixam de valer).
      await scope.trx.rawQuery(
        `update employment_assignments set valid_to = ?::date, version = version + 1, updated_by = ?,
           updated_at = now()
         where tenant_id = ? and employee_id = ? and valid_from <= ?::date
           and (valid_to is null or valid_to > ?::date)`,
        [last, context.userId, tenant, t.employee_id, last, last]
      )
      // Colaborador: cessou funções.
      await scope.trx.rawQuery(
        `update employees set status = 'TERMINATED', version = version + 1, updated_by = ?, updated_at = now()
          where tenant_id = ? and id = ?`,
        [context.userId, tenant, t.employee_id]
      )
      await audit(scope, {
        action: 'hr.employee.terminated',
        entityType: 'employee',
        entityId: t.employee_id,
        changes: { status: { from: t.employee_status, to: 'TERMINATED' } },
        metadata: { terminationId: id, code: t.code, lastWorkingDay: last },
      })
      // Férias: o saldo do ano fecha; os dias pagos vão na liquidação.
      const lines = await linesOf(scope, id)
      const paid = lines
        .filter((l) => VACATION_KINDS.includes(l.kind as any) && l.quantity)
        .reduce((a, l) => a + (scaled(l.quantity, 2) ?? 0n), 0n)
      const adjusted = await closeLeaveBalance(
        scope,
        t.employee_id,
        Number(last.slice(0, 4)),
        last,
        `Saldo encerrado na cessação ${t.code} (${daysText(paid)} dias na liquidação final)`
      )
      // Empréstimos em curso: a checklist garante que ficam tratados.
      if ((await outstandingLoans(scope, t.employee_id)).length) {
        const has = await scope.trx.rawQuery(
          `select 1 from termination_tasks where tenant_id = ? and termination_id = ? and kind = 'LOANS'`,
          [tenant, id]
        )
        if (!has.rows.length)
          await addTask(scope, id, {
            category: 'FINANCE',
            kind: 'LOANS',
            title: 'Liquidar os adiantamentos e empréstimos em curso',
          })
      }
      await scope.trx.rawQuery(
        `update employee_terminations set status = 'APPROVED', decided_by_membership_id = ?, decided_at = now(),
           decision_note = ?, version = version + 1, updated_by = ?, updated_at = now()
         where tenant_id = ? and id = ?`,
        [context.membershipId, note, context.userId, tenant, id] as never[]
      )
      await audit(scope, {
        action: 'hr.termination.approved',
        entityType: 'employee_termination',
        entityId: id,
        changes: { status: { from: 'PENDING_APPROVAL', to: 'APPROVED' } },
        metadata: {
          code: t.code,
          lastWorkingDay: last,
          leaveDaysAdjusted: daysText(adjusted),
          settlementLines: lines.length,
        },
      })
      return this.view(scope, id)
    })
  }

  cancel(context: TenantContext, id: string, reason: string | null, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const { t, access } = await terminationFor(scope, id, true)
      needManage(access)
      if (Number(t.version) !== expectedVersion) throw ApiError.versionConflict(Number(t.version))
      if (!['DRAFT', 'PENDING_APPROVAL'].includes(t.status))
        wrongState('Uma cessação aprovada já produziu efeitos: não se cancela.')
      const why = reason?.trim() || null
      if (!why) fail([{ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo.' }])
      await scope.trx.rawQuery(
        `update employee_terminations set status = 'CANCELLED', cancel_reason = ?, version = version + 1,
           updated_by = ?, updated_at = now() where tenant_id = ? and id = ?`,
        [why, context.userId, context.tenantId, id] as never[]
      )
      await audit(scope, {
        action: 'hr.termination.cancelled',
        entityType: 'employee_termination',
        entityId: id,
        changes: { status: { from: t.status, to: 'CANCELLED' } },
        metadata: { code: t.code },
      })
      return { id, status: 'CANCELLED' }
    })
  }

  /**
   * Gera o lote EXTRA da liquidação final (no primeiro mês aberto desde o do último dia ou o corrente), com uma entrada
   * por componente. Exige também `hr.payroll.manage` na entidade legal. Se o lote anterior foi cancelado, gera outro.
   */
  settlement(context: TenantContext, id: string, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const { t, access } = await terminationFor(scope, id, true)
      needManage(access)
      if (Number(t.version) !== expectedVersion) throw ApiError.versionConflict(Number(t.version))
      if (t.status !== 'APPROVED') wrongState('A liquidação gera-se depois da aprovação.')
      if (t.settlement_run_id && t.run_status !== 'CANCELLED')
        wrongState(`A liquidação já está no lote ${t.run_code}.`)
      const pay = entityAccess(await payScopes(scope), t.legal_entity_id)
      if (!pay.manage)
        throw ApiError.forbidden(
          'OUT_OF_SCOPE',
          'Gerar a liquidação exige também gerir o processamento salarial desta entidade legal.'
        )
      const lines = await linesOf(scope, id)
      if (!lines.length) wrongState('A liquidação não tem linhas.')
      // Primeiro mês aberto a partir do mês do último dia (ou do corrente, se posterior).
      const lastMonth = `${(t.last_text as string).slice(0, 7)}-01`
      const nowMonth = `${today().slice(0, 7)}-01`
      let period = lastMonth > nowMonth ? lastMonth : nowMonth
      let p = await periodRow(scope, t.legal_entity_id, period, true)
      for (let i = 0; i < 12 && p!.status !== 'OPEN'; i++) {
        period = addMonths(period, 1)
        p = await periodRow(scope, t.legal_entity_id, period, true)
      }
      if (p!.status !== 'OPEN')
        throw ApiError.conflict('PERIOD_CLOSED', `O mês ${monthLabel(period)} já está fechado.`)
      const code = await nextRunCode(scope, period)
      const r = await scope.trx.rawQuery(
        `insert into payroll_runs (tenant_id, period_id, code, kind, description, created_by, updated_by)
         values (?, ?, ?, 'EXTRA', ?, ?, ?) returning id`,
        [
          context.tenantId,
          p!.id,
          code,
          `Liquidação final ${t.code} — ${t.employee_code}`.slice(0, 200),
          context.userId,
          context.userId,
        ]
      )
      const runId = (r.rows[0] as { id: string }).id
      const byComponent = new Map<string, bigint>()
      for (const l of lines)
        byComponent.set(
          l.component.id,
          (byComponent.get(l.component.id) ?? 0n) + (scaled(l.amount, 2) ?? 0n)
        )
      for (const [componentId, amount] of byComponent)
        await scope.trx.rawQuery(
          `insert into payroll_run_inputs (tenant_id, run_id, employee_id, component_id, amount, note, created_by,
             updated_by) values (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            context.tenantId,
            runId,
            t.employee_id,
            componentId,
            moneyText(amount),
            `Liquidação final ${t.code}`,
            context.userId,
            context.userId,
          ]
        )
      await scope.trx.rawQuery(
        `update employee_terminations set settlement_run_id = ?, version = version + 1, updated_by = ?,
           updated_at = now() where tenant_id = ? and id = ?`,
        [runId, context.userId, context.tenantId, id]
      )
      await audit(scope, {
        action: 'hr.payroll.run_created',
        entityType: 'payroll_run',
        entityId: runId,
        metadata: {
          code,
          kind: 'EXTRA',
          legalEntityId: t.legal_entity_id,
          period,
          terminationId: id,
        },
      })
      await audit(scope, {
        action: 'hr.termination.settlement_generated',
        entityType: 'employee_termination',
        entityId: id,
        metadata: { code: t.code, runCode: code, components: byComponent.size },
      })
      return this.view(scope, id)
    })
  }

  /** Conclui: checklist tratada e, havendo liquidação, lote fechado. Depois disto nada muda. */
  complete(context: TenantContext, id: string, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const { t, access } = await terminationFor(scope, id, true)
      needManage(access)
      if (Number(t.version) !== expectedVersion) throw ApiError.versionConflict(Number(t.version))
      if (t.status !== 'APPROVED') wrongState('Só um processo aprovado se conclui.')
      const issues: ErrorDetail[] = []
      const pending = (await tasksOf(scope, id)).filter((k) => k.status === 'PENDING')
      if (pending.length)
        issues.push({
          path: 'tasks',
          code: 'TASKS_PENDING',
          message: `Faltam ${pending.length} tarefa(s) da checklist de saída.`,
        })
      const lines = await linesOf(scope, id)
      if (lines.length && (!t.settlement_run_id || t.run_status !== 'CLOSED'))
        issues.push({
          path: 'settlement',
          code: 'SETTLEMENT_OPEN',
          message: 'A liquidação final tem de estar processada num lote fechado.',
        })
      fail(issues)
      await scope.trx.rawQuery(
        `update employee_terminations set status = 'SETTLED', settled_by = ?, settled_at = now(),
           version = version + 1, updated_by = ?, updated_at = now() where tenant_id = ? and id = ?`,
        [context.userId, context.userId, context.tenantId, id]
      )
      await audit(scope, {
        action: 'hr.termination.settled',
        entityType: 'employee_termination',
        entityId: id,
        changes: { status: { from: 'APPROVED', to: 'SETTLED' } },
        metadata: { code: t.code },
      })
      return this.view(scope, id)
    })
  }

  addTask(
    context: TenantContext,
    id: string,
    input: Record<string, unknown>,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const { t, access } = await terminationFor(scope, id, true)
      needManage(access)
      if (Number(t.version) !== expectedVersion) throw ApiError.versionConflict(Number(t.version))
      if (!['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(t.status))
        wrongState('O processo já não aceita tarefas.')
      const { values: v, issues } = normalizeFields(input, {
        title: { kind: 'text', min: 3, max: 200, label: 'Tarefa' },
      })
      if (!v.title && !issues.length)
        issues.push({ path: 'title', code: 'REQUIRED', message: 'Obrigatório.' })
      if (!TASK_CATEGORIES.includes(input.category as any))
        issues.push({ path: 'category', code: 'INVALID', message: 'Categoria inválida.' })
      fail(issues)
      await addTask(scope, id, {
        category: input.category as string,
        kind: 'MANUAL',
        title: v.title as string,
      })
      await bump(scope, id)
      await audit(scope, {
        action: 'hr.termination.task_added',
        entityType: 'employee_termination',
        entityId: id,
        metadata: { code: t.code, category: input.category, title: v.title },
      })
      return this.view(scope, id)
    })
  }

  /**
   * Estado de uma tarefa da checklist. As de sistema verificam o facto: o acesso só fica feito com a conta do
   * colaborador suspensa ou revogada; os empréstimos, sem prestações por liquidar.
   */
  setTask(
    context: TenantContext,
    taskId: string,
    input: { status: string; notes?: string | null },
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      if (!isUuid(taskId)) throw ApiError.notFound()
      const k = await scope.trx.rawQuery(
        `select * from termination_tasks where tenant_id = ? and id = ? for update`,
        [context.tenantId, taskId]
      )
      const task = k.rows[0] as any
      if (!task) throw ApiError.notFound()
      const { t, access } = await terminationFor(scope, task.termination_id, true)
      needManage(access)
      if (Number(task.version) !== expectedVersion)
        throw ApiError.versionConflict(Number(task.version))
      if (!['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(t.status))
        wrongState('O processo já não aceita alterações.')
      if (!TASK_STATUSES.includes(input.status as any))
        fail([{ path: 'status', code: 'INVALID', message: 'Estado inválido.' }])
      const notes = input.notes?.trim() || null
      if (notes && notes.length > 1000)
        fail([{ path: 'notes', code: 'LENGTH', message: 'Notas: até 1000 caracteres.' }])
      if (input.status === 'NOT_APPLICABLE' && !notes && task.kind !== 'MANUAL')
        fail([{ path: 'notes', code: 'REQUIRED', message: 'Indique porque não se aplica.' }])
      if (input.status === 'DONE' && task.kind === 'SYSTEM_ACCESS' && t.membership_id) {
        const m = await scope.trx.rawQuery(
          `select status from tenant_memberships where tenant_id = ? and id = ?`,
          [context.tenantId, t.membership_id]
        )
        const st = (m.rows[0] as { status: string } | undefined)?.status
        if (st !== 'SUSPENDED' && st !== 'REVOKED')
          throw ApiError.conflict(
            'ACCESS_ACTIVE',
            'A conta do colaborador ainda está activa: suspenda-a em Membros primeiro.'
          )
      }
      if (input.status === 'DONE' && task.kind === 'LOANS') {
        const due = (await outstandingLoans(scope, t.employee_id)).filter(
          (l) => (scaled(l.outstanding, 2) ?? 0n) > 0n
        )
        if (due.length)
          throw ApiError.conflict(
            'LOANS_OUTSTANDING',
            `Ainda há valores por liquidar: ${due
              .map((l) => `${l.code} (${moneyLabel(scaled(l.outstanding, 2) ?? 0n)})`)
              .join(', ')}.`
          )
      }
      await scope.trx.rawQuery(
        `update termination_tasks set status = ?, notes = ?, completed_by = ?, completed_at = ?,
           version = version + 1, updated_by = ?, updated_at = now() where tenant_id = ? and id = ?`,
        [
          input.status,
          notes,
          input.status === 'PENDING' ? null : context.userId,
          input.status === 'PENDING' ? null : new Date(),
          context.userId,
          context.tenantId,
          taskId,
        ] as never[]
      )
      await audit(scope, {
        action: 'hr.termination.task',
        entityType: 'employee_termination',
        entityId: t.id,
        changes: { [task.title]: { from: task.status, to: input.status } },
        metadata: { code: t.code, taskId, kind: task.kind },
      })
      return this.view(scope, t.id)
    })
  }
}

/** Documentos da cessação (anexos): o mesmo acesso do processo; concluído ou cancelado, só leitura. */
export async function terminationAccess(scope: TenantScope, id: string) {
  const t = await findTermination(scope, id)
  if (!t) return null
  const a = accessTo(await termScopes(scope), t, scope.context.membershipId)
  if (!a) return null
  return { read: true, write: a.manage && !['SETTLED', 'CANCELLED'].includes(t.status) }
}
