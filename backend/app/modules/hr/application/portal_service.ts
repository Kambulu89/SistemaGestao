import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { employeeView, findRow } from '#modules/hr/application/employee_service'
import { contractTermsAt } from '#modules/hr/application/career_service'
import { teamLeave } from '#modules/hr/application/leave_service'
import { normalizeEmployee } from '#modules/hr/domain/employee'

/*
 * Portais (7.12).
 *
 *  - O meu espaço: a ficha ligada à conta do actor (com os seus dados pessoais; IBAN mascarado), contratos e condições
 *    em vigor, empréstimos e certificados. O próprio actualiza só contactos e contacto de emergência (auditado, sem os
 *    valores). Férias e recibos vêm dos endpoints próprios (`leave/me`, `payslips`).
 *  - A minha equipa: quem tem a ficha como chefia directa (e as equipas abaixo, até 5 níveis) vê dados básicos da equipa
 *    — cargo, departamento, estado, ausências (tipo confidencial mascarado), fim de contrato e certificados a expirar —
 *    e os pedidos de ausência pendentes, com a indicação de quais pode decidir (a regra é a do 7.4). Nunca salários
 *    nem dados pessoais.
 */

const today = () => new Date().toISOString().slice(0, 10)
const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`)
  x.setUTCDate(x.getUTCDate() + n)
  return x.toISOString().slice(0, 10)
}
const RESERVED = '[RESERVADO]'
/** Campos que o próprio pode actualizar no portal. */
export const SELF_FIELDS = [
  'personalEmail',
  'personalPhone',
  'addressLine',
  'city',
  'province',
  'countryCode',
  'emergencyName',
  'emergencyPhone',
  'emergencyRelation',
] as const
const COLUMNS: Record<(typeof SELF_FIELDS)[number], string> = {
  personalEmail: 'personal_email',
  personalPhone: 'personal_phone',
  addressLine: 'address_line',
  city: 'city',
  province: 'province',
  countryCode: 'country_code',
  emergencyName: 'emergency_name',
  emergencyPhone: 'emergency_phone',
  emergencyRelation: 'emergency_relation',
}
const MAX: Record<string, number> = {
  addressLine: 200,
  city: 80,
  province: 80,
  emergencyName: 160,
  emergencyRelation: 60,
}

/** IBAN mascarado: só os últimos 4 caracteres. */
export function maskIban(iban: string | null) {
  if (!iban) return null
  const clean = iban.replace(/\s/g, '')
  return `${'•'.repeat(Math.max(0, clean.length - 4))}${clean.slice(-4)}`
}

async function ownEmployeeId(scope: TenantScope) {
  const r = await scope.trx.rawQuery(
    `select id from employees where tenant_id = ? and membership_id = ?`,
    [scope.context.tenantId, scope.context.membershipId]
  )
  const row = r.rows[0] as { id: string } | undefined
  if (!row)
    throw new ApiError(404, 'NOT_LINKED', 'A sua conta não está ligada a uma ficha de colaborador.')
  return row.id
}

async function ownContracts(scope: TenantScope, employeeId: string) {
  const r = await scope.trx.rawQuery(
    `select id, code, contract_type, status, currency, start_date::text as start_text, end_date::text as end_text,
        probation_end_date::text as probation_text, termination_date::text as termination_text
       from employment_contracts where tenant_id = ? and employee_id = ? and status <> 'CANCELLED'
      order by start_date desc`,
    [scope.context.tenantId, employeeId]
  )
  return (r.rows as any[]).map((c) => ({
    id: c.id as string,
    code: c.code as string,
    contractType: c.contract_type as string,
    status: c.status as string,
    currency: c.currency as string,
    startDate: c.start_text as string,
    endDate: (c.end_text as string) ?? null,
    probationEndDate: (c.probation_text as string) ?? null,
    terminationDate: (c.termination_text as string) ?? null,
  }))
}

export class PortalService {
  /** O meu espaço: só a própria ficha. */
  me(context: TenantContext) {
    return runInTenant(context, async (scope) => {
      const id = await ownEmployeeId(scope)
      const row = await findRow(scope, id)
      const profile = employeeView(row, true) as ReturnType<typeof employeeView> &
        Record<string, unknown>
      const contracts = await ownContracts(scope, id)
      const terms = await contractTermsAt(scope, id, today())
      const loans = await scope.trx.rawQuery(
        `select l.id, l.code, l.kind, l.status, l.currency, l.principal::text as principal,
            coalesce(sum(i.amount) filter (where i.status = 'PENDING'), 0)::text as outstanding
           from employee_loans l
           left join employee_loan_installments i on i.tenant_id = l.tenant_id and i.loan_id = l.id
          where l.tenant_id = ? and l.employee_id = ? and l.status not in ('CANCELLED','REJECTED')
          group by l.id order by l.created_at desc`,
        [context.tenantId, id]
      )
      const certs = await scope.trx.rawQuery(
        `select id, name, issuer, number, issued_on::text as issued_text, expires_on::text as expires_text
           from employee_certificates where tenant_id = ? and employee_id = ? order by issued_on desc`,
        [context.tenantId, id]
      )
      return {
        profile: { ...profile, bankIban: maskIban(profile.bankIban as string | null) },
        contracts,
        currentTerms: terms
          ? {
              contractId: terms.contractId,
              currency: terms.currency,
              baseSalary: (terms as any).baseSalary ?? null,
              weeklyHours: (terms as any).weeklyHours ?? null,
              workSchedule: (terms as any).workSchedule ?? null,
              endDate: (terms as any).endDate ?? null,
            }
          : null,
        loans: (loans.rows as any[]).map((l) => ({
          id: l.id as string,
          code: l.code as string,
          kind: l.kind as string,
          status: l.status as string,
          currency: l.currency as string,
          principal: l.principal as string,
          outstanding: l.outstanding as string,
        })),
        certificates: (certs.rows as any[]).map((c) => ({
          id: c.id as string,
          name: c.name as string,
          issuer: c.issuer as string,
          number: (c.number as string) ?? null,
          issuedOn: c.issued_text as string,
          expiresOn: (c.expires_text as string) ?? null,
        })),
        selfEditable: SELF_FIELDS,
      }
    })
  }

  /** O próprio actualiza contactos pessoais e de emergência; a auditoria guarda só os nomes dos campos. */
  updateContacts(context: TenantContext, input: Record<string, unknown>, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const id = await ownEmployeeId(scope)
      const row = await findRow(scope, id, true)
      if (Number(row.version) !== expectedVersion)
        throw ApiError.versionConflict(Number(row.version))
      const others = Object.keys(input).filter(
        (k) => !(SELF_FIELDS as readonly string[]).includes(k)
      )
      if (others.length)
        throw new ApiError(
          403,
          'NOT_SELF_EDITABLE',
          'Estes dados só os recursos humanos alteram.',
          others.map((path) => ({ path, code: 'NOT_SELF_EDITABLE', message: 'Peça aos RH.' }))
        )
      const { values, issues } = normalizeEmployee(input, today(), () => true)
      const extra: ErrorDetail[] = []
      for (const [k, max] of Object.entries(MAX))
        if (typeof values[k] === 'string' && (values[k] as string).length > max)
          extra.push({ path: k, code: 'LENGTH', message: `Até ${max} caracteres.` })
      if (issues.length || extra.length) throw ApiError.validation([...issues, ...extra])
      const changed = SELF_FIELDS.filter(
        (k) => k in values && (values[k] ?? null) !== (row[COLUMNS[k]] ?? null)
      )
      if (changed.length) {
        await scope.trx.rawQuery(
          `update employees set ${changed.map((k) => `${COLUMNS[k]} = ?`).join(', ')}, version = version + 1,
             updated_by = ?, updated_at = now() where tenant_id = ? and id = ?`,
          [
            ...changed.map((k) => values[k] ?? null),
            context.userId,
            context.tenantId,
            id,
          ] as never[]
        )
        await audit(scope, {
          action: 'hr.employee.self_updated',
          entityType: 'employee',
          entityId: id,
          changes: Object.fromEntries(changed.map((k) => [k, { from: RESERVED, to: RESERVED }])),
        })
      }
      return employeeView(await findRow(scope, id), true)
    })
  }

  /** A minha equipa (chefia directa e equipas abaixo). */
  team(context: TenantContext) {
    return runInTenant(context, async (scope) => {
      const me = await ownEmployeeId(scope)
      const t = context.tenantId
      const r = await scope.trx.rawQuery(
        `with recursive team as (
           select e.id, 1 as depth from employees e
            where e.tenant_id = ? and e.manager_id = ? and e.status <> 'TERMINATED'
           union
           select e.id, team.depth + 1 from employees e join team on e.manager_id = team.id
            where e.tenant_id = ? and e.status <> 'TERMINATED' and team.depth < 5
         )
         select e.id, e.code, e.full_name, e.status, e.hire_date::text as hire_text, min(team.depth) as depth,
            p.name as position_name, d.name as department_name, m.full_name as manager_name,
            (select c.end_date::text from employment_contracts c where c.tenant_id = e.tenant_id
               and c.employee_id = e.id and c.status in ('ACTIVE','SUSPENDED') limit 1) as contract_end,
            (select c.probation_end_date::text from employment_contracts c where c.tenant_id = e.tenant_id
               and c.employee_id = e.id and c.status in ('ACTIVE','SUSPENDED') limit 1) as probation_end
           from team join employees e on e.tenant_id = ? and e.id = team.id
           left join positions p on p.tenant_id = e.tenant_id and p.id = e.position_id
           left join departments d on d.tenant_id = e.tenant_id and d.id = e.department_id
           left join employees m on m.tenant_id = e.tenant_id and m.id = e.manager_id
          group by e.id, p.name, d.name, m.full_name order by min(team.depth), e.full_name`,
        [t, me, t, t]
      )
      const rows = r.rows as any[]
      const ids = rows.map((x) => x.id as string)
      const now = today()
      const horizon = addDays(now, 30)
      const alertUntil = addDays(now, 60)
      const leave = await teamLeave(scope, ids, now, horizon)
      const certs = ids.length
        ? await scope.trx.rawQuery(
            `select employee_id, name, expires_on::text as expires_text from employee_certificates
              where tenant_id = ? and employee_id = any(?::uuid[]) and expires_on between ?::date and ?::date
              order by expires_on`,
            [t, ids, now, alertUntil] as never[]
          )
        : { rows: [] }
      const members = rows.map((x) => {
        const mine = leave.filter((l) => l.employee.id === x.id)
        const approved = mine.filter((l) => l.status === 'APPROVED')
        const alerts: { kind: string; date: string; label: string }[] = []
        if (x.contract_end && x.contract_end >= now && x.contract_end <= alertUntil)
          alerts.push({ kind: 'CONTRACT_END', date: x.contract_end, label: 'Fim do contrato' })
        if (x.probation_end && x.probation_end >= now && x.probation_end <= alertUntil)
          alerts.push({
            kind: 'PROBATION_END',
            date: x.probation_end,
            label: 'Fim do período experimental',
          })
        for (const cert of (certs.rows as any[]).filter((k) => k.employee_id === x.id))
          alerts.push({
            kind: 'CERTIFICATE',
            date: cert.expires_text,
            label: `Certificado: ${cert.name}`,
          })
        return {
          id: x.id as string,
          code: x.code as string,
          fullName: x.full_name as string,
          status: x.status as string,
          hireDate: x.hire_text as string,
          depth: Number(x.depth),
          positionName: (x.position_name as string) ?? null,
          departmentName: (x.department_name as string) ?? null,
          managerName: (x.manager_name as string) ?? null,
          absentToday: approved.find((l) => l.startDate <= now && l.endDate >= now) ?? null,
          nextAbsence: approved.find((l) => l.startDate > now) ?? null,
          pendingRequests: mine.filter((l) => l.status === 'PENDING').length,
          alerts,
        }
      })
      return {
        members,
        summary: {
          size: members.length,
          direct: members.filter((m) => m.depth === 1).length,
          absentToday: members.filter((m) => m.absentToday).length,
          toDecide: leave.filter((l) => l.canDecide).length,
          alerts: members.reduce((a, m) => a + m.alerts.length, 0),
        },
        pending: leave.filter((l) => l.status === 'PENDING'),
        absences: leave.filter((l) => l.status === 'APPROVED'),
        horizon,
      }
    })
  }
}
