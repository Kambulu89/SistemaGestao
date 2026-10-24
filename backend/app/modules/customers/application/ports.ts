import type { TenantContext, TenantScope } from '#core/tenancy/index'
import type {
  CustomerStatus,
  CustomerValues,
  InteractionValues,
  SegmentValues,
} from '#modules/customers/domain/customers'

interface Audited {
  id: string
  version: number
  createdAt: Date
  updatedAt: Date
}

export interface Segment extends Audited, SegmentValues {}

/** O cliente com o que a lista precisa da Party e do segmento (lido, nunca escrito, nesta consulta). */
export interface Customer extends Audited, CustomerValues {
  partyName: string
  partyKind: string
  taxId: string | null
  segmentName: string | null
}

export interface Interaction extends Audited, InteractionValues {}

export interface CustomerFilter {
  /** Nome da Party, código do cliente ou NIF. */
  q?: string
  segmentId?: string
  accountManagerMembershipId?: string
  organizationId?: string
  partyId?: string
  status?: CustomerStatus
  limit: number
  offset: number
}

export interface SegmentStore {
  list(scope: TenantScope): Promise<Segment[]>
  find(scope: TenantScope, id: string): Promise<Segment | null>
  /** `null` se o código já existir. */
  insert(scope: TenantScope, values: SegmentValues): Promise<Segment | null>
  update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: SegmentValues
  ): Promise<Segment>
}

export interface CustomerStore {
  list(scope: TenantScope, filter: CustomerFilter): Promise<{ items: Customer[]; total: number }>
  find(scope: TenantScope, id: string): Promise<Customer | null>
  /** `'CODE'` / `'PARTY'` se o código ou a Party (nessa organização) já existir. */
  insert(scope: TenantScope, values: CustomerValues): Promise<Customer | 'CODE' | 'PARTY'>
  update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: CustomerValues
  ): Promise<Customer>
}

export interface InteractionStore {
  list(
    scope: TenantScope,
    filter: {
      partyId?: string
      ownerMembershipId?: string
      followUpBefore?: string
      limit: number
      offset: number
    }
  ): Promise<{ items: Interaction[]; total: number }>
  find(scope: TenantScope, id: string): Promise<Interaction | null>
  insert(scope: TenantScope, values: InteractionValues): Promise<Interaction>
  update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: InteractionValues
  ): Promise<Interaction>
}

/** Referências a outros módulos, vistas pelas suas APIs públicas. */
export interface References {
  partyExists(context: TenantContext, partyId: string): Promise<boolean>
  /** A moeda base da organização, ou `null` se não existir. */
  organizationCurrency(context: TenantContext, organizationId: string): Promise<string | null>
  /** Membership activa do tenant (gestor de conta, responsável de interacção). */
  membershipActive(scope: TenantScope, membershipId: string): Promise<boolean>
}
