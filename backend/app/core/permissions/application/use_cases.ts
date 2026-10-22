import { ApiError, type ApiErrorDetail } from '#core/http/api_error'
import type { TenantContext, TenantUnitOfWork } from '#core/tenancy/index'
import { grantsAccess, type MembershipStore } from '#core/membership/index'
import {
  PERMISSION_CATALOG,
  TENANT_ADMIN_ROLE,
  isValidPermissionCode,
} from '#core/permissions/domain/catalog'
import { validateCondition, type EvalContext } from '#core/permissions/domain/condition'
import { decide, type Decision, type FieldRule } from '#core/permissions/domain/decision'
import type {
  AssignmentView,
  IamStore,
  PermissionCatalogStore,
  PermissionRecord,
  PolicyInput,
  PolicyView,
  RoleView,
} from '#core/permissions/application/ports'

const validation = (details: ApiErrorDetail[]) =>
  new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', details)

const ROLE_CODE = /^[a-z][a-z0-9_]{1,59}$/
const KNOWN_CODES = new Set(PERMISSION_CATALOG.map((p) => p.code))

/** Contexto de avaliação: o sujeito vem sempre do `TenantContext` validado, nunca do pedido. */
function evalContext(
  context: TenantContext,
  resource: Record<string, unknown>,
  now: Date
): EvalContext {
  return {
    subject: {
      membershipId: context.membershipId,
      userId: context.userId,
      organizationId: context.organizationId,
    },
    resource,
    env: { now: now.toISOString() },
  }
}

export interface Clock {
  now(): Date
}

/** Decide se o actor do contexto pode executar `permission` sobre um recurso com estes atributos. */
export class Authorize {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly store: IamStore,
    private readonly clock: Clock
  ) {}

  async decision(
    context: TenantContext,
    permission: string,
    resource: Record<string, unknown> = {}
  ): Promise<Decision> {
    if (!isValidPermissionCode(permission)) {
      throw new Error(`Código de permissão inválido: ${permission}`)
    }
    if (!context.membershipId) {
      // Actores de serviço/suporte não têm papéis de tenant: negar por omissão.
      return decide({
        permission,
        grants: [],
        policies: [],
        context: evalContext(context, resource, this.clock.now()),
      })
    }
    const now = this.clock.now()
    return this.uow.run(async (scope) => {
      const [grants, policies] = await Promise.all([
        this.store.effectiveGrants(scope, context.membershipId as string, now),
        this.store.activePolicies(scope),
      ])
      return decide({ permission, grants, policies, context: evalContext(context, resource, now) })
    }, context)
  }

  /** Lança 403 se não for permitido. A razão detalhada não vai para o cliente (só para os logs). */
  async require(
    context: TenantContext,
    permission: string,
    resource: Record<string, unknown> = {}
  ): Promise<Decision> {
    const decision = await this.decision(context, permission, resource)
    if (!decision.allowed) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Não tem permissão para esta operação.')
    }
    return decision
  }
}

/** Permissões efectivas (para a interface). Conveniência visual: o servidor volta a verificar sempre. */
export class ListEffectivePermissions {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly store: IamStore,
    private readonly clock: Clock
  ) {}

  async execute(context: TenantContext): Promise<{ code: string; unitScoped: boolean }[]> {
    if (!context.membershipId) return []
    const grants = await this.uow.run(
      (scope) =>
        this.store.effectiveGrants(scope, context.membershipId as string, this.clock.now()),
      context
    )
    const byCode = new Map<string, boolean>()
    for (const g of grants)
      byCode.set(g.permissionCode, (byCode.get(g.permissionCode) ?? true) && g.unitId !== null)
    return [...byCode]
      .map(([code, unitScoped]) => ({ code, unitScoped }))
      .sort((a, b) => a.code.localeCompare(b.code))
  }
}

