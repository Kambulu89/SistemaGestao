import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { constraintOf, isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope, type PermissionScope } from '#modules/rbac/index'
import { legalEntityFacts, orgReferenceFacts } from '#modules/organization/index'
import {
  ACCESS_LEVELS,
  childLevel,
  isLocationCode,
  pathCode,
  seriesCodes,
  WAREHOUSE_TYPES,
  warehouseAccess,
  type AccessLevel,
  type LocationLevel,
} from '#modules/inventory/domain/warehouses'

/*
 * Armazéns (8.2). Gerir (`inventory.warehouses.manage`) e consultar (`inventory.read`) seguem o âmbito RBAC pela
 * entidade legal ou filial do armazém. Um armazém restrito só é visível a quem o gere e aos membros da sua lista
 * (consultar ou operar). A entidade legal de um armazém não muda; as localizações não mudam de código nem de superior
 * (garantido na base) e não se apagam: inactivam-se, depois das localizações abaixo.
 */

const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : v)
const WH_CODE = /^[A-Z0-9][A-Z0-9_-]{0,19}$/

interface Scopes {
  read: PermissionScope
  manage: PermissionScope
}
const noOwn = (s: PermissionScope): PermissionScope => ({ ...s, own: false })

async function scopes(scope: TenantScope): Promise<Scopes> {
  return {
    read: noOwn(await permissionScope(scope, 'inventory.read')),
    manage: noOwn(await permissionScope(scope, 'inventory.warehouses.manage')),
  }
}

const covers = (s: PermissionScope, le: string, branch: string | null) =>
  s.tenant || s.legalEntityIds.has(le) || (!!branch && s.branchIds.has(branch))

function clause(s: PermissionScope) {
  if (s.tenant) return { sql: 'true', params: [] as unknown[] }
  const parts: string[] = []
  const params: unknown[] = []
  if (s.legalEntityIds.size) {
    parts.push('w.legal_entity_id = any(?::uuid[])')
    params.push([...s.legalEntityIds])
  }
  if (s.branchIds.size) {
    parts.push('w.branch_id = any(?::uuid[])')
    params.push([...s.branchIds])
  }
  return parts.length ? { sql: `(${parts.join(' or ')})`, params } : null
}

const W_SELECT = `select w.*, le.code as le_code, le.legal_name as le_name, b.name as branch_name,
    mu.full_name as manager_name, a.access_level as my_level
  from warehouses w
  join legal_entities le on le.tenant_id = w.tenant_id and le.id = w.legal_entity_id
  left join branches b on b.tenant_id = w.tenant_id and b.id = w.branch_id
  left join tenant_memberships mm on mm.tenant_id = w.tenant_id and mm.id = w.manager_membership_id
  left join users mu on mu.id = mm.user_id
  left join warehouse_access a on a.tenant_id = w.tenant_id and a.warehouse_id = w.id and a.membership_id = ?`

function access(s: Scopes, w: any) {
  return warehouseAccess({
    manage: covers(s.manage, w.legal_entity_id, w.branch_id),
    read: covers(s.read, w.legal_entity_id, w.branch_id),
    mode: w.access_mode,
    entry: (w.my_level as AccessLevel) ?? null,
  })
}

function view(w: any) {
  return {
    id: w.id as string,
    version: Number(w.version),
    code: w.code as string,
    name: w.name as string,
    legalEntity: {
      id: w.legal_entity_id as string,
      code: w.le_code as string,
      name: w.le_name as string,
    },
    branch: w.branch_id ? { id: w.branch_id as string, name: w.branch_name as string } : null,
    manager: w.manager_membership_id
      ? {
          membershipId: w.manager_membership_id as string,
          name: (w.manager_name as string) ?? null,
        }
      : null,
    warehouseType: w.warehouse_type as string,
    addressLine: (w.address_line as string) ?? null,
    city: (w.city as string) ?? null,
    province: (w.province as string) ?? null,
    countryCode: (w.country_code as string) ?? null,
    accessMode: w.access_mode as 'OPEN' | 'RESTRICTED',
    status: w.status as string,
    createdAt: w.created_at,
  }
}

