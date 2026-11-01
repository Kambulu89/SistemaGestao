import type { TenantScope } from '#core/tenancy/index'
import type { ScopeRef, StoredValue } from '#core/settings/domain/setting'
import type { ConvertibleUnit } from '#core/settings/domain/units'

export interface OrganizationRef {
  id: string
  code: string
}

export interface BranchRef {
  id: string
  code: string
  organizationId: string
  type: string
}

/** Consultas de leitura às entidades a que as configurações se referem (sempre dentro do tenant). */
export interface ReferenceLookup {
  organization(scope: TenantScope, id: string): Promise<OrganizationRef | null>
  branch(scope: TenantScope, id: string): Promise<BranchRef | null>
  membershipExists(scope: TenantScope, id: string): Promise<boolean>
}

export interface SettingStore {
  list(scope: TenantScope, filter: { key?: string; scopeType?: string }): Promise<StoredValue[]>
  /** Todos os valores das chaves que podem aplicar-se ao contexto. */
  forResolution(scope: TenantScope): Promise<StoredValue[]>
  find(scope: TenantScope, key: string, ref: ScopeRef): Promise<StoredValue | null>
  insert(scope: TenantScope, key: string, ref: ScopeRef, value: unknown): Promise<StoredValue>
  /** `null` se a versão já não for a esperada (ou a linha desapareceu). */
  update(
    scope: TenantScope,
    key: string,
    ref: ScopeRef,
    value: unknown,
    expectedVersion: number
  ): Promise<StoredValue | null>
  delete(scope: TenantScope, key: string, ref: ScopeRef): Promise<boolean>
  /** Serializa as alterações de configuração do tenant. */
  lock(scope: TenantScope): Promise<void>
}

export interface TaxRate {
  id: string
  organizationId: string
  code: string
  name: string
  /** Percentagem como decimal em string. */
  rate: string
  validFrom: string
  validTo: string | null
  category: string
  exemptionReason: string | null
  version: number
}

export interface TaxRateValues {
  organizationId: string
  code: string
  name: string
  rate: string
  validFrom: string
  validTo: string | null
  category: string
  exemptionReason: string | null
}

export interface TaxRateStore {
  list(
    scope: TenantScope,
    filter: { organizationId?: string; code?: string; on?: string }
  ): Promise<TaxRate[]>
  find(scope: TenantScope, id: string): Promise<TaxRate | null>
  /** `'OVERLAP'` se o período se sobrepuser a outro do mesmo código e organização. */
  insert(scope: TenantScope, values: TaxRateValues): Promise<TaxRate | 'OVERLAP'>
  update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    patch: Partial<Pick<TaxRateValues, 'name' | 'validTo' | 'category' | 'exemptionReason'>>
  ): Promise<TaxRate | 'OVERLAP'>
}

export interface Unit extends ConvertibleUnit {
  id: string
  name: string
  version: number
}

export interface UnitValues {
  code: string
  name: string
  dimension: string
  precision: number
  baseUnitId: string | null
  factor: string | null
}

export interface UnitStore {
  lock(scope: TenantScope): Promise<void>
  list(scope: TenantScope): Promise<Unit[]>
  find(scope: TenantScope, id: string): Promise<Unit | null>
  findByCode(scope: TenantScope, code: string): Promise<Unit | null>
  /** `null` se o código já existir. */
  insert(scope: TenantScope, values: UnitValues): Promise<Unit | null>
  update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    patch: { name?: string; precision?: number }
  ): Promise<Unit>
}

export interface Sequence {
  id: string
  organizationId: string
  branchId: string | null
  documentType: string
  series: string
  period: string
  prefixTemplate: string
  /** Próximo número a emitir (bigint como string). */
  nextValue: string
  padding: number
  version: number
}

export interface SequenceValues {
  organizationId: string
  branchId: string | null
  documentType: string
  series: string
  period: string
  prefixTemplate: string
  nextValue: string
  padding: number
}

export interface SequenceStore {
  list(
    scope: TenantScope,
    filter: { organizationId?: string; documentType?: string }
  ): Promise<Sequence[]>
  find(scope: TenantScope, id: string): Promise<Sequence | null>
  /** `null` se já existir uma sequência no mesmo âmbito. */
  insert(scope: TenantScope, values: SequenceValues): Promise<Sequence | null>
  update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    patch: { prefixTemplate?: string; padding?: number; nextValue?: string }
  ): Promise<Sequence>
  /**
   * A sequência aplicável: a da filial (se indicada) antes da da organização, e o período mais
   * específico primeiro.
   */
  resolve(
    scope: TenantScope,
    input: {
      organizationId: string
      branchId: string | null
      documentType: string
      series: string
      periods: readonly string[]
    }
  ): Promise<Sequence | null>
  /**
   * Reserva o próximo número **sob o lock da linha** (`UPDATE … RETURNING`) na transacção do chamador.
   * Se essa transacção anular, o número volta; se confirmar, nunca é reutilizado.
   */
  allocate(scope: TenantScope, id: string): Promise<bigint>
}

export interface Clock {
  now(): Date
}
