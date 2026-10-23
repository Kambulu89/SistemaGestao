/** API pública dos metadados e entidades dinâmicas (C10). Outros módulos importam **apenas** daqui. */
export { metadataServices } from '#dynamic/metadata/presentation/composition'
export type { RecordView } from '#dynamic/metadata/application/record_use_cases'
export type { EntityDefinition, SchemaVersion } from '#dynamic/metadata/application/ports'
export {
  registerRecordRules,
  type RecordRuleCheck,
  type RecordRules,
} from '#dynamic/metadata/application/record_rules'
export {
  registerRecordStates,
  type RecordState,
  type RecordStates,
  type RecordStateTarget,
} from '#dynamic/metadata/application/record_states'
export type { FieldSpec, Issue } from '#dynamic/metadata/domain/field_types'
export type { RecordValues } from '#dynamic/metadata/domain/record'