async function findWarehouse(scope: TenantScope, id: string, lock = false) {
  if (!isUuid(id)) return null
  const r = await scope.trx.rawQuery(
    `${W_SELECT} where w.tenant_id = ? and w.id = ?${lock ? ' for update of w' : ''}`,
    [scope.context.membershipId, scope.context.tenantId, id]
  )
  return (r.rows[0] as any) ?? null
}

async function warehouseFor(scope: TenantScope, id: string, lock = false) {
  const w = await findWarehouse(scope, id, lock)
  if (!w) throw ApiError.notFound()
  const a = access(await scopes(scope), w)
  if (!a) throw ApiError.notFound()
  return { w, access: a }
}

const needManage = (a: { manage: boolean }) => {
  if (!a.manage) throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere este armazém.')
}

async function activeMember(scope: TenantScope, membershipId: string) {
  const r = await scope.trx.rawQuery(
    `select m.status, u.full_name from tenant_memberships m join users u on u.id = m.user_id
      where m.tenant_id = ? and m.id = ?`,
    [scope.context.tenantId, membershipId]
  )
  return (r.rows[0] as { status: string; full_name: string } | undefined) ?? null
}

async function locationsOf(scope: TenantScope, warehouseId: string) {
  const r = await scope.trx.rawQuery(
    `select * from warehouse_locations where tenant_id = ? and warehouse_id = ? order by path_code`,
    [scope.context.tenantId, warehouseId]
  )
  return (r.rows as any[]).map((l) => ({
    id: l.id as string,
    version: Number(l.version),
    parentId: (l.parent_id as string) ?? null,
    level: l.level as LocationLevel,
    code: l.code as string,
    pathCode: l.path_code as string,
    name: (l.name as string) ?? null,
    holdsStock: Boolean(l.holds_stock),
    status: l.status as string,
  }))
}

async function accessList(scope: TenantScope, warehouseId: string) {
  const r = await scope.trx.rawQuery(
    `select a.id, a.membership_id, a.access_level, u.full_name, u.email from warehouse_access a
       join tenant_memberships m on m.tenant_id = a.tenant_id and m.id = a.membership_id
       join users u on u.id = m.user_id
      where a.tenant_id = ? and a.warehouse_id = ? order by u.full_name`,
    [scope.context.tenantId, warehouseId]
  )
  return (r.rows as any[]).map((a) => ({
    id: a.id as string,
    membershipId: a.membership_id as string,
    name: a.full_name as string,
    email: a.email as string,
    level: a.access_level as AccessLevel,
  }))
}

