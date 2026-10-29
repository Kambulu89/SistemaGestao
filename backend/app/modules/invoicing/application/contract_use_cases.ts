import { ApiError } from '#core/http/api_error'
import type { TenantContext, TenantUnitOfWork } from '#core/tenancy/index'
import {
  effectiveContractStatus,
  noticeDeadline,
  normalizeContract,
  type ContractInput,
  type ContractStatus,
  type Issue,
} from '#modules/invoicing/domain/invoicing'
import type { Contract, ContractStore, References } from '#modules/invoicing/application/ports'

const MAX_PAGE = 200

interface Clock {
  now(): Date
}

export type ContractView = Contract & {
  /** `EXPIRED` é derivado do fim; o estado gravado fica em `status`. */
  effectiveStatus: ContractStatus
  noticeDeadline: string | null
}

export const invoicingValidation = (details: Issue[]) =>
  new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', details)

/**
 * Contratos (M05): rascunho → activo (com número) → terminado, e expirado por derivação quando o fim passa. Depois de
 * activo, a contraparte, o tipo, o início e a moeda não mudam; o resto (valor, fim, renovação, aviso) pode ser revisto.
 */
export class ContractUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly contracts: ContractStore,
    private readonly references: References,
    private readonly clock: Clock
  ) {}

  private today(): string {
    return this.clock.now().toISOString().slice(0, 10)
  }

  private view(contract: Contract): ContractView {
    return {
      ...contract,
      effectiveStatus: effectiveContractStatus(contract.status, contract.endDate, this.today()),
      noticeDeadline: noticeDeadline(contract.endDate, contract.noticeDays),
    }
  }

  async list(
    context: TenantContext,
    filter: {
      partyId?: string
      type?: string
      status?: string
      q?: string
      limit?: number
      offset?: number
    }
  ) {
    const { items, total } = await this.uow.run(
      (scope) =>
        this.contracts.list(scope, {
          ...filter,
          today: this.today(),
          limit: Math.min(filter.limit ?? 50, MAX_PAGE),
          offset: filter.offset ?? 0,
        }),
      context
    )
    return { items: items.map((c) => this.view(c)), total }
  }

  get(context: TenantContext, id: string): Promise<ContractView> {
    return this.uow.run(async (scope) => {
      const contract = await this.contracts.find(scope, id)
      if (!contract) throw ApiError.notFound()
      return this.view(contract)
    }, context)
  }

  async create(context: TenantContext, input: ContractInput): Promise<ContractView> {
    const issues: Issue[] = []
    const organizationId = typeof input.organizationId === 'string' ? input.organizationId : ''
    const currency = organizationId
      ? await this.references.organizationCurrency(context, organizationId)
      : null
    if (organizationId && currency === null) {
      issues.push({
        path: 'organizationId',
        code: 'UNKNOWN_ORGANIZATION',
        message: 'A organização não existe.',
      })
    }
    const values = normalizeContract(input, null, currency ?? 'AOA', issues)
    if (!values || issues.length > 0) throw invoicingValidation(issues)
    if (!(await this.references.partyExists(context, values.partyId))) {
      throw invoicingValidation([
        { path: 'partyId', code: 'UNKNOWN_PARTY', message: 'A contraparte não existe.' },
      ])
    }
    return this.uow.run(
      async (scope) => this.view(await this.contracts.insert(scope, values)),
      context
    )
  }

  update(
    context: TenantContext,
    id: string,
    input: ContractInput & { expectedVersion: number }
  ): Promise<ContractView> {
    return this.uow.run(async (scope) => {
      const current = await this.contracts.find(scope, id, true)
      if (!current) throw ApiError.notFound()
      if (current.status === 'TERMINATED') {
        throw ApiError.conflict('CONTRACT_TERMINATED', 'Um contrato terminado não se altera.')
      }
      const issues: Issue[] = []
      const values = normalizeContract(input, current, current.currency, issues)
      if (!values) throw invoicingValidation(issues)
      if (current.status === 'ACTIVE') {
        const frozen = (
          ['organizationId', 'partyId', 'type', 'startDate', 'currency'] as const
        ).filter((key) => values[key] !== current[key])
        if (frozen.length > 0) {
          throw ApiError.conflict(
            'CONTRACT_FIELD_LOCKED',
            'Num contrato activo não se mudam a contraparte, o tipo, o início nem a moeda.',
            frozen.map((path) => ({
              path,
              code: 'LOCKED',
              message: 'Campo bloqueado depois da activação.',
            }))
          )
        }
      } else if (
        values.partyId !== current.partyId &&
        !(await this.references.partyExists(context, values.partyId))
      ) {
        throw invoicingValidation([
          { path: 'partyId', code: 'UNKNOWN_PARTY', message: 'A contraparte não existe.' },
        ])
      }
      return this.view(await this.contracts.update(scope, id, input.expectedVersion, values))
    }, context)
  }

  /** Activa o contrato e atribui o número. Idempotente: activar um activo devolve-o. */
  activate(
    context: TenantContext,
    id: string
  ): Promise<{ contract: ContractView; idempotent: boolean }> {
    return this.uow.run(async (scope) => {
      const contract = await this.contracts.find(scope, id, true)
      if (!contract) throw ApiError.notFound()
      if (contract.status === 'ACTIVE') return { contract: this.view(contract), idempotent: true }
      if (contract.status === 'TERMINATED') {
        throw ApiError.conflict('CONTRACT_TERMINATED', 'Um contrato terminado não se reactiva.')
      }
      const number = await this.references.issueNumber(scope, {
        organizationId: contract.organizationId,
        documentType: 'CONTRACT',
        date: this.clock.now(),
      })
      return {
        contract: this.view(await this.contracts.activate(scope, id, number)),
        idempotent: false,
      }
    }, context)
  }

  /** Termina um contrato activo, com motivo. Idempotente. */
  terminate(
    context: TenantContext,
    id: string,
    reason: unknown
  ): Promise<{ contract: ContractView; idempotent: boolean }> {
    const text = typeof reason === 'string' ? reason.trim() : ''
    if (!text || text.length > 300) {
      throw invoicingValidation([
        {
          path: 'reason',
          code: 'REASON_REQUIRED',
          message: 'Indique o motivo (até 300 caracteres).',
        },
      ])
    }
    return this.uow.run(async (scope) => {
      const contract = await this.contracts.find(scope, id, true)
      if (!contract) throw ApiError.notFound()
      if (contract.status === 'TERMINATED')
        return { contract: this.view(contract), idempotent: true }
      if (contract.status !== 'ACTIVE') {
        throw ApiError.conflict('CONTRACT_NOT_ACTIVE', 'Só um contrato activo se termina.')
      }
      return {
        contract: this.view(await this.contracts.terminate(scope, id, text)),
        idempotent: false,
      }
    }, context)
  }
}