/** "O que este utilizador pode fazer?" Não concede nem altera nada. */
export class SimulateAuthorization {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly store: IamStore,
    private readonly memberships: MembershipStore,
    private readonly clock: Clock
  ) {}

  async execute(
    context: TenantContext,
    input: { membershipId: string; permission: string; resource?: Record<string, unknown> }
  ): Promise<Decision> {
    if (!isValidPermissionCode(input.permission)) {
      throw validation([
        {
          path: 'permission',
          code: 'INVALID_PERMISSION',
          message: 'Código de permissão inválido.',
        },
      ])
    }
    const now = this.clock.now()
    return this.uow.run(async (scope) => {
      const membership = await this.memberships.findById(scope, input.membershipId)
      if (!membership) throw ApiError.notFound('Membership não encontrada.')
      const grants = grantsAccess(membership)
        ? await this.store.effectiveGrants(scope, membership.id, now)
        : []
      const policies = await this.store.activePolicies(scope)
      return decide({
        permission: input.permission,
        grants,
        policies,
        context: {
          subject: {
            membershipId: membership.id,
            userId: membership.userId,
            organizationId: membership.defaultOrganizationId,
          },
          resource: input.resource ?? {},
          env: { now: now.toISOString() },
        },
      })
    }, context)
  }
}

export class ListPermissions {
  constructor(private readonly catalog: PermissionCatalogStore) {}
  execute(): Promise<PermissionRecord[]> {
    return this.catalog.list()
  }
}

// --- papéis --------------------------------------------------------------------------------------

function checkPermissionCodes(codes: string[], path = 'permissionCodes') {
  const unknown = codes.filter((c) => !KNOWN_CODES.has(c))
  if (unknown.length > 0) {
    throw validation(
      unknown.map((c) => ({
        path,
        code: 'UNKNOWN_PERMISSION',
        message: `Permissão desconhecida: ${c}.`,
      }))
    )
  }
}

export class RoleUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly store: IamStore,
    private readonly memberships: MembershipStore
  ) {}

  list(context: TenantContext): Promise<RoleView[]> {
    return this.uow.run((scope) => this.store.listRoles(scope), context)
  }

  get(context: TenantContext, id: string): Promise<RoleView> {
    return this.uow.run(async (scope) => {
      const role = await this.store.findRole(scope, id)
      if (!role) throw ApiError.notFound('Papel não encontrado.')
      return role
    }, context)
  }

  create(
    context: TenantContext,
    input: { code: string; name: string; description?: string | null; permissionCodes: string[] }
  ): Promise<RoleView> {
    const details: ApiErrorDetail[] = []
    if (!ROLE_CODE.test(input.code)) {
      details.push({
        path: 'code',
        code: 'INVALID_CODE',
        message: 'Use 2–60 caracteres: a-z, 0-9 e _.',
      })
    }
    if (!input.name.trim())
      details.push({ path: 'name', code: 'REQUIRED', message: 'Indique o nome.' })
    if (details.length > 0) throw validation(details)
    checkPermissionCodes(input.permissionCodes)

    return this.uow.run(async (scope) => {
      const role = await this.store.insertRole(scope, {
        code: input.code,
        name: input.name.trim(),
        description: input.description ?? null,
        isSystem: false,
        permissionCodes: [...new Set(input.permissionCodes)],
      })
      if (!role) throw ApiError.conflict('ROLE_CODE_TAKEN', 'Já existe um papel com este código.')
      return role
    }, context)
  }

  /** Papéis de sistema são imutáveis. Alterar permissões invalida a versão de quem tem o papel. */
  update(
    context: TenantContext,
    id: string,
    input: {
      expectedVersion: number
      name?: string
      description?: string | null
      permissionCodes?: string[]
    }
  ): Promise<RoleView> {
    if (input.permissionCodes) checkPermissionCodes(input.permissionCodes)
    return this.uow.run(async (scope) => {
      const role = await this.store.findRole(scope, id)
      if (!role) throw ApiError.notFound('Papel não encontrado.')
      if (role.isSystem) {
        throw ApiError.conflict(
          'SYSTEM_ROLE_IMMUTABLE',
          'Os papéis de sistema não podem ser alterados.'
        )
      }
      const updated = await this.store.updateRole(scope, id, input.expectedVersion, {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      })
      if (input.permissionCodes) {
        await this.store.setRolePermissions(scope, id, [...new Set(input.permissionCodes)])
        await this.memberships.bumpAuthorization(
          scope,
          await this.store.membershipsWithRole(scope, id)
        )
      }
      return (await this.store.findRole(scope, id)) ?? updated
    }, context)
  }

  delete(context: TenantContext, id: string): Promise<void> {
    return this.uow.run(async (scope) => {
      const role = await this.store.findRole(scope, id)
      if (!role) throw ApiError.notFound('Papel não encontrado.')
      if (role.isSystem) {
        throw ApiError.conflict(
          'SYSTEM_ROLE_IMMUTABLE',
          'Os papéis de sistema não podem ser removidos.'
        )
      }
      if ((await this.store.deleteRole(scope, id)) === 'IN_USE') {
        throw ApiError.conflict('ROLE_IN_USE', 'O papel ainda está atribuído a membros.')
      }
    }, context)
  }
}

