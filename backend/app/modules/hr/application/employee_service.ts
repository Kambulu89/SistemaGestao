import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { constraintOf } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope, type PermissionScope } from '#modules/rbac/index'
import { legalEntityFacts, orgReferenceFacts } from '#modules/organization/index'
import { isValidIban } from '#modules/settings/index'
import {
  type EmployeeStatus,
  GENERAL_FIELDS,
  SENSITIVE_FIELDS,
  SENSITIVE_KEYS,
  STATUS_TRANSITIONS,
  birthBeforeHire,
  employeeChanges,
  normalizeEmployee,
} from '#modules/hr/domain/employee'

/** Onde está o colaborador na estrutura (o que os âmbitos RBAC comparam). */
interface Placement {
  legalEntityId: string
  branchId: string | null
  departmentId: string | null
  membershipId: string | null
}

/** O âmbito cobre o colaborador? `own` só conta quando a ficha está ligada à membership do actor. */
export function covers(s: PermissionScope, e: Placement, membershipId: string) {
  return (
    s.tenant ||
    s.legalEntityIds.has(e.legalEntityId) ||
    (!!e.branchId && s.branchIds.has(e.branchId)) ||
    (!!e.departmentId && s.departmentIds.has(e.departmentId)) ||
    (s.own && !!e.membershipId && e.membershipId === membershipId)
  )
}

/** Filtro SQL equivalente a `covers` (para listas); `null` quando o actor não vê nenhum colaborador. */
export function scopeClause(s: PermissionScope, membershipId: string, alias = 'e') {
  if (s.tenant) return { sql: 'true', params: [] as unknown[] }
  const parts: string[] = []
  const params: unknown[] = []
  const any = (column: string, ids: Set<string>) => {
    if (ids.size === 0) return
    parts.push(`${alias}.${column} = any(?::uuid[])`)
    params.push([...ids])
  }
  any('legal_entity_id', s.legalEntityIds)
  any('branch_id', s.branchIds)
  any('department_id', s.departmentIds)
  if (s.own) {
    parts.push(`${alias}.membership_id = ?`)
    params.push(membershipId)
  }
  return parts.length ? { sql: `(${parts.join(' or ')})`, params } : null
}

const SELECT = `select e.*, e.hire_date::text as hire_date_text, e.birth_date::text as birth_date_text,
    e.id_document_expiry::text as id_document_expiry_text,
    le.code as le_code, le.legal_name as le_name, b.name as branch_name, d.name as department_name,
    p.name as position_name, cc.code as cost_center_code, m.full_name as manager_name, m.code as manager_code
  from employees e
  join legal_entities le on le.tenant_id = e.tenant_id and le.id = e.legal_entity_id
  left join branches b on b.tenant_id = e.tenant_id and b.id = e.branch_id
  left join departments d on d.tenant_id = e.tenant_id and d.id = e.department_id
  left join positions p on p.tenant_id = e.tenant_id and p.id = e.position_id
  left join cost_centers cc on cc.tenant_id = e.tenant_id and cc.id = e.cost_center_id
  left join employees m on m.tenant_id = e.tenant_id and m.id = e.manager_id`

/** Valores da ficha (API) a partir da linha; datas como AAAA-MM-DD. */
function values(r: any): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, column] of Object.entries({ ...GENERAL_FIELDS, ...SENSITIVE_FIELDS }))
    out[key] = r[column] ?? null
  out.hireDate = r.hire_date_text
  out.birthDate = r.birth_date_text ?? null
  out.idDocumentExpiry = r.id_document_expiry_text ?? null
  return out
}

/** Vista da ficha: os campos sensíveis vêm a `null` (e `sensitiveVisible: false`) para quem não os pode ver. */
function view(r: any, sensitive: boolean) {
  const v = values(r)
  if (!sensitive) for (const key of SENSITIVE_KEYS) v[key] = null
  return {
    id: r.id as string,
    version: Number(r.version),
    ...v,
    legalEntity: { code: r.le_code, name: r.le_name },
    branchName: r.branch_name ?? null,
    departmentName: r.department_name ?? null,
    positionName: r.position_name ?? null,
    costCenterCode: r.cost_center_code ?? null,
    manager: r.manager_id ? { code: r.manager_code, fullName: r.manager_name } : null,
    sensitiveVisible: sensitive,
  }
}

