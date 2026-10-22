import type { ApiResponse } from '@japa/api-client'
import { serviceTenantContext } from '#core/tenancy/index'
import { iamServices } from '#core/permissions/index'
import type { Tenant } from '#platform/tenants/index'
import { PASSWORD, createActiveUser } from '#tests/support/auth_fixture'
import { addMember } from '#tests/support/membership_fixture'

const COOKIE = 'sg_session'

export async function login(client: any, email: string) {
  const response = (await client
    .post('/api/v1/auth/login')
    .json({ email, password: PASSWORD })) as ApiResponse
  response.assertStatus(200)
  const header = response.headers()['set-cookie'] as string | string[]
  const raw = (Array.isArray(header) ? header : [header]).find((c) =>
    c.startsWith(`${COOKIE}=`)
  ) as string
  return {
    cookie: `${COOKIE}=${raw.split(';')[0].split('=')[1]}`,
    csrf: response.body().data.csrfToken as string,
  }
}

export interface Actor {
  email: string
  userId: string
  membershipId: string
  cookie: string
  csrf: string
}

/** Chamadas autenticadas num tenant concreto (o selector é só um selector). */
export function api(client: any, tenant: Tenant, actor: Actor) {
  const base = (request: any, write: boolean) => {
    request.header('cookie', actor.cookie).header('x-tenant-id', tenant.id)
    return write ? request.header('x-csrf-token', actor.csrf) : request
  }
  return {
    get: (url: string) => base(client.get(url), false) as Promise<ApiResponse>,
    post: (url: string, body: unknown) =>
      base(client.post(url), true).json(body) as Promise<ApiResponse>,
    patch: (url: string, body: unknown) =>
      base(client.patch(url), true).json(body) as Promise<ApiResponse>,
    delete: (url: string) => base(client.delete(url), true) as Promise<ApiResponse>,
  }
}

export async function newActor(client: any, tenant: Tenant, admin = false): Promise<Actor> {
  const { user, email } = await createActiveUser()
  const membership = await addMember(tenant, user.id)
  if (admin) {
    await iamServices().ensureTenantAdmin.execute(
      serviceTenantContext(tenant.id, 'teste'),
      membership.id
    )
  }
  const session = await login(client, email)
  return { email, userId: user.id, membershipId: membership.id, ...session }
}

export const authzVersion = async (client: any, tenant: Tenant, actor: Actor) =>
  (await api(client, tenant, actor).get('/api/v1/context')).body().data
    .authorizationVersion as number
