import { readFileSync } from 'node:fs'
import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import redis from '@adonisjs/redis/services/main'
import { parse } from 'yaml'
import { iamServices } from '#core/permissions/index'
import { PLATFORM_TABLES } from '#core/tenancy/domain/platform_tables'
import { ChangeTenantStatus, LucidTenantStore } from '#platform/tenants/index'
import { capture } from '#tests/support/capture'
import { deleteTestUsers, resetAuthState } from '#tests/support/auth_fixture'
import { createActiveTenant, deleteTestTenants } from '#tests/support/membership_fixture'
import { api, login, newActor, type Actor } from '#tests/support/api_fixture'
import {
  SHARED,
  buildWorld,
  crossTenantUser,
  grantAdmin,
  type World,
} from '#tests/support/matrix_fixture'

/**
 * MATRIZ DE ISOLAMENTO (fatia 1.9). Dois tenants com os MESMOS códigos, nomes e identificações, cada um
 * com todas as entidades de tenant. Nada do que um tenant faz, vê ou referencia pode atingir o outro:
 * API (ids alheios, referências cruzadas, varrimento de todas as rotas), base de dados (RLS, FKs
 * compostas) e Redis. A cobertura é automática: se aparecer uma rota de tenant no OpenAPI ou uma
 * tabela com `tenant_id` sem dados no cenário, esta suite falha.
 */

const UUID0 = '00000000-0000-4000-8000-000000000000'
const WRITES = new Set(['post', 'put', 'patch', 'delete'])

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete'

function call(
  client: any,
  method: Method,
  url: string,
  options: { actor?: Actor; tenantId?: string; csrf?: string; body?: unknown } = {}
) {
  const request = client[method](`/api/v1${url}`)
  if (options.actor) request.header('cookie', options.actor.cookie)
  if (options.tenantId) request.header('x-tenant-id', options.tenantId)
  if (WRITES.has(method)) {
    const csrf = options.csrf ?? options.actor?.csrf
    if (csrf) request.header('x-csrf-token', csrf)
    request.json(options.body ?? {})
  }
  return request as Promise<import('@japa/api-client').ApiResponse>
}

let cached: { a: World; b: World } | undefined

/** Constrói (uma vez) os dois tenants do cenário; o cliente HTTP só existe dentro de um teste. */
async function worlds(client: any): Promise<{ a: World; b: World }> {
  if (!cached) {
    await iamServices().syncCatalog.execute()
    await resetAuthState()
    const a = await buildWorld(client, 'A')
    const b = await buildWorld(client, 'B')
    cached = { a, b }
  }
  return cached
}

async function snapshot(world: World) {
  const get = async (url: string) => (await world.http.get(url)).body().data
  return {
    roles: await get('/api/v1/roles'),
    assignments: await get('/api/v1/role-assignments'),
    policies: await get('/api/v1/access-policies'),
    organizations: await get('/api/v1/organizations'),
    units: await get('/api/v1/organization-units'),
    costCenters: await get('/api/v1/cost-centers'),
    scopes: await get('/api/v1/membership-scopes'),
    members: await get('/api/v1/memberships'),
    invitations: await get('/api/v1/invitations'),
    parties: await get('/api/v1/parties'),
    party: await get(`/api/v1/parties/${world.ids.personParty}`),
    orgParty: await get(`/api/v1/parties/${world.ids.organizationParty}`),
    team: await get(`/api/v1/organization-units/${world.ids.unitRoot}/members`),
    preferences: await get('/api/v1/me/preferences'),
  }
}

const idsOf = (value: unknown): string[] => {
  const found: string[] = []
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk)
    else if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        if (key === 'id' && typeof child === 'string') found.push(child)
        else walk(child)
      }
    }
  }
  walk(value)
  return found
}

