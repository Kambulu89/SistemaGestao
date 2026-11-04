import { test } from '@japa/runner'
import {
  as,
  cleanDatabase,
  createRole,
  memberWithRoles,
  signIn,
  tenantWithAdmin,
} from '#tests/support/fixtures'

test.group('rbac | perfis, permissões e autoescalada', (group) => {
  group.each.setup(() => cleanDatabase())

  test('o administrador do tenant tem todas as permissões; o perfil de sistema não se altera', async ({
    client,
    assert,
  }) => {
    const { tenant, admin } = await tenantWithAdmin('ACME')
    const s = await signIn(client, admin.email, tenant.id)
    const mine = await as(client, s).get('/api/v1/me/permissions')
    mine.assertStatus(200)
    assert.includeMembers(mine.body().data.tenant, ['members.manage', 'roles.manage'])
    const roles = (await as(client, s).get('/api/v1/roles')).body().data
    const system = roles.find((r: any) => r.code === 'tenant_admin')
    assert.isTrue(system.isSystem)
    const edit = await as(client, s).patch(`/api/v1/roles/${system.id}`, {
      expectedVersion: system.version,
      name: 'X',
    })
    edit.assertStatus(409)
    edit.assertBodyContains({ error: { code: 'SYSTEM_ROLE' } })
  })

  test('cria, valida, altera com versão e só elimina perfis sem atribuições', async ({
    client,
    assert,
  }) => {
    const { tenant, admin } = await tenantWithAdmin()
    const s = await signIn(client, admin.email, tenant.id)
    const bad = await as(client, s).post('/api/v1/roles', {
      code: 'X Y',
      name: 'x',
      permissionCodes: ['nao.existe'],
    })
    bad.assertStatus(422)
    assert.sameMembers(
      bad.body().error.details.map((d: any) => d.code),
      ['INVALID_CODE', 'INVALID_NAME', 'UNKNOWN_PERMISSION']
    )
    const role = await createRole(client, s, 'leitor', ['members.read'])
    const dup = await as(client, s).post('/api/v1/roles', {
      code: 'leitor',
      name: 'Outro',
      permissionCodes: [],
    })
    dup.assertStatus(409)
    const updated = await as(client, s).patch(`/api/v1/roles/${role.id}`, {
      expectedVersion: role.version,
      permissionCodes: ['members.read', 'roles.read'],
    })
    updated.assertStatus(200)
    assert.deepEqual(updated.body().data.permissionCodes, ['members.read', 'roles.read'])
    const stale = await as(client, s).patch(`/api/v1/roles/${role.id}`, {
      expectedVersion: role.version,
      name: 'Outro nome',
    })
    stale.assertStatus(409)
    stale.assertBodyContains({ error: { code: 'VERSION_CONFLICT' } })

    await memberWithRoles(client, s, [role.id])
    const inUse = await as(client, s).delete(`/api/v1/roles/${role.id}`)
    inUse.assertStatus(409)
    inUse.assertBodyContains({ error: { code: 'ROLE_IN_USE' } })
    const unused = await createRole(client, s, 'temporario', [])
    ;(await as(client, s).delete(`/api/v1/roles/${unused.id}`)).assertStatus(200)
  })

  test('sem permissão dá 403; ninguém concede o que não tem nem se altera a si próprio', async ({
    client,
    assert,
  }) => {
    const { tenant, admin } = await tenantWithAdmin()
    const s = await signIn(client, admin.email, tenant.id)
    const reader = await createRole(client, s, 'leitor', ['members.read'])
    const roleAdmin = await createRole(client, s, 'gestor_perfis', ['roles.manage', 'roles.read'])
    const memberManager = await createRole(client, s, 'gestor_membros', [
      'members.manage',
      'members.read',
    ])

    const r = await memberWithRoles(client, s, [reader.id])
    ;(await as(client, r.session).get('/api/v1/roles')).assertStatus(403)
    ;(
      await as(client, r.session).post('/api/v1/members/invitations', { email: 'x@teste.invalid' })
    ).assertStatus(403)

    // Gestor de perfis não pode criar um perfil com members.manage (não a tem).
    const p = await memberWithRoles(client, s, [roleAdmin.id])
    const escalate = await as(client, p.session).post('/api/v1/roles', {
      code: 'tudo',
      name: 'Tudo',
      permissionCodes: ['members.manage'],
    })
    escalate.assertStatus(403)
    escalate.assertBodyContains({ error: { code: 'PRIVILEGE_ESCALATION' } })

    // Gestor de membros não atribui o perfil de administrador (tem permissões que ele não tem) nem se altera a si.
    const m = await memberWithRoles(client, s, [memberManager.id])
    const adminRole = (await as(client, s).get('/api/v1/roles'))
      .body()
      .data.find((x: any) => x.code === 'tenant_admin')
    const toAdmin = await as(client, m.session).post(`/api/v1/members/${r.memberId}/roles`, {
      roleId: adminRole.id,
    })
    toAdmin.assertStatus(403)
    toAdmin.assertBodyContains({ error: { code: 'PRIVILEGE_ESCALATION' } })
    const self = await as(client, m.session).post(`/api/v1/members/${m.memberId}/roles`, {
      roleId: reader.id,
    })
    self.assertStatus(403)
    self.assertBodyContains({ error: { code: 'SELF_ASSIGNMENT' } })
    const ok = await as(client, m.session).post(`/api/v1/members/${r.memberId}/roles`, {
      roleId: memberManager.id,
      scopeType: 'OWN',
    })
    ok.assertStatus(200)
    assert.includeDeepMembers(
      ok.body().data.roles.map((x: any) => ({ roleCode: x.roleCode, scopeType: x.scopeType })),
      [{ roleCode: 'gestor_membros', scopeType: 'OWN' }]
    )
    // Âmbito OWN não abre as rotas de empresa.
    ;(
      await as(client, r.session).post(`/api/v1/members/${m.memberId}/suspend`, {
        expectedVersion: 1,
      })
    ).assertStatus(403)
  })

  test('o último administrador activo não é suspenso nem perde o perfil', async ({ client }) => {
    const { tenant, admin } = await tenantWithAdmin()
    const s = await signIn(client, admin.email, tenant.id)
    const all = await createRole(client, s, 'quase_admin', [
      'members.manage',
      'members.read',
      'roles.read',
    ])
    const b = await memberWithRoles(client, s, [all.id])
    const members = (await as(client, b.session).get('/api/v1/members')).body().data
    const first = members.find((x: any) => x.email === admin.email)
    const adminAssignment = first.roles.find((x: any) => x.roleCode === 'tenant_admin')

    const unassign = await as(client, b.session).delete(
      `/api/v1/members/${first.id}/roles/${adminAssignment.id}`
    )
    unassign.assertStatus(409)
    unassign.assertBodyContains({ error: { code: 'LAST_ADMIN' } })
    const suspend = await as(client, b.session).post(`/api/v1/members/${first.id}/suspend`, {
      expectedVersion: first.version,
    })
    suspend.assertStatus(409)
    suspend.assertBodyContains({ error: { code: 'LAST_ADMIN' } })
    const selfSuspend = await as(client, s).post(`/api/v1/members/${first.id}/suspend`, {
      expectedVersion: first.version,
    })
    selfSuspend.assertStatus(403)
  })

  test('suspender um membro corta-lhe o acesso; reactivar devolve-o', async ({ client }) => {
    const { tenant, admin } = await tenantWithAdmin()
    const s = await signIn(client, admin.email, tenant.id)
    const reader = await createRole(client, s, 'leitor', ['members.read'])
    const r = await memberWithRoles(client, s, [reader.id])
    ;(await as(client, r.session).get('/api/v1/members')).assertStatus(200)
    const member = (await as(client, s).get(`/api/v1/members/${r.memberId}`)).body().data
    const suspended = await as(client, s).post(`/api/v1/members/${r.memberId}/suspend`, {
      expectedVersion: member.version,
    })
    suspended.assertStatus(200)
    const denied = await as(client, r.session).get('/api/v1/members')
    denied.assertStatus(403)
    denied.assertBodyContains({ error: { code: 'TENANT_ACCESS_DENIED' } })
    await as(client, s).post(`/api/v1/members/${r.memberId}/reactivate`, {
      expectedVersion: member.version + 1,
    })
    ;(await as(client, r.session).get('/api/v1/members')).assertStatus(200)
  })

  test('isolamento: ids de perfis e membros de outra empresa dão 404', async ({ client }) => {
    const a = await tenantWithAdmin('EMPA')
    const b = await tenantWithAdmin('EMPB')
    const sa = await signIn(client, a.admin.email, a.tenant.id)
    const sb = await signIn(client, b.admin.email, b.tenant.id)
    const roleB = await createRole(client, sb, 'so_b', [])
    const memberB = (await as(client, sb).get('/api/v1/members')).body().data[0]
    ;(await as(client, sa).get(`/api/v1/roles/${roleB.id}`)).assertStatus(404)
    ;(await as(client, sa).get(`/api/v1/members/${memberB.id}`)).assertStatus(404)
    ;(
      await as(client, sa).patch(`/api/v1/roles/${roleB.id}`, { expectedVersion: 1, name: 'x' })
    ).assertStatus(404)
    const crossAssign = await as(client, sa).post(`/api/v1/members/${memberB.id}/roles`, {
      roleId: roleB.id,
    })
    crossAssign.assertStatus(404)
  })
})
