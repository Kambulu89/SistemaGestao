/*
|--------------------------------------------------------------------------
| Validação das variáveis de ambiente
|--------------------------------------------------------------------------
*/

import { Env } from '@adonisjs/core/env'
import { assertEnvConsistency, envSchema } from '#start/env_schema'

const env = await Env.create(new URL('../', import.meta.url), envSchema)

assertEnvConsistency({
  NODE_ENV: env.get('NODE_ENV'),
  MAIL_DRIVER: env.get('MAIL_DRIVER'),
  APP_KEY: env.get('APP_KEY'),
})

export default env
