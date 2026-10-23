/**
 * Metadados de campos (C10, spec §5.1). Só existem os tipos cuja validação e armazenamento estão
 * implementados e testados; os restantes da matriz são recusados com um erro explícito em vez de
 * ficarem a meio.
 */
export const SUPPORTED_FIELD_TYPES = [
  'TEXT',
  'TEXTAREA',
  'NUMBER',
  'DECIMAL',
  'BOOLEAN',
  'DATE',
  'DATETIME',
  'EMAIL',
  'PHONE',
  'URL',
  'SELECT',
  'RADIO',
  'MULTISELECT',
  'ENTITY_REFERENCE',
  'USER_REFERENCE',
] as const
export type FieldType = (typeof SUPPORTED_FIELD_TYPES)[number]

/** Tipos da matriz ainda por implementar, com a fatia que os traz (ver docs/implementation-plan.md). */
export const PLANNED_FIELD_TYPES: Readonly<Record<string, string>> = {
  CURRENCY: 'conversão e arredondamento por moeda',
  CHECKBOX: 'colecção tipada de opções',
  FILE: 'anexos (Fase 4)',
  IMAGE: 'anexos (Fase 4)',
  FORMULA: 'motor de regras e fórmulas (C12)',
  LOOKUP: 'caminhos de referência autorizados',
  AUTONUMBER: 'integração com o motor de sequências',
}

export interface FieldOption {
  code: string
  label: string
  /** Opção retirada numa versão posterior: continua legível nos registos antigos, mas já não se escolhe. */
  archived?: boolean
}

export interface FieldSpec {
  code: string
  label: string
  type: FieldType
  required: boolean
  defaultValue: unknown
  validation: Record<string, unknown>
  options: FieldOption[]
  position: number
  /** Entidade de destino de um `ENTITY_REFERENCE`. */
  referenceEntityId: string | null
  /** Valor guardado à parte e nunca auditado, listado nem pesquisado sem a permissão `dynamic.sensitive`. */
  sensitive: boolean
  readOnly: boolean
  /** Campo retirado: os valores antigos continuam legíveis, mas deixa de aceitar escritas. */
  archived: boolean
}

export const CODE_PATTERN = /^[a-z][a-z0-9_]{1,49}$/
export const OPTION_CODE_PATTERN = /^[a-z0-9_]{1,50}$/
export const MAX_FIELDS_PER_VERSION = 200
export const MAX_OPTIONS = 100
export const MAX_RECORD_BYTES = 64 * 1024

export const isSupportedType = (value: unknown): value is FieldType =>
  typeof value === 'string' && (SUPPORTED_FIELD_TYPES as readonly string[]).includes(value)

export interface Issue {
  path: string
  code: string
  message: string
}

export const TEXT_DEFAULT_MAX = 255
export const TEXTAREA_DEFAULT_MAX = 10_000

/** Forma decimal declarada (obrigatória num campo DECIMAL): precisão e escala. */
export function decimalShape(validation: Record<string, unknown>) {
  return { precision: validation.precision as number, scale: validation.scale as number }
}
