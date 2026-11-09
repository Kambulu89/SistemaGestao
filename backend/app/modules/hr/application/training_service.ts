import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { constraintOf, isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope, type PermissionScope } from '#modules/rbac/index'
import { covers, findRow, placementOf, scopeClause } from '#modules/hr/application/employee_service'
import { cents, normalizeFields } from '#modules/hr/domain/recruitment'
import { moneyText } from '#modules/hr/domain/compensation'

/*
 * Formação (7.10). Catálogo de competências e cursos: `hr.training.settings` (rota). Sessões: qualquer
 * `hr.training.*` vê; `hr.training.manage` prepara, inscreve, regista resultados e conclui. As inscrições, competências e
 * certificados de cada colaborador seguem o âmbito da sua colocação (o próprio vê os seus com OWN). Concluir uma sessão
 * atribui as competências do curso a quem foi aprovado (ou presente, se o curso não tem avaliação) e emite os
 * certificados; depois a sessão não muda.
 */

const noOwn = (s: PermissionScope): PermissionScope => ({ ...s, own: false })
const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
const wrongState = (message: string): never => {
  throw ApiError.conflict('INVALID_STATE', message)
}
const today = () => new Date().toISOString().slice(0, 10)
const addMonths = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() + n)
  return d.toISOString().slice(0, 10)
}

export const COURSE_MODES = ['INTERNAL', 'EXTERNAL', 'ONLINE'] as const
export const ENROLLMENT_RESULTS = ['ATTENDED', 'PASSED', 'FAILED', 'NO_SHOW', 'CANCELLED'] as const

interface TrainingScopes {
  read: PermissionScope
  manage: PermissionScope
  settings: PermissionScope
}

async function trainingScopes(scope: TenantScope): Promise<TrainingScopes> {
  const read = await permissionScope(scope, 'hr.training.read')
  const manage = await permissionScope(scope, 'hr.training.manage')
  const settings = await permissionScope(scope, 'hr.training.settings')
  return { read, manage, settings }
}

const anyScope = (p: PermissionScope) =>
  p.tenant || p.own || p.legalEntityIds.size > 0 || p.branchIds.size > 0 || p.departmentIds.size > 0

async function employeeFor(scope: TenantScope, s: TrainingScopes, id: string) {
  const e = isUuid(id) ? await findRow(scope, id) : null
  if (!e) throw ApiError.notFound()
  const me = scope.context.membershipId
  const place = placementOf(e)
  const manage = covers(noOwn(s.manage), place, me)
  if (!manage && !covers(s.read, place, me)) throw ApiError.notFound()
  return { e, manage }
}

function codeTaken(error: unknown, constraint: string, what: string): never {
  if (constraintOf(error) === constraint)
    throw new ApiError(409, 'CODE_TAKEN', `Já existe ${what} com este código.`, [
      { path: 'code', code: 'CODE_TAKEN', message: 'Código já usado.' },
    ])
  throw error
}

// ---------------------------------------------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------------------------------------------

async function courseCompetencies(scope: TenantScope, courseId: string) {
  const r = await scope.trx.rawQuery(
    `select cc.competency_id, cc.level, c.code, c.name from training_course_competencies cc
       join competencies c on c.tenant_id = cc.tenant_id and c.id = cc.competency_id
      where cc.tenant_id = ? and cc.course_id = ? order by c.name`,
    [scope.context.tenantId, courseId]
  )
  return (r.rows as any[]).map((x) => ({
    competencyId: x.competency_id as string,
    code: x.code as string,
    name: x.name as string,
    level: Number(x.level),
  }))
}

function courseView(c: any, competencies: Awaited<ReturnType<typeof courseCompetencies>>) {
  return {
    id: c.id as string,
    version: Number(c.version),
    code: c.code as string,
    name: c.name as string,
    description: (c.description as string) ?? null,
    mode: c.mode as string,
    provider: (c.provider as string) ?? null,
    durationHours: c.duration_hours as string,
    assessed: Boolean(c.assessed),
    issuesCertificate: Boolean(c.issues_certificate),
    certificateValidityMonths:
      c.certificate_validity_months === null ? null : Number(c.certificate_validity_months),
    status: c.status as string,
    competencies,
  }
}

function competencyLinks(raw: unknown, valid: Set<string>) {
  const issues: ErrorDetail[] = []
  if (!Array.isArray(raw))
    return {
      links: [],
      issues: [{ path: 'competencies', code: 'INVALID', message: 'Lista inválida.' }],
    }
  const seen = new Set<string>()
  const links: { competencyId: string; level: number }[] = []
  raw.forEach((l: any, i: number) => {
    const p = `competencies.${i}`
    if (!isUuid(l?.competencyId) || !valid.has(l.competencyId))
      issues.push({
        path: `${p}.competencyId`,
        code: 'INVALID',
        message: 'Competência inexistente ou inactiva.',
      })
    else if (seen.has(l.competencyId))
      issues.push({
        path: `${p}.competencyId`,
        code: 'DUPLICATE',
        message: 'Competência repetida.',
      })
    else seen.add(l.competencyId)
    if (!Number.isInteger(l?.level) || l.level < 1 || l.level > 5)
      issues.push({ path: `${p}.level`, code: 'INVALID', message: 'Nível de 1 a 5.' })
    if (!issues.some((x) => x.path.startsWith(`${p}.`)))
      links.push({ competencyId: l.competencyId, level: l.level })
  })
  return { links, issues }
}

async function activeCompetencyIds(scope: TenantScope) {
  const r = await scope.trx.rawQuery(
    `select id from competencies where tenant_id = ? and status = 'ACTIVE'`,
    [scope.context.tenantId]
  )
  return new Set((r.rows as any[]).map((x) => x.id as string))
}

