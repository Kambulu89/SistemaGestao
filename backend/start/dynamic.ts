/*
|--------------------------------------------------------------------------
| Entidades dinâmicas
|--------------------------------------------------------------------------
|
| Liga as regras de negócio (C12), as máquinas de estados (C13) e os workflows (C14) às escritas de registos (C10). Sem isto as escritas
| falham (nunca se ignoram regras nem estados em silêncio).
*/

import { registerDynamicRules } from '#dynamic/rules/index'
import { registerDynamicStates } from '#dynamic/states/index'
import { registerDynamicWorkflows } from '#dynamic/workflows/index'

registerDynamicRules()
registerDynamicStates()
registerDynamicWorkflows()