// --- atribuições ---------------------------------------------------------------------------------

export class AssignmentUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly store: IamStore,
    private readonly memberships: MembershipStore
  ) {}

  list(context: TenantContext, membershipId?: string): Promise<AssignmentView[]> {
    return this.uow.run((scope) => this.store.listAssignments(scope, membershipId), context)
  }

  assign(
    context: TenantContext,
    input: {
      membershipId: string
      roleId: string
      organizationUnitId?: string | null
      validFrom?: Date | null
      validUntil?: Date | null
    }
  ): Promise<AssignmentView> {
    if (input.validFrom && input.validUntil && input.validUntil <= input.validFrom) {
      throw validation([
        {
          path: 'validUntil',
          code: 'INVALID_WINDOW',
          message: 'O fim tem de ser posterior ao início.',
        },
      ])
    }
    return this.uow.run(async (scope) => {
      // Membership e papel têm de existir *neste* tenant (um id alheio é 404).
      if (!(await this.memberships.findById(scope, input.membershipId))) {
        throw ApiError.notFound('Membership não encontrada.')
      }
      if (!(await this.store.findRole(scope, input.roleId))) {
        throw ApiError.notFound('Papel não encontrado.')
      }
      const assignment = await this.store.insertAssignment(scope, {
        membershipId: input.membershipId,
        roleId: input.roleId,
        organizationUnitId: input.organizationUnitId ?? null,
        validFrom: input.validFrom ?? null,
        validUntil: input.validUntil ?? null,
      })
      if (!assignment) throw ApiError.conflict('ASSIGNMENT_EXISTS', 'O papel já está atribuído.')
      await this.memberships.bumpAuthorization(scope, [input.membershipId])
      return assignment
    }, context)
  }

  revoke(context: TenantContext, assignmentId: string): Promise<void> {
    return this.uow.run(async (scope) => {
      const membershipId = await this.store.deleteAssignment(scope, assignmentId)
      if (!membershipId) throw ApiError.notFound('Atribuição não encontrada.')
      await this.memberships.bumpAuthorization(scope, [membershipId])
    }, context)
  }
}

// --- políticas -----------------------------------------------------------------------------------

