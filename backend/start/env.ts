/*
|--------------------------------------------------------------------------
| Validação das variáveis de ambiente
|--------------------------------------------------------------------------
*/

import { Env } from '@adonisjs/core/env'
import { envSchema } from '#start/env_schema'

export default await Env.create(new URL('../', import.meta.url), envSchema)
