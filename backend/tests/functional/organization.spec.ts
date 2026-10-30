import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { iamServices } from '#core/permissions/index'
import { LucidTenantDatabase, serviceTenantContext } from '#core/tenancy/index'
import { capture } from '#tests/support/capture'
import { deleteTestUsers, resetAuthState } from '#tests/support/auth_fixture'
import { createActiveTenant, deleteTestTenants } from '#tests/support/membership_fixture'
import { api, authzVersion, newActor, type Actor } from '#tests/support/api_fixture'
import type { Tenant } from '#platform/tenants/index'

let counter = 0
const code = (prefix: string) => `${prefix}${process.pid}${counter++}`

const orgBody = (extra: Record<string, unknown> = {}) => ({
  code: code('ORG'),
  legalName: 'Empresa Exemplo, Lda.',
  countryCode: 'AO',
  baseCurrency: 'AOA',
  ...extra,
})

async function newOrg(http: ReturnType<typeof api>, extra: Record<string, unknown> = {}) {
  const response = await http.post('/api/v1/organizations', orgBody(extra))
  response.assertStatus(201)
  return response.body().data as { id: string; version: number }
}

async function newUnit(
  http: ReturnType<typeof api>,
  organizationId: string,
  parentId: string | null = null,
  extra: Record<string, unknown> = {}
) {
  const response = await http.post('/api/v1/organization-units', {
    organizationId,
    parentId,
    code: code('U'),
    name: 'Unidade',
    ...extra,
  })
  response.assertStatus(201)
  return response.body().data as { id: string; version: number; parentId: string | null }
}

async function setup(client: any) {
  const tenant = await createActiveTenant()
  const admin = await newActor(client, tenant, true)
  const operator = await newActor(client, tenant)
  return { tenant, admin, operator, http: api(client, tenant, admin) }
}

