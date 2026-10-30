import { ApiError, type ApiErrorDetail } from '#core/http/api_error'
import type { TenantContext, TenantUnitOfWork } from '#core/tenancy/index'
import type { MembershipStore } from '#core/membership/index'
import {
  UNIT_TYPES,
  isValidNodeCode,
  organizationIssues,
  wouldCreateCycle,
  type CostCenter,
  type MembershipScope,
  type Organization,
  type OrganizationUnit,
  type TeamMember,
} from '#core/organization/domain/organization'
import type {
  CostCenterValues,
  OrganizationStore,
  OrganizationValues,
  UnitValues,
} from '#core/organization/application/ports'

const validation = (details: ApiErrorDetail[]) =>
  new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', details)

const invalidParent = (message: string) =>
  validation([{ path: 'parentId', code: 'INVALID_PARENT', message }])

// --- organizações --------------------------------------------------------------------------------

export class OrganizationUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly store: OrganizationStore
  ) {}

  list(context: TenantContext): Promise<Organization[]> {
    return this.uow.run((scope) => this.store.listOrganizations(scope), context)
  }

  get(context: TenantContext, id: string): Promise<Organization> {
    return this.uow.run(async (scope) => {
      const organization = await this.store.findOrganization(scope, id)
      if (!organization) throw ApiError.notFound('Organização não encontrada.')
      return organization
    }, context)
  }

  create(context: TenantContext, input: OrganizationValues): Promise<Organization> {
    const issues = organizationIssues(input)
    if (issues.length > 0) throw validation(issues)
    return this.uow.run(async (scope) => {
      const created = await this.store.insertOrganization(scope, {
        ...input,
        legalName: input.legalName.trim(),
      })
      if (!created)
        throw ApiError.conflict(
          'ORGANIZATION_CODE_TAKEN',
          'Já existe uma organização com este código.'
        )
      return created
    }, context)
  }

  /**
   * O código não muda. A moeda base e o país só podem mudar enquanto não houver lançamentos; como
   * ainda não existem documentos nem movimentos, a regra fica registada em docs/decisions.md (D-025)
   * e passa a ser imposta pelos módulos financeiros quando existirem (processo de migração controlado).
   */
  update(
    context: TenantContext,
    id: string,
    input: { expectedVersion: number } & Partial<Omit<OrganizationValues, 'code'>>
  ): Promise<Organization> {
    const { expectedVersion, ...values } = input
    const issues = organizationIssues(values, true)
    if (issues.length > 0) throw validation(issues)
    return this.uow.run(
      (scope) => this.store.updateOrganization(scope, id, expectedVersion, values),
      context
    )
  }
}

// --- unidades ------------------------------------------------------------------------------------