/** Pedidos de `me` sobre as entidades de `other`: todos têm de ser 404 (nunca 200, nunca 403). */
function foreignIdCases(me: World, other: World): [Method, string, unknown?][] {
  const o = other.ids
  const m = other.admin.membershipId
  const stale = { expectedVersion: 1 }
  return [
    ['get', `/roles/${o.role}`],
    ['patch', `/roles/${o.role}`, { ...stale, name: 'x' }],
    ['delete', `/roles/${o.role}`],
    ['delete', `/role-assignments/${o.assignment}`],
    ['patch', `/access-policies/${o.policy}`, { ...stale, name: 'x' }],
    ['get', `/organizations/${o.organization}`],
    ['patch', `/organizations/${o.organization}`, { ...stale, tradeName: 'x' }],
    ['get', `/organization-units/${o.unitRoot}`],
    ['patch', `/organization-units/${o.unitRoot}`, { ...stale, name: 'x' }],
    ['get', `/organization-units/${o.unitRoot}/members`],
    [
      'post',
      `/organization-units/${o.unitRoot}/members`,
      { membershipId: me.admin.membershipId, startsOn: '2026-01-01' },
    ],
    ['delete', `/team-members/${o.teamMember}`],
    ['patch', `/cost-centers/${o.costCenter}`, { ...stale, name: 'x' }],
    ['delete', `/membership-scopes/${o.scope}`],
    ['get', `/memberships/${m}`],
    ['patch', `/memberships/${m}`, { ...stale, status: 'SUSPENDED' }],
    ['put', `/memberships/${m}/person`, { partyId: null }],
    ['post', `/invitations/${o.invitation}/revoke`],
    ['patch', `/tax-rates/${o.taxRate}`, { ...stale, name: 'x' }],
    ['patch', `/units/${o.unit}`, { ...stale, name: 'x' }],
    ['patch', `/sequences/${o.sequence}`, { ...stale, padding: 8 }],
    ['get', `/parties/${o.personParty}`],
    ['patch', `/parties/${o.personParty}`, { ...stale, displayName: 'x' }],
    ['get', `/parties/${o.personParty}/possible-duplicates`],
    ['get', `/parties/${o.personParty}/relationships`],
    ['post', `/parties/${o.personParty}/contacts`, { type: 'EMAIL', value: 'x@exemplo.invalid' }],
    [
      'post',
      `/parties/${o.personParty}/addresses`,
      { type: 'OTHER', line1: 'x', city: 'y', countryCode: 'AO' },
    ],
    [
      'post',
      `/parties/${o.personParty}/relationships`,
      { targetPartyId: me.ids.organizationParty, relationshipType: 'X' },
    ],
    ['patch', `/contacts/${o.contact}`, { ...stale, label: 'x' }],
    ['delete', `/contacts/${o.contact}`],
    ['patch', `/addresses/${o.address}`, { ...stale, city: 'x' }],
    ['delete', `/addresses/${o.address}`],
    ['delete', `/party-relationships/${o.relationship}`],
  ]
}