function courseInput(input: Record<string, unknown>, creating: boolean) {
  const { values: v, issues } = normalizeFields(input, {
    code: { kind: 'code', label: 'Código' },
    name: { kind: 'text', min: 3, max: 160, label: 'Nome' },
    description: { kind: 'longtext', max: 4000, label: 'Descrição' },
    provider: { kind: 'text', max: 160, label: 'Entidade formadora' },
  })
  if ('mode' in input) {
    if (!COURSE_MODES.includes(input.mode as any))
      issues.push({ path: 'mode', code: 'INVALID', message: 'Interna, externa ou online.' })
    else v.mode = input.mode
  }
  if ('durationHours' in input) {
    const h =
      typeof input.durationHours === 'string'
        ? input.durationHours.trim()
        : String(input.durationHours ?? '')
    if (!/^\d{1,4}(\.\d{1,2})?$/.test(h) || Number(h) <= 0)
      issues.push({
        path: 'durationHours',
        code: 'INVALID',
        message: 'Horas positivas (até 2 casas).',
      })
    else v.durationHours = h
  }
  for (const k of ['assessed', 'issuesCertificate'])
    if (k in input) {
      if (typeof input[k] !== 'boolean')
        issues.push({ path: k, code: 'INVALID', message: 'Sim ou não.' })
      else v[k] = input[k]
    }
  if ('certificateValidityMonths' in input) {
    const m = input.certificateValidityMonths
    if (m === null || m === '') v.certificateValidityMonths = null
    else if (!Number.isInteger(m) || (m as number) < 1 || (m as number) > 240)
      issues.push({
        path: 'certificateValidityMonths',
        code: 'INVALID',
        message: 'De 1 a 240 meses.',
      })
    else v.certificateValidityMonths = m
  }
  if ('status' in input) {
    if (!['ACTIVE', 'INACTIVE'].includes(input.status as string))
      issues.push({ path: 'status', code: 'INVALID', message: 'Activo ou inactivo.' })
    else v.status = input.status
  }
  if (creating)
    for (const k of ['code', 'name', 'mode', 'durationHours'])
      if (v[k] === undefined || v[k] === null)
        if (!issues.some((i) => i.path === k))
          issues.push({ path: k, code: 'REQUIRED', message: 'Obrigatório.' })
  return { values: v, issues }
}

const COURSE_COLUMNS: Record<string, string> = {
  code: 'code',
  name: 'name',
  description: 'description',
  mode: 'mode',
  provider: 'provider',
  durationHours: 'duration_hours',
  assessed: 'assessed',
  issuesCertificate: 'issues_certificate',
  certificateValidityMonths: 'certificate_validity_months',
  status: 'status',
}

export class TrainingCatalogService {
  /** Competências: para quem configura e para quem lida com formação (sem dados de ninguém). */
  competencies(context: TenantContext) {
    return runInTenant(context, async (scope) => {
      const s = await trainingScopes(scope)
      if (!anyScope(s.read) && !anyScope(s.manage) && !anyScope(s.settings))
        throw ApiError.forbidden('FORBIDDEN', 'Sem acesso à formação.')
      const r = await scope.trx.rawQuery(
        `select * from competencies where tenant_id = ? order by status, name`,
        [context.tenantId]
      )
      return (r.rows as any[]).map((c) => ({
        id: c.id as string,
        version: Number(c.version),
        code: c.code as string,
        name: c.name as string,
        description: (c.description as string) ?? null,
        status: c.status as string,
      }))
    })
  }

