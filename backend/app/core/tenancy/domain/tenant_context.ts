/**
 * Contexto de tenant de um pedido, job ou consumidor. É **imutável** e só é criado depois de o
 * servidor ter autenticado a identidade e validado a membership (pipeline da spec §10.1). Nunca é
 * construído a partir de um `tenant_id` enviado pelo cliente sem essa validação.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const ACTOR_TYPES = ['USER', 'SERVICE', 'SUPPORT'] as const
export type ActorType = (typeof ACTOR_TYPES)[number]

/** Unidades organizacionais a que o actor tem acesso: todas as do tenant ou uma lista explícita. */
export type UnitScope =
  { readonly kind: 'ALL' } | { readonly kind: 'UNITS'; readonly unitIds: readonly string[] }

export interface TenantContextProps {
  tenantId: string
  userId?: string | null
  membershipId?: string | null
  organizationId?: string | null
  unitScope: UnitScope
  actorType: ActorType
  /** Versão de autorização da membership: uma alteração de acessos invalida decisões em cache. */
  permissionsVersion: number
  correlationId: string
  locale: string
}

/** Operação de domínio sem contexto de tenant: falha em vez de assumir um tenant por omissão. */
export class MissingTenantContextError extends Error {
  constructor() {
    super('Operação de tenant sem contexto de tenant válido.')
    this.name = 'MissingTenantContextError'
  }
}

export class InvalidTenantContextError extends Error {
  constructor(reason: string) {
    super(`Contexto de tenant inválido: ${reason}`)
    this.name = 'InvalidTenantContextError'
  }
}

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value)

function optionalUuid(name: string, value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null
  if (!isUuid(value)) throw new InvalidTenantContextError(`${name} não é um UUID`)
  return value
}

export class TenantContext {
  readonly tenantId: string
  readonly userId: string | null
  readonly membershipId: string | null
  readonly organizationId: string | null
  readonly unitScope: UnitScope
  readonly actorType: ActorType
  readonly permissionsVersion: number
  readonly correlationId: string
  readonly locale: string

  private constructor(props: TenantContextProps) {
    this.tenantId = props.tenantId
    this.userId = optionalUuid('userId', props.userId)
    this.membershipId = optionalUuid('membershipId', props.membershipId)
    this.organizationId = optionalUuid('organizationId', props.organizationId)
    this.unitScope =
      props.unitScope.kind === 'ALL'
        ? Object.freeze({ kind: 'ALL' })
        : Object.freeze({ kind: 'UNITS', unitIds: Object.freeze([...props.unitScope.unitIds]) })
    this.actorType = props.actorType
    this.permissionsVersion = props.permissionsVersion
    this.correlationId = props.correlationId
    this.locale = props.locale
    Object.freeze(this)
  }

  /** Valida e cria o contexto. Qualquer inconsistência lança `InvalidTenantContextError`. */
  static create(props: TenantContextProps): TenantContext {
    if (!isUuid(props.tenantId)) throw new InvalidTenantContextError('tenantId não é um UUID')
    if (!ACTOR_TYPES.includes(props.actorType)) {
      throw new InvalidTenantContextError('actorType desconhecido')
    }
    if (!Number.isInteger(props.permissionsVersion) || props.permissionsVersion < 0) {
      throw new InvalidTenantContextError('permissionsVersion tem de ser um inteiro ≥ 0')
    }
    if (!props.correlationId.trim()) throw new InvalidTenantContextError('falta o correlationId')
    if (!props.locale.trim()) throw new InvalidTenantContextError('falta o locale')
    if (props.unitScope.kind === 'UNITS') {
      if (props.unitScope.unitIds.some((id) => !isUuid(id))) {
        throw new InvalidTenantContextError('unitScope contém um id que não é UUID')
      }
    } else if (props.unitScope.kind !== 'ALL') {
      throw new InvalidTenantContextError('unitScope desconhecido')
    }

    const context = new TenantContext(props)
    if (context.actorType === 'USER' && (!context.userId || !context.membershipId)) {
      throw new InvalidTenantContextError('um utilizador exige userId e membershipId')
    }
    if (context.actorType === 'SUPPORT' && !context.userId) {
      throw new InvalidTenantContextError('o suporte exige userId')
    }
    if (context.actorType === 'SERVICE' && context.userId) {
      throw new InvalidTenantContextError('um actor de serviço não tem userId')
    }
    return context
  }
}
