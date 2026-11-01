/** API pública das regras de negócio (C12). Outros módulos importam **apenas** daqui. */
export { ruleServices } from '#dynamic/rules/presentation/composition'

import { registerRecordRules } from '#dynamic/metadata/index'
import { ruleServices } from '#dynamic/rules/presentation/composition'

/** Liga as regras às escritas de registos (chamado no arranque, em `start/dynamic.ts`). */
export function registerDynamicRules(): void {
  registerRecordRules(ruleServices().enforcer)
}
