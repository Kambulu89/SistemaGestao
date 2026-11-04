import hash from '@adonisjs/core/services/hash'
import db from '@adonisjs/lucid/services/db'

export const PASSWORD = 'frase-de-teste-bem-longa'
let counter = 0

/** Fixtures pela conta dona (BYPASSRLS): preparam dados de vários tenants sem passar pela API. */
const owner = () => db.connection('owner')

export async function createUser(overrides: { email?: string; status?: string } = {}) {
  const email = overrides.email ?? `u${process.pid}-${Date.now()}-${counter++}@teste.invalid`
  const result = await owner().rawQuery(
    `insert into users (email, full_name, password_hash, status) values (?, ?, ?, ?) returning id, email`,
    [email, 'Pessoa de Teste', await hash.make(PASSWORD), overrides.status ?? 'ACTIVE']
  )
  return result.rows[0] as { id: string; email: string }
}

export async function createTenant(code = `T${counter++}${Date.now() % 100000}`) {
  const result = await owner().rawQuery(
    `insert into tenants (code, name, slug, country_code, default_currency) values (?, ?, ?, 'AO', 'AOA') returning id, code`,
    [code, `Empresa ${code}`, code.toLowerCase()]
  )
  return result.rows[0] as { id: string; code: string }
}

export async function addMembership(tenantId: string, userId: string, status = 'ACTIVE') {
  const result = await owner().rawQuery(
    `insert into tenant_memberships (tenant_id, user_id, status, joined_at) values (?, ?, ?, now()) returning id`,
    [tenantId, userId, status]
  )
  return (result.rows[0] as { id: string }).id
}

export async function cleanDatabase() {
  await owner().rawQuery(
    'truncate tenant_memberships, auth_sessions, rate_limit_counters, users, tenants restart identity cascade'
  )
}

/** Faz login e devolve os cabeçalhos (cookie de sessão e CSRF) para os pedidos seguintes. */
export async function login(client: any, email: string, password = PASSWORD) {
  const response = await client.post('/api/v1/auth/login').json({ email, password })
  const cookies = (response.headers()['set-cookie'] as string[]).map((c) => c.split(';')[0])
  const xsrf = cookies.find((c) => c.startsWith('XSRF-TOKEN='))!.split('=')[1]
  return { response, cookie: cookies.join('; '), xsrf }
}
