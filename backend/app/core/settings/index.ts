/** API pública de configurações, referências, impostos e sequências (C09). Outros módulos importam **apenas** daqui. */
export {
  SETTING_DEFINITIONS,
  SETTING_SCOPES,
  type EffectiveSetting,
  type SettingDefinition,
  type SettingScope,
} from '#core/settings/domain/setting'
export type { IssuedNumber } from '#core/settings/application/use_cases'
export { settingsServices } from '#core/settings/presentation/composition'
