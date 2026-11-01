import { ApiError } from '#core/http/api_error'
import type { TenantContext, TenantScope, TenantUnitOfWork } from '#core/tenancy/index'
import { SettingsRuleError } from '#core/settings/domain/errors'
import {
  SETTING_DEFINITIONS,
  findDefinition,
  resolveEffective,
  validateScope,
  validateValue,
  type EffectiveSetting,
  type ScopeRef,
  type SettingDefinition,
  type StoredValue,
} from '#core/settings/domain/setting'
import {
  formatNumber,
  isValidPeriod,
  periodKeys,
  validateTemplate,
  type SequenceContext,
} from '#core/settings/domain/sequence'
import { isValidDate, validateTaxRate } from '#core/settings/domain/tax'
import { convert } from '#core/settings/domain/units'
import type {
  Clock,
  ReferenceLookup,
  Sequence,
  SequenceStore,
  SettingStore,
  TaxRate,
  TaxRateStore,
  Unit,
  UnitStore,
} from '#core/settings/application/ports'

const systemClock: Clock = { now: () => new Date() }

const validation = (path: string, code: string, message: string) =>
  new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', [{ path, code, message }])

/** Regras de domínio violadas → erro de validação com a forma da API. */
function rules<T>(work: () => T): T {
  try {
    return work()
  } catch (error) {
    if (error instanceof SettingsRuleError) throw validation(error.path, error.code, error.message)
    throw error
  }
}

// --- configurações ------------------------------------------------------------------------------

export interface EffectiveQuery {
  organizationId?: string
  branchId?: string
  moduleCode?: string
}

abstract class SettingsCase {
  constructor(
    protected readonly uow: TenantUnitOfWork,
    protected readonly store: SettingStore,
    protected readonly lookup: ReferenceLookup
  ) {}

  protected definition(key: string): SettingDefinition {
    const definition = findDefinition(key)
    if (!definition) throw ApiError.notFound('Chave de configuração desconhecida.')
    return definition
  }

  /** O âmbito aponta para entidades que existem **neste tenant** (e a filial pertence à organização indicada). */
  protected async assertScopeExists(scope: TenantScope, ref: ScopeRef, organizationId?: string) {
    const missing = (path: string) => validation(path, 'NOT_FOUND', 'Inexistente neste tenant.')
    if (
      ref.scopeType === 'ORGANIZATION' &&
      !(await this.lookup.organization(scope, ref.scopeId!))
    ) {
      throw missing('scopeId')
    }
    if (ref.scopeType === 'BRANCH') {
      const branch = await this.lookup.branch(scope, ref.scopeId!)
      if (!branch || branch.type !== 'BRANCH') throw missing('scopeId')
      if (organizationId && branch.organizationId !== organizationId) {
        throw validation(
          'branchId',
          'BRANCH_NOT_IN_ORGANIZATION',
          'A filial não pertence à organização.'
        )
      }
    }
    if (
      ref.scopeType === 'MEMBERSHIP' &&
      !(await this.lookup.membershipExists(scope, ref.scopeId!))
    ) {
      throw missing('scopeId')
    }
  }
}

/** Valores efectivos, com o nível de origem, para o contexto pedido e o próprio membro. */
export class ResolveSettings extends SettingsCase {
  execute(context: TenantContext, query: EffectiveQuery): Promise<EffectiveSetting[]> {
    return this.uow.run(async (scope) => {
      if (query.organizationId) {
        if (!(await this.lookup.organization(scope, query.organizationId))) {
          throw validation('organizationId', 'NOT_FOUND', 'Inexistente neste tenant.')
        }
      }
      if (query.branchId) {
        await this.assertScopeExists(
          scope,
          { scopeType: 'BRANCH', scopeId: query.branchId, moduleCode: null },
          query.organizationId
        )
      }
      const values = await this.store.forResolution(scope)
      return SETTING_DEFINITIONS.map((definition) =>
        resolveEffective(definition, values, {
          organizationId: query.organizationId ?? null,
          branchId: query.branchId ?? null,
          moduleCode: query.moduleCode ?? null,
          membershipId: context.membershipId,
        })
      )
    }, context)
  }
}