  saveCompetency(context: TenantContext, id: string | null, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { values: v, issues } = normalizeFields(input, {
        code: { kind: 'code', label: 'Código' },
        name: { kind: 'text', min: 2, max: 160, label: 'Nome' },
        description: { kind: 'longtext', max: 2000, label: 'Descrição' },
      })
      if ('status' in input && !['ACTIVE', 'INACTIVE'].includes(input.status as string))
        issues.push({ path: 'status', code: 'INVALID', message: 'Activa ou inactiva.' })
      if (!id)
        for (const k of ['code', 'name'])
          if (!v[k]) issues.push({ path: k, code: 'REQUIRED', message: 'Obrigatório.' })
      fail(issues)
      const status = (input.status as string) ?? null
      try {
        if (!id) {
          const r = await scope.trx.rawQuery(
            `insert into competencies (tenant_id, code, name, description, created_by, updated_by)
             values (?, ?, ?, ?, ?, ?) returning id`,
            [
              context.tenantId,
              v.code,
              v.name,
              v.description ?? null,
              context.userId,
              context.userId,
            ] as never[]
          )
          id = (r.rows[0] as { id: string }).id
        } else {
          if (!isUuid(id)) throw ApiError.notFound()
          const r = await scope.trx.rawQuery(
            `update competencies set code = coalesce(?, code), name = coalesce(?, name),
               description = case when ? then ? else description end, status = coalesce(?, status),
               version = version + 1, updated_by = ?, updated_at = now() where tenant_id = ? and id = ? returning id`,
            [
              v.code ?? null,
              v.name ?? null,
              'description' in v,
              v.description ?? null,
              status,
              context.userId,
              context.tenantId,
              id,
            ] as never[]
          )
          if (!r.rows.length) throw ApiError.notFound()
        }
      } catch (error) {
        codeTaken(error, 'competencies_code_unique', 'uma competência')
      }
      await audit(scope, {
        action: 'hr.training.competency_saved',
        entityType: 'competency',
        entityId: id!,
        metadata: { code: v.code, status },
      })
      return { id }
    })
  }

  courses(context: TenantContext) {
    return runInTenant(context, async (scope) => {
      const s = await trainingScopes(scope)
      if (!anyScope(s.read) && !anyScope(s.manage) && !anyScope(s.settings))
        throw ApiError.forbidden('FORBIDDEN', 'Sem acesso à formação.')
      const r = await scope.trx.rawQuery(
        `select * from training_courses where tenant_id = ? order by status, name`,
        [context.tenantId]
      )
      const out = []
      for (const c of r.rows as any[])
        out.push(courseView(c, await courseCompetencies(scope, c.id)))
      return out
    })
  }

  saveCourse(context: TenantContext, id: string | null, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      let cur: any = null
      if (id) {
        if (!isUuid(id)) throw ApiError.notFound()
        cur = (
          await scope.trx.rawQuery(
            `select * from training_courses where tenant_id = ? and id = ? for update`,
            [context.tenantId, id]
          )
        ).rows[0]
        if (!cur) throw ApiError.notFound()
      }
      const { values: v, issues } = courseInput(input, !id)
      let links: { competencyId: string; level: number }[] | null = null
      if ('competencies' in input) {
        const l = competencyLinks(input.competencies, await activeCompetencyIds(scope))
        issues.push(...l.issues)
        links = l.links
      }
      const issues2 = () => {
        const issuesCert = (v.issuesCertificate ?? cur?.issues_certificate) as boolean
        const months =
          'certificateValidityMonths' in v
            ? v.certificateValidityMonths
            : cur?.certificate_validity_months
        if (!issuesCert && months !== null && months !== undefined)
          return [
            {
              path: 'certificateValidityMonths',
              code: 'NO_CERTIFICATE',
              message: 'Só com certificado.',
            },
          ]
        return []
      }
      issues.push(...issues2())
      fail(issues)
      const keys = Object.keys(COURSE_COLUMNS).filter((k) => k in v)
      try {
        if (!id) {
          const r = await scope.trx.rawQuery(
            `insert into training_courses (tenant_id, ${keys.map((k) => COURSE_COLUMNS[k]).join(', ')}, created_by,
               updated_by) values (?, ${keys.map(() => '?').join(', ')}, ?, ?) returning id`,
            [context.tenantId, ...keys.map((k) => v[k]), context.userId, context.userId] as never[]
          )
          id = (r.rows[0] as { id: string }).id
        } else if (keys.length)
          await scope.trx.rawQuery(
            `update training_courses set ${keys.map((k) => `${COURSE_COLUMNS[k]} = ?, `).join('')}version = version + 1,
               updated_by = ?, updated_at = now() where tenant_id = ? and id = ?`,
            [...keys.map((k) => v[k]), context.userId, context.tenantId, id] as never[]
          )
      } catch (error) {
        codeTaken(error, 'training_courses_code_unique', 'um curso')
      }
      if (links) {
        await scope.trx.rawQuery(
          `delete from training_course_competencies where tenant_id = ? and course_id = ?`,
          [context.tenantId, id]
        )
        for (const l of links)
          await scope.trx.rawQuery(
            `insert into training_course_competencies (tenant_id, course_id, competency_id, level, created_by,
               updated_by) values (?, ?, ?, ?, ?, ?)`,
            [
              context.tenantId,
              id,
              l.competencyId,
              l.level,
              context.userId,
              context.userId,
            ] as never[]
          )
      }
      await audit(scope, {
        action: cur ? 'hr.training.course_updated' : 'hr.training.course_created',
        entityType: 'training_course',
        entityId: id!,
        metadata: { fields: keys, competencies: links?.length ?? null },
      })
      const c = (
        await scope.trx.rawQuery(`select * from training_courses where tenant_id = ? and id = ?`, [
          context.tenantId,
          id,
        ])
      ).rows[0]
      return courseView(c, await courseCompetencies(scope, id!))
    })
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Sessões e inscrições
// ---------------------------------------------------------------------------------------------------------------

const SESSION_SELECT = `select s.*, s.starts_on::text as start_text, s.ends_on::text as end_text, c.code as course_code,
    c.name as course_name, c.assessed, c.issues_certificate, c.certificate_validity_months, c.provider,
    c.duration_hours, (select count(*)::int from training_enrollments x where x.tenant_id = s.tenant_id
      and x.session_id = s.id and x.status <> 'CANCELLED') as participants
  from training_sessions s join training_courses c on c.tenant_id = s.tenant_id and c.id = s.course_id`

async function findSession(scope: TenantScope, id: string, lock = false) {
  if (!isUuid(id)) return null
  const r = await scope.trx.rawQuery(
    `${SESSION_SELECT} where s.tenant_id = ? and s.id = ?${lock ? ' for update of s' : ''}`,
    [scope.context.tenantId, id]
  )
  return (r.rows[0] as any) ?? null
}

/** Custo por participante: o custo da sessão repartido pelos inscritos não cancelados, ao cêntimo. */
export function costPerHead(total: string | null, participants: number) {
  if (total === null || participants <= 0) return null
  const c = cents(total) ?? 0n
  const n = BigInt(participants)
  return moneyText((c * 2n + n) / (2n * n))
}

function sessionView(s: any) {
  return {
    id: s.id as string,
    version: Number(s.version),
    code: s.code as string,
    course: {
      id: s.course_id as string,
      code: s.course_code as string,
      name: s.course_name as string,
      assessed: Boolean(s.assessed),
      issuesCertificate: Boolean(s.issues_certificate),
      durationHours: s.duration_hours as string,
    },
    startsOn: s.start_text as string,
    endsOn: s.end_text as string,
    location: (s.location as string) ?? null,
    trainer: (s.trainer as string) ?? null,
    capacity: s.capacity === null ? null : Number(s.capacity),
    currency: (s.currency as string) ?? null,
    costTotal: (s.cost_total as string) ?? null,
    participants: Number(s.participants),
    costPerHead: costPerHead(s.cost_total ?? null, Number(s.participants)),
    status: s.status as string,
    completedAt: s.completed_at ?? null,
  }
}

