import db from '@adonisjs/lucid/services/db'
import redis from '@adonisjs/redis/services/main'
import { authServices } from '#core/auth/index'
import { DEV_MAILBOX_KEY } from '#core/auth/infrastructure/token_mailers'

export const PASSWORD = 'uma-frase-de-teste-longa'
export const ORIGIN = 'http://localhost:4200'

let counter = 0
export const uniqueEmail = (prefix = 'user') =>
  `${prefix}-${process.pid}-${Date.now()}-${counter++}@teste.invalid`

/** Limpa contadores de rate limit e a caixa de desenvolvimento (isolamento entre testes). */
export async function resetAuthState() {
  const keys = await redis.keys('ratelimit:*')
  if (keys.length > 0) await redis.del(...keys)
  await redis.del(DEV_MAILBOX_KEY)
}

/** Remove os utilizadores de teste com a conta dona (a conta de runtime não apaga). */
export async function deleteTestUsers() {
  const owner = db.connection('owner')
  await owner.rawQuery(
    `delete from one_time_tokens where user_id in (select id from users where email like '%@teste.invalid')`
  )
  await owner.rawQuery(
    `delete from auth_sessions where user_id in (select id from users where email like '%@teste.invalid')`
  )
  await owner.rawQuery(`delete from users where email like '%@teste.invalid'`)
}

export async function createActiveUser(email = uniqueEmail()) {
  const user = await authServices().createUser.execute({
    email,
    displayName: 'Utilizador de teste',
    password: PASSWORD,
    verified: true,
  })
  return { user, email }
}

/** Mensagens que o `dev-redis` recebeu (a mais recente por último). */
export async function mailbox(): Promise<
  { to: string; purpose: string; token: string; expiresAt: string }[]
> {
  const raw = await redis.lrange(DEV_MAILBOX_KEY, 0, -1)
  return raw.map((entry) => JSON.parse(entry))
}