/** Normaliza os dados do armazém (parcial na alteração). */
function normalize(input: Record<string, unknown>, creating: boolean) {
  const issues: ErrorDetail[] = []
  const v: Record<string, unknown> = {}
  const has = (k: string) => k in input || creating
  if (creating) {
    const c = text(input.code)
    if (typeof c !== 'string' || !WH_CODE.test(c.toUpperCase()))
      issues.push({
        path: 'code',
        code: 'INVALID_CODE',
        message: 'Código: até 20 letras, dígitos, _ ou -.',
      })
    else v.code = c.toUpperCase()
    const le = input.legalEntityId
    if (typeof le !== 'string' || !isUuid(le))
      issues.push({ path: 'legalEntityId', code: 'REQUIRED', message: 'Indique a entidade legal.' })
    else v.legalEntityId = le
  }
  if (has('name')) {
    const n = text(input.name)
    if (typeof n !== 'string' || n.length < 2 || n.length > 120)
      issues.push({ path: 'name', code: 'LENGTH', message: 'Nome: 2 a 120 caracteres.' })
    else v.name = n
  }
  if (has('warehouseType')) {
    if (!WAREHOUSE_TYPES.includes(input.warehouseType as any))
      issues.push({ path: 'warehouseType', code: 'INVALID', message: 'Tipo inválido.' })
    else v.warehouseType = input.warehouseType
  }
  for (const k of ['branchId', 'managerMembershipId'] as const)
    if (k in input) {
      const x = input[k]
      if (x === null || x === '') v[k] = null
      else if (typeof x !== 'string' || !isUuid(x))
        issues.push({ path: k, code: 'INVALID', message: 'Inválido.' })
      else v[k] = x
    }
  for (const [k, max] of [
    ['addressLine', 200],
    ['city', 80],
    ['province', 80],
  ] as const)
    if (k in input) {
      const x = text(input[k])
      if (x === '' || x === null || x === undefined) v[k] = null
      else if (typeof x !== 'string' || x.length > max)
        issues.push({ path: k, code: 'LENGTH', message: `Até ${max} caracteres.` })
      else v[k] = x
    }
  if ('countryCode' in input) {
    const x = text(input.countryCode)
    if (x === '' || x === null || x === undefined) v.countryCode = null
    else if (typeof x !== 'string' || !/^[A-Za-z]{2}$/.test(x))
      issues.push({
        path: 'countryCode',
        code: 'INVALID_COUNTRY',
        message: 'País em código ISO de 2 letras.',
      })
    else v.countryCode = x.toUpperCase()
  }
  if ('accessMode' in input) {
    if (!['OPEN', 'RESTRICTED'].includes(input.accessMode as string))
      issues.push({ path: 'accessMode', code: 'INVALID', message: 'Aberto ou restrito.' })
    else v.accessMode = input.accessMode
  }
  if ('status' in input && !creating) {
    if (!['ACTIVE', 'INACTIVE'].includes(input.status as string))
      issues.push({ path: 'status', code: 'INVALID', message: 'Activo ou inactivo.' })
    else v.status = input.status
  }
  return { v, issues }
}

const COLUMNS: Record<string, string> = {
  code: 'code',
  name: 'name',
  legalEntityId: 'legal_entity_id',
  branchId: 'branch_id',
  managerMembershipId: 'manager_membership_id',
  warehouseType: 'warehouse_type',
  addressLine: 'address_line',
  city: 'city',
  province: 'province',
  countryCode: 'country_code',
  accessMode: 'access_mode',
  status: 'status',
}