async function nextSessionCode(scope: TenantScope, startsOn: string) {
  const prefix = `FOR-${startsOn.slice(0, 4)}-`
  await scope.trx.rawQuery(`select pg_advisory_xact_lock(hashtext(?))`, [
    `${scope.context.tenantId}:${prefix}`,
  ])
  const r = await scope.trx.rawQuery(
    `select coalesce(max(substring(code from ${prefix.length + 1})::int), 0) + 1 as n from training_sessions
      where tenant_id = ? and code like ? and substring(code from ${prefix.length + 1}) ~ '^[0-9]+$'`,
    [scope.context.tenantId, `${prefix}%`]
  )
  return `${prefix}${String((r.rows[0] as { n: number }).n).padStart(4, '0')}`
}

function sessionInput(input: Record<string, unknown>) {
  const { values: v, issues } = normalizeFields(input, {
    courseId: { kind: 'uuid', label: 'Curso' },
    startsOn: { kind: 'date', label: 'Início' },
    endsOn: { kind: 'date', label: 'Fim' },
    location: { kind: 'text', max: 200, label: 'Local' },
    trainer: { kind: 'text', max: 160, label: 'Formador' },
    currency: { kind: 'currency', label: 'Moeda' },
    costTotal: { kind: 'money', label: 'Custo' },
    capacity: { kind: 'int', min: 1, max: 10000, label: 'Capacidade' },
  })
  return { values: v, issues }
}

const needManage = (s: TrainingScopes) => {
  if (!anyScope(noOwn(s.manage))) throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere formação.')
}

async function enrollmentsOf(scope: TenantScope, s: TrainingScopes, sessionId: string) {
  const r = await scope.trx.rawQuery(
    `select x.*, e.code as employee_code, e.full_name, e.legal_entity_id, e.branch_id, e.department_id,
        e.membership_id, cert.id as certificate_id
       from training_enrollments x
       join employees e on e.tenant_id = x.tenant_id and e.id = x.employee_id
       left join employee_certificates cert on cert.tenant_id = x.tenant_id and cert.enrollment_id = x.id
      where x.tenant_id = ? and x.session_id = ? order by e.full_name`,
    [scope.context.tenantId, sessionId]
  )
  const me = scope.context.membershipId
  return (r.rows as any[])
    .filter(
      (x) => covers(s.read, placementOf(x), me) || covers(noOwn(s.manage), placementOf(x), me)
    )
    .map((x) => ({
      id: x.id as string,
      version: Number(x.version),
      employee: {
        id: x.employee_id as string,
        code: x.employee_code as string,
        fullName: x.full_name as string,
      },
      status: x.status as string,
      hoursAttended: (x.hours_attended as string) ?? null,
      score: (x.score as string) ?? null,
      notes: (x.notes as string) ?? null,
      certificateId: (x.certificate_id as string) ?? null,
      canManage: covers(noOwn(s.manage), placementOf(x), me),
    }))
}

export class TrainingSessionService {
  list(context: TenantContext, f: { status?: string; limit: number; offset: number }) {
    return runInTenant(context, async (scope) => {
      const s = await trainingScopes(scope)
      if (!anyScope(s.read) && !anyScope(s.manage)) return { items: [], total: 0 }
      const where = ['s.tenant_id = ?']
      const params: unknown[] = [context.tenantId]
      if (f.status) {
        where.push('s.status = ?')
        params.push(f.status)
      }
      const rows = await scope.trx.rawQuery(
        `${SESSION_SELECT} where ${where.join(' and ')} order by s.starts_on desc, s.code desc limit ? offset ?`,
        [...params, f.limit, f.offset] as never[]
      )
      const count = await scope.trx.rawQuery(
        `select count(*)::int as n from training_sessions s where ${where.join(' and ')}`,
        params as never[]
      )
      return {
        items: (rows.rows as any[]).map(sessionView),
        total: (count.rows[0] as { n: number }).n,
      }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const s = await trainingScopes(scope)
      if (!anyScope(s.read) && !anyScope(s.manage)) throw ApiError.notFound()
      const x = await findSession(scope, id)
      if (!x) throw ApiError.notFound()
      return {
        ...sessionView(x),
        enrollments: await enrollmentsOf(scope, s, id),
        competencies: await courseCompetencies(scope, x.course_id),
        access: { manage: anyScope(noOwn(s.manage)) && x.status === 'PLANNED' },
      }
    })
  }