export class ListSettings extends SettingsCase {
  execute(context: TenantContext, filter: { key?: string; scopeType?: string }) {
    return this.uow.run((scope) => this.store.list(scope, filter), context)
  }
}

export interface SetSettingInput extends ScopeRef {
  value: unknown
  expectedVersion?: number
}

/** Define o valor de uma chave num âmbito. Actualizar um valor existente exige `expectedVersion`. */
export class SetSetting extends SettingsCase {
  execute(context: TenantContext, key: string, input: SetSettingInput): Promise<StoredValue> {
    const definition = this.definition(key)
    rules(() => {
      validateScope(definition, input)
      validateValue(definition, input.value)
    })
    return this.uow.run(async (scope) => {
      await this.store.lock(scope)
      await this.assertScopeExists(scope, input)
      const current = await this.store.find(scope, key, input)
      if (!current) return this.store.insert(scope, key, input, input.value)
      if (input.expectedVersion === undefined) {
        throw ApiError.conflict(
          'VERSION_REQUIRED',
          'Já existe um valor neste âmbito; indique expectedVersion.'
        )
      }
      const updated = await this.store.update(scope, key, input, input.value, input.expectedVersion)
      if (!updated) throw ApiError.versionConflict(current.version)
      return updated
    }, context)
  }
}

/** Repor a herança: remove o valor do âmbito (o histórico fica na auditoria). */
export class ResetSetting extends SettingsCase {
  execute(context: TenantContext, key: string, ref: ScopeRef): Promise<void> {
    const definition = this.definition(key)
    rules(() => validateScope(definition, ref))
    return this.uow.run(async (scope) => {
      await this.store.lock(scope)
      if (!(await this.store.delete(scope, key, ref))) {
        throw ApiError.notFound('Não há valor definido neste âmbito.')
      }
    }, context)
  }
}

// --- impostos -----------------------------------------------------------------------------------

export class TaxRateUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly store: TaxRateStore,
    private readonly lookup: ReferenceLookup
  ) {}

  list(
    context: TenantContext,
    filter: { organizationId?: string; code?: string; on?: string }
  ): Promise<TaxRate[]> {
    if (filter.on !== undefined && !isValidDate(filter.on)) {
      throw validation('on', 'INVALID_DATE', 'Data no formato AAAA-MM-DD.')
    }
    return this.uow.run((scope) => this.store.list(scope, filter), context)
  }

  create(
    context: TenantContext,
    input: {
      organizationId: string
      code: string
      name: string
      rate: string
      validFrom: string
      validTo: string | null
      category: string
      exemptionReason: string | null
    }
  ): Promise<TaxRate> {
    const values = { ...input, code: input.code.trim().toUpperCase(), name: input.name.trim() }
    rules(() => {
      validateTaxRate(values)
      if (!values.name || values.name.length > 160) {
        throw new SettingsRuleError('name', 'INVALID_NAME', 'O nome é obrigatório (máx. 160).')
      }
    })
    return this.uow.run(async (scope) => {
      if (!(await this.lookup.organization(scope, values.organizationId))) {
        throw validation('organizationId', 'NOT_FOUND', 'Inexistente neste tenant.')
      }
      const created = await this.store.insert(scope, values)
      if (created === 'OVERLAP') throw overlap()
      return created
    }, context)
  }

  /**
   * Só o que não altera o passado: nome, categoria, motivo e **fim** de validade. A taxa, o código e o
   * início são imutáveis (a taxa é copiada para as linhas emitidas): para mudar a taxa, feche o período
   * e crie outro.
   */
  update(
    context: TenantContext,
    id: string,
    input: {
      expectedVersion: number
      name?: string
      validTo?: string | null
      category?: string
      exemptionReason?: string | null
    }
  ): Promise<TaxRate> {
    const { expectedVersion, ...patch } = input
    return this.uow.run(async (scope) => {
      const current = await this.store.find(scope, id)
      if (!current) throw ApiError.notFound()
      const merged = { ...current, ...patch }
      rules(() => {
        validateTaxRate(merged)
        if (!merged.name.trim() || merged.name.length > 160) {
          throw new SettingsRuleError('name', 'INVALID_NAME', 'O nome é obrigatório (máx. 160).')
        }
      })
      if (current.version !== expectedVersion) throw ApiError.versionConflict(current.version)
      const updated = await this.store.update(scope, id, expectedVersion, patch)
      if (updated === 'OVERLAP') throw overlap()
      return updated
    }, context)
  }
}

