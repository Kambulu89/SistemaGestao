import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope, type PermissionScope } from '#modules/rbac/index'
import { covers, findRow, placementOf, scopeClause } from '#modules/hr/application/employee_service'
import { normalizeFields } from '#modules/hr/domain/recruitment'

/*
 * Processos disciplinares (7.10), de acesso restrito: só `hr.discipline.read|manage` no âmbito da colocação do
 * colaborador; as permissões gerais de RH não os mostram, ninguém vê nem trata processos sobre si próprio, e cada
 * consulta de um processo fica na auditoria. A cronologia é só de acréscimo; uma sanção exige o registo prévio da
 * defesa ou audiência do trabalhador; encerrado, o processo não muda. O texto dos factos nunca vai para a auditoria.
 */

export const CASE_CATEGORIES = ['ATTENDANCE', 'CONDUCT', 'PERFORMANCE', 'SAFETY', 'OTHER'] as const
export const CASE_OUTCOMES = [
  'NO_ACTION',
  'VERBAL_WARNING',
  'WRITTEN_WARNING',
  'SUSPENSION',
  'DISMISSAL',
  'OTHER',
] as const
/** Eventos que se registam à mão (as decisões e mudanças de estado vêm das acções). */
export const MANUAL_EVENTS = ['NOTE', 'NOTIFICATION', 'HEARING', 'DEFENCE'] as const

const noOwn = (s: PermissionScope): PermissionScope => ({ ...s, own: false })
const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
const wrongState = (message: string): never => {
  throw ApiError.conflict('INVALID_STATE', message)
}
const today = () => new Date().toISOString().slice(0, 10)

interface DisciplineScopes {
  read: PermissionScope
  manage: PermissionScope
}

async function disciplineScopes(scope: TenantScope): Promise<DisciplineScopes> {
  const read = noOwn(await permissionScope(scope, 'hr.discipline.read'))
  const manage = noOwn(await permissionScope(scope, 'hr.discipline.manage'))
  return { read, manage }
}

/** Acesso a um colaborador para processos disciplinares (nunca o próprio). */
function accessTo(s: DisciplineScopes, e: any, me: string) {
  if (e.membership_id && e.membership_id === me) return null
  const place = placementOf(e)
  const manage = covers(s.manage, place, me)
  const read = manage || covers(s.read, place, me)
  return read ? { read, manage } : null
}

const CASE_SELECT = `select c.*, c.occurred_on::text as occurred_text, c.decided_on::text as decided_text,
    e.code as employee_code, e.full_name as employee_name, e.legal_entity_id, e.branch_id, e.department_id,
    e.membership_id, cu.full_name as created_by_name, du.full_name as decided_by_name
  from disciplinary_cases c
  join employees e on e.tenant_id = c.tenant_id and e.id = c.employee_id
  left join users cu on cu.id = c.created_by
  left join tenant_memberships dm on dm.tenant_id = c.tenant_id and dm.id = c.decided_by_membership_id
  left join users du on du.id = dm.user_id`

async function findCase(scope: TenantScope, id: string, lock = false) {
  if (!isUuid(id)) return null
  const r = await scope.trx.rawQuery(
    `${CASE_SELECT} where c.tenant_id = ? and c.id = ?${lock ? ' for update of c' : ''}`,
    [scope.context.tenantId, id]
  )
  return (r.rows[0] as any) ?? null
}

async function eventsOf(scope: TenantScope, caseId: string) {
  const r = await scope.trx.rawQuery(
    `select ev.*, ev.occurred_on::text as occurred_text, u.full_name as created_by_name
       from disciplinary_events ev left join users u on u.id = ev.created_by
      where ev.tenant_id = ? and ev.case_id = ? order by ev.created_at, ev.occurred_on`,
    [scope.context.tenantId, caseId]
  )
  return (r.rows as any[]).map((x) => ({
    id: x.id as string,
    kind: x.kind as string,
    occurredOn: x.occurred_text as string,
    text: x.text as string,
    createdBy: (x.created_by_name as string) ?? null,
    createdAt: x.created_at,
  }))
}