  create(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      needManage(await trainingScopes(scope))
      const { values: v, issues } = sessionInput(input)
      for (const k of ['courseId', 'startsOn', 'endsOn'])
        if (!v[k] && !issues.some((i) => i.path === k))
          issues.push({ path: k, code: 'REQUIRED', message: 'Obrigatório.' })
      if (v.startsOn && v.endsOn && (v.endsOn as string) < (v.startsOn as string))
        issues.push({ path: 'endsOn', code: 'RANGE', message: 'O fim é anterior ao início.' })
      if ((v.costTotal ?? null) !== null && !v.currency)
        issues.push({ path: 'currency', code: 'REQUIRED', message: 'Indique a moeda do custo.' })
      if (v.courseId) {
        const c = (
          await scope.trx.rawQuery(
            `select status from training_courses where tenant_id = ? and id = ?`,
            [context.tenantId, v.courseId] as never[]
          )
        ).rows[0] as any
        if (!c || c.status !== 'ACTIVE')
          issues.push({
            path: 'courseId',
            code: 'INVALID',
            message: 'Curso inexistente ou inactivo.',
          })
      }
      fail(issues)
      const code = await nextSessionCode(scope, v.startsOn as string)
      const r = await scope.trx.rawQuery(
        `insert into training_sessions (tenant_id, course_id, code, starts_on, ends_on, location, trainer, capacity,
           currency, cost_total, created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          context.tenantId,
          v.courseId,
          code,
          v.startsOn,
          v.endsOn,
          v.location ?? null,
          v.trainer ?? null,
          v.capacity ?? null,
          v.costTotal ? v.currency : null,
          v.costTotal ?? null,
          context.userId,
          context.userId,
        ] as never[]
      )
      const id = (r.rows[0] as { id: string }).id
      await audit(scope, {
        action: 'hr.training.session_created',
        entityType: 'training_session',
        entityId: id,
        metadata: {
          code,
          courseId: v.courseId,
          startsOn: v.startsOn,
          costTotal: v.costTotal ?? null,
        },
      })
      return sessionView(await findSession(scope, id))
    })
  }

  /** Inscreve colaboradores (no âmbito de quem gere), sem repetir e dentro da capacidade. */
  enroll(context: TenantContext, id: string, employeeIds: string[], expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const s = await trainingScopes(scope)
      needManage(s)
      const x = await findSession(scope, id, true)
      if (!x) throw ApiError.notFound()
      if (Number(x.version) !== expectedVersion) throw ApiError.versionConflict(Number(x.version))
      if (x.status !== 'PLANNED') wrongState('Só uma sessão planeada recebe inscrições.')
      const issues: ErrorDetail[] = []
      const ids = [...new Set(employeeIds)]
      if (!ids.length)
        issues.push({ path: 'employeeIds', code: 'REQUIRED', message: 'Escolha colaboradores.' })
      if (x.capacity !== null && Number(x.participants) + ids.length > Number(x.capacity))
        issues.push({
          path: 'employeeIds',
          code: 'CAPACITY',
          message: `Capacidade ${x.capacity}: ${Number(x.capacity) - Number(x.participants)} lugar(es) livre(s).`,
        })
      const me = context.membershipId
      for (const [i, eid] of ids.entries()) {
        const e = isUuid(eid) ? await findRow(scope, eid) : null
        if (!e || !covers(noOwn(s.manage), placementOf(e), me))
          issues.push({
            path: `employeeIds.${i}`,
            code: 'OUT_OF_SCOPE',
            message: 'Colaborador fora do seu âmbito.',
          })
        else if (e.status === 'TERMINATED')
          issues.push({
            path: `employeeIds.${i}`,
            code: 'TERMINATED',
            message: `${e.full_name} já cessou funções.`,
          })
      }
      fail(issues)
      for (const eid of ids) {
        const existing = (
          await scope.trx.rawQuery(
            `select id, status from training_enrollments where tenant_id = ? and session_id = ? and employee_id = ?`,
            [context.tenantId, id, eid]
          )
        ).rows[0] as any
        if (existing?.status === 'CANCELLED')
          await scope.trx.rawQuery(
            `update training_enrollments set status = 'ENROLLED', version = version + 1, updated_by = ?,
               updated_at = now() where tenant_id = ? and id = ?`,
            [context.userId, context.tenantId, existing.id]
          )
        else if (!existing)
          await scope.trx.rawQuery(
            `insert into training_enrollments (tenant_id, session_id, employee_id, created_by, updated_by)
             values (?, ?, ?, ?, ?)`,
            [context.tenantId, id, eid, context.userId, context.userId]
          )
      }
      await scope.trx.rawQuery(
        `update training_sessions set version = version + 1, updated_by = ?, updated_at = now()
          where tenant_id = ? and id = ?`,
        [context.userId, context.tenantId, id]
      )
      await audit(scope, {
        action: 'hr.training.enrolled',
        entityType: 'training_session',
        entityId: id,
        metadata: { code: x.code, employeeIds: ids },
      })
      return this.getIn(scope, s, id)
    })
  }

  /** Resultado de um participante (presente, aprovado, reprovado, faltou, cancelado). */
  setResult(
    context: TenantContext,
    enrollmentId: string,
    input: Record<string, unknown>,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const s = await trainingScopes(scope)
      if (!isUuid(enrollmentId)) throw ApiError.notFound()
      const en = (
        await scope.trx.rawQuery(
          `select x.*, e.legal_entity_id, e.branch_id, e.department_id, e.membership_id from training_enrollments x
             join employees e on e.tenant_id = x.tenant_id and e.id = x.employee_id
            where x.tenant_id = ? and x.id = ? for update of x`,
          [context.tenantId, enrollmentId]
        )
      ).rows[0] as any
      if (!en || !covers(noOwn(s.manage), placementOf(en), context.membershipId))
        throw ApiError.notFound()
      if (Number(en.version) !== expectedVersion) throw ApiError.versionConflict(Number(en.version))
      const x = await findSession(scope, en.session_id, true)
      if (x.status !== 'PLANNED') wrongState('A sessão já não está planeada.')
      const issues: ErrorDetail[] = []
      const status = input.status as string
      if (!ENROLLMENT_RESULTS.includes(status as any))
        issues.push({ path: 'status', code: 'INVALID', message: 'Resultado inválido.' })
      else if (status !== 'CANCELLED' && x.start_text > today())
        issues.push({ path: 'status', code: 'NOT_STARTED', message: 'A sessão ainda não começou.' })
      else if (x.assessed && status === 'ATTENDED')
        issues.push({
          path: 'status',
          code: 'ASSESSED',
          message: 'Curso com avaliação: aprovado ou reprovado.',
        })
      else if (!x.assessed && ['PASSED', 'FAILED'].includes(status))
        issues.push({
          path: 'status',
          code: 'NOT_ASSESSED',
          message: 'Curso sem avaliação: presente ou faltou.',
        })
      const { values: v, issues: i2 } = normalizeFields(input, {
        notes: { kind: 'longtext', max: 2000, label: 'Notas' },
      })
      issues.push(...i2)
      const num = (k: string, max: number) => {
        if (!(k in input) || input[k] === null || input[k] === '') return null
        const t = String(input[k]).trim().replace(',', '.')
        if (!/^\d{1,4}(\.\d{1,2})?$/.test(t) || Number(t) > max) {
          issues.push({ path: k, code: 'INVALID', message: `Valor de 0 a ${max}.` })
          return null
        }
        return t
      }
      const hours = num('hoursAttended', Number(x.duration_hours))
      const score = num('score', 100)
      if (score !== null && !x.assessed)
        issues.push({ path: 'score', code: 'NOT_ASSESSED', message: 'Curso sem avaliação.' })
      fail(issues)
      await scope.trx.rawQuery(
        `update training_enrollments set status = ?, hours_attended = ?, score = ?, notes = ?, version = version + 1,
           updated_by = ?, updated_at = now() where tenant_id = ? and id = ?`,
        [
          status,
          hours,
          score,
          v.notes ?? null,
          context.userId,
          context.tenantId,
          enrollmentId,
        ] as never[]
      )
      await audit(scope, {
        action: 'hr.training.result',
        entityType: 'training_session',
        entityId: en.session_id,
        metadata: { employeeId: en.employee_id, status, hours, score },
      })
      return this.getIn(scope, s, en.session_id)
    })
  }

  /**
   * Conclui a sessão: todos os inscritos têm resultado; quem foi aprovado (ou presente, sem avaliação) recebe as
   * competências do curso (só se o nível sobe) e, se o curso o prevê, um certificado com validade.
   */
  complete(context: TenantContext, id: string, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const s = await trainingScopes(scope)
      needManage(s)
      const x = await findSession(scope, id, true)
      if (!x) throw ApiError.notFound()
      if (Number(x.version) !== expectedVersion) throw ApiError.versionConflict(Number(x.version))
      if (x.status !== 'PLANNED') wrongState('A sessão já não está planeada.')
      if (x.end_text > today())
        fail([{ path: 'endsOn', code: 'NOT_ENDED', message: 'A sessão ainda não terminou.' }])
      const all = (
        await scope.trx.rawQuery(
          `select x.*, e.full_name from training_enrollments x join employees e on e.tenant_id = x.tenant_id
             and e.id = x.employee_id where x.tenant_id = ? and x.session_id = ?`,
          [context.tenantId, id]
        )
      ).rows as any[]
      const pending = all.filter((e) => e.status === 'ENROLLED')
      if (pending.length)
        fail(
          pending.map((p) => ({
            path: `enrollments.${p.id}`,
            code: 'NO_RESULT',
            message: `${p.full_name}: falta o resultado.`,
          }))
        )
      const grant = all.filter((e) => e.status === (x.assessed ? 'PASSED' : 'ATTENDED'))
      const links = await courseCompetencies(scope, x.course_id)
      let competenciesGranted = 0
      let certificates = 0
      for (const [i, e] of grant.entries()) {
        for (const l of links) {
          const cur = (
            await scope.trx.rawQuery(
              `select level from employee_competencies where tenant_id = ? and employee_id = ? and competency_id = ?
                order by acquired_on desc, created_at desc limit 1`,
              [context.tenantId, e.employee_id, l.competencyId]
            )
          ).rows[0] as { level: number } | undefined
          if (cur && Number(cur.level) >= l.level) continue
          await scope.trx.rawQuery(
            `insert into employee_competencies (tenant_id, employee_id, competency_id, level, acquired_on, source,
               enrollment_id, created_by, updated_by) values (?, ?, ?, ?, ?, 'TRAINING', ?, ?, ?)`,
            [
              context.tenantId,
              e.employee_id,
              l.competencyId,
              l.level,
              x.end_text,
              e.id,
              context.userId,
              context.userId,
            ]
          )
          competenciesGranted++
        }
        if (x.issues_certificate) {
          await scope.trx.rawQuery(
            `insert into employee_certificates (tenant_id, employee_id, name, issuer, number, issued_on, expires_on,
               enrollment_id, created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              context.tenantId,
              e.employee_id,
              x.course_name,
              x.provider ?? 'Formação interna',
              `${x.code}-${String(i + 1).padStart(3, '0')}`,
              x.end_text,
              x.certificate_validity_months
                ? addMonths(x.end_text, Number(x.certificate_validity_months))
                : null,
              e.id,
              context.userId,
              context.userId,
            ] as never[]
          )
          certificates++
        }
      }
      await scope.trx.rawQuery(
        `update training_sessions set status = 'COMPLETED', completed_by = ?, completed_at = now(),
           version = version + 1, updated_by = ?, updated_at = now() where tenant_id = ? and id = ?`,
        [context.userId, context.userId, context.tenantId, id]
      )
      await audit(scope, {
        action: 'hr.training.session_completed',
        entityType: 'training_session',
        entityId: id,
        metadata: {
          code: x.code,
          participants: all.length,
          granted: grant.length,
          competenciesGranted,
          certificates,
        },
      })
      return this.getIn(scope, s, id)
    })
  }

  cancel(context: TenantContext, id: string, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const s = await trainingScopes(scope)
      needManage(s)
      const x = await findSession(scope, id, true)
      if (!x) throw ApiError.notFound()
      if (Number(x.version) !== expectedVersion) throw ApiError.versionConflict(Number(x.version))
      if (x.status !== 'PLANNED') wrongState('A sessão já não está planeada.')
      await scope.trx.rawQuery(
        `update training_sessions set status = 'CANCELLED', version = version + 1, updated_by = ?, updated_at = now()
          where tenant_id = ? and id = ?`,
        [context.userId, context.tenantId, id]
      )
      await audit(scope, {
        action: 'hr.training.session_cancelled',
        entityType: 'training_session',
        entityId: id,
        metadata: { code: x.code },
      })
      return this.getIn(scope, s, id)
    })
  }

  /** Custos de formação de um ano: por curso e por departamento, para os colaboradores no âmbito de quem pede. */
  costs(context: TenantContext, year: number) {
    return runInTenant(context, async (scope) => {
      const s = await trainingScopes(scope)
      const parts: string[] = []
      const params: unknown[] = []
      for (const p of [s.read, noOwn(s.manage)]) {
        const c = scopeClause(p, context.membershipId)
        if (c) {
          parts.push(c.sql)
          params.push(...c.params)
        }
      }
      if (!parts.length) return { year, byCourse: [], byDepartment: [] }
      const base = `with shares as (
          select x.employee_id, x.status, s.course_id, s.currency, c.name as course_name, c.code as course_code,
            coalesce(x.hours_attended, case when x.status in ('ATTENDED','PASSED','FAILED') then c.duration_hours else 0 end) as hours,
            case when s.cost_total is null then null else s.cost_total / nullif((select count(*) from training_enrollments y
              where y.tenant_id = x.tenant_id and y.session_id = x.session_id and y.status <> 'CANCELLED'), 0) end as share,
            e.department_id
          from training_enrollments x
          join training_sessions s on s.tenant_id = x.tenant_id and s.id = x.session_id
          join training_courses c on c.tenant_id = s.tenant_id and c.id = s.course_id
          join employees e on e.tenant_id = x.tenant_id and e.id = x.employee_id
          where x.tenant_id = ? and x.status <> 'CANCELLED' and s.status <> 'CANCELLED'
            and extract(year from s.starts_on) = ? and (${parts.join(' or ')}))`
      const all = [context.tenantId, year, ...params]
      const byCourse = await scope.trx.rawQuery(
        `${base} select course_code, course_name, currency, count(*)::int as participants,
            sum(hours)::numeric(12,2)::text as hours, round(sum(share), 2)::text as cost
           from shares group by course_code, course_name, currency order by course_name`,
        all as never[]
      )
      const byDepartment = await scope.trx.rawQuery(
        `${base} select d.name as department, sh.currency, count(*)::int as participants,
            sum(sh.hours)::numeric(12,2)::text as hours, round(sum(sh.share), 2)::text as cost
           from shares sh left join departments d on d.tenant_id = ? and d.id = sh.department_id
           group by d.name, sh.currency order by d.name nulls last`,
        [...all, context.tenantId] as never[]
      )
      const map = (r: any) => ({
        participants: Number(r.participants),
        hours: r.hours as string,
        currency: (r.currency as string) ?? null,
        cost: (r.cost as string) ?? null,
      })
      return {
        year,
        byCourse: (byCourse.rows as any[]).map((r) => ({
          code: r.course_code,
          name: r.course_name,
          ...map(r),
        })),
        byDepartment: (byDepartment.rows as any[]).map((r) => ({
          department: r.department ?? null,
          ...map(r),
        })),
      }
    })
  }

  private async getIn(scope: TenantScope, s: TrainingScopes, id: string) {
    const x = await findSession(scope, id)
    return {
      ...sessionView(x),
      enrollments: await enrollmentsOf(scope, s, id),
      competencies: await courseCompetencies(scope, x.course_id),
      access: { manage: anyScope(noOwn(s.manage)) && x.status === 'PLANNED' },
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Ficha do colaborador: formação, competências e certificados
// ---------------------------------------------------------------------------------------------------------------

async function certificatesOf(scope: TenantScope, employeeId: string) {
  const r = await scope.trx.rawQuery(
    `select *, issued_on::text as issued_text, expires_on::text as expires_text from employee_certificates
      where tenant_id = ? and employee_id = ? order by issued_on desc`,
    [scope.context.tenantId, employeeId]
  )
  return (r.rows as any[]).map((c) => ({
    id: c.id as string,
    name: c.name as string,
    issuer: c.issuer as string,
    number: (c.number as string) ?? null,
    issuedOn: c.issued_text as string,
    expiresOn: (c.expires_text as string) ?? null,
    expired: !!c.expires_text && c.expires_text < today(),
    fromTraining: Boolean(c.enrollment_id),
  }))
}

/** Acesso aos documentos de um certificado (anexos): o mesmo da formação do colaborador. */
export async function certificateAccess(scope: TenantScope, id: string) {
  if (!isUuid(id)) return null
  const c = (
    await scope.trx.rawQuery(
      `select employee_id from employee_certificates where tenant_id = ? and id = ?`,
      [scope.context.tenantId, id]
    )
  ).rows[0] as any
  if (!c) return null
  const e = await findRow(scope, c.employee_id)
  if (!e) return null
  const s = await trainingScopes(scope)
  const me = scope.context.membershipId
  const manage = covers(noOwn(s.manage), placementOf(e), me)
  if (!manage && !covers(s.read, placementOf(e), me)) return null
  return { read: true, write: manage }
}

export class EmployeeTrainingService {
  summary(context: TenantContext, employeeId: string) {
    return runInTenant(context, async (scope) => {
      const s = await trainingScopes(scope)
      const { e, manage } = await employeeFor(scope, s, employeeId)
      const enrollments = await scope.trx.rawQuery(
        `select x.id, x.status, x.hours_attended, x.score, s.id as session_id, s.code, s.starts_on::text as start_text,
            s.ends_on::text as end_text, s.status as session_status, c.name as course_name
           from training_enrollments x
           join training_sessions s on s.tenant_id = x.tenant_id and s.id = x.session_id
           join training_courses c on c.tenant_id = s.tenant_id and c.id = s.course_id
          where x.tenant_id = ? and x.employee_id = ? order by s.starts_on desc`,
        [context.tenantId, e.id]
      )
      const comps = await scope.trx.rawQuery(
        `select ec.*, ec.acquired_on::text as acquired_text, c.code, c.name from employee_competencies ec
           join competencies c on c.tenant_id = ec.tenant_id and c.id = ec.competency_id
          where ec.tenant_id = ? and ec.employee_id = ? order by c.name, ec.acquired_on desc, ec.created_at desc`,
        [context.tenantId, e.id]
      )
      const current = new Map<string, any>()
      for (const c of comps.rows as any[])
        if (!current.has(c.competency_id)) current.set(c.competency_id, c)
      return {
        employee: { id: e.id as string, code: e.code as string, fullName: e.full_name as string },
        enrollments: (enrollments.rows as any[]).map((x) => ({
          id: x.id as string,
          sessionId: x.session_id as string,
          sessionCode: x.code as string,
          course: x.course_name as string,
          startsOn: x.start_text as string,
          endsOn: x.end_text as string,
          sessionStatus: x.session_status as string,
          status: x.status as string,
          hoursAttended: (x.hours_attended as string) ?? null,
          score: (x.score as string) ?? null,
        })),
        competencies: [...current.values()].map((c) => ({
          competencyId: c.competency_id as string,
          code: c.code as string,
          name: c.name as string,
          level: Number(c.level),
          acquiredOn: c.acquired_text as string,
          source: c.source as string,
        })),
        history: (comps.rows as any[]).map((c) => ({
          name: c.name as string,
          level: Number(c.level),
          acquiredOn: c.acquired_text as string,
          source: c.source as string,
        })),
        certificates: await certificatesOf(scope, e.id),
        access: { manage },
      }
    })
  }

  /** Avaliação de competência (fora de formação): novo registo no histórico, nunca apaga o anterior. */
  assess(context: TenantContext, employeeId: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const s = await trainingScopes(scope)
      const { e, manage } = await employeeFor(scope, s, employeeId)
      if (!manage)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere a formação deste colaborador.')
      const { values: v, issues } = normalizeFields(input, {
        competencyId: { kind: 'uuid', label: 'Competência' },
        acquiredOn: { kind: 'date', label: 'Data' },
        notes: { kind: 'longtext', max: 2000, label: 'Notas' },
      })
      if (!v.competencyId || !(await activeCompetencyIds(scope)).has(v.competencyId as string))
        issues.push({
          path: 'competencyId',
          code: 'INVALID',
          message: 'Competência inexistente ou inactiva.',
        })
      if (
        !Number.isInteger(input.level) ||
        (input.level as number) < 1 ||
        (input.level as number) > 5
      )
        issues.push({ path: 'level', code: 'INVALID', message: 'Nível de 1 a 5.' })
      if (!v.acquiredOn)
        issues.push({ path: 'acquiredOn', code: 'REQUIRED', message: 'Obrigatório.' })
      else if ((v.acquiredOn as string) > today())
        issues.push({ path: 'acquiredOn', code: 'FUTURE', message: 'A data não pode ser futura.' })
      fail(issues)
      await scope.trx.rawQuery(
        `insert into employee_competencies (tenant_id, employee_id, competency_id, level, acquired_on, source, notes,
           created_by, updated_by) values (?, ?, ?, ?, ?, 'ASSESSMENT', ?, ?, ?)`,
        [
          context.tenantId,
          e.id,
          v.competencyId,
          input.level,
          v.acquiredOn,
          v.notes ?? null,
          context.userId,
          context.userId,
        ] as never[]
      )
      await audit(scope, {
        action: 'hr.training.competency_assessed',
        entityType: 'employee',
        entityId: e.id,
        metadata: { competencyId: v.competencyId, level: input.level },
      })
      return { ok: true }
    })
  }

  /** Certificado obtido fora das sessões da empresa (o ficheiro anexa-se depois). */
  addCertificate(context: TenantContext, employeeId: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const s = await trainingScopes(scope)
      const { e, manage } = await employeeFor(scope, s, employeeId)
      if (!manage)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere a formação deste colaborador.')
      const { values: v, issues } = normalizeFields(input, {
        name: { kind: 'text', min: 2, max: 200, label: 'Nome' },
        issuer: { kind: 'text', min: 2, max: 200, label: 'Entidade emissora' },
        number: { kind: 'text', max: 60, label: 'Número' },
        issuedOn: { kind: 'date', label: 'Emissão' },
        expiresOn: { kind: 'date', label: 'Validade' },
      })
      for (const k of ['name', 'issuer', 'issuedOn'])
        if (!v[k] && !issues.some((i) => i.path === k))
          issues.push({ path: k, code: 'REQUIRED', message: 'Obrigatório.' })
      if (v.issuedOn && (v.issuedOn as string) > today())
        issues.push({ path: 'issuedOn', code: 'FUTURE', message: 'A data não pode ser futura.' })
      if (v.issuedOn && v.expiresOn && (v.expiresOn as string) < (v.issuedOn as string))
        issues.push({
          path: 'expiresOn',
          code: 'RANGE',
          message: 'A validade é anterior à emissão.',
        })
      fail(issues)
      const r = await scope.trx.rawQuery(
        `insert into employee_certificates (tenant_id, employee_id, name, issuer, number, issued_on, expires_on,
           created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          context.tenantId,
          e.id,
          v.name,
          v.issuer,
          v.number ?? null,
          v.issuedOn,
          v.expiresOn ?? null,
          context.userId,
          context.userId,
        ] as never[]
      )
      const id = (r.rows[0] as { id: string }).id
      await audit(scope, {
        action: 'hr.training.certificate_added',
        entityType: 'employee',
        entityId: e.id,
        metadata: { certificateId: id, name: v.name },
      })
      return { id }
    })
  }
}