export class UnitUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly store: OrganizationStore,
    private readonly memberships: MembershipStore
  ) {}

  list(context: TenantContext, organizationId?: string): Promise<OrganizationUnit[]> {
    return this.uow.run((scope) => this.store.listUnits(scope, organizationId), context)
  }

  get(context: TenantContext, id: string): Promise<OrganizationUnit> {
    return this.uow.run(async (scope) => {
      const unit = await this.store.findUnit(scope, id)
      if (!unit) throw ApiError.notFound('Unidade não encontrada.')
      return unit
    }, context)
  }

  create(context: TenantContext, input: UnitValues): Promise<OrganizationUnit> {
    this.checkFields(input)
    return this.uow.run(async (scope) => {
      await this.store.lockStructure(scope)
      if (!(await this.store.findOrganization(scope, input.organizationId))) {
        throw ApiError.notFound('Organização não encontrada.')
      }
      if (input.parentId) {
        const parents = await this.store.unitParents(scope, input.organizationId)
        if (!parents.has(input.parentId)) {
          throw invalidParent('A unidade pai não existe nesta organização.')
        }
      }
      await this.checkManager(scope, input.managerMembershipId)
      const created = await this.store.insertUnit(scope, input)
      if (!created)
        throw ApiError.conflict(
          'UNIT_CODE_TAKEN',
          'Já existe uma unidade com este código na organização.'
        )
      return created
    }, context)
  }

  /** A organização e o código não mudam. Mudar o pai rejeita ciclos (a unidade nunca é pai de si nem de um antepassado). */
  update(
    context: TenantContext,
    id: string,
    input: { expectedVersion: number } & Partial<Omit<UnitValues, 'organizationId' | 'code'>>
  ): Promise<OrganizationUnit> {
    const { expectedVersion, ...values } = input
    this.checkFields(values, true)
    return this.uow.run(async (scope) => {
      await this.store.lockStructure(scope)
      const current = await this.store.findUnit(scope, id)
      if (!current) throw ApiError.notFound('Unidade não encontrada.')

      if (values.parentId !== undefined && values.parentId !== current.parentId) {
        const parents = await this.store.unitParents(scope, current.organizationId)
        if (values.parentId !== null && !parents.has(values.parentId)) {
          throw invalidParent('A unidade pai não existe nesta organização.')
        }
        if (wouldCreateCycle(parents, id, values.parentId)) {
          throw invalidParent('Uma unidade não pode ser pai de si própria nem de um antepassado.')
        }
      }
      if (values.managerMembershipId) await this.checkManager(scope, values.managerMembershipId)
      return this.store.updateUnit(scope, id, expectedVersion, values)
    }, context)
  }

  private checkFields(input: Partial<UnitValues>, partial = false) {
    const details: ApiErrorDetail[] = []
    if (!partial && !isValidNodeCode(input.code ?? '')) {
      details.push({
        path: 'code',
        code: 'INVALID_CODE',
        message: 'Código inválido (letras, dígitos, _ . -; máx. 40).',
      })
    }
    if ((!partial || input.name !== undefined) && !(input.name ?? '').trim()) {
      details.push({ path: 'name', code: 'REQUIRED', message: 'Indique o nome.' })
    }
    if (input.type !== undefined && !(UNIT_TYPES as readonly string[]).includes(input.type)) {
      details.push({ path: 'type', code: 'INVALID_TYPE', message: 'Tipo de unidade inválido.' })
    }
    if (details.length > 0) throw validation(details)
  }

  private async checkManager(
    scope: Parameters<MembershipStore['findById']>[0],
    membershipId: string | null
  ) {
    if (membershipId && !(await this.memberships.findById(scope, membershipId))) {
      throw validation([
        {
          path: 'managerMembershipId',
          code: 'NOT_FOUND',
          message: 'Membership inexistente neste tenant.',
        },
      ])
    }
  }
}

// --- centros de custo ----------------------------------------------------------------------------

export class CostCenterUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly store: OrganizationStore,
    private readonly memberships: MembershipStore
  ) {}

  list(context: TenantContext, organizationId?: string): Promise<CostCenter[]> {
    return this.uow.run((scope) => this.store.listCostCenters(scope, organizationId), context)
  }

  create(context: TenantContext, input: CostCenterValues): Promise<CostCenter> {
    if (!isValidNodeCode(input.code) || !input.name.trim()) {
      throw validation([
        { path: 'code', code: 'INVALID_CODE', message: 'Código e nome são obrigatórios.' },
      ])
    }
    return this.uow.run(async (scope) => {
      await this.store.lockStructure(scope)
      if (!(await this.store.findOrganization(scope, input.organizationId))) {
        throw ApiError.notFound('Organização não encontrada.')
      }
      if (input.parentId) {
        // Um centro de custo pai de outra organização é rejeitado.
        const parents = await this.store.costCenterParents(scope, input.organizationId)
        if (!parents.has(input.parentId)) {
          throw invalidParent('O centro de custo pai não existe nesta organização.')
        }
      }
      if (
        input.responsibleMembershipId &&
        !(await this.memberships.findById(scope, input.responsibleMembershipId))
      ) {
        throw validation([
          {
            path: 'responsibleMembershipId',
            code: 'NOT_FOUND',
            message: 'Membership inexistente neste tenant.',
          },
        ])
      }
      const created = await this.store.insertCostCenter(scope, input)
      if (!created)
        throw ApiError.conflict(
          'COST_CENTER_CODE_TAKEN',
          'Já existe um centro de custo com este código na organização.'
        )
      return created
    }, context)
  }

  update(
    context: TenantContext,
    id: string,
    input: { expectedVersion: number } & Partial<Omit<CostCenterValues, 'organizationId' | 'code'>>
  ): Promise<CostCenter> {
    const { expectedVersion, ...values } = input
    return this.uow.run(async (scope) => {
      await this.store.lockStructure(scope)
      const current = await this.store.findCostCenter(scope, id)
      if (!current) throw ApiError.notFound('Centro de custo não encontrado.')
      if (values.parentId !== undefined && values.parentId !== current.parentId) {
        const parents = await this.store.costCenterParents(scope, current.organizationId)
        if (values.parentId !== null && !parents.has(values.parentId)) {
          throw invalidParent('O centro de custo pai não existe nesta organização.')
        }
        if (wouldCreateCycle(parents, id, values.parentId)) {
          throw invalidParent(
            'Um centro de custo não pode ser pai de si próprio nem de um antepassado.'
          )
        }
      }
      if (
        values.responsibleMembershipId &&
        !(await this.memberships.findById(scope, values.responsibleMembershipId))
      ) {
        throw validation([
          {
            path: 'responsibleMembershipId',
            code: 'NOT_FOUND',
            message: 'Membership inexistente neste tenant.',
          },
        ])
      }
      return this.store.updateCostCenter(scope, id, expectedVersion, values)
    }, context)
  }
}

