/*
|--------------------------------------------------------------------------
| Entidades dinâmicas
|--------------------------------------------------------------------------
|
| Liga as regras de negócio (C12) às escritas de registos (C10). Sem isto as escritas falham (as regras nunca se
| ignoram em silêncio).
*/

import { registerDynamicRules } from '#dynamic/rules/index'

registerDynamicRules()