test.group('organização | estrutura', (group) => {
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

  test('exige organization.read / organization.manage', async ({ client, assert }) => {
    const { tenant, operator, http } = await setup(client)
    ;(await api(client, tenant, operator).get('/api/v1/organizations')).assertStatus(403)
    ;(await api(client, tenant, operator).post('/api/v1/organizations', orgBody())).assertStatus(
      403
    )
    const org = await newOrg(http)
    const list = await http.get('/api/v1/organizations')
    assert.deepEqual(
      list.body().data.map((o: any) => o.id),
      [org.id]
    )
  })

  test('cria, valida, evita códigos repetidos e controla versões', async ({ client, assert }) => {
    const { http } = await setup(client)
    const body = orgBody()
    const created = await http.post('/api/v1/organizations', body)
    created.assertStatus(201)
    assert.match(String(created.header('location')), /\/api\/v1\/organizations\/[0-9a-f-]{36}$/)
    assert.strictEqual(created.body().data.fiscalYearStartMonth, 1)
    ;(await http.post('/api/v1/organizations', body)).assertStatus(409)

    for (const bad of [
      { countryCode: 'ao' },
      { baseCurrency: 'kz' },
      { fiscalYearStartMonth: 13 },
      { legalName: '   ' },
      { code: 'com espaço' },
    ]) {
      const response = await http.post('/api/v1/organizations', orgBody(bad))
      response.assertStatus(422)
    }

    const org = created.body().data
    const updated = await http.patch(`/api/v1/organizations/${org.id}`, {
      expectedVersion: org.version,
      tradeName: 'Exemplo',
      code: 'TENTATIVA',
    })
    updated.assertStatus(200)
    assert.strictEqual(updated.body().data.tradeName, 'Exemplo')
    assert.strictEqual(updated.body().data.code, body.code, 'o código não muda')
    const stale = await http.patch(`/api/v1/organizations/${org.id}`, {
      expectedVersion: org.version,
      tradeName: 'Velho',
    })
    stale.assertStatus(409)
    assert.strictEqual(stale.body().error.code, 'VERSION_CONFLICT')
  })

  test('unidades: árvore, pai da mesma organização e código único', async ({ client, assert }) => {
    const { http } = await setup(client)
    const a = await newOrg(http)
    const b = await newOrg(http)
    const root = await newUnit(http, a.id)
    const child = await newUnit(http, a.id, root.id, { type: 'DEPARTMENT' })
    assert.strictEqual(child.parentId, root.id)

    const foreignParent = await http.post('/api/v1/organization-units', {
      organizationId: b.id,
      parentId: root.id,
      code: code('U'),
      name: 'Filha de outra organização',
    })
    foreignParent.assertStatus(422)
    assert.strictEqual(foreignParent.body().error.details[0].code, 'INVALID_PARENT')

    const dup = { organizationId: a.id, code: 'DUP', name: 'x' }
    ;(await http.post('/api/v1/organization-units', dup)).assertStatus(201)
    ;(await http.post('/api/v1/organization-units', dup)).assertStatus(409)
    ;(
      await http.post('/api/v1/organization-units', { ...dup, code: 'X', type: 'NADA' })
    ).assertStatus(422)
    ;(
      await http.post('/api/v1/organization-units', {
        organizationId: '00000000-0000-4000-8000-000000000000',
        code: 'Z',
        name: 'z',
      })
    ).assertStatus(404)

    const byOrg = await http.get(`/api/v1/organization-units?organizationId=${a.id}`)
    assert.lengthOf(byOrg.body().data, 3)
    assert.lengthOf(
      (await http.get(`/api/v1/organization-units?organizationId=${b.id}`)).body().data,
      0
    )
  })

  test('uma unidade não pode ser pai de si própria nem de um antepassado', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    const org = await newOrg(http)
    const root = await newUnit(http, org.id)
    const mid = await newUnit(http, org.id, root.id)
    const leaf = await newUnit(http, org.id, mid.id)

    for (const [unit, parentId] of [
      [root, root.id],
      [root, leaf.id],
      [mid, leaf.id],
    ] as const) {
      const response = await http.patch(`/api/v1/organization-units/${unit.id}`, {
        expectedVersion: unit.version,
        parentId,
      })
      response.assertStatus(422)
      assert.strictEqual(response.body().error.details[0].code, 'INVALID_PARENT')
    }

    // Mover para um ramo válido e para a raiz funciona.
    const moved = await http.patch(`/api/v1/organization-units/${leaf.id}`, {
      expectedVersion: leaf.version,
      parentId: root.id,
    })
    moved.assertStatus(200)
    const toRoot = await http.patch(`/api/v1/organization-units/${leaf.id}`, {
      expectedVersion: moved.body().data.version,
      parentId: null,
    })
    assert.isNull(toRoot.body().data.parentId)
  })

  test('a base de dados também impõe o pai da mesma organização e o "não ser pai de si"', async ({
    client,
    assert,
  }) => {
    const { tenant, http } = await setup(client)
    const a = await newOrg(http)
    const b = await newOrg(http)
    const unitA = await newUnit(http, a.id)
    const context = serviceTenantContext(tenant.id, 'teste')
    const insert = (org: string, parent: string | null) =>
      new LucidTenantDatabase().run(
        (scope) =>
          (scope as any).trx.rawQuery(
            `insert into organization_units (tenant_id, organization_id, parent_id, code, name)
             values (?, ?, ?, 'RAW', 'raw')`,
            [tenant.id, org, parent as string]
          ),
        context
      )

    const error = await capture(() => insert(b.id, unitA.id))
    assert.match(error.message, /organization_units_parent_fk/)

    const own = await capture(() =>
      new LucidTenantDatabase().run(
        (scope) =>
          (scope as any).trx.rawQuery(`update organization_units set parent_id = id where id = ?`, [
            unitA.id,
          ]),
        context
      )
    )
    assert.match(own.message, /organization_units_not_own_parent/)
  })

  test('atualizar unidade: gestor tem de ser do tenant; inactivar mantém o histórico', async ({
    client,
    assert,
  }) => {
    const { admin, http } = await setup(client)
    const other = await createActiveTenant()
    const foreign = await newActor(client, other)
    const org = await newOrg(http)
    const unit = await newUnit(http, org.id)

    const bad = await http.patch(`/api/v1/organization-units/${unit.id}`, {
      expectedVersion: unit.version,
      managerMembershipId: foreign.membershipId,
    })
    bad.assertStatus(422)

    const ok = await http.patch(`/api/v1/organization-units/${unit.id}`, {
      expectedVersion: unit.version,
      managerMembershipId: admin.membershipId,
      active: false,
    })
    ok.assertStatus(200)
    assert.isFalse(ok.body().data.active)
    ;(await http.get(`/api/v1/organization-units/${unit.id}`)).assertStatus(200) // histórico preservado
  })

  test('centros de custo: pai de outra organização rejeitado, ciclos e responsável', async ({
    client,
    assert,
  }) => {
    const { admin, http } = await setup(client)
    const a = await newOrg(http)
    const b = await newOrg(http)
    const post = (body: Record<string, unknown>) => http.post('/api/v1/cost-centers', body)
    const ccA = (await post({ organizationId: a.id, code: 'CC1', name: 'Geral' })).body().data
    const child = (
      await post({ organizationId: a.id, code: 'CC2', name: 'Filho', parentId: ccA.id })
    ).body().data

    const foreign = await post({ organizationId: b.id, code: 'CC3', name: 'Mau', parentId: ccA.id })
    foreign.assertStatus(422)
    assert.strictEqual(foreign.body().error.details[0].code, 'INVALID_PARENT')
    ;(await post({ organizationId: a.id, code: 'CC1', name: 'Repetido' })).assertStatus(409)

    const cycle = await http.patch(`/api/v1/cost-centers/${ccA.id}`, {
      expectedVersion: ccA.version,
      parentId: child.id,
    })
    cycle.assertStatus(422)

    const ok = await http.patch(`/api/v1/cost-centers/${child.id}`, {
      expectedVersion: child.version,
      responsibleMembershipId: admin.membershipId,
    })
    ok.assertStatus(200)
    assert.strictEqual(ok.body().data.responsibleMembershipId, admin.membershipId)
    assert.lengthOf((await http.get(`/api/v1/cost-centers?organizationId=${a.id}`)).body().data, 2)
  })

  test('equipas: membros com janela, unidade inactiva recusa, remoção', async ({
    client,
    assert,
  }) => {
    const { admin, operator, http } = await setup(client)
    const org = await newOrg(http)
    const unit = await newUnit(http, org.id)
    const url = `/api/v1/organization-units/${unit.id}/members`

    const added = await http.post(url, {
      membershipId: operator.membershipId,
      startsOn: '2026-01-15',
      roleLabel: 'Analista',
    })
    added.assertStatus(201)
    assert.strictEqual(added.body().data.startsOn, '2026-01-15')
    assert.isNull(added.body().data.endsOn)
    assert.lengthOf((await http.get(url)).body().data, 1)

    ;(
      await http.post(url, {
        membershipId: operator.membershipId,
        startsOn: '2026-05-01',
        endsOn: '2026-04-01',
      })
    ).assertStatus(422)
    ;(
      await http.post(url, {
        membershipId: '00000000-0000-4000-8000-000000000000',
        startsOn: '2026-01-01',
      })
    ).assertStatus(404)

    await http.patch(`/api/v1/organization-units/${unit.id}`, {
      expectedVersion: unit.version,
      active: false,
    })
    const inactive = await http.post(url, {
      membershipId: admin.membershipId,
      startsOn: '2026-01-01',
    })
    inactive.assertStatus(409)
    assert.strictEqual(inactive.body().error.code, 'UNIT_INACTIVE')

    ;(await http.delete(`/api/v1/team-members/${added.body().data.id}`)).assertStatus(204)
    ;(await http.delete(`/api/v1/team-members/${added.body().data.id}`)).assertStatus(404)
  })

  test('isolamento: organizações, unidades e centros de outro tenant dão 404', async ({
    client,
    assert,
  }) => {
    const a = await setup(client)
    const b = await setup(client)
    const orgB = await newOrg(b.http)
    const unitB = await newUnit(b.http, orgB.id)

    ;(await a.http.get(`/api/v1/organizations/${orgB.id}`)).assertStatus(404)
    ;(await a.http.get(`/api/v1/organization-units/${unitB.id}`)).assertStatus(404)
    ;(
      await a.http.patch(`/api/v1/organization-units/${unitB.id}`, {
        expectedVersion: 1,
        name: 'x',
      })
    ).assertStatus(404)
    ;(
      await a.http.post('/api/v1/organization-units', {
        organizationId: orgB.id,
        code: 'X',
        name: 'x',
      })
    ).assertStatus(404)
    ;(await a.http.get('/api/v1/organizations/nao-e-uuid')).assertStatus(404)
    assert.lengthOf((await a.http.get('/api/v1/organizations')).body().data, 0)

    // Sem contexto, a RLS esconde tudo na base.
    assert.lengthOf(await db.connection('runtime').from('organization_units'), 0)
  })
})