const placementOf = (r: any): Placement => ({
  legalEntityId: r.legal_entity_id,
  branchId: r.branch_id,
  departmentId: r.department_id,
  membershipId: r.membership_id,
})

const UNIQUE: Record<string, [string, string, string]> = {
  employees_code_unique: ['code', 'CODE_TAKEN', 'Já existe um colaborador com este código.'],
  employees_tax_id_unique: ['taxId', 'TAX_ID_TAKEN', 'Já existe um colaborador com este NIF.'],
  employees_social_security_unique: [
    'socialSecurityNumber',
    'SOCIAL_SECURITY_TAKEN',
    'Já existe um colaborador com este número de segurança social.',
  ],
  employees_membership_unique: [
    'membershipId',
    'MEMBERSHIP_TAKEN',
    'Este membro já está ligado a outra ficha.',
  ],
}

function mapUnique(error: unknown): never {
  const c = constraintOf(error)
  const u = c ? UNIQUE[c] : undefined
  if (u) throw new ApiError(409, u[1], u[2], [{ path: u[0], code: u[1], message: u[2] }])
  throw error
}

export interface EmployeeListFilter {
  q?: string
  status?: string
  legalEntityId?: string
  branchId?: string
  departmentId?: string
  positionId?: string
  managerId?: string
  sort?: { field: 'code' | 'fullName' | 'hireDate' | 'status'; direction: 'asc' | 'desc' }
  limit: number
  offset: number
}

const SORT_COLUMNS = {
  code: 'e.code',
  fullName: 'e.full_name',
  hireDate: 'e.hire_date',
  status: 'e.status',
} as const
export const EMPLOYEE_SORT_FIELDS = Object.keys(SORT_COLUMNS) as (keyof typeof SORT_COLUMNS)[]

/** Âmbitos das três permissões do RH para o actor (uma consulta por permissão). */
async function scopes(scope: TenantScope) {
  const [read, manage, sensitive] = await Promise.all([
    permissionScope(scope, 'hr.read'),
    permissionScope(scope, 'hr.manage'),
    permissionScope(scope, 'hr.sensitive'),
  ])
  return { read, manage, sensitive }
}

async function findRow(scope: TenantScope, id: string, lock = false) {
  const r = await scope.trx.rawQuery(
    `${SELECT} where e.tenant_id = ? and e.id = ?${lock ? ' for update of e' : ''}`,
    [scope.context.tenantId, id]
  )
  return (r.rows[0] as any) ?? null
}

/**
 * Acesso de leitura/escrita a um colaborador para outros módulos (ex.: anexos, que são documentos pessoais e por isso
 * seguem `hr.sensitive`). `null` = inexistente ou fora do âmbito.
 */
export async function employeeAccess(
  scope: TenantScope,
  id: string,
  kind: 'sensitive' | 'general'
) {
  const row = await findRow(scope, id)
  if (!row) return null
  const s = await scopes(scope)
  const me = scope.context.membershipId
  const place = placementOf(row)
  const read = kind === 'sensitive' ? covers(s.sensitive, place, me) : covers(s.read, place, me)
  if (!read) return null
  const manage = covers({ ...s.manage, own: false }, place, me)
  return { read: true, write: manage && (kind === 'general' || covers(s.sensitive, place, me)) }
}