test.group('matriz de isolamento', (group) => {
  group.each.timeout(120_000)
  group.teardown(async () => {
    await deleteTestTenants()
    await deleteTestUsers()
  })

  test('o cenário tem os mesmos códigos e identificações nos dois tenants', async ({
    client,
    assert,
  }) => {
    const { a, b } = await worlds(client)
    assert.notStrictEqual(a.tenant.id, b.tenant.id)
    for (const world of [a, b]) {
      const orgs = (await world.http.get('/api/v1/organizations')).body().data
      assert.strictEqual(orgs[0].code, SHARED.orgCode)
      const roles = (await world.http.get('/api/v1/roles')).body().data.map((r: any) => r.code)
      assert.include(roles, SHARED.roleCode)
      const person = (await world.http.get(`/api/v1/parties/${world.ids.personParty}`)).body().data
      assert.strictEqual(person.contacts[0].value, SHARED.personEmail)
    }
    // Cada tenant tem o seu: nenhum id se repete entre os dois.
    const [sa, sb] = [await snapshot(a), await snapshot(b)]
    const idsA = new Set(idsOf(sa))
    assert.isEmpty(idsOf(sb).filter((id) => idsA.has(id)))
  })

  test('ids do outro tenant dão sempre 404, nos dois sentidos, e nada muda', async ({
    client,
    assert,
  }) => {
    const { a, b } = await worlds(client)
    const [beforeA, beforeB] = [await snapshot(a), await snapshot(b)]

    for (const [me, other] of [
      [a, b],
      [b, a],
    ] as const) {
      for (const [method, url, body] of foreignIdCases(me, other)) {
        const response = await call(client, method, url, {
          actor: me.admin,
          tenantId: me.tenant.id,
          body,
        })
        assert.strictEqual(response.status(), 404, `${me.label} ${method.toUpperCase()} ${url}`)
        assert.strictEqual(response.body().error.code, 'NOT_FOUND')
      }
    }

    assert.deepEqual(await snapshot(a), beforeA)
    assert.deepEqual(await snapshot(b), beforeB)
  })

  test('as listagens só contêm dados do próprio tenant e têm a mesma dimensão nos dois', async ({
    client,
    assert,
  }) => {
    const { a, b } = await worlds(client)
    const [sa, sb] = [await snapshot(a), await snapshot(b)]
    const idsA = new Set(idsOf(sa))
    const idsB = new Set(idsOf(sb))
    assert.isEmpty([...idsA].filter((id) => idsB.has(id)))
    for (const key of [
      'roles',
      'assignments',
      'policies',
      'organizations',
      'units',
      'costCenters',
      'scopes',
      'members',
      'invitations',
      'parties',
      'team',
    ] as const) {
      assert.lengthOf(sa[key], sb[key].length, key)
      assert.isAbove(sa[key].length, 0, key)
    }
    // As preferências são do membro e do tenant: o mesmo ui.theme tem valores diferentes.
    assert.strictEqual(sa.preferences['ui.theme'], 'dark')
    assert.strictEqual(sb.preferences['ui.theme'], 'light')
    // A pesquisa não atravessa tenants: o mesmo email existe nos dois mas cada um vê só o seu.
    for (const world of [a, b]) {
      const found = (await world.http.get(`/api/v1/parties?q=${SHARED.personEmail}`)).body().data
      assert.deepEqual(
        found.map((p: any) => p.id),
        [world.ids.personParty]
      )
    }
    // Duplicados não cruzam tenants (mesmo email, mesmo documento, mesmo NIF).
    for (const world of [a, b]) {
      assert.deepEqual(
        (
          await world.http.get(`/api/v1/parties/${world.ids.personParty}/possible-duplicates`)
        ).body().data,
        []
      )
      assert.deepEqual(
        (
          await world.http.get(`/api/v1/parties/${world.ids.organizationParty}/possible-duplicates`)
        ).body().data,
        []
      )
    }
  })

  test('referências cruzadas em corpos de pedido são rejeitadas (404 ou 422)', async ({
    client,
    assert,
  }) => {
    const { a, b } = await worlds(client)
    const bi = b.ids
    const cases: [string, Method, string, Record<string, unknown>, number][] = [
      [
        'atribuir papel de B a membro de A',
        'post',
        '/role-assignments',
        { membershipId: a.member.membershipId, roleId: bi.role },
        404,
      ],
      [
        'atribuir papel de A a membro de B',
        'post',
        '/role-assignments',
        { membershipId: b.member.membershipId, roleId: a.ids.role },
        404,
      ],
      [
        'atribuir papel com unidade de B',
        'post',
        '/role-assignments',
        {
          membershipId: a.operator.membershipId,
          roleId: a.ids.role,
          organizationUnitId: bi.unitRoot,
        },
        404,
      ],
      [
        'unidade numa organização de B',
        'post',
        '/organization-units',
        { organizationId: bi.organization, code: 'X1', name: 'x' },
        404,
      ],
      [
        'unidade com pai de B',
        'post',
        '/organization-units',
        { organizationId: a.ids.organization, parentId: bi.unitRoot, code: 'X2', name: 'x' },
        422,
      ],
      [
        'unidade com gestor de B',
        'post',
        '/organization-units',
        {
          organizationId: a.ids.organization,
          managerMembershipId: b.admin.membershipId,
          code: 'X3',
          name: 'x',
        },
        422,
      ],
      [
        'centro de custo com pai de B',
        'post',
        '/cost-centers',
        { organizationId: a.ids.organization, parentId: bi.costCenter, code: 'X4', name: 'x' },
        422,
      ],
      [
        'centro de custo com responsável de B',
        'post',
        '/cost-centers',
        {
          organizationId: a.ids.organization,
          responsibleMembershipId: b.admin.membershipId,
          code: 'X5',
          name: 'x',
        },
        422,
      ],
      [
        'âmbito de membro de B',
        'post',
        '/membership-scopes',
        { membershipId: b.member.membershipId, organizationId: a.ids.organization },
        404,
      ],
      [
        'âmbito com organização de B',
        'post',
        '/membership-scopes',
        { membershipId: a.operator.membershipId, organizationId: bi.organization },
        404,
      ],
      [
        'âmbito com unidade de B',
        'post',
        '/membership-scopes',
        {
          membershipId: a.operator.membershipId,
          organizationId: a.ids.organization,
          organizationUnitId: bi.unitRoot,
        },
        422,
      ],
      [
        'equipa com membro de B',
        'post',
        `/organization-units/${a.ids.unitRoot}/members`,
        { membershipId: b.member.membershipId, startsOn: '2026-01-01' },
        404,
      ],
      [
        'relação para party de B',
        'post',
        `/parties/${a.ids.personParty}/relationships`,
        { targetPartyId: bi.organizationParty, relationshipType: 'X' },
        404,
      ],
      [
        'convite com papel de B',
        'post',
        '/invitations',
        { email: 'novo1@exemplo.invalid', roleIds: [bi.role] },
        422,
      ],
      [
        'convite com unidade de B',
        'post',
        '/invitations',
        { email: 'novo2@exemplo.invalid', unitIds: [bi.unitRoot] },
        422,
      ],
      [
        'organização por omissão de B',
        'put',
        '/me/default-organization',
        { organizationId: bi.organization },
        422,
      ],
      [
        'ligar membro de A a pessoa de B',
        'put',
        `/memberships/${a.operator.membershipId}/person`,
        { partyId: bi.personParty },
        404,
      ],
      [
        'ligar membro de B',
        'put',
        `/memberships/${b.operator.membershipId}/person`,
        { partyId: a.ids.personParty },
        404,
      ],
      [
        'simular membro de B',
        'post',
        '/authorization/simulate',
        { membershipId: b.admin.membershipId, permission: 'iam.read' },
        404,
      ],
    ]
    for (const [label, method, url, body, expected] of cases) {
      const response = await call(client, method, `${url}`, {
        actor: a.admin,
        tenantId: a.tenant.id,
        body,
      })
      assert.strictEqual(response.status(), expected, label)
    }
  })

  test('um tenantId no corpo ou no URL nunca decide o tenant', async ({ client, assert }) => {
    const { a, b } = await worlds(client)
    const created = await call(client, 'post', '/organizations', {
      actor: a.admin,
      tenantId: a.tenant.id,
      body: {
        code: 'EXTRA-A',
        legalName: 'Extra',
        countryCode: 'AO',
        baseCurrency: 'AOA',
        tenantId: b.tenant.id,
        tenant_id: b.tenant.id,
      },
    })
    created.assertStatus(201)
    const id = created.body().data.id
    assert.notProperty(created.body().data, 'tenantId')
    assert.isOk((await a.http.get(`/api/v1/organizations/${id}`)).body().data)
    ;(await b.http.get(`/api/v1/organizations/${id}`)).assertStatus(404)
    assert.notInclude(
      (await b.http.get('/api/v1/organizations')).body().data.map((o: any) => o.code),
      'EXTRA-A'
    )
    // Limpeza: não há DELETE de organizações; remove-se a linha de teste para não afectar as outras verificações.
    await db.connection('owner').transaction(async (trx) => {
      await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [a.tenant.id])
      await trx.from('organizations').where('id', id).delete()
    })

    // Selectores contraditórios ou inválidos nunca são resolvidos "pelo que der".
    const both = await client
      .get('/api/v1/context')
      .header('cookie', a.admin.cookie)
      .header('x-tenant-id', a.tenant.id)
      .header('x-tenant-code', b.tenant.code)
    both.assertStatus(400)
    ;(
      await client
        .get('/api/v1/context')
        .header('cookie', a.admin.cookie)
        .header('x-tenant-code', b.tenant.code)
    ).assertStatus(403)
  })

  test('varrimento: TODAS as rotas de tenant do OpenAPI recusam sessão, selector e tenant errados', async ({
    client,
    assert,
  }) => {
    const { a, b } = await worlds(client)
    const spec = parse(readFileSync('openapi/openapi.yaml', 'utf8')) as {
      paths: Record<string, Record<string, { parameters?: Record<string, unknown>[] }>>
    }
    const operations: { method: Method; path: string }[] = []
    for (const [path, ops] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        const takesTenant = (op.parameters ?? []).some(
          (p) => p.$ref === '#/components/parameters/TenantId' || p.name === 'X-Tenant-Id'
        )
        if (takesTenant) operations.push({ method: method as Method, path })
      }
    }
    // Operações que NÃO são de tenant (públicas, sessão ou conta). Qualquer outra tem de declarar o
    // selector de tenant, senão escapava ao varrimento: acrescentar uma rota de tenant sem selector falha aqui.
    const NON_TENANT = new Set([
      'get /health',
      'get /ready',
      'post /auth/login',
      'post /auth/forgot-password',
      'post /auth/reset-password',
      'post /auth/verify-email',
      'post /auth/logout',
      'get /me',
      'get /me/sessions',
      'delete /me/sessions/{id}',
      'post /me/password',
      'get /me/security-events',
      'get /me/tenants',
      'post /invitations/accept',
      // Administração da plataforma: sem selector de tenant (política própria `platform.*`; testada em platform.spec.ts)
      'get /platform/tenants',
      'post /platform/tenants',
      'get /platform/tenants/{id}',
      'post /platform/tenants/{id}/suspend',
      'post /platform/tenants/{id}/resume',
      'get /platform/plans',
      'post /platform/plans',
      'post /platform/plans/{code}/revisions/{revision}/publish',
      'post /platform/plans/{code}/revisions/{revision}/retire',
      'get /platform/tenants/{id}/subscription',
      'post /platform/tenants/{id}/subscription',
      'put /platform/tenants/{id}/subscription/plan',
      'put /platform/tenants/{id}/subscription/status',
    ])
    const declared = new Set(operations.map((o) => `${o.method} ${o.path}`))
    const undeclared = Object.entries(spec.paths).flatMap(([path, ops]) =>
      Object.keys(ops)
        .map((method) => `${method} ${path}`)
        .filter((key) => !NON_TENANT.has(key) && !declared.has(key))
    )
    assert.isEmpty(undeclared, `rotas sem selector de tenant no OpenAPI: ${undeclared.join(', ')}`)
    assert.isAbove(operations.length, 50)

    const url = (path: string) => path.replace('{id}', UUID0).replace('{key}', 'ui.theme')
    const noPermissionNeeded = (path: string) =>
      path === '/context' ||
      path === '/context/features' ||
      path === '/settings/effective' ||
      path.startsWith('/me/')

    for (const { method, path } of operations) {
      const label = `${method.toUpperCase()} ${path}`
      const u = url(path)

      const anonymous = await call(client, method, u, { tenantId: a.tenant.id })
      assert.strictEqual(anonymous.status(), 401, `${label} sem sessão`)

      const noSelector = await call(client, method, u, { actor: a.admin })
      assert.strictEqual(noSelector.status(), 400, `${label} sem selector`)
      assert.strictEqual(noSelector.body().error.code, 'TENANT_SELECTOR_REQUIRED')

      const wrongTenant = await call(client, method, u, { actor: a.admin, tenantId: b.tenant.id })
      assert.strictEqual(wrongTenant.status(), 403, `${label} tenant alheio`)
      assert.strictEqual(wrongTenant.body().error.code, 'TENANT_ACCESS_DENIED')

      const missing = await call(client, method, u, { actor: a.admin, tenantId: UUID0 })
      assert.strictEqual(
        missing.body().error.code,
        'TENANT_ACCESS_DENIED',
        `${label} tenant inexistente`
      )

      if (WRITES.has(method)) {
        const csrf = await call(client, method, u, {
          actor: a.admin,
          tenantId: a.tenant.id,
          csrf: 'falso',
        })
        assert.strictEqual(csrf.body().error.code, 'CSRF_TOKEN_INVALID', `${label} CSRF`)
      }

      const operator = await call(client, method, u, { actor: a.operator, tenantId: a.tenant.id })
      if (noPermissionNeeded(path)) {
        assert.notInclude([401, 403], operator.status(), `${label} sem permissão extra`)
      } else {
        assert.strictEqual(operator.status(), 403, `${label} sem papel`)
        assert.strictEqual(operator.body().error.code, 'PERMISSION_DENIED')
      }
    }
  })

  test('um membro com papel limitado só faz o que o papel permite', async ({ client, assert }) => {
    const { a } = await worlds(client)
    // `member` tem só party.read.
    const asMember = api(client, a.tenant, a.member)
    ;(await asMember.get('/api/v1/parties')).assertStatus(200)
    for (const [method, url] of [
      ['post', '/people'],
      ['patch', `/parties/${a.ids.personParty}`],
      ['get', '/roles'],
      ['post', '/roles'],
      ['get', '/organizations'],
      ['get', '/memberships'],
      ['get', '/invitations'],
      ['post', '/authorization/simulate'],
    ] as const) {
      const response = await call(client, method, url, {
        actor: a.member,
        tenantId: a.tenant.id,
        body: {},
      })
      assert.strictEqual(response.status(), 403, `${method} ${url}`)
    }
    const permissions = (await asMember.get('/api/v1/context'))
      .body()
      .data.permissions.map((p: any) => p.code)
    assert.deepEqual(permissions, ['party.read'])
  })

  test('trocar de tenant não reutiliza permissões nem papéis do anterior', async ({
    client,
    assert,
  }) => {
    const { a, b } = await worlds(client)
    const user = await crossTenantUser(a.tenant, b.tenant)
    await grantAdmin(a.tenant, user.membershipA)
    const session = await login(client, user.email)
    const actor: Actor = {
      email: user.email,
      userId: user.user.id,
      membershipId: user.membershipA,
      ...session,
    }

    for (let i = 0; i < 3; i++) {
      const inA = await api(client, a.tenant, actor).get('/api/v1/context')
      assert.include(
        inA.body().data.permissions.map((p: any) => p.code),
        'iam.manage'
      )
      assert.strictEqual(inA.body().data.tenant.id, a.tenant.id)

      const inB = await api(client, b.tenant, { ...actor, membershipId: user.membershipB }).get(
        '/api/v1/context'
      )
      inB.assertStatus(200)
      assert.strictEqual(inB.body().data.tenant.id, b.tenant.id)
      assert.deepEqual(inB.body().data.permissions, [], 'em B não tem nada de A')
      assert.strictEqual(inB.body().data.membership.id, user.membershipB)

      const rolesInB = await api(client, b.tenant, actor).get('/api/v1/roles')
      assert.strictEqual(rolesInB.status(), 403)
      assert.strictEqual(rolesInB.body().error.code, 'PERMISSION_DENIED')
      ;(await api(client, a.tenant, actor).get('/api/v1/roles')).assertStatus(200)
    }
  })

  test('pedidos intercalados dos dois tenants nunca se misturam', async ({ client, assert }) => {
    const { a, b } = await worlds(client)
    const jobs = Array.from({ length: 24 }, (_, i) => {
      const world = i % 2 === 0 ? a : b
      return world.http
        .get('/api/v1/organizations')
        .then((r) => ({ label: world.label, ids: idsOf(r.body().data) }))
    })
    for (const result of await Promise.all(jobs)) {
      const world = result.label === 'A' ? a : b
      const other = result.label === 'A' ? b : a
      assert.include(result.ids, world.ids.organization)
      assert.notInclude(result.ids, other.ids.organization)
    }
  })

  test('um tenant suspenso bloqueia todas as rotas; uma membership suspensa também', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const small = await createActiveTenant()
    const admin = await newActor(client, small, true)
    ;(await api(client, small, admin).get('/api/v1/roles')).assertStatus(200)

    await new ChangeTenantStatus(new LucidTenantStore()).execute(small.code, 'SUSPENDED')
    for (const [method, url] of [
      ['get', '/context'],
      ['get', '/roles'],
      ['get', '/parties'],
      ['get', '/organizations'],
      ['post', '/people'],
      ['get', '/memberships'],
    ] as const) {
      const response = await call(client, method, url, {
        actor: admin,
        tenantId: small.id,
        body: {},
      })
      assert.strictEqual(response.status(), 403, url)
      assert.strictEqual(response.body().error.code, 'TENANT_NOT_ACTIVE', url)
    }
    // Quem não é membro do tenant suspenso vê o mesmo que num tenant inexistente.
    const outsider = await call(client, 'get', '/roles', { actor: a.admin, tenantId: small.id })
    assert.strictEqual(outsider.body().error.code, 'TENANT_ACCESS_DENIED')
  })

  test('base de dados: toda a tabela de tenant está coberta pelo cenário e isolada por RLS', async ({
    client,
    assert,
  }) => {
    const { a, b } = await worlds(client)
    const owner = db.connection('owner')
    const tables = (
      await owner.rawQuery(
        `select c.table_name from information_schema.columns c
           join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
          where c.table_schema = 'public' and c.column_name = 'tenant_id' and t.table_type = 'BASE TABLE'
          order by c.table_name`
      )
    ).rows
      .map((r: { table_name: string }) => r.table_name)
      // `tenant_domains` tem `tenant_id` mas é global (plano de controlo): consta de PLATFORM_TABLES.
      .filter((t: string) => !PLATFORM_TABLES.has(`public.${t}`)) as string[]
    assert.isAbove(tables.length, 15)

    const asTenant = <T>(
      connection: string,
      tenantId: string | null,
      fn: (trx: any) => Promise<T>
    ) =>
      db.connection(connection).transaction(async (trx) => {
        if (tenantId) await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [tenantId])
        return fn(trx)
      }) as Promise<T>
    const count = async (trx: any, sql: string): Promise<number> => {
      const result = await trx.rawQuery(sql)
      return result.rows[0].n as number
    }

    for (const table of tables) {
      const ownerA = await asTenant('owner', a.tenant.id, (trx) =>
        count(trx, `select count(*)::int as n from ${table} where tenant_id = '${a.tenant.id}'`)
      )
      const ownerB = await asTenant('owner', b.tenant.id, (trx) =>
        count(trx, `select count(*)::int as n from ${table} where tenant_id = '${b.tenant.id}'`)
      )
      assert.isAbove(ownerA, 0, `${table}: o cenário não tem dados de A (estenda matrix_fixture)`)
      assert.isAbove(ownerB, 0, `${table}: o cenário não tem dados de B (estenda matrix_fixture)`)

      // Sem contexto: nada. Com contexto de A: só A, e tudo o que é de A.
      assert.strictEqual(
        await asTenant('runtime', null, (trx) =>
          count(trx, `select count(*)::int as n from ${table}`)
        ),
        0,
        `${table} sem contexto`
      )
      const seenByA = await asTenant('runtime', a.tenant.id, (trx) =>
        count(trx, `select count(*)::int as n from ${table}`)
      )
      assert.strictEqual(seenByA, ownerA, `${table}: A vê exactamente os seus`)
      assert.strictEqual(
        await asTenant('runtime', a.tenant.id, (trx) =>
          count(trx, `select count(*)::int as n from ${table} where tenant_id <> '${a.tenant.id}'`)
        ),
        0,
        `${table}: A não vê linhas de B`
      )

      if (table === 'audit_logs') {
        // Imutável: a conta de runtime nem sequer tem privilégios de escrita (mais forte do que a RLS).
        for (const sql of [
          `delete from ${table} where tenant_id = '${a.tenant.id}'`,
          `update ${table} set reason = 'x' where tenant_id = '${a.tenant.id}'`,
          `insert into ${table} (tenant_id, action, resource_type, actor_type) values ('${a.tenant.id}', 'X', 'x', 'USER')`,
        ]) {
          const denied = await capture(() =>
            asTenant('runtime', a.tenant.id, (t) => t.rawQuery(sql))
          )
          assert.match(denied.message, /permission denied/, `${table}: ${sql.split(' ')[0]}`)
        }
        continue
      }

      // Não consegue apagar nem mudar linhas de B, nem passar as suas para B (WITH CHECK).
      const deleted = await asTenant('runtime', a.tenant.id, (trx) =>
        count(
          trx,
          `with d as (delete from ${table} where tenant_id = '${b.tenant.id}' returning 1) select count(*)::int as n from d`
        )
      )
      assert.strictEqual(deleted, 0, `${table}: delete cruzado`)
      const moved = await capture(() =>
        asTenant('runtime', a.tenant.id, (trx) =>
          trx.rawQuery(
            `update ${table} set tenant_id = '${b.tenant.id}' where tenant_id = '${a.tenant.id}'`
          )
        )
      )
      assert.match(moved.message, /row-level security/, `${table}: mover linhas para B`)
    }
  })

  test('base de dados: uma linha de um tenant nunca referencia outro (FKs compostas)', async ({
    client,
    assert,
  }) => {
    const { a, b } = await worlds(client)
    // O id da pessoa de B lê-se com o contexto de B (para A a RLS esconderia a linha e o teste seria vazio).
    const personIdOfB = await db.connection('owner').transaction(async (trx) => {
      await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [b.tenant.id])
      const row = await trx.from('people').where('party_id', b.ids.personParty).first()
      return row.id as string
    })
    const attempt = (sql: string, params: unknown[]) =>
      capture(() =>
        db.connection('owner').transaction(async (trx) => {
          await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [a.tenant.id])
          await trx.rawQuery(sql, params as never)
        })
      )
    const cases: [string, string, unknown[]][] = [
      [
        'atribuição de A a papel de B',
        `insert into role_assignments (tenant_id, membership_id, role_id) values (?, ?, ?)`,
        [a.tenant.id, a.operator.membershipId, b.ids.role],
      ],
      [
        'atribuição de A a membro de B',
        `insert into role_assignments (tenant_id, membership_id, role_id) values (?, ?, ?)`,
        [a.tenant.id, b.operator.membershipId, a.ids.role],
      ],
      [
        'contacto de A em party de B',
        `insert into contacts (tenant_id, party_id, type, value, value_key) values (?, ?, 'EMAIL', 'x@y.zz', 'x@y.zz')`,
        [a.tenant.id, b.ids.personParty],
      ],
      [
        'unidade de A com organização de B',
        `insert into organization_units (tenant_id, organization_id, code, name) values (?, ?, 'ZZ', 'zz')`,
        [a.tenant.id, b.ids.organization],
      ],
      [
        'equipa de A em unidade de B',
        `insert into team_members (tenant_id, unit_id, membership_id, starts_on) values (?, ?, ?, '2026-01-01')`,
        [a.tenant.id, b.ids.unitRoot, a.operator.membershipId],
      ],
      [
        'relação de A para party de B',
        `insert into party_relationships (tenant_id, source_party_id, target_party_id, relationship_type) values (?, ?, ?, 'X')`,
        [a.tenant.id, a.ids.personParty, b.ids.organizationParty],
      ],
      [
        'membership de A ligada a pessoa de B',
        `update tenant_memberships set person_id = ? where id = ?`,
        [personIdOfB, a.operator.membershipId],
      ],
    ]
    for (const [label, sql, params] of cases) {
      const error = await attempt(sql, params).catch((e) => {
        throw new Error(`${label}: ${e.message}`)
      })
      assert.match(
        error.message,
        /violates (foreign key|row-level security)|null value|not-null/i,
        label
      )
    }
  })

  test('Redis: nenhuma chave guarda dados de tenant sem prefixo de tenant', async ({
    client,
    assert,
  }) => {
    await worlds(client)
    const keys = await redis.keys('*')
    // Prefixos permitidos hoje: contadores de rate limit (por IP/conta, sem dados de negócio) e a caixa
    // de desenvolvimento. Qualquer cache, fila ou canal novo tem de usar `tenant:{id}:` e ser listado aqui.
    const allowed = /^(ratelimit:|dev:mailbox$|tenant:[0-9a-f-]{36}:)/
    const unexpected = keys.filter((k) => !allowed.test(k))
    assert.isEmpty(unexpected, `chaves fora do padrão: ${unexpected.join(', ')}`)
    assert.isFalse(
      keys.some((k) => k.includes(SHARED.personEmail)),
      'nenhum email de cadastro em chaves'
    )
  })
})