export class WarehouseService {
  list(
    context: TenantContext,
    f: {
      q?: string
      legalEntityId?: string
      status?: string
      warehouseType?: string
      limit: number
      offset: number
    }
  ) {
    return runInTenant(context, async (scope) => {
      const s = await scopes(scope)
      const m = clause(s.manage)
      const r = clause(s.read)
      const parts: string[] = []
      const params: unknown[] = []
      if (m) {
        parts.push(m.sql)
        params.push(...m.params)
      }
      if (r) {
        parts.push(`(${r.sql} and (w.access_mode = 'OPEN' or a.access_level is not null))`)
        params.push(...r.params)
      }
      if (!parts.length) return { items: [], total: 0 }
      const where = ['w.tenant_id = ?', `(${parts.join(' or ')})`]
      const all: unknown[] = [context.tenantId, ...params]
      if (f.q) {
        const like = `%${f.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
        where.push('(lower(w.code) like ? or lower(w.name) like ?)')
        all.push(like, like)
      }
      for (const [k, col] of [
        ['legalEntityId', 'w.legal_entity_id'],
        ['status', 'w.status'],
        ['warehouseType', 'w.warehouse_type'],
      ] as const)
        if (f[k]) {
          where.push(`${col} = ?`)
          all.push(f[k])
        }
      const cl = where.join(' and ')
      const rows = await scope.trx.rawQuery(
        `${W_SELECT} where ${cl} order by w.code limit ? offset ?`,
        [context.membershipId, ...all, f.limit, f.offset] as never[]
      )
      const count = await scope.trx.rawQuery(
        `select count(*)::int as n from warehouses w left join warehouse_access a on a.tenant_id = w.tenant_id
           and a.warehouse_id = w.id and a.membership_id = ? where ${cl}`,
        [context.membershipId, ...all] as never[]
      )
      return {
        items: (rows.rows as any[]).map((w) => ({ ...view(w), access: access(s, w) })),
        total: (count.rows[0] as { n: number }).n,
        canCreate:
          s.manage.tenant || s.manage.legalEntityIds.size > 0 || s.manage.branchIds.size > 0,
      }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, (scope) => this.detail(scope, id))
  }

  private async detail(scope: TenantScope, id: string) {
    const { w, access: a } = await warehouseFor(scope, id)
    return {
      ...view(w),
      access: a,
      locations: await locationsOf(scope, id),
      members: a.manage ? await accessList(scope, id) : null,
    }
  }

  /** Verifica entidade legal, filial (da mesma entidade) e responsável activos. */
  private async checkRefs(scope: TenantScope, v: Record<string, any>, legalEntityId: string) {
    const issues: ErrorDetail[] = []
    const le = await legalEntityFacts(scope, legalEntityId)
    if (!le)
      issues.push({
        path: 'legalEntityId',
        code: 'NOT_FOUND',
        message: 'Entidade legal inexistente.',
      })
    else if (le.status !== 'ACTIVE' && 'legalEntityId' in v)
      issues.push({ path: 'legalEntityId', code: 'INACTIVE', message: 'Entidade legal inactiva.' })
    if (v.branchId) {
      const f = await orgReferenceFacts(scope, { branchId: v.branchId })
      if (!f.branch)
        issues.push({ path: 'branchId', code: 'NOT_FOUND', message: 'Filial inexistente.' })
      else if (f.branch.legalEntityId !== legalEntityId)
        issues.push({
          path: 'branchId',
          code: 'OTHER_LEGAL_ENTITY',
          message: 'A filial é de outra entidade legal.',
        })
      else if (f.branch.status !== 'ACTIVE')
        issues.push({ path: 'branchId', code: 'INACTIVE', message: 'Filial inactiva.' })
    }
    if (v.managerMembershipId) {
      const m = await activeMember(scope, v.managerMembershipId)
      if (!m || m.status !== 'ACTIVE')
        issues.push({
          path: 'managerMembershipId',
          code: 'NOT_FOUND',
          message: 'Responsável: membro activo da empresa.',
        })
    }
    fail(issues)
  }

  create(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { v, issues } = normalize(input, true)
      fail(issues)
      const s = await scopes(scope)
      if (!covers(s.manage, v.legalEntityId as string, (v.branchId as string) ?? null))
        throw ApiError.forbidden(
          'OUT_OF_SCOPE',
          'Não gere armazéns desta entidade legal ou filial.'
        )
      await this.checkRefs(scope, v, v.legalEntityId as string)
      const keys = Object.keys(v)
      let id: string
      try {
        const r = await scope.trx.rawQuery(
          `insert into warehouses (tenant_id, ${keys.map((k) => COLUMNS[k]).join(', ')}, created_by, updated_by)
           values (?, ${keys.map(() => '?').join(', ')}, ?, ?) returning id`,
          [context.tenantId, ...keys.map((k) => v[k]), context.userId, context.userId] as never[]
        )
        id = (r.rows[0] as { id: string }).id
      } catch (error) {
        if (constraintOf(error) === 'warehouses_code_unique')
          throw new ApiError(409, 'CODE_TAKEN', 'Já existe um armazém com este código.', [
            { path: 'code', code: 'CODE_TAKEN', message: 'Já existe um armazém com este código.' },
          ])
        throw error
      }
      await audit(scope, {
        action: 'inventory.warehouse.created',
        entityType: 'warehouse',
        entityId: id,
        metadata: { code: v.code, legalEntityId: v.legalEntityId, branchId: v.branchId ?? null },
      })
      return this.detail(scope, id)
    })
  }

  update(
    context: TenantContext,
    id: string,
    input: Record<string, unknown>,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const { w, access: a } = await warehouseFor(scope, id, true)
      needManage(a)
      if (Number(w.version) !== expectedVersion) throw ApiError.versionConflict(Number(w.version))
      if ('legalEntityId' in input && input.legalEntityId !== w.legal_entity_id)
        fail([
          {
            path: 'legalEntityId',
            code: 'FIXED',
            message: 'A entidade legal de um armazém não muda.',
          },
        ])
      if ('code' in input && String(input.code).toUpperCase() !== w.code)
        fail([{ path: 'code', code: 'FIXED', message: 'O código de um armazém não muda.' }])
      const { v, issues } = normalize(input, false)
      fail(issues)
      const branch = 'branchId' in v ? (v.branchId as string | null) : w.branch_id
      if (!covers((await scopes(scope)).manage, w.legal_entity_id, branch))
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere armazéns desta filial.')
      await this.checkRefs(scope, v, w.legal_entity_id)
      const keys = Object.keys(v)
      if (keys.length) {
        await scope.trx.rawQuery(
          `update warehouses set ${keys.map((k) => `${COLUMNS[k]} = ?`).join(', ')}, version = version + 1,
             updated_by = ?, updated_at = now() where tenant_id = ? and id = ?`,
          [...keys.map((k) => v[k]), context.userId, context.tenantId, id] as never[]
        )
        const before = view(w) as Record<string, any>
        const changes: Record<string, { from: unknown; to: unknown }> = {}
        for (const k of keys) {
          const from =
            k === 'branchId'
              ? (before.branch?.id ?? null)
              : k === 'managerMembershipId'
                ? (before.manager?.membershipId ?? null)
                : (before[k] ?? null)
          if (from !== (v[k] ?? null)) changes[k] = { from, to: v[k] ?? null }
        }
        await audit(scope, {
          action: 'inventory.warehouse.updated',
          entityType: 'warehouse',
          entityId: id,
          changes,
        })
      }
      return this.detail(scope, id)
    })
  }

  /** Nova localização: o nível vem do superior (zona → corredor → estante → posição). */
  addLocations(context: TenantContext, warehouseId: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { w, access: a } = await warehouseFor(scope, warehouseId, true)
      needManage(a)
      if (w.status !== 'ACTIVE') throw ApiError.conflict('INACTIVE', 'O armazém está inactivo.')
      const issues: ErrorDetail[] = []
      let parent: any = null
      if (input.parentId !== undefined && input.parentId !== null && input.parentId !== '') {
        if (typeof input.parentId !== 'string' || !isUuid(input.parentId))
          issues.push({
            path: 'parentId',
            code: 'INVALID',
            message: 'Localização superior inválida.',
          })
        else {
          const r = await scope.trx.rawQuery(
            `select * from warehouse_locations where tenant_id = ? and warehouse_id = ? and id = ?`,
            [context.tenantId, warehouseId, input.parentId]
          )
          parent = r.rows[0] ?? null
          if (!parent)
            issues.push({
              path: 'parentId',
              code: 'NOT_FOUND',
              message: 'Localização superior inexistente.',
            })
          else if (parent.status !== 'ACTIVE')
            issues.push({
              path: 'parentId',
              code: 'INACTIVE',
              message: 'Localização superior inactiva.',
            })
        }
      }
      fail(issues)
      const level = childLevel(parent ? (parent.level as LocationLevel) : null)
      if (!level)
        fail([
          {
            path: 'parentId',
            code: 'TOO_DEEP',
            message: 'Uma posição não tem localizações abaixo.',
          },
        ])
      let codes: string[]
      if ('series' in input && input.series) {
        const sr = input.series as Record<string, unknown>
        const c = seriesCodes(
          typeof sr.prefix === 'string' ? sr.prefix : '',
          Number(sr.from),
          Number(sr.to),
          Number(sr.width ?? 2)
        )
        if (!c)
          fail([
            {
              path: 'series',
              code: 'INVALID',
              message: 'Série inválida (até 200 códigos de até 20 caracteres).',
            },
          ])
        codes = c!
      } else {
        const c = typeof input.code === 'string' ? input.code.trim().toUpperCase() : ''
        if (!isLocationCode(c))
          fail([
            {
              path: 'code',
              code: 'INVALID_CODE',
              message: 'Código: até 20 letras maiúsculas, dígitos ou _.',
            },
          ])
        codes = [c]
      }
      const name =
        typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 120) : null
      const holds = typeof input.holdsStock === 'boolean' ? input.holdsStock : level === 'BIN'
      const paths = codes.map((c) => pathCode(parent?.path_code ?? null, c))
      const taken = await scope.trx.rawQuery(
        `select path_code from warehouse_locations where tenant_id = ? and warehouse_id = ? and path_code = any(?::text[])`,
        [context.tenantId, warehouseId, paths] as never[]
      )
      if (taken.rows.length)
        throw new ApiError(
          409,
          'LOCATION_EXISTS',
          `Já existem: ${(taken.rows as any[])
            .map((x) => x.path_code)
            .slice(0, 10)
            .join(', ')}.`,
          [{ path: 'code', code: 'LOCATION_EXISTS', message: 'Localização repetida.' }]
        )
      for (const [i, c] of codes.entries())
        await scope.trx.rawQuery(
          `insert into warehouse_locations (tenant_id, warehouse_id, parent_id, level, code, path_code, name,
             holds_stock, created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            context.tenantId,
            warehouseId,
            parent?.id ?? null,
            level,
            c,
            paths[i],
            codes.length === 1 ? name : null,
            holds,
            context.userId,
            context.userId,
          ] as never[]
        )
      await audit(scope, {
        action: 'inventory.location.created',
        entityType: 'warehouse',
        entityId: warehouseId,
        metadata: { level, count: codes.length, first: paths[0], last: paths.at(-1) },
      })
      return this.detail(scope, warehouseId)
    })
  }