const overlap = () =>
  ApiError.conflict(
    'TAX_RATE_OVERLAP',
    'O período sobrepõe-se a outra taxa com o mesmo código nesta organização.'
  )

// --- unidades de medida -------------------------------------------------------------------------

const UNIT_CODE = /^[A-Za-z][A-Za-z0-9_./-]{0,19}$/
const DIMENSION = /^[A-Z][A-Z_]{1,29}$/

export class UnitUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly store: UnitStore
  ) {}

  list(context: TenantContext): Promise<Unit[]> {
    return this.uow.run((scope) => this.store.list(scope), context)
  }

  /**
   * Cria uma unidade. Uma unidade derivada aponta para uma unidade **base** da mesma dimensão (sem
   * cadeias nem ciclos) com o seu factor; a dimensão, a base e o factor não mudam depois.
   */
  create(
    context: TenantContext,
    input: {
      code: string
      name: string
      dimension: string
      precision: number
      baseUnitId: string | null
      factor: string | null
    }
  ): Promise<Unit> {
    const values = { ...input, code: input.code.trim(), name: input.name.trim() }
    rules(() => {
      if (!UNIT_CODE.test(values.code)) {
        throw new SettingsRuleError('code', 'INVALID_CODE', 'Código inválido (máx. 20).')
      }
      if (!values.name || values.name.length > 120) {
        throw new SettingsRuleError('name', 'INVALID_NAME', 'O nome é obrigatório (máx. 120).')
      }
      if (!DIMENSION.test(values.dimension)) {
        throw new SettingsRuleError(
          'dimension',
          'INVALID_DIMENSION',
          'Dimensão: maiúsculas e _ (ex.: MASS).'
        )
      }
      if (!Number.isInteger(values.precision) || values.precision < 0 || values.precision > 6) {
        throw new SettingsRuleError('precision', 'INVALID_PRECISION', 'A precisão é de 0 a 6.')
      }
      if ((values.baseUnitId === null) !== (values.factor === null)) {
        throw new SettingsRuleError(
          'factor',
          'BASE_AND_FACTOR',
          'Uma unidade derivada indica a unidade base e o factor; uma base não tem nenhum.'
        )
      }
      if (
        values.factor !== null &&
        !(/^\d{1,13}(\.\d{1,6})?$/.test(values.factor) && Number(values.factor) > 0)
      ) {
        throw new SettingsRuleError(
          'factor',
          'INVALID_FACTOR',
          'O factor é um decimal > 0 (até 6 casas).'
        )
      }
    })
    return this.uow.run(async (scope) => {
      await this.store.lock(scope)
      if (values.baseUnitId) {
        const base = await this.store.find(scope, values.baseUnitId)
        if (!base)
          throw validation('baseUnitId', 'NOT_FOUND', 'Unidade base inexistente neste tenant.')
        if (base.baseUnitId !== null) {
          throw validation(
            'baseUnitId',
            'BASE_NOT_ROOT',
            'A unidade base não pode ser ela própria derivada.'
          )
        }
        if (base.dimension !== values.dimension) {
          throw validation('dimension', 'DIMENSION_MISMATCH', 'A unidade base tem outra dimensão.')
        }
      }
      const created = await this.store.insert(scope, values)
      if (!created)
        throw ApiError.conflict('UNIT_CODE_TAKEN', 'Já existe uma unidade com este código.')
      return created
    }, context)
  }

  update(
    context: TenantContext,
    id: string,
    input: { expectedVersion: number; name?: string; precision?: number }
  ): Promise<Unit> {
    const { expectedVersion, ...patch } = input
    rules(() => {
      if (patch.name !== undefined && (!patch.name.trim() || patch.name.length > 120)) {
        throw new SettingsRuleError('name', 'INVALID_NAME', 'O nome é obrigatório (máx. 120).')
      }
      if (
        patch.precision !== undefined &&
        (!Number.isInteger(patch.precision) || patch.precision < 0 || patch.precision > 6)
      ) {
        throw new SettingsRuleError('precision', 'INVALID_PRECISION', 'A precisão é de 0 a 6.')
      }
    })
    return this.uow.run(
      (scope) =>
        this.store.update(scope, id, expectedVersion, {
          name: patch.name?.trim(),
          precision: patch.precision,
        }),
      context
    )
  }

  /** Converte entre unidades do tenant; dimensões incompatíveis são recusadas. */
  convert(
    context: TenantContext,
    input: { from: string; to: string; quantity: string }
  ): Promise<{ from: string; to: string; quantity: string; result: string }> {
    return this.uow.run(async (scope) => {
      const from = await this.store.findByCode(scope, input.from)
      const to = await this.store.findByCode(scope, input.to)
      if (!from || !to) throw ApiError.notFound('Unidade não encontrada.')
      const result = rules(() => convert(input.quantity, from, to))
      return { from: from.code, to: to.code, quantity: input.quantity, result }
    }, context)
  }
}