export class EmployeeService {
  list(context: TenantContext, filter: EmployeeListFilter) {
    return runInTenant(context, async (scope) => {
      const s = await scopes(scope)
      const visible = scopeClause(s.read, context.membershipId)
      if (!visible) return { items: [], total: 0 }
      const where = ['e.tenant_id = ?', visible.sql]
      const params: unknown[] = [context.tenantId, ...visible.params]
      for (const [key, column] of [
        ['status', 'e.status'],
        ['legalEntityId', 'e.legal_entity_id'],
        ['branchId', 'e.branch_id'],
        ['departmentId', 'e.department_id'],
        ['positionId', 'e.position_id'],
        ['managerId', 'e.manager_id'],
      ] as const) {
        const v = filter[key]
        if (v) {
          where.push(`${column} = ?`)
          params.push(v)
        }
      }
      if (filter.q) {
        const like = `%${filter.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
        where.push(
          `(lower(e.code) like ? or lower(e.full_name) like ? or lower(coalesce(e.work_email, '')) like ?)`
        )
        params.push(like, like, like)
      }
      const order = filter.sort
        ? `${SORT_COLUMNS[filter.sort.field]} ${filter.sort.direction === 'desc' ? 'desc' : 'asc'}, e.code`
        : 'e.full_name, e.code'
      const clause = where.join(' and ')
      const rows = await scope.trx.rawQuery(
        `${SELECT} where ${clause} order by ${order} limit ? offset ?`,
        [...params, filter.limit, filter.offset] as never[]
      )
      const count = await scope.trx.rawQuery(
        `select count(*)::int as n from employees e where ${clause}`,
        params as never[]
      )
      return {
        // Nas listas nunca vão dados sensíveis, mesmo para quem os pode ver na ficha.
        items: (rows.rows as any[]).map((r) => view(r, false)),
        total: (count.rows[0] as { n: number }).n,
      }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const row = await findRow(scope, id)
      if (!row) throw ApiError.notFound()
      const s = await scopes(scope)
      const me = context.membershipId
      const place = placementOf(row)
      if (!covers(s.read, place, me)) throw ApiError.notFound()
      const reports = await scope.trx.rawQuery(
        `select count(*)::int as n from employees where tenant_id = ? and manager_id = ? and status <> 'TERMINATED'`,
        [context.tenantId, id]
      )
      return {
        ...view(row, covers(s.sensitive, place, me)),
        directReports: (reports.rows[0] as { n: number }).n,
        access: {
          manage: covers({ ...s.manage, own: false }, place, me),
          sensitive: covers(s.sensitive, place, me),
        },
      }
    })
  }

  create(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { values: v, issues } = this.normalize(input)
      for (const key of ['code', 'fullName', 'legalEntityId', 'hireDate'])
        if (v[key] === undefined || v[key] === null)
          issues.push({ path: key, code: 'REQUIRED', message: 'Obrigatório.' })
      if ('status' in v && v.status !== 'ACTIVE')
        issues.push({
          path: 'status',
          code: 'INVALID',
          message: 'Um colaborador novo fica activo.',
        })
      if (issues.length) throw ApiError.validation(issues)
      const place: Placement = {
        legalEntityId: v.legalEntityId as string,
        branchId: (v.branchId as string) ?? null,
        departmentId: (v.departmentId as string) ?? null,
        membershipId: (v.membershipId as string) ?? null,
      }
      const s = await scopes(scope)
      this.assertManage(s, place, context.membershipId)
      this.assertSensitive(s, place, context.membershipId, v)
      await this.checkReferences(scope, { ...v }, null)
      const columns: string[] = []
      const params: unknown[] = []
      for (const [key, column] of Object.entries({ ...GENERAL_FIELDS, ...SENSITIVE_FIELDS }))
        if (v[key] !== undefined) {
          columns.push(column)
          params.push(v[key])
        }
      let id: string
      try {
        const r = await scope.trx.rawQuery(
          `insert into employees (tenant_id, created_by, updated_by, ${columns.join(', ')})
           values (?, ?, ?, ${columns.map(() => '?').join(', ')}) returning id`,
          [context.tenantId, context.userId, context.userId, ...params] as never[]
        )
        id = (r.rows[0] as { id: string }).id
      } catch (error) {
        mapUnique(error)
      }
      await audit(scope, {
        action: 'hr.employee.created',
        entityType: 'employee',
        entityId: id,
        changes: employeeChanges({}, v),
      })
      const row = await findRow(scope, id)
      return view(row, covers(s.sensitive, placementOf(row), context.membershipId))
    })
  }

  update(
    context: TenantContext,
    id: string,
    input: Record<string, unknown>,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const row = await findRow(scope, id, true)
      const s = await scopes(scope)
      const me = context.membershipId
      if (!row || !covers(s.read, placementOf(row), me)) throw ApiError.notFound()
      if (Number(row.version) !== expectedVersion)
        throw ApiError.versionConflict(Number(row.version))
      const { values: v, issues } = this.normalize(input)
      if ('status' in v)
        issues.push({
          path: 'status',
          code: 'USE_STATUS_ACTION',
          message: 'Use a acção de estado.',
        })
      for (const key of ['code', 'fullName', 'legalEntityId', 'hireDate'])
        if (key in v && (v[key] === null || v[key] === undefined))
          issues.push({ path: key, code: 'REQUIRED', message: 'Obrigatório.' })
      if (row.status === 'TERMINATED')
        issues.push({
          path: 'status',
          code: 'TERMINATED',
          message: 'A ficha de um colaborador cessado não se altera.',
        })
      if (issues.length) throw ApiError.validation(issues)
      const before = values(row)
      const after = { ...before, ...v }
      const oldPlace = placementOf(row)
      const newPlace: Placement = {
        legalEntityId: after.legalEntityId as string,
        branchId: (after.branchId as string) ?? null,
        departmentId: (after.departmentId as string) ?? null,
        membershipId: (after.membershipId as string) ?? null,
      }
      // Mudar de lugar exige gerir a origem e o destino.
      this.assertManage(s, oldPlace, me)
      this.assertManage(s, newPlace, me)
      this.assertSensitive(s, oldPlace, me, v)
      if (!birthBeforeHire(after.birthDate, after.hireDate))
        throw ApiError.validation([
          {
            path: 'birthDate',
            code: 'AFTER_HIRE',
            message: 'A data de nascimento tem de ser anterior à admissão.',
          },
        ])
      await this.checkReferences(scope, after, id)
      const changed = Object.keys(v).filter((k) => (before[k] ?? null) !== (v[k] ?? null))
      if (changed.length === 0) return view(row, covers(s.sensitive, oldPlace, me))
      const sets = changed.map(
        (k) => `${{ ...GENERAL_FIELDS, ...SENSITIVE_FIELDS }[k as 'code']} = ?`
      )
      try {
        await scope.trx.rawQuery(
          `update employees set ${sets.join(', ')}, version = version + 1, updated_by = ?, updated_at = now()
            where tenant_id = ? and id = ?`,
          [...changed.map((k) => v[k]), context.userId, context.tenantId, id] as never[]
        )
      } catch (error) {
        mapUnique(error)
      }
      await audit(scope, {
        action: 'hr.employee.updated',
        entityType: 'employee',
        entityId: id,
        changes: employeeChanges(before, Object.fromEntries(changed.map((k) => [k, v[k]]))),
      })
      const fresh = await findRow(scope, id)
      return view(fresh, covers(s.sensitive, placementOf(fresh), me))
    })
  }

  /** Suspender ou reactivar (a cessação é o processo do 7.11). */
  setStatus(
    context: TenantContext,
    id: string,
    status: EmployeeStatus,
    reason: string | null,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const row = await findRow(scope, id, true)
      const s = await scopes(scope)
      const me = context.membershipId
      if (!row || !covers(s.read, placementOf(row), me)) throw ApiError.notFound()
      this.assertManage(s, placementOf(row), me)
      if (Number(row.version) !== expectedVersion)
        throw ApiError.versionConflict(Number(row.version))
      const from = row.status as EmployeeStatus
      if (!STATUS_TRANSITIONS[from].includes(status))
        throw ApiError.validation([
          {
            path: 'status',
            code: 'INVALID_TRANSITION',
            message: `Não é possível passar de ${from} a ${status}.`,
          },
        ])
      await scope.trx.rawQuery(
        `update employees set status = ?, version = version + 1, updated_by = ?, updated_at = now()
          where tenant_id = ? and id = ?`,
        [status, context.userId, context.tenantId, id]
      )
      await audit(scope, {
        action: 'hr.employee.status_changed',
        entityType: 'employee',
        entityId: id,
        changes: { status: { from, to: status } },
        metadata: reason ? { reason } : null,
      })
      const fresh = await findRow(scope, id)
      return view(fresh, covers(s.sensitive, placementOf(fresh), me))
    })
  }

  private normalize(input: Record<string, unknown>) {
    return normalizeEmployee(input, new Date().toISOString().slice(0, 10), isValidIban)
  }

  private assertManage(s: { manage: PermissionScope }, place: Placement, me: string) {
    if (!covers({ ...s.manage, own: false }, place, me))
      throw ApiError.forbidden(
        'OUT_OF_SCOPE',
        'Não gere colaboradores nesta entidade, filial ou departamento.'
      )
  }

  /** Alterar dados pessoais exige `hr.sensitive` no âmbito do colaborador. */
  private assertSensitive(
    s: { sensitive: PermissionScope },
    place: Placement,
    me: string,
    v: Record<string, unknown>
  ) {
    const touched = SENSITIVE_KEYS.filter((k) => k in v)
    if (touched.length && !covers(s.sensitive, place, me))
      throw new ApiError(
        403,
        'SENSITIVE_FORBIDDEN',
        'Não pode alterar dados pessoais deste colaborador.',
        touched.map((path) => ({ path, code: 'SENSITIVE_FORBIDDEN', message: 'Dado reservado.' }))
      )
  }

  /** Coerência com a estrutura: tudo da mesma entidade legal, activo, e superior sem ciclos. */
  private async checkReferences(
    scope: TenantScope,
    v: Record<string, unknown>,
    selfId: string | null
  ) {
    const issues: ErrorDetail[] = []
    const le = await legalEntityFacts(scope, v.legalEntityId as string)
    if (!le)
      throw ApiError.validation([
        { path: 'legalEntityId', code: 'NOT_FOUND', message: 'Entidade legal inexistente.' },
      ])
    if (le.status !== 'ACTIVE')
      issues.push({ path: 'legalEntityId', code: 'INACTIVE', message: 'Entidade legal inactiva.' })
    const facts = await orgReferenceFacts(scope, {
      branchId: v.branchId as string,
      departmentId: v.departmentId as string,
      positionId: v.positionId as string,
      costCenterId: v.costCenterId as string,
    })
    const ref = (
      key: string,
      fact: { legalEntityId?: string; status: string } | null,
      label: string
    ) => {
      if (!v[key]) return
      if (!fact)
        return issues.push({ path: key, code: 'NOT_FOUND', message: `${label} inexistente.` })
      if (fact.status !== 'ACTIVE')
        issues.push({ path: key, code: 'INACTIVE', message: `${label} inactivo(a).` })
      if (fact.legalEntityId && fact.legalEntityId !== v.legalEntityId)
        issues.push({
          path: key,
          code: 'OTHER_LEGAL_ENTITY',
          message: `${label} de outra entidade legal.`,
        })
    }
    ref('branchId', facts.branch, 'Filial')
    ref('departmentId', facts.department, 'Departamento')
    ref('positionId', facts.position, 'Cargo')
    ref('costCenterId', facts.costCenter, 'Centro de custo')
    if (facts.department?.branchId && v.branchId && facts.department.branchId !== v.branchId)
      issues.push({
        path: 'departmentId',
        code: 'OTHER_BRANCH',
        message: 'O departamento pertence a outra filial.',
      })
    if (
      facts.position?.departmentId &&
      v.departmentId &&
      facts.position.departmentId !== v.departmentId
    )
      issues.push({
        path: 'positionId',
        code: 'OTHER_DEPARTMENT',
        message: 'O cargo pertence a outro departamento.',
      })
    if (v.managerId) {
      if (v.managerId === selfId)
        issues.push({
          path: 'managerId',
          code: 'SELF',
          message: 'Não pode ser superior de si próprio.',
        })
      else {
        const m = await scope.trx.rawQuery(
          `select status from employees where tenant_id = ? and id = ?`,
          [scope.context.tenantId, v.managerId as string]
        )
        const manager = m.rows[0] as { status: string } | undefined
        if (!manager)
          issues.push({ path: 'managerId', code: 'NOT_FOUND', message: 'Superior inexistente.' })
        else if (manager.status === 'TERMINATED')
          issues.push({
            path: 'managerId',
            code: 'TERMINATED',
            message: 'O superior já cessou funções.',
          })
        else if (selfId) {
          // O novo superior não pode estar abaixo deste colaborador (ciclo).
          const cycle = await scope.trx.rawQuery(
            `with recursive up as (
               select id, manager_id, 1 as depth from employees where tenant_id = ? and id = ?
               union all
               select e.id, e.manager_id, up.depth + 1 from employees e
                 join up on e.id = up.manager_id where e.tenant_id = ? and up.depth < 100)
             select 1 from up where id = ? limit 1`,
            [scope.context.tenantId, v.managerId as string, scope.context.tenantId, selfId]
          )
          if (cycle.rows.length)
            issues.push({
              path: 'managerId',
              code: 'CYCLE',
              message: 'O superior escolhido depende deste colaborador.',
            })
        }
      }
    }
    if (v.membershipId) {
      const r = await scope.trx.rawQuery(
        `select 1 from tenant_memberships where tenant_id = ? and id = ?`,
        [scope.context.tenantId, v.membershipId as string]
      )
      if (!r.rows.length)
        issues.push({ path: 'membershipId', code: 'NOT_FOUND', message: 'Membro inexistente.' })
    }
    if (!birthBeforeHire(v.birthDate, v.hireDate))
      issues.push({
        path: 'birthDate',
        code: 'AFTER_HIRE',
        message: 'A data de nascimento tem de ser anterior à admissão.',
      })
    if (issues.length) throw ApiError.validation(issues)
  }
}
