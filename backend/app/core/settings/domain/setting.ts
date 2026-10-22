import { SettingsRuleError } from '#core/settings/domain/errors'

/**
 * Definições de configuração (C09). Cada chave declara o tipo, o valor por omissão e os **âmbitos
 * permitidos**; é isso (e só isso) que decide a precedência e se uma preferência pessoal é admitida.
 * São entregues por código: o tenant só define valores, nunca chaves.
 */
export const SETTING_SCOPES = ['TENANT', 'ORGANIZATION', 'BRANCH', 'MODULE', 'MEMBERSHIP'] as const
export type SettingScope = (typeof SETTING_SCOPES)[number]

export type ValueSpec =
  | { type: 'boolean' }
  | { type: 'integer'; min?: number; max?: number }
  | { type: 'string'; maxLength: number }
  | { type: 'enum'; options: readonly string[] }

export interface SettingDefinition {
  key: string
  category: 'PRESENTATION' | 'FISCAL'
  description: string
  spec: ValueSpec
  defaultValue: boolean | number | string
  allowedScopes: readonly SettingScope[]
}

/** Preferências de apresentação: plataforma < tenant < organização < filial < módulo < membership. */
const PRESENTATION: readonly SettingScope[] = [
  'TENANT',
  'ORGANIZATION',
  'BRANCH',
  'MODULE',
  'MEMBERSHIP',
]
/** Regras fiscais: plataforma < tenant < organização; nunca override pessoal nem por filial/módulo. */
const FISCAL: readonly SettingScope[] = ['TENANT', 'ORGANIZATION']

export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
  {
    key: 'ui.locale',
    category: 'PRESENTATION',
    description: 'Idioma da interface.',
    spec: { type: 'enum', options: ['pt-AO', 'pt-PT', 'en'] },
    defaultValue: 'pt-AO',
    allowedScopes: PRESENTATION,
  },
  {
    key: 'ui.dateFormat',
    category: 'PRESENTATION',
    description: 'Formato de datas apresentado.',
    spec: { type: 'enum', options: ['dd/MM/yyyy', 'yyyy-MM-dd', 'MM/dd/yyyy'] },
    defaultValue: 'dd/MM/yyyy',
    allowedScopes: PRESENTATION,
  },
  {
    key: 'tax.pricesIncludeTax',
    category: 'FISCAL',
    description: 'Os preços incluem imposto.',
    spec: { type: 'boolean' },
    defaultValue: false,
    allowedScopes: FISCAL,
  },
  {
    key: 'tax.roundingMode',
    category: 'FISCAL',
    description: 'Arredondamento dos impostos.',
    spec: { type: 'enum', options: ['HALF_UP', 'HALF_EVEN'] },
    defaultValue: 'HALF_UP',
    allowedScopes: FISCAL,
  },
]

export const findDefinition = (key: string) => SETTING_DEFINITIONS.find((d) => d.key === key)

const MODULE_CODE = /^[a-z][a-z0-9_]{1,39}$/

/** Valida o valor contra o tipo declarado (nunca se aceita o que a definição não prevê). */
export function validateValue(definition: SettingDefinition, value: unknown): void {
  const spec = definition.spec
  const bad = (message: string) => new SettingsRuleError('value', 'INVALID_VALUE', message)
  switch (spec.type) {
    case 'boolean':
      if (typeof value !== 'boolean') throw bad('Esperado um booleano.')
      return
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) throw bad('Esperado um inteiro.')
      if (
        (spec.min !== undefined && value < spec.min) ||
        (spec.max !== undefined && value > spec.max)
      ) {
        throw bad('Valor fora dos limites permitidos.')
      }
      return
    case 'string':
      if (typeof value !== 'string' || value.length > spec.maxLength) {
        throw bad(`Esperado texto até ${spec.maxLength} caracteres.`)
      }
      return
    case 'enum':
      if (typeof value !== 'string' || !spec.options.includes(value)) {
        throw bad(`Valores permitidos: ${spec.options.join(', ')}.`)
      }
  }
}

export interface ScopeRef {
  scopeType: SettingScope
  scopeId: string | null
  moduleCode: string | null
}

/**
 * Um âmbito é válido para a chave? Verifica os âmbitos permitidos e a forma do par (id, módulo):
 * a combinação filial+módulo é `BRANCH` com `moduleCode`.
 */