function caseView(c: any, withDetails: boolean) {
  return {
    id: c.id as string,
    version: Number(c.version),
    code: c.code as string,
    employee: {
      id: c.employee_id as string,
      code: c.employee_code as string,
      fullName: c.employee_name as string,
    },
    occurredOn: c.occurred_text as string,
    category: c.category as string,
    summary: c.summary as string,
    status: c.status as string,
    outcome: (c.outcome as string) ?? null,
    decidedOn: (c.decided_text as string) ?? null,
    decidedBy: (c.decided_by_name as string) ?? null,
    createdBy: (c.created_by_name as string) ?? null,
    createdAt: c.created_at,
    ...(withDetails
      ? {
          description: c.description as string,
          outcomeDetails: (c.outcome_details as string) ?? null,
        }
      : {}),
  }
}

async function caseFor(scope: TenantScope, id: string, lock = false) {
  const c = await findCase(scope, id, lock)
  if (!c) throw ApiError.notFound()
  const a = accessTo(await disciplineScopes(scope), c, scope.context.membershipId)
  if (!a) throw ApiError.notFound()
  return { c, access: a }
}

async function addEvent(
  scope: TenantScope,
  caseId: string,
  kind: string,
  occurredOn: string,
  text: string
) {
  await scope.trx.rawQuery(
    `insert into disciplinary_events (tenant_id, case_id, kind, occurred_on, text, created_by, updated_by)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [
      scope.context.tenantId,
      caseId,
      kind,
      occurredOn,
      text,
      scope.context.userId,
      scope.context.userId,
    ]
  )
}

async function nextCaseCode(scope: TenantScope) {
  const prefix = `DISC-${today().slice(0, 4)}-`
  await scope.trx.rawQuery(`select pg_advisory_xact_lock(hashtext(?))`, [
    `${scope.context.tenantId}:${prefix}`,
  ])
  const r = await scope.trx.rawQuery(
    `select coalesce(max(substring(code from ${prefix.length + 1})::int), 0) + 1 as n from disciplinary_cases
      where tenant_id = ? and code like ? and substring(code from ${prefix.length + 1}) ~ '^[0-9]+$'`,
    [scope.context.tenantId, `${prefix}%`]
  )
  return `${prefix}${String((r.rows[0] as { n: number }).n).padStart(4, '0')}`
}

/** Acesso aos documentos de um processo (anexos): o mesmo do processo; encerrado, só leitura. */
export async function disciplinaryCaseAccess(scope: TenantScope, id: string) {
  const c = await findCase(scope, id)
  if (!c) return null
  const a = accessTo(await disciplineScopes(scope), c, scope.context.membershipId)
  if (!a) return null
  return { read: true, write: a.manage && c.status !== 'CLOSED' }
}

export class DisciplineService {
  list(
    context: TenantContext,
    f: { status?: string; employeeId?: string; limit: number; offset: number }
  ) {
    return runInTenant(context, async (scope) => {
      const s = await disciplineScopes(scope)
      const parts: string[] = []
      const params: unknown[] = []
      for (const p of [s.read, s.manage]) {
        const c = scopeClause(p, context.membershipId)
        if (c) {
          parts.push(c.sql)
          params.push(...c.params)
        }
      }
      if (!parts.length) return { items: [], total: 0, canCreate: false }
      const where = [
        'c.tenant_id = ?',
        `(${parts.join(' or ')})`,
        '(e.membership_id is null or e.membership_id <> ?)',
      ]
      const all: unknown[] = [context.tenantId, ...params, context.membershipId]
      if (f.status) {
        where.push('c.status = ?')
        all.push(f.status)
      }
      if (f.employeeId) {
        where.push('c.employee_id = ?')
        all.push(f.employeeId)
      }
      const clause = where.join(' and ')
      const rows = await scope.trx.rawQuery(
        `${CASE_SELECT} where ${clause} order by c.occurred_on desc, c.created_at desc limit ? offset ?`,
        [...all, f.limit, f.offset] as never[]
      )
      const count = await scope.trx.rawQuery(
        `select count(*)::int as n from disciplinary_cases c join employees e on e.tenant_id = c.tenant_id
           and e.id = c.employee_id where ${clause}`,
        all as never[]
      )
      return {
        items: (rows.rows as any[]).map((c) => caseView(c, false)),
        total: (count.rows[0] as { n: number }).n,
      }
    })
  }

  /** Consulta de um processo: fica registada na auditoria (quem viu, quando). */
  get(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const { c, access } = await caseFor(scope, id)
      await audit(scope, {
        action: 'hr.discipline.viewed',
        entityType: 'disciplinary_case',
        entityId: id,
        metadata: { code: c.code },
      })
      return {
        ...caseView(c, true),
        events: await eventsOf(scope, id),
        access: { manage: access.manage && c.status !== 'CLOSED' },
      }
    })
  }

  create(context: TenantContext, employeeId: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const e = isUuid(employeeId) ? await findRow(scope, employeeId) : null
      if (!e) throw ApiError.notFound()
      if (e.membership_id && e.membership_id === context.membershipId)
        throw ApiError.forbidden('SELF_CASE', 'Ninguém abre nem trata processos sobre si próprio.')
      const a = accessTo(await disciplineScopes(scope), e, context.membershipId)
      if (!a) throw ApiError.notFound()
      if (!a.manage)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere processos deste colaborador.')
      const { values: v, issues } = normalizeFields(input, {
        occurredOn: { kind: 'date', label: 'Data dos factos' },
        summary: { kind: 'text', min: 3, max: 200, label: 'Resumo' },
        description: { kind: 'longtext', min: 10, max: 8000, label: 'Descrição dos factos' },
      })
      if (!CASE_CATEGORIES.includes(input.category as any))
        issues.push({ path: 'category', code: 'INVALID', message: 'Categoria inválida.' })
      for (const k of ['occurredOn', 'summary', 'description'])
        if (!v[k] && !issues.some((i) => i.path === k))
          issues.push({ path: k, code: 'REQUIRED', message: 'Obrigatório.' })
      if (v.occurredOn && (v.occurredOn as string) > today())
        issues.push({ path: 'occurredOn', code: 'FUTURE', message: 'A data não pode ser futura.' })
      fail(issues)
      const code = await nextCaseCode(scope)
      const r = await scope.trx.rawQuery(
        `insert into disciplinary_cases (tenant_id, employee_id, code, occurred_on, category, summary, description,
           created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          context.tenantId,
          e.id,
          code,
          v.occurredOn,
          input.category,
          v.summary,
          v.description,
          context.userId,
          context.userId,
        ] as never[]
      )
      const id = (r.rows[0] as { id: string }).id
      await addEvent(scope, id, 'STATUS', today(), 'Processo aberto.')
      await audit(scope, {
        action: 'hr.discipline.opened',
        entityType: 'disciplinary_case',
        entityId: id,
        metadata: { code, employeeId: e.id, category: input.category },
      })
      return caseView(await findCase(scope, id), true)
    })
  }

  addEvent(
    context: TenantContext,
    id: string,
    input: Record<string, unknown>,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const { c, access } = await caseFor(scope, id, true)
      if (!access.manage)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere processos deste colaborador.')
      if (Number(c.version) !== expectedVersion) throw ApiError.versionConflict(Number(c.version))
      if (c.status === 'CLOSED') wrongState('O processo está encerrado.')
      const { values: v, issues } = normalizeFields(input, {
        occurredOn: { kind: 'date', label: 'Data' },
        text: { kind: 'longtext', min: 3, max: 8000, label: 'Texto' },
      })
      if (!MANUAL_EVENTS.includes(input.kind as any))
        issues.push({ path: 'kind', code: 'INVALID', message: 'Tipo de registo inválido.' })
      for (const k of ['occurredOn', 'text'])
        if (!v[k] && !issues.some((i) => i.path === k))
          issues.push({ path: k, code: 'REQUIRED', message: 'Obrigatório.' })
      if (
        v.occurredOn &&
        ((v.occurredOn as string) > today() || (v.occurredOn as string) < c.occurred_text)
      )
        issues.push({
          path: 'occurredOn',
          code: 'RANGE',
          message: 'Entre a data dos factos e hoje.',
        })
      fail(issues)
      await addEvent(scope, id, input.kind as string, v.occurredOn as string, v.text as string)
      await scope.trx.rawQuery(
        `update disciplinary_cases set version = version + 1, updated_by = ?, updated_at = now()
          where tenant_id = ? and id = ?`,
        [context.userId, context.tenantId, id]
      )
      await audit(scope, {
        action: 'hr.discipline.event',
        entityType: 'disciplinary_case',
        entityId: id,
        metadata: { code: c.code, kind: input.kind },
      })
      return this.view(scope, id, access.manage)
    })
  }

  review(context: TenantContext, id: string, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const { c, access } = await caseFor(scope, id, true)
      if (!access.manage)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere processos deste colaborador.')
      if (Number(c.version) !== expectedVersion) throw ApiError.versionConflict(Number(c.version))
      if (c.status !== 'OPEN') wrongState('Só um processo aberto passa a instrução.')
      await scope.trx.rawQuery(
        `update disciplinary_cases set status = 'UNDER_REVIEW', version = version + 1, updated_by = ?,
           updated_at = now() where tenant_id = ? and id = ?`,
        [context.userId, context.tenantId, id]
      )
      await addEvent(scope, id, 'STATUS', today(), 'Processo em instrução.')
      await audit(scope, {
        action: 'hr.discipline.under_review',
        entityType: 'disciplinary_case',
        entityId: id,
        changes: { status: { from: c.status, to: 'UNDER_REVIEW' } },
        metadata: { code: c.code },
      })
      return this.view(scope, id, access.manage)
    })
  }

  /** Encerra com a decisão. Uma sanção exige registo prévio da defesa ou da audiência do trabalhador. */
  close(
    context: TenantContext,
    id: string,
    input: Record<string, unknown>,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const { c, access } = await caseFor(scope, id, true)
      if (!access.manage)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere processos deste colaborador.')
      if (Number(c.version) !== expectedVersion) throw ApiError.versionConflict(Number(c.version))
      if (c.status === 'CLOSED') wrongState('O processo já está encerrado.')
      const { values: v, issues } = normalizeFields(input, {
        decidedOn: { kind: 'date', label: 'Data da decisão' },
        outcomeDetails: { kind: 'longtext', min: 3, max: 8000, label: 'Fundamentação' },
      })
      if (!CASE_OUTCOMES.includes(input.outcome as any))
        issues.push({ path: 'outcome', code: 'INVALID', message: 'Decisão inválida.' })
      for (const k of ['decidedOn', 'outcomeDetails'])
        if (!v[k] && !issues.some((i) => i.path === k))
          issues.push({ path: k, code: 'REQUIRED', message: 'Obrigatório.' })
      if (
        v.decidedOn &&
        ((v.decidedOn as string) > today() || (v.decidedOn as string) < c.occurred_text)
      )
        issues.push({
          path: 'decidedOn',
          code: 'RANGE',
          message: 'Entre a data dos factos e hoje.',
        })
      if (input.outcome && input.outcome !== 'NO_ACTION') {
        const heard = await scope.trx.rawQuery(
          `select 1 from disciplinary_events where tenant_id = ? and case_id = ? and kind in ('DEFENCE','HEARING') limit 1`,
          [context.tenantId, id]
        )
        if (!heard.rows.length)
          issues.push({
            path: 'outcome',
            code: 'DEFENCE_REQUIRED',
            message: 'Antes de uma sanção, registe a defesa ou a audiência do trabalhador.',
          })
      }
      fail(issues)
      await addEvent(scope, id, 'DECISION', v.decidedOn as string, v.outcomeDetails as string)
      await scope.trx.rawQuery(
        `update disciplinary_cases set status = 'CLOSED', outcome = ?, outcome_details = ?, decided_on = ?,
           decided_by_membership_id = ?, version = version + 1, updated_by = ?, updated_at = now()
         where tenant_id = ? and id = ?`,
        [
          input.outcome,
          v.outcomeDetails,
          v.decidedOn,
          context.membershipId,
          context.userId,
          context.tenantId,
          id,
        ] as never[]
      )
      await audit(scope, {
        action: 'hr.discipline.closed',
        entityType: 'disciplinary_case',
        entityId: id,
        changes: { status: { from: c.status, to: 'CLOSED' } },
        metadata: { code: c.code, outcome: input.outcome },
      })
      return this.view(scope, id, access.manage)
    })
  }

  private async view(scope: TenantScope, id: string, manage: boolean) {
    const c = await findCase(scope, id)
    return {
      ...caseView(c, true),
      events: await eventsOf(scope, id),
      access: { manage: manage && c.status !== 'CLOSED' },
    }
  }
}