// --- sequências ---------------------------------------------------------------------------------

const DOC_TYPE = /^[A-Z][A-Z0-9_]{1,49}$/
const SERIES = /^[A-Za-z0-9][A-Za-z0-9_-]{0,29}$/
const MAX_BIGINT = 9223372036854775807n

function parseNextValue(text: string): bigint {
  if (!/^[1-9]\d{0,18}$/.test(text) || BigInt(text) > MAX_BIGINT) {
    throw new SettingsRuleError(
      'nextValue',
      'INVALID_NEXT_VALUE',
      'O próximo número é um inteiro ≥ 1.'
    )
  }
  return BigInt(text)
}

export interface SequenceInput {
  organizationId: string
  branchId: string | null
  documentType: string
  series: string
  period: string
  prefixTemplate: string
  nextValue: string
  padding: number
}

export class SequenceUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly store: SequenceStore,
    private readonly lookup: ReferenceLookup,
    private readonly clock: Clock = systemClock
  ) {}

  list(context: TenantContext, filter: { organizationId?: string; documentType?: string }) {
    return this.uow.run((scope) => this.store.list(scope, filter), context)
  }

  private checkFormat(input: { prefixTemplate: string; padding: number; nextValue: string }) {
    validateTemplate(input.prefixTemplate)
    if (!Number.isInteger(input.padding) || input.padding < 1 || input.padding > 12) {
      throw new SettingsRuleError('padding', 'INVALID_PADDING', 'O preenchimento é de 1 a 12.')
    }
    parseNextValue(input.nextValue)
  }

  create(context: TenantContext, input: SequenceInput): Promise<Sequence> {
    rules(() => {
      if (!DOC_TYPE.test(input.documentType)) {
        throw new SettingsRuleError(
          'documentType',
          'INVALID_DOCUMENT_TYPE',
          'Tipo: maiúsculas, dígitos e _.'
        )
      }
      if (!SERIES.test(input.series)) {
        throw new SettingsRuleError('series', 'INVALID_SERIES', 'Série inválida (máx. 30).')
      }
      if (!isValidPeriod(input.period)) {
        throw new SettingsRuleError('period', 'INVALID_PERIOD', 'Período: ALL, AAAA ou AAAA-MM.')
      }
      this.checkFormat(input)
    })
    return this.uow.run(async (scope) => {
      if (!(await this.lookup.organization(scope, input.organizationId))) {
        throw validation('organizationId', 'NOT_FOUND', 'Inexistente neste tenant.')
      }
      if (input.branchId) {
        const branch = await this.lookup.branch(scope, input.branchId)
        if (!branch || branch.type !== 'BRANCH' || branch.organizationId !== input.organizationId) {
          throw validation('branchId', 'NOT_FOUND', 'Filial inexistente nesta organização.')
        }
      }
      const created = await this.store.insert(scope, input)
      if (!created) {
        throw ApiError.conflict('SEQUENCE_EXISTS', 'Já existe uma sequência neste âmbito.')
      }
      return created
    }, context)
  }

  /**
   * O tipo, a série, o período e o âmbito não mudam (mudavam a identidade da numeração). O modelo e o
   * preenchimento podem; o próximo número só **sobe** (nunca se reutiliza um número).
   */
  update(
    context: TenantContext,
    id: string,
    input: {
      expectedVersion: number
      prefixTemplate?: string
      padding?: number
      nextValue?: string
    }
  ): Promise<Sequence> {
    const { expectedVersion, ...patch } = input
    return this.uow.run(async (scope) => {
      const current = await this.store.find(scope, id)
      if (!current) throw ApiError.notFound()
      rules(() => {
        this.checkFormat({
          prefixTemplate: patch.prefixTemplate ?? current.prefixTemplate,
          padding: patch.padding ?? current.padding,
          nextValue: patch.nextValue ?? current.nextValue,
        })
        if (patch.nextValue !== undefined && BigInt(patch.nextValue) < BigInt(current.nextValue)) {
          throw new SettingsRuleError(
            'nextValue',
            'NEXT_VALUE_DECREASE',
            'O próximo número não pode diminuir: números emitidos nunca se reutilizam.'
          )
        }
      })
      return this.store.update(scope, id, expectedVersion, patch)
    }, context)
  }

  /** Pré-visualização do formato **sem consumir** número: é só renderização. */
  async preview(
    context: TenantContext,
    input: {
      organizationId: string
      branchId: string | null
      series: string
      prefixTemplate: string
      padding: number
      nextValue: string
      date?: Date
    }
  ): Promise<{ example: string }> {
    const next = rules(() => {
      this.checkFormat(input)
      return parseNextValue(input.nextValue)
    })
    return this.uow.run(async (scope) => {
      const organization = await this.lookup.organization(scope, input.organizationId)
      if (!organization)
        throw validation('organizationId', 'NOT_FOUND', 'Inexistente neste tenant.')
      const branch = input.branchId ? await this.lookup.branch(scope, input.branchId) : null
      if (input.branchId && !branch)
        throw validation('branchId', 'NOT_FOUND', 'Inexistente neste tenant.')
      return {
        example: formatNumber(input.prefixTemplate, input.padding, next, {
          date: input.date ?? this.clock.now(),
          series: input.series,
          organizationCode: organization.code,
          branchCode: branch?.code ?? null,
        }),
      }
    }, context)
  }
}