// --- equipas -------------------------------------------------------------------------------------

export class TeamUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly store: OrganizationStore,
    private readonly memberships: MembershipStore
  ) {}

  list(context: TenantContext, unitId: string): Promise<TeamMember[]> {
    return this.uow.run(async (scope) => {
      if (!(await this.store.findUnit(scope, unitId)))
        throw ApiError.notFound('Unidade não encontrada.')
      return this.store.listTeamMembers(scope, unitId)
    }, context)
  }

  add(
    context: TenantContext,
    input: {
      unitId: string
      membershipId: string
      startsOn: string
      endsOn: string | null
      roleLabel: string | null
    }
  ): Promise<TeamMember> {
    if (input.endsOn !== null && input.endsOn < input.startsOn) {
      throw validation([
        {
          path: 'endsOn',
          code: 'INVALID_WINDOW',
          message: 'O fim não pode ser anterior ao início.',
        },
      ])
    }
    return this.uow.run(async (scope) => {
      const unit = await this.store.findUnit(scope, input.unitId)
      if (!unit) throw ApiError.notFound('Unidade não encontrada.')
      if (!unit.active) {
        throw ApiError.conflict(
          'UNIT_INACTIVE',
          'A unidade está inactiva e não aceita novos registos.'
        )
      }
      if (!(await this.memberships.findById(scope, input.membershipId))) {
        throw ApiError.notFound('Membership não encontrada.')
      }
      return this.store.insertTeamMember(scope, input)
    }, context)
  }

  remove(context: TenantContext, id: string): Promise<void> {
    return this.uow.run(async (scope) => {
      if (!(await this.store.deleteTeamMember(scope, id)))
        throw ApiError.notFound('Registo não encontrado.')
    }, context)
  }
}

// --- âmbitos de acesso (MembershipScope) -----------------------------------------------------------

export class ScopeUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly store: OrganizationStore,
    private readonly memberships: MembershipStore
  ) {}

  list(context: TenantContext, membershipId?: string): Promise<MembershipScope[]> {
    return this.uow.run((scope) => this.store.listScopes(scope, membershipId), context)
  }

  /** Dá acesso a uma organização inteira (sem `organizationUnitId`) ou a uma unidade (com ou sem descendentes). */
  add(
    context: TenantContext,
    input: {
      membershipId: string
      organizationId: string
      organizationUnitId: string | null
      includeDescendants: boolean
    }
  ): Promise<MembershipScope> {
    return this.uow.run(async (scope) => {
      if (!(await this.memberships.findById(scope, input.membershipId))) {
        throw ApiError.notFound('Membership não encontrada.')
      }
      if (!(await this.store.findOrganization(scope, input.organizationId))) {
        throw ApiError.notFound('Organização não encontrada.')
      }
      if (input.organizationUnitId) {
        const unit = await this.store.findUnit(scope, input.organizationUnitId)
        if (!unit || unit.organizationId !== input.organizationId) {
          throw validation([
            {
              path: 'organizationUnitId',
              code: 'NOT_IN_ORGANIZATION',
              message: 'A unidade não pertence a esta organização.',
            },
          ])
        }
      }
      const created = await this.store.insertScope(scope, input)
      if (!created) throw ApiError.conflict('SCOPE_EXISTS', 'Este âmbito já está atribuído.')
      // Alterar o âmbito altera o que a membership pode ver: invalida a versão de autorização.
      await this.memberships.bumpAuthorization(scope, [input.membershipId])
      return created
    }, context)
  }

  remove(context: TenantContext, id: string): Promise<void> {
    return this.uow.run(async (scope) => {
      const membershipId = await this.store.deleteScope(scope, id)
      if (!membershipId) throw ApiError.notFound('Âmbito não encontrado.')
      await this.memberships.bumpAuthorization(scope, [membershipId])
    }, context)
  }
}

/** Unidades acessíveis à membership (âmbitos expandidos). Usado ao construir o `TenantContext`. */
export class ResolveUnitScope {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly store: OrganizationStore
  ) {}

  execute(context: TenantContext, membershipId: string): Promise<string[]> {
    return this.uow.run((scope) => this.store.expandUnitScope(scope, membershipId), context)
  }
}
