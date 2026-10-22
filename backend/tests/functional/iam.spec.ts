import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import type { ApiResponse } from '@japa/api-client'
import { serviceTenantContext } from '#core/tenancy/index'
import { iamServices, TENANT_ADMIN_ROLE } from '#core/permissions/index'
import type { Tenant } from '#platform/tenants/index'
import {
  PASSWORD,
  createActiveUser,
  deleteTestUsers,
  resetAuthState,
} from '#tests/support/auth_fixture'
import { addMember, createActiveTenant, deleteTestTenants } from '#tests/support/membership_fixture'

const COOKIE = 'sg_session'

async function login(client: any, email: string) {
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

interface Actor {
  email: string
  userId: string
  membershipId: string
  cookie: string
  csrf: string
}

/** Chamadas autenticadas num tenant concreto (o selector é só um selector). */
function api(client: any, tenant: Tenant, actor: Actor) {
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

async function newActor(client: any, tenant: Tenant, admin = false): Promise<Actor> {
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

const authzVersion = async (client: any, tenant: Tenant, actor: Actor) =>
  (await api(client, tenant, actor).get('/api/v1/context')).body().data
    .authorizationVersion as number

test.group('autorização | RBAC no servidor', (group) => {
  group.setup(async () => {
    await iamServices().syncCatalog.execute()
  })
  group.each.setup(async () => {
    await resetAuthState()
    return async () => {
      await deleteTestTenants()
      await deleteTestUsers()
    }
  })

  test('sem papel nega por omissão (403); o administrador acede; sem sessão é 401', async ({
    client,
    assert,
  }) => {
    const tenant = await createActiveTenant()
    const admin = await newActor(client, tenant, true)
    const operator = await newActor(client, tenant)

    ;(await client.get('/api/v1/roles').header('x-tenant-id', tenant.id)).assertStatus(401)

    const denied = await api(client, tenant, operator).get('/api/v1/roles')
    denied.assertStatus(403)
    assert.strictEqual(denied.body().error.code, 'PERMISSION_DENIED')
    assert.notInclude(JSON.stringify(denied.body()), 'iam.read')

    const ok = await api(client, tenant, admin).get('/api/v1/roles')
    ok.assertStatus(200)
    assert.include(
      ok.body().data.map((r: any) => r.code),
      TENANT_ADMIN_ROLE
    )
  })

  test('o catálogo de permissões segue <recurso>.<acção>', async ({ client, assert }) => {
    const tenant = await createActiveTenant()
    const admin = await newActor(client, tenant, true)
    const response = await api(client, tenant, admin).get('/api/v1/permissions')
    response.assertStatus(200)
    const codes = response.body().data.map((p: any) => p.code) as string[]
    assert.include(codes, 'iam.manage')
    assert.isTrue(codes.every((c) => /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(c)))
  })

  test('criar, alterar e apagar papéis (validação, 409 de versão e de código repetido)', async ({
    client,
    assert,
  }) => {
    const tenant = await createActiveTenant()
    const admin = await newActor(client, tenant, true)
    const http = api(client, tenant, admin)

    const created = await http.post('/api/v1/roles', {
      code: 'leitor',
      name: 'Leitor',
      permissionCodes: ['iam.read'],
    })
    created.assertStatus(201)
    const role = created.body().data
    assert.match(String(created.header('location')), new RegExp(`/api/v1/roles/${role.id}$`))
    assert.deepEqual(role.permissionCodes, ['iam.read'])

    ;(
      await http.post('/api/v1/roles', { code: 'leitor', name: 'Outro', permissionCodes: [] })
    ).assertStatus(409)
    const unknown = await http.post('/api/v1/roles', {
      code: 'x1',
      name: 'X',
      permissionCodes: ['invoice.approve'],
    })
    unknown.assertStatus(422)
    assert.strictEqual(unknown.body().error.details[0].code, 'UNKNOWN_PERMISSION')
    ;(
      await http.post('/api/v1/roles', { code: 'Mau Código', name: 'X', permissionCodes: [] })
    ).assertStatus(422)

    const updated = await http.patch(`/api/v1/roles/${role.id}`, {
      expectedVersion: role.version,
      name: 'Leitor IAM',
      permissionCodes: ['iam.read', 'member.read'],
    })
    updated.assertStatus(200)
    assert.deepEqual(updated.body().data.permissionCodes, ['iam.read', 'member.read'])

    const stale = await http.patch(`/api/v1/roles/${role.id}`, {
      expectedVersion: role.version,
      name: 'Velho',
    })
    stale.assertStatus(409)
    assert.strictEqual(stale.body().error.code, 'VERSION_CONFLICT')

    ;(await http.delete(`/api/v1/roles/${role.id}`)).assertStatus(204)
    ;(await http.get(`/api/v1/roles/${role.id}`)).assertStatus(404)
  })

  test('o papel de sistema é imutável', async ({ client, assert }) => {
    const tenant = await createActiveTenant()
    const admin = await newActor(client, tenant, true)
    const http = api(client, tenant, admin)
    const roles = (await http.get('/api/v1/roles')).body().data
    const system = roles.find((r: any) => r.code === TENANT_ADMIN_ROLE)
    assert.isTrue(system.isSystem)

    const patch = await http.patch(`/api/v1/roles/${system.id}`, {
      expectedVersion: system.version,
      name: 'X',
    })
    patch.assertStatus(409)
    assert.strictEqual(patch.body().error.code, 'SYSTEM_ROLE_IMMUTABLE')
    ;(await http.delete(`/api/v1/roles/${system.id}`)).assertStatus(409)
  })

  test('atribuir um papel dá acesso de imediato, revogar corta, e a authorizationVersion sobe', async ({
    client,
    assert,
  }) => {
    const tenant = await createActiveTenant()
    const admin = await newActor(client, tenant, true)
    const operator = await newActor(client, tenant)
    const http = api(client, tenant, admin)
    const asOperator = api(client, tenant, operator)

    const role = (
      await http.post('/api/v1/roles', {
        code: 'leitor',
        name: 'Leitor',
        permissionCodes: ['iam.read'],
      })
    ).body().data
    ;(await asOperator.get('/api/v1/roles')).assertStatus(403)
    const before = await authzVersion(client, tenant, operator)

    const assigned = await http.post('/api/v1/role-assignments', {
      membershipId: operator.membershipId,
      roleId: role.id,
    })
    assigned.assertStatus(201)
    ;(await asOperator.get('/api/v1/roles')).assertStatus(200)
    assert.strictEqual(await authzVersion(client, tenant, operator), before + 1)

    // Só lê: não gere.
    ;(
      await asOperator.post('/api/v1/roles', { code: 'z1', name: 'Z', permissionCodes: [] })
    ).assertStatus(403)
    ;(
      await http.post('/api/v1/role-assignments', {
        membershipId: operator.membershipId,
        roleId: role.id,
      })
    ).assertStatus(409)

    // Alterar as permissões do papel também invalida a versão de quem o tem.
    const v1 = await authzVersion(client, tenant, operator)
    ;(
      await http.patch(`/api/v1/roles/${role.id}`, {
        expectedVersion: role.version,
        permissionCodes: [],
      })
    ).assertStatus(200)
    assert.strictEqual(await authzVersion(client, tenant, operator), v1 + 1)
    ;(await asOperator.get('/api/v1/roles')).assertStatus(403)

    ;(await http.delete(`/api/v1/roles/${role.id}`)).assertStatus(409) // ainda atribuído
    ;(await http.delete(`/api/v1/role-assignments/${assigned.body().data.id}`)).assertStatus(204)
    ;(await http.delete(`/api/v1/role-assignments/${assigned.body().data.id}`)).assertStatus(404)
    ;(await http.delete(`/api/v1/roles/${role.id}`)).assertStatus(204)
  })

  test('a janela de validade da atribuição é respeitada', async ({ client }) => {
    const tenant = await createActiveTenant()
    const admin = await newActor(client, tenant, true)
    const http = api(client, tenant, admin)
    const role = (
      await http.post('/api/v1/roles', {
        code: 'leitor',
        name: 'Leitor',
        permissionCodes: ['iam.read'],
      })
    ).body().data
    const day = 24 * 60 * 60 * 1000

    const expired = await newActor(client, tenant)
    await http.post('/api/v1/role-assignments', {
      membershipId: expired.membershipId,
      roleId: role.id,
      validFrom: new Date(Date.now() - 3 * day).toISOString(),
      validUntil: new Date(Date.now() - day).toISOString(),
    })
    ;(await api(client, tenant, expired).get('/api/v1/roles')).assertStatus(403)

    const future = await newActor(client, tenant)
    await http.post('/api/v1/role-assignments', {
      membershipId: future.membershipId,
      roleId: role.id,
      validFrom: new Date(Date.now() + day).toISOString(),
    })
    ;(await api(client, tenant, future).get('/api/v1/roles')).assertStatus(403)

    const current = await newActor(client, tenant)
    await http.post('/api/v1/role-assignments', {
      membershipId: current.membershipId,
      roleId: role.id,
      validFrom: new Date(Date.now() - day).toISOString(),
      validUntil: new Date(Date.now() + day).toISOString(),
    })
    ;(await api(client, tenant, current).get('/api/v1/roles')).assertStatus(200)

    const inverted = await http.post('/api/v1/role-assignments', {
      membershipId: current.membershipId,
      roleId: role.id,
      validFrom: new Date(Date.now() + day).toISOString(),
      validUntil: new Date(Date.now() - day).toISOString(),
    })
    inverted.assertStatus(422)
  })

  test('isolamento: ids de outro tenant dão 404 e um admin de A não tem poderes em B', async ({
    client,
    assert,
  }) => {
    const a = await createActiveTenant()
    const b = await createActiveTenant()
    const adminA = await newActor(client, a, true)
    const adminB = await newActor(client, b, true)
    const roleB = (
      await api(client, b, adminB).post('/api/v1/roles', {
        code: 'so_b',
        name: 'B',
        permissionCodes: [],
      })
    ).body().data
    const http = api(client, a, adminA)

    ;(await http.get(`/api/v1/roles/${roleB.id}`)).assertStatus(404)
    ;(
      await http.patch(`/api/v1/roles/${roleB.id}`, { expectedVersion: 1, name: 'x' })
    ).assertStatus(404)
    ;(await http.delete(`/api/v1/roles/${roleB.id}`)).assertStatus(404)
    ;(
      await http.post('/api/v1/role-assignments', {
        membershipId: adminB.membershipId,
        roleId: roleB.id,
      })
    ).assertStatus(404)
    ;(
      await http.post('/api/v1/role-assignments', {
        membershipId: adminA.membershipId,
        roleId: roleB.id,
      })
    ).assertStatus(404)
    ;(await http.get('/api/v1/roles/nao-e-uuid')).assertStatus(404)

    // A sessão de A com o selector de B: sem membership em B.
    ;(await api(client, b, adminA).get('/api/v1/roles')).assertStatus(403)
    // Os papéis de A não incluem os de B.
    const listA = (await http.get('/api/v1/roles')).body().data.map((r: any) => r.code)
    assert.notInclude(listA, 'so_b')
  })

  test('/context devolve as permissões efectivas (só apresentação)', async ({ client, assert }) => {
    const tenant = await createActiveTenant()
    const admin = await newActor(client, tenant, true)
    const operator = await newActor(client, tenant)
    const adminPerms = (await api(client, tenant, admin).get('/api/v1/context')).body().data
      .permissions
    assert.include(
      adminPerms.map((p: any) => p.code),
      'iam.manage'
    )
    const opPerms = (await api(client, tenant, operator).get('/api/v1/context')).body().data
      .permissions
    assert.deepEqual(opPerms, [])
  })
})

test.group('autorização | políticas ABAC e simulação', (group) => {
  group.setup(async () => {
    await iamServices().syncCatalog.execute()
  })
  group.each.setup(async () => {
    await resetAuthState()
    return async () => {
      await deleteTestTenants()
      await deleteTestUsers()
    }
  })

  test('uma política DENY activa bloqueia mesmo com o papel; rascunho e desactivada não', async ({
    client,
    assert,
  }) => {
    const tenant = await createActiveTenant()
    const admin = await newActor(client, tenant, true)
    const operator = await newActor(client, tenant)
    const http = api(client, tenant, admin)
    const asOperator = api(client, tenant, operator)
    const role = (
      await http.post('/api/v1/roles', {
        code: 'leitor',
        name: 'Leitor',
        permissionCodes: ['iam.read'],
      })
    ).body().data
    await http.post('/api/v1/role-assignments', {
      membershipId: operator.membershipId,
      roleId: role.id,
    })
    ;(await asOperator.get('/api/v1/roles')).assertStatus(200)

    const created = await http.post('/api/v1/access-policies', {
      name: 'Bloquear este operador',
      resource: 'iam',
      action: 'read',
      effect: 'DENY',
      condition: {
        op: 'eq',
        left: { var: 'subject.membershipId' },
        right: { value: operator.membershipId },
      },
    })
    created.assertStatus(201)
    const policy = created.body().data
    assert.strictEqual(policy.status, 'DRAFT')
    ;(await asOperator.get('/api/v1/roles')).assertStatus(200) // rascunho não vale

    const before = await authzVersion(client, tenant, operator)
    const activated = await http.patch(`/api/v1/access-policies/${policy.id}`, {
      expectedVersion: policy.version,
      status: 'ACTIVE',
    })
    activated.assertStatus(200)
    ;(await asOperator.get('/api/v1/roles')).assertStatus(403)
    assert.strictEqual(await authzVersion(client, tenant, operator), before + 1)
    ;(await http.get('/api/v1/roles')).assertStatus(200) // o administrador não é afectado

    const stale = await http.patch(`/api/v1/access-policies/${policy.id}`, {
      expectedVersion: policy.version,
      status: 'DISABLED',
    })
    stale.assertStatus(409)

    ;(
      await http.patch(`/api/v1/access-policies/${policy.id}`, {
        expectedVersion: activated.body().data.version,
        status: 'DISABLED',
      })
    ).assertStatus(200)
    ;(await asOperator.get('/api/v1/roles')).assertStatus(200)
  })

  test('políticas com AST inválida são rejeitadas com o caminho do problema', async ({
    client,
    assert,
  }) => {
    const tenant = await createActiveTenant()
    const admin = await newActor(client, tenant, true)
    const http = api(client, tenant, admin)

    const bad = await http.post('/api/v1/access-policies', {
      name: 'Má',
      resource: 'iam',
      action: 'read',
      effect: 'DENY',
      condition: { op: 'and', args: [{ op: 'run', code: 'process.exit()' }] },
    })
    bad.assertStatus(422)
    assert.strictEqual(bad.body().error.details[0].code, 'UNKNOWN_OP')
    assert.strictEqual(bad.body().error.details[0].path, 'condition.args[0]')

    const variable = await http.post('/api/v1/access-policies', {
      name: 'Má 2',
      resource: 'iam',
      action: 'read',
      effect: 'DENY',
      condition: { op: 'eq', left: { var: 'process.env.SECRET' }, right: { value: 1 } },
    })
    variable.assertStatus(422)
    ;(await http.get('/api/v1/access-policies')).assertStatus(200)
    assert.lengthOf((await http.get('/api/v1/access-policies')).body().data, 0)
  })

  test('as regras de campo e a condição ficam guardadas e vêm na simulação', async ({
    client,
    assert,
  }) => {
    const tenant = await createActiveTenant()
    const admin = await newActor(client, tenant, true)
    const http = api(client, tenant, admin)
    const policy = await http.post('/api/v1/access-policies', {
      name: 'Salário restrito',
      resource: 'iam',
      action: 'read',
      effect: 'ALLOW',
      status: 'ACTIVE',
      fieldRules: [
        { field: 'salary', mode: 'HIDDEN' },
        { field: 'notes', mode: 'READ_ONLY' },
      ],
    })
    policy.assertStatus(201)

    const simulated = await http.post('/api/v1/authorization/simulate', {
      membershipId: admin.membershipId,
      permission: 'iam.read',
    })
    simulated.assertStatus(200)
    assert.isTrue(simulated.body().data.allowed)
    assert.deepEqual(simulated.body().data.hiddenFields, ['salary'])
    assert.deepEqual(simulated.body().data.readOnlyFields, ['notes'])
  })

  test('a simulação mostra a origem e não concede nada', async ({ client, assert }) => {
    const tenant = await createActiveTenant()
    const other = await createActiveTenant()
    const admin = await newActor(client, tenant, true)
    const operator = await newActor(client, tenant)
    const foreign = await newActor(client, other)
    const http = api(client, tenant, admin)
    const body = { membershipId: operator.membershipId, permission: 'iam.read' }

    const denied = await http.post('/api/v1/authorization/simulate', body)
    denied.assertStatus(200)
    assert.isFalse(denied.body().data.allowed)
    assert.strictEqual(denied.body().data.reason, 'NO_PERMISSION')

    const role = (
      await http.post('/api/v1/roles', {
        code: 'leitor',
        name: 'Leitor',
        permissionCodes: ['iam.read'],
      })
    ).body().data
    await http.post('/api/v1/role-assignments', {
      membershipId: operator.membershipId,
      roleId: role.id,
    })
    const allowed = await http.post('/api/v1/authorization/simulate', body)
    assert.isTrue(allowed.body().data.allowed)
    assert.deepEqual(allowed.body().data.grantedBy, [{ roleId: role.id, roleCode: 'leitor' }])

    // Simular não altera nada: o operador continua a não poder gerir.
    const before = (await http.get('/api/v1/role-assignments')).body().data.length
    await http.post('/api/v1/authorization/simulate', {
      membershipId: operator.membershipId,
      permission: 'iam.manage',
    })
    assert.strictEqual((await http.get('/api/v1/role-assignments')).body().data.length, before)
    ;(
      await api(client, tenant, operator).post('/api/v1/roles', {
        code: 'z1',
        name: 'Z',
        permissionCodes: [],
      })
    ).assertStatus(403)

    // Só quem gere pode simular; membership de outro tenant → 404; permissão mal formada → 422.
    ;(
      await api(client, tenant, operator).post('/api/v1/authorization/simulate', body)
    ).assertStatus(403)
    ;(
      await http.post('/api/v1/authorization/simulate', {
        ...body,
        membershipId: foreign.membershipId,
      })
    ).assertStatus(404)
    ;(
      await http.post('/api/v1/authorization/simulate', { ...body, permission: 'sem-ponto' })
    ).assertStatus(422)
  })

  test('a RLS isola papéis e políticas entre tenants na base de dados', async ({
    client,
    assert,
  }) => {
    const a = await createActiveTenant()
    const b = await createActiveTenant()
    await newActor(client, a, true)
    await newActor(client, b, true)

    const rows = await db.connection('runtime').transaction(async (trx) => {
      await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [a.id])
      return trx.from('roles').select('tenant_id')
    })
    assert.isAbove(rows.length, 0)
    assert.isTrue(rows.every((r) => r.tenant_id === a.id))
    const bare = await db.connection('runtime').from('role_assignments')
    assert.lengthOf(bare, 0)
  })
})