export function validateScope(definition: SettingDefinition, ref: ScopeRef): void {
  if (!definition.allowedScopes.includes(ref.scopeType)) {
    throw new SettingsRuleError(
      'scopeType',
      'SCOPE_NOT_ALLOWED',
      `A chave ${definition.key} não admite o âmbito ${ref.scopeType}.`
    )
  }
  const needsId = ref.scopeType !== 'TENANT' && ref.scopeType !== 'MODULE'
  if (needsId !== (ref.scopeId !== null)) {
    throw new SettingsRuleError(
      'scopeId',
      needsId ? 'SCOPE_ID_REQUIRED' : 'SCOPE_ID_NOT_ALLOWED',
      needsId ? 'Indique o identificador do âmbito.' : 'Este âmbito não tem identificador.'
    )
  }
  const moduleAllowed = ref.scopeType === 'MODULE' || ref.scopeType === 'BRANCH'
  if (ref.scopeType === 'MODULE' && ref.moduleCode === null) {
    throw new SettingsRuleError('moduleCode', 'MODULE_REQUIRED', 'Indique o módulo.')
  }
  if (ref.moduleCode !== null && !moduleAllowed) {
    throw new SettingsRuleError('moduleCode', 'MODULE_NOT_ALLOWED', 'Este âmbito não tem módulo.')
  }
  if (ref.moduleCode !== null) {
    if (!MODULE_CODE.test(ref.moduleCode)) {
      throw new SettingsRuleError('moduleCode', 'INVALID_MODULE', 'Código de módulo inválido.')
    }
    if (ref.scopeType === 'BRANCH' && !definition.allowedScopes.includes('MODULE')) {
      throw new SettingsRuleError(
        'moduleCode',
        'SCOPE_NOT_ALLOWED',
        `A chave ${definition.key} não admite a combinação filial+módulo.`
      )
    }
  }
}

export interface StoredValue extends ScopeRef {
  key: string
  value: unknown
  version: number
}

export interface ResolutionContext {
  organizationId: string | null
  branchId: string | null
  moduleCode: string | null
  membershipId: string | null
}

export type ValueSource =
  { level: 'DEFAULT' } | { level: SettingScope; scopeId: string | null; moduleCode: string | null }

export interface EffectiveSetting {
  key: string
  category: SettingDefinition['category']
  value: unknown
  source: ValueSource
  allowedScopes: readonly SettingScope[]
}

/**
 * Valor efectivo: o do âmbito mais específico presente, na ordem
 * omissão < tenant < organização < filial < módulo < filial+módulo < membership.
 * Só contam os âmbitos que a definição permite (um valor antigo fora disso é ignorado).
 */
export function resolveEffective(
  definition: SettingDefinition,
  values: readonly StoredValue[],
  context: ResolutionContext
): EffectiveSetting {
  const allowed = new Set(definition.allowedScopes)
  const candidates: Array<{ ref: ScopeRef; applies: boolean }> = [
    { ref: { scopeType: 'TENANT', scopeId: null, moduleCode: null }, applies: true },
    {
      ref: { scopeType: 'ORGANIZATION', scopeId: context.organizationId, moduleCode: null },
      applies: context.organizationId !== null,
    },
    {
      ref: { scopeType: 'BRANCH', scopeId: context.branchId, moduleCode: null },
      applies: context.branchId !== null,
    },
    {
      ref: { scopeType: 'MODULE', scopeId: null, moduleCode: context.moduleCode },
      applies: context.moduleCode !== null,
    },
    {
      ref: { scopeType: 'BRANCH', scopeId: context.branchId, moduleCode: context.moduleCode },
      applies: context.branchId !== null && context.moduleCode !== null,
    },
    {
      ref: { scopeType: 'MEMBERSHIP', scopeId: context.membershipId, moduleCode: null },
      applies: context.membershipId !== null,
    },
  ]
  let result: EffectiveSetting = {
    key: definition.key,
    category: definition.category,
    value: definition.defaultValue,
    source: { level: 'DEFAULT' },
    allowedScopes: definition.allowedScopes,
  }
  for (const { ref, applies } of candidates) {
    if (!applies || !allowed.has(ref.scopeType)) continue
    const hit = values.find(
      (v) =>
        v.key === definition.key &&
        v.scopeType === ref.scopeType &&
        v.scopeId === ref.scopeId &&
        v.moduleCode === ref.moduleCode
    )
    if (hit) {
      result = {
        ...result,
        value: hit.value,
        source: { level: ref.scopeType, scopeId: ref.scopeId, moduleCode: ref.moduleCode },
      }
    }
  }
  return result
}