  /** Altera nome, se guarda stock e estado; inactivar exige as localizações abaixo inactivas. */
  updateLocation(
    context: TenantContext,
    locationId: string,
    input: Record<string, unknown>,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      if (!isUuid(locationId)) throw ApiError.notFound()
      const r = await scope.trx.rawQuery(
        `select * from warehouse_locations where tenant_id = ? and id = ? for update`,
        [context.tenantId, locationId]
      )
      const l = r.rows[0] as any
      if (!l) throw ApiError.notFound()
      const { access: a } = await warehouseFor(scope, l.warehouse_id, true)
      needManage(a)
      if (Number(l.version) !== expectedVersion) throw ApiError.versionConflict(Number(l.version))
      const issues: ErrorDetail[] = []
      const v: Record<string, unknown> = {}
      if ('code' in input || 'parentId' in input)
        issues.push({
          path: 'code',
          code: 'FIXED',
          message: 'O código e a localização superior não mudam.',
        })
      if ('name' in input) {
        const n = text(input.name)
        if (n === '' || n === null) v.name = null
        else if (typeof n !== 'string' || n.length > 120)
          issues.push({ path: 'name', code: 'LENGTH', message: 'Até 120 caracteres.' })
        else v.name = n
      }
      if ('holdsStock' in input) v.holds_stock = input.holdsStock === true
      if ('status' in input) {
        if (!['ACTIVE', 'INACTIVE'].includes(input.status as string))
          issues.push({ path: 'status', code: 'INVALID', message: 'Activo ou inactivo.' })
        else v.status = input.status
      }
      fail(issues)
      if (v.status === 'INACTIVE' && l.status === 'ACTIVE') {
        const kids = await scope.trx.rawQuery(
          `select count(*)::int as n from warehouse_locations where tenant_id = ? and parent_id = ? and status = 'ACTIVE'`,
          [context.tenantId, locationId]
        )
        if ((kids.rows[0] as { n: number }).n)
          throw ApiError.conflict(
            'ACTIVE_CHILDREN',
            'Inactive primeiro as localizações abaixo desta.'
          )
      }
      if (v.status === 'ACTIVE' && l.status === 'INACTIVE' && l.parent_id) {
        const p = await scope.trx.rawQuery(
          `select status from warehouse_locations where tenant_id = ? and id = ?`,
          [context.tenantId, l.parent_id]
        )
        if ((p.rows[0] as { status: string }).status !== 'ACTIVE')
          throw ApiError.conflict('INACTIVE_PARENT', 'Reactive primeiro a localização superior.')
      }
      const keys = Object.keys(v)
      if (keys.length) {
        await scope.trx.rawQuery(
          `update warehouse_locations set ${keys.map((k) => `${k} = ?`).join(', ')}, version = version + 1,
             updated_by = ?, updated_at = now() where tenant_id = ? and id = ?`,
          [...keys.map((k) => v[k]), context.userId, context.tenantId, locationId] as never[]
        )
        await audit(scope, {
          action: 'inventory.location.updated',
          entityType: 'warehouse',
          entityId: l.warehouse_id,
          metadata: { location: l.path_code, fields: keys },
        })
      }
      return this.detail(scope, l.warehouse_id)
    })
  }

  /** Membro na lista de acesso do armazém (`level: null` retira). */
  setAccess(context: TenantContext, warehouseId: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { access: a } = await warehouseFor(scope, warehouseId, true)
      needManage(a)
      const m = input.membershipId
      if (typeof m !== 'string' || !isUuid(m))
        fail([{ path: 'membershipId', code: 'REQUIRED', message: 'Indique o membro.' }])
      const level = input.level ?? null
      if (level !== null && !ACCESS_LEVELS.includes(level as any))
        fail([{ path: 'level', code: 'INVALID', message: 'Consultar ou operar.' }])
      const member = await activeMember(scope, m as string)
      if (!member || member.status !== 'ACTIVE')
        fail([{ path: 'membershipId', code: 'NOT_FOUND', message: 'Membro activo da empresa.' }])
      if (level)
        await scope.trx.rawQuery(
          `insert into warehouse_access (tenant_id, warehouse_id, membership_id, access_level, created_by, updated_by)
           values (?, ?, ?, ?, ?, ?)
           on conflict (tenant_id, warehouse_id, membership_id) do update set access_level = excluded.access_level,
             version = warehouse_access.version + 1, updated_by = excluded.updated_by, updated_at = now()`,
          [context.tenantId, warehouseId, m, level, context.userId, context.userId] as never[]
        )
      else
        await scope.trx.rawQuery(
          `delete from warehouse_access where tenant_id = ? and warehouse_id = ? and membership_id = ?`,
          [context.tenantId, warehouseId, m] as never[]
        )
      await audit(scope, {
        action: level ? 'inventory.warehouse.access_granted' : 'inventory.warehouse.access_revoked',
        entityType: 'warehouse',
        entityId: warehouseId,
        metadata: { membershipId: m, level },
      })
      return this.detail(scope, warehouseId)
    })
  }

  /** Membros activos que podem ser responsáveis ou entrar na lista (só para quem gere armazéns). */
  candidates(context: TenantContext) {
    return runInTenant(context, async (scope) => {
      const s = await scopes(scope)
      if (!(s.manage.tenant || s.manage.legalEntityIds.size || s.manage.branchIds.size))
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere armazéns.')
      const r = await scope.trx.rawQuery(
        `select m.id, u.full_name, u.email from tenant_memberships m join users u on u.id = m.user_id
          where m.tenant_id = ? and m.status = 'ACTIVE' order by u.full_name limit 500`,
        [context.tenantId]
      )
      return (r.rows as any[]).map((x) => ({
        membershipId: x.id as string,
        name: x.full_name as string,
        email: x.email as string,
      }))
    })
  }
}

/** Acesso de outro bloco a um armazém (para movimentos): `null` se não o vê. */
export async function warehouseAccessFor(scope: TenantScope, warehouseId: string) {
  const w = await findWarehouse(scope, warehouseId)
  if (!w) return null
  const a = access(await scopes(scope), w)
  return a ? { ...a, legalEntityId: w.legal_entity_id as string, status: w.status as string } : null
}
