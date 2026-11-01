import { ApiError, type ApiErrorDetail } from '#core/http/api_error'
import type { TenantContext, TenantScope, TenantUnitOfWork } from '#core/tenancy/index'
import { wouldCreateCycle } from '#core/organization/domain/organization'
import {
  normalizePosition,
  type Position,
  type PositionIssue,
  type PositionStatus,
  type PositionValues,
} from '#core/organization/domain/position'
import type { OrganizationStore } from '#core/organization/application/ports'

export interface PositionFilter {
  departmentId?: string
  status?: PositionStatus
  q?: string
  limit: number
  offset: number
}

export interface PositionStore {
  list(scope: TenantScope, filter: PositionFilter): Promise<Position[]>
  find(scope: TenantScope, id: string): Promise<Position | null>
  /** `null` se o código já existir no tenant. */
  insert(scope: TenantScope, values: PositionValues): Promise<Position | null>
  update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: Partial<Omit<PositionValues, 'code'>>
  ): Promise<Position>
  parents(scope: TenantScope): Promise<Map<string, string | null>>
  activeChildren(scope: TenantScope, id: string): Promise<number>
}

const validation = (details: ApiErrorDetail[]) =>
  new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', details)

/** Unidades onde um cargo pode ter o seu departamento por omissão. */
const DEPARTMENT_TYPES = new Set(['DEPARTMENT', 'SECTION', 'TEAM'])

/**
 * Cargos e funções. O código é único no tenant e imutável; a hierarquia de cargos não tem ciclos (verificados sob o
 * lock da estrutura organizacional); um cargo com subordinados activos não se desactiva. Não há eliminação: um cargo
 * que deixa de existir passa a INACTIVE e o histórico (auditoria) mantém-se.
 */
export class PositionUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly store: PositionStore,
    private readonly organization: OrganizationStore
  ) {}

  list(context: TenantContext, filter: PositionFilter): Promise<Position[]> {
    return this.uow.run((scope) => this.store.list(scope, filter), context)
  }

  get(context: TenantContext, id: string): Promise<Position> {
    return this.uow.run(async (scope) => {
      const position = await this.store.find(scope, id)
      if (!position) throw ApiError.notFound('Cargo não encontrado.')
      return position
    }, context)
  }

  create(context: TenantContext, input: Record<string, unknown>): Promise<Position> {
    const issues: PositionIssue[] = []
    const values = normalizePosition(input, false, issues) as PositionValues
    if (issues.length > 0) throw validation(issues)
    return this.uow.run(async (scope) => {
      await this.organization.lockStructure(scope)
      await this.checkReferences(scope, values, null)
      const created = await this.store.insert(scope, values)
      if (!created) {
        throw ApiError.conflict('POSITION_CODE_TAKEN', 'Já existe um cargo com este código.')
      }
      return created
    }, context)
  }

  update(
    context: TenantContext,
    id: string,
    input: Record<string, unknown> & { expectedVersion: number }
  ): Promise<Position> {
    const issues: PositionIssue[] = []
    const { expectedVersion, ...rest } = input
    if ('code' in rest) {
      issues.push({ path: 'code', code: 'IMMUTABLE', message: 'O código não se altera.' })
    }
    const values = normalizePosition(rest, true, issues)
    if (issues.length > 0) throw validation(issues)
    return this.uow.run(async (scope) => {
      await this.organization.lockStructure(scope)
      const current = await this.store.find(scope, id)
      if (!current) throw ApiError.notFound('Cargo não encontrado.')
      await this.checkReferences(scope, values, id)
      if (values.status === 'INACTIVE' && current.status === 'ACTIVE') {
        if ((await this.store.activeChildren(scope, id)) > 0) {
          throw ApiError.conflict(
            'POSITION_HAS_SUBORDINATES',
            'Há cargos activos que reportam a este: reafecte-os antes de o desactivar.'
          )
        }
      }
      return this.store.update(scope, id, expectedVersion, values)
    }, context)
  }

  private async checkReferences(
    scope: TenantScope,
    values: Partial<PositionValues>,
    id: string | null
  ) {
    if (values.departmentId) {
      const unit = await this.organization.findUnit(scope, values.departmentId)
      // Unidade de outro tenant é simplesmente inexistente (o RLS e o filtro não a devolvem).
      if (!unit || !DEPARTMENT_TYPES.has(unit.type)) {
        throw validation([
          {
            path: 'departmentId',
            code: 'INVALID_DEPARTMENT',
            message: 'Indique um departamento, secção ou equipa existente.',
          },
        ])
      }
    }
    if (values.parentId) {
      const parent = await this.store.find(scope, values.parentId)
      if (!parent) {
        throw validation([
          { path: 'parentId', code: 'INVALID_PARENT', message: 'O cargo superior não existe.' },
        ])
      }
      if (id && wouldCreateCycle(await this.store.parents(scope), id, values.parentId)) {
        throw validation([
          {
            path: 'parentId',
            code: 'INVALID_PARENT',
            message: 'Um cargo não pode reportar a si próprio nem a um subordinado.',
          },
        ])
      }
    }
  }
}
