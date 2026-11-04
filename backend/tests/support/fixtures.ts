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
    'truncate membership_roles, role_permissions, roles, one_time_tokens, tenant_memberships, auth_sessions, rate_limit_counters, users, tenants restart identity cascade'
  )
}

/** Faz login e devolve os cabeçalhos (cookie de sessão e CSRF) para os pedidos seguintes. */
export async function login(client: any, email: string, password = PASSWORD) {
  const response = await client.post('/api/v1/auth/login').json({ email, password })
  const cookies = (response.headers()['set-cookie'] as string[]).map((c) => c.split(';')[0])
  const xsrf = cookies.find((c) => c.startsWith('XSRF-TOKEN='))!.split('=')[1]
  return { response, cookie: cookies.join('; '), xsrf }
}

/** Tenant com administrador (fluxo real de `tenant:create`). */
export async function tenantWithAdmin(code = `T${counter++}${Date.now() % 100000}`) {
  const { createTenantWithAdmin } = await import('#modules/members/application/tenant_bootstrap')
  const admin = await createUser()
  const tenant = await createTenantWithAdmin({
    code,
    name: `Empresa ${code}`,
    countryCode: 'AO',
    defaultCurrency: 'AOA',
    adminEmail: admin.email,
  })
  return { tenant, admin }
}

export interface Session {
  cookie: string
  xsrf: string
  tenantId: string
}

/** Cliente autenticado numa empresa: aplica cookie, CSRF e X-Tenant-Id. */
export function as(client: any, s: Session) {
  const wrap = (method: 'get' | 'post' | 'patch' | 'delete', url: string) =>
    client[method](url)
      .header('cookie', s.cookie)
      .header('x-xsrf-token', s.xsrf)
      .header('x-tenant-id', s.tenantId)
  return {
    get: (url: string) => wrap('get', url),
    post: (url: string, body: object = {}) => wrap('post', url).json(body),
    patch: (url: string, body: object = {}) => wrap('patch', url).json(body),
    delete: (url: string) => wrap('delete', url),
  }
}

export async function signIn(
  client: any,
  email: string,
  tenantId: string,
  password = PASSWORD
): Promise<Session> {
  const { cookie, xsrf } = await login(client, email, password)
  return { cookie, xsrf, tenantId }
}

/** Último token enviado para um email (caixa de desenvolvimento), extraído da ligação. */
export async function lastTokenFor(email: string, purpose: 'INVITATION' | 'PASSWORD_RESET') {
  const { devMailboxMessages } = await import('#modules/identity/index')
  const message = [...devMailboxMessages()]
    .reverse()
    .find((m) => m.to === email && m.purpose === purpose)
  return message ? new URL(message.link, 'http://x').searchParams.get('token')! : null
}

/** Convida, aceita e entra: devolve a sessão de um membro com os perfis dados. */
export async function memberWithRoles(client: any, admin: Session, roleIds: string[]) {
  const email = `m${process.pid}-${Date.now()}-${counter++}@teste.invalid`
  const invited = await as(client, admin).post('/api/v1/members/invitations', {
    email,
    fullName: 'Membro de Teste',
    roles: roleIds.map((roleId) => ({ roleId })),
  })
  if (invited.status() !== 201) throw new Error(`convite falhou: ${JSON.stringify(invited.body())}`)
  const token = await lastTokenFor(email, 'INVITATION')
  const accepted = await client
    .post('/api/v1/auth/invitations/accept')
    .json({ token, password: PASSWORD })
  if (accepted.status() !== 200)
    throw new Error(`aceitação falhou: ${JSON.stringify(accepted.body())}`)
  return {
    session: await signIn(client, email, admin.tenantId),
    memberId: invited.body().data.member.id as string,
    email,
  }
}

export async function createRole(
  client: any,
  admin: Session,
  code: string,
  permissionCodes: string[]
) {
  const response = await as(client, admin).post('/api/v1/roles', {
    code,
    name: `Perfil ${code}`,
    permissionCodes,
  })
  if (response.status() !== 201)
    throw new Error(`perfil falhou: ${JSON.stringify(response.body())}`)
  return response.body().data as { id: string; version: number }
}