function checkPolicy(input: Partial<PolicyInput>) {
  const details: ApiErrorDetail[] = []
  const target = /^(\*|[a-z][a-z0-9_]*)$/
  if (input.name !== undefined && !input.name.trim()) {
    details.push({ path: 'name', code: 'REQUIRED', message: 'Indique o nome.' })
  }
  if (input.resource !== undefined && !target.test(input.resource)) {
    details.push({
      path: 'resource',
      code: 'INVALID_RESOURCE',
      message: 'Recurso inválido (ou *).',
    })
  }
  if (input.action !== undefined && !target.test(input.action)) {
    details.push({ path: 'action', code: 'INVALID_ACTION', message: 'Acção inválida (ou *).' })
  }
  if (
    input.priority !== undefined &&
    !(Number.isInteger(input.priority) && Math.abs(input.priority) <= 1000)
  ) {
    details.push({
      path: 'priority',
      code: 'INVALID_PRIORITY',
      message: 'Prioridade entre -1000 e 1000.',
    })
  }
  if (input.condition) {
    for (const issue of validateCondition(input.condition)) {
      details.push({ ...issue, path: `condition${issue.path.slice(1)}` })
    }
  }
  input.fieldRules?.forEach((rule: FieldRule, i) => {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]{0,59}$/.test(rule.field) ||
      !['HIDDEN', 'READ_ONLY'].includes(rule.mode)
    ) {
      details.push({
        path: `fieldRules[${i}]`,
        code: 'INVALID_FIELD_RULE',
        message: 'Regra de campo inválida.',
      })
    }
    if (rule.when) {
      for (const issue of validateCondition(rule.when)) {
        details.push({ ...issue, path: `fieldRules[${i}].when${issue.path.slice(1)}` })
      }
    }
  })
  if (details.length > 0) throw validation(details)
}

export class PolicyUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly store: IamStore,
    private readonly memberships: MembershipStore
  ) {}

  list(context: TenantContext): Promise<PolicyView[]> {
    return this.uow.run((scope) => this.store.listPolicies(scope), context)
  }

  create(context: TenantContext, input: PolicyInput): Promise<PolicyView> {
    checkPolicy(input)
    return this.uow.run(async (scope) => {
      const policy = await this.store.insertPolicy(scope, input)
      await this.memberships.bumpAllAuthorization(scope)
      return policy
    }, context)
  }

  update(
    context: TenantContext,
    id: string,
    input: Partial<PolicyInput> & { expectedVersion: number }
  ): Promise<PolicyView> {
    const { expectedVersion, ...values } = input
    checkPolicy(values)
    return this.uow.run(async (scope) => {
      const policy = await this.store.updatePolicy(scope, id, expectedVersion, values)
      await this.memberships.bumpAllAuthorization(scope)
      return policy
    }, context)
  }
}

// --- arranque do catálogo e do papel de administrador ----------------------------------------------

export class SyncPermissionCatalog {
  constructor(private readonly catalog: PermissionCatalogStore) {}
  execute(): Promise<void> {
    return this.catalog.sync(PERMISSION_CATALOG)
  }
}

/**
 * Garante o papel de sistema `tenant_admin` com **todas** as permissões do catálogo (volta a sincronizar
 * quando o catálogo cresce) e, opcionalmente, atribui-o a uma membership. Idempotente.
 */
export class EnsureTenantAdmin {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly store: IamStore,
    private readonly memberships: MembershipStore
  ) {}

  async execute(context: TenantContext, membershipId?: string): Promise<RoleView> {
    const codes = PERMISSION_CATALOG.map((p) => p.code)
    return this.uow.run(async (scope) => {
      let role = await this.store.findRoleByCode(scope, TENANT_ADMIN_ROLE)
      if (!role) {
        role = await this.store.insertRole(scope, {
          code: TENANT_ADMIN_ROLE,
          name: 'Administrador do tenant',
          description: 'Todas as permissões do catálogo.',
          isSystem: true,
          permissionCodes: codes,
        })
      } else if (role.permissionCodes.length !== codes.length) {
        await this.store.setRolePermissions(scope, role.id, codes)
        await this.memberships.bumpAuthorization(
          scope,
          await this.store.membershipsWithRole(scope, role.id)
        )
      }
      if (!role) throw new Error('Não foi possível criar o papel de administrador.')

      if (membershipId) {
        if (!(await this.memberships.findById(scope, membershipId))) {
          throw ApiError.notFound('Membership não encontrada.')
        }
        const created = await this.store.insertAssignment(scope, {
          membershipId,
          roleId: role.id,
          organizationUnitId: null,
          validFrom: null,
          validUntil: null,
        })
        if (created) await this.memberships.bumpAuthorization(scope, [membershipId])
      }
      return (await this.store.findRole(scope, role.id)) as RoleView
    }, context)
  }
}