test.group('organização | âmbitos de acesso (MembershipScope)', (group) => {
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

  const scopeOf = async (client: any, tenant: Tenant, actor: Actor) =>
    (await api(client, tenant, actor).get('/api/v1/context')).body().data.unitScope as {
      kind: string
      unitIds: string[]
    }

  async function tree(http: ReturnType<typeof api>) {
    const org = await newOrg(http)
    const root = await newUnit(http, org.id)
    const mid = await newUnit(http, org.id, root.id)
    const leaf = await newUnit(http, org.id, mid.id)
    const sibling = await newUnit(http, org.id)
    return { org, root, mid, leaf, sibling }
  }

  test('sem âmbitos não há unidades; organização inteira dá todas', async ({ client, assert }) => {
    const { tenant, operator, http } = await setup(client)
    const t = await tree(http)
    assert.deepEqual((await scopeOf(client, tenant, operator)).unitIds, [])

    const before = await authzVersion(client, tenant, operator)
    const added = await http.post('/api/v1/membership-scopes', {
      membershipId: operator.membershipId,
      organizationId: t.org.id,
    })
    added.assertStatus(201)
    assert.sameMembers((await scopeOf(client, tenant, operator)).unitIds, [
      t.root.id,
      t.mid.id,
      t.leaf.id,
      t.sibling.id,
    ])
    assert.strictEqual(await authzVersion(client, tenant, operator), before + 1)

    ;(await http.delete(`/api/v1/membership-scopes/${added.body().data.id}`)).assertStatus(204)
    ;(await http.delete(`/api/v1/membership-scopes/${added.body().data.id}`)).assertStatus(404)
    assert.deepEqual((await scopeOf(client, tenant, operator)).unitIds, [])
    assert.strictEqual(await authzVersion(client, tenant, operator), before + 2)
  })

  test('uma unidade com ou sem descendentes; vários âmbitos somam-se', async ({
    client,
    assert,
  }) => {
    const { tenant, operator, http } = await setup(client)
    const t = await tree(http)
    const scope = (organizationUnitId: string, includeDescendants: boolean) =>
      http.post('/api/v1/membership-scopes', {
        membershipId: operator.membershipId,
        organizationId: t.org.id,
        organizationUnitId,
        includeDescendants,
      })

    ;(await scope(t.mid.id, false)).assertStatus(201)
    assert.deepEqual((await scopeOf(client, tenant, operator)).unitIds, [t.mid.id])

    ;(await scope(t.root.id, true)).assertStatus(201)
    assert.sameMembers((await scopeOf(client, tenant, operator)).unitIds, [
      t.root.id,
      t.mid.id,
      t.leaf.id,
    ])

    ;(await scope(t.sibling.id, false)).assertStatus(201)
    assert.sameMembers((await scopeOf(client, tenant, operator)).unitIds, [
      t.root.id,
      t.mid.id,
      t.leaf.id,
      t.sibling.id,
    ])
    ;(await scope(t.sibling.id, false)).assertStatus(409)
  })

  test('validações: unidade de outra organização, membership ou organização alheias', async ({
    client,
    assert,
  }) => {
    const { tenant, operator, http } = await setup(client)
    const other = await setup(client)
    const t = await tree(http)
    const otherOrg = await newOrg(http)
    const otherTenantOrg = await newOrg(other.http)

    const mismatch = await http.post('/api/v1/membership-scopes', {
      membershipId: operator.membershipId,
      organizationId: otherOrg.id,
      organizationUnitId: t.root.id,
    })
    mismatch.assertStatus(422)
    assert.strictEqual(mismatch.body().error.details[0].code, 'NOT_IN_ORGANIZATION')
    ;(
      await http.post('/api/v1/membership-scopes', {
        membershipId: other.operator.membershipId,
        organizationId: t.org.id,
      })
    ).assertStatus(404)
    ;(
      await http.post('/api/v1/membership-scopes', {
        membershipId: operator.membershipId,
        organizationId: otherTenantOrg.id,
      })
    ).assertStatus(404)
    ;(await api(client, tenant, operator).post('/api/v1/membership-scopes', {})).assertStatus(403)

    const listed = await http.get(`/api/v1/membership-scopes?membershipId=${operator.membershipId}`)
    assert.lengthOf(listed.body().data, 0)
  })

  test('o âmbito limita a decisão: recurso de outra unidade é recusado, mesmo com o papel', async ({
    client,
    assert,
  }) => {
    const { operator, http } = await setup(client)
    const t = await tree(http)
    const role = (
      await http.post('/api/v1/roles', {
        code: 'leitor_org',
        name: 'Leitor',
        permissionCodes: ['organization.read'],
      })
    ).body().data
    await http.post('/api/v1/role-assignments', {
      membershipId: operator.membershipId,
      roleId: role.id,
    })
    await http.post('/api/v1/membership-scopes', {
      membershipId: operator.membershipId,
      organizationId: t.org.id,
      organizationUnitId: t.mid.id,
      includeDescendants: true,
    })

    const simulate = async (unitId?: string) =>
      (
        await http.post('/api/v1/authorization/simulate', {
          membershipId: operator.membershipId,
          permission: 'organization.read',
          resource: unitId ? { unitId } : {},
        })
      ).body().data
    assert.isTrue((await simulate(t.mid.id)).allowed)
    assert.isTrue((await simulate(t.leaf.id)).allowed)
    const outside = await simulate(t.sibling.id)
    assert.isFalse(outside.allowed)
    assert.strictEqual(outside.reason, 'UNIT_OUT_OF_SCOPE')
    assert.isTrue((await simulate()).allowed, 'sem unidade no recurso não há âmbito a verificar')
  })

  test('atribuição de papel por unidade: a unidade tem de existir no tenant', async ({
    client,
  }) => {
    const { operator, http } = await setup(client)
    const other = await setup(client)
    const t = await tree(http)
    const otherUnit = await newUnit(other.http, (await newOrg(other.http)).id)
    const role = (
      await http.post('/api/v1/roles', {
        code: 'leitor_org',
        name: 'Leitor',
        permissionCodes: ['organization.read'],
      })
    ).body().data
    const assign = (organizationUnitId: string) =>
      http.post('/api/v1/role-assignments', {
        membershipId: operator.membershipId,
        roleId: role.id,
        organizationUnitId,
      })

    ;(await assign(otherUnit.id)).assertStatus(404)
    ;(await assign(t.mid.id)).assertStatus(201)
  })
})