export interface IssuedNumber {
  sequenceId: string
  /** Número formatado (prefixo + valor preenchido). */
  number: string
  value: string
}

/**
 * Emissão de números **dentro da transacção do chamador** (a do documento): o lock da linha da sequência
 * serializa as emissões, o número é único e, confirmada a transacção, nunca se reutiliza (cancelar o
 * documento não devolve o número). Se a transacção anular, o número volta — sem lacunas.
 */
export class SequenceIssuer {
  constructor(
    private readonly store: SequenceStore,
    private readonly lookup: ReferenceLookup
  ) {}

  async issue(
    scope: TenantScope,
    input: {
      organizationId: string
      branchId?: string | null
      documentType: string
      series: string
      date: Date
    }
  ): Promise<IssuedNumber> {
    const sequence = await this.store.resolve(scope, {
      organizationId: input.organizationId,
      branchId: input.branchId ?? null,
      documentType: input.documentType,
      series: input.series,
      periods: periodKeys(input.date),
    })
    if (!sequence) {
      throw ApiError.conflict(
        'SEQUENCE_NOT_CONFIGURED',
        'Não há sequência configurada para este documento, série e período.'
      )
    }
    const organization = await this.lookup.organization(scope, sequence.organizationId)
    const branch = sequence.branchId ? await this.lookup.branch(scope, sequence.branchId) : null
    const context: SequenceContext = {
      date: input.date,
      series: input.series,
      organizationCode: organization?.code ?? '',
      branchCode: branch?.code ?? null,
    }
    const value = await this.store.allocate(scope, sequence.id)
    return {
      sequenceId: sequence.id,
      number: formatNumber(sequence.prefixTemplate, sequence.padding, value, context),
      value: value.toString(),
    }
  }
}
