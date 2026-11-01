import { test } from '@japa/runner'
import { iamServices } from '#core/permissions/index'
import { deleteTestUsers, resetAuthState } from '#tests/support/auth_fixture'
import { createActiveTenant, deleteTestTenants } from '#tests/support/membership_fixture'
import { api, newActor } from '#tests/support/api_fixture'

async function structure(http: ReturnType<typeof api>) {
  const org = (
    await http.post('/api/v1/organizations', {
      code: 'EMP1',
      legalName: 'Empresa, Lda.',
      countryCode: 'AO',
      baseCurrency: 'AOA',
    })
  ).body().data
  const branch = (
    await http.post('/api/v1/organization-units', {
      organizationId: org.id,
      code: 'SEDE',
      name: 'Sede',
      type: 'BRANCH',
    })
  ).body().data
  const department = (
    await http.post('/api/v1/organization-units', {
      organizationId: org.id,
      parentId: branch.id,
      code: 'RH',
      name: 'Recursos Humanos',
      type: 'DEPARTMENT',
    })
  ).body().data
  return { org, branch, department }
}

test.group('organização | cargos e funções', (group) => {
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

  test('cria com descrição funcional e departamento; código único e imutável', async ({
    client,
    assert,
  }) => {
    const tenant = await createActiveTenant()
    const admin = await newActor(client, tenant, true)
    const http = api(client, tenant, admin)
    const { department, branch } = await structure(http)

    const created = await http.post('/api/v1/positions', {
      code: 'TEC-RH',
      name: '  Técnico de RH ',
      departmentId: department.id,
      hierarchyLevel: 4,
      competencies: ['Legislação laboral', 'Legislação laboral', 'Excel'],
      responsibilities: 'Processar admissões.',
    })
    created.assertStatus(201)
    const position = created.body().data
    assert.strictEqual(position.name, 'Técnico de RH')
    assert.deepEqual(position.competencies, ['Legislação laboral', 'Excel'])
    assert.strictEqual(position.status, 'ACTIVE')
    assert.match(String(created.header('location')), /\/api\/v1\/positions\/[0-9a-f-]{36}$/)

    const duplicate = await http.post('/api/v1/positions', { code: 'TEC-RH', name: 'Outro' })
    duplicate.assertStatus(409)
    assert.strictEqual(duplicate.body().error.code, 'POSITION_CODE_TAKEN')
    ;(await http.post('/api/v1/positions', { code: 'com espaço', name: 'x' })).assertStatus(422)
    ;(
      await http.post('/api/v1/positions', { code: 'X1', name: 'x', hierarchyLevel: 30 })
    ).assertStatus(422)
    // Uma filial não é departamento.
    const onBranch = await http.post('/api/v1/positions', {
      code: 'X2',
      name: 'x',
      departmentId: branch.id,
    })
    onBranch.assertStatus(422)
    assert.strictEqual(onBranch.body().error.details[0].code, 'INVALID_DEPARTMENT')

    const immutable = await http.patch(`/api/v1/positions/${position.id}`, {
      expectedVersion: position.version,
      code: 'NOVO',
    })
    immutable.assertStatus(422)
    const renamed = await http.patch(`/api/v1/positions/${position.id}`, {
      expectedVersion: position.version,
      name: 'Técnico Superior de RH',
    })
    renamed.assertStatus(200)
    assert.strictEqual(renamed.body().data.code, 'TEC-RH')
    const stale = await http.patch(`/api/v1/positions/${position.id}`, {
      expectedVersion: position.version,
      name: 'x',
    })
    stale.assertStatus(409)

    const listed = await http.get(`/api/v1/positions?departmentId=${department.id}&q=superior`)
    assert.deepEqual(
      listed.body().data.map((p: any) => p.code),
      ['TEC-RH']
    )
  })

  test('hierarquia de cargos sem ciclos; não se desactiva com subordinados activos', async ({
    client,
    assert,
  }) => {
    const tenant = await createActiveTenant()
    const admin = await newActor(client, tenant, true)
    const http = api(client, tenant, admin)
    const director = (
      await http.post('/api/v1/positions', { code: 'DIR', name: 'Director' })
    ).body().data
    const head = (
      await http.post('/api/v1/positions', { code: 'CHEFE', name: 'Chefe', parentId: director.id })
    ).body().data
    const tech = (
      await http.post('/api/v1/positions', { code: 'TEC', name: 'Técnico', parentId: head.id })
    ).body().data

    const cycle = await http.patch(`/api/v1/positions/${director.id}`, {
      expectedVersion: director.version,
      parentId: tech.id,
    })
    cycle.assertStatus(422)
    assert.strictEqual(cycle.body().error.details[0].code, 'INVALID_PARENT')
    ;(
      await http.patch(`/api/v1/positions/${director.id}`, {
        expectedVersion: director.version,
        parentId: director.id,
      })
    ).assertStatus(422)

    const blocked = await http.patch(`/api/v1/positions/${head.id}`, {
      expectedVersion: head.version,
      status: 'INACTIVE',
    })
    blocked.assertStatus(409)
    assert.strictEqual(blocked.body().error.code, 'POSITION_HAS_SUBORDINATES')
    ;(
      await http.patch(`/api/v1/positions/${tech.id}`, {
        expectedVersion: tech.version,
        status: 'INACTIVE',
      })
    ).assertStatus(200)
    ;(
      await http.patch(`/api/v1/positions/${head.id}`, {
        expectedVersion: head.version,
        status: 'INACTIVE',
      })
    ).assertStatus(200)
    const inactive = await http.get('/api/v1/positions?status=INACTIVE')
    assert.sameMembers(
      inactive.body().data.map((p: any) => p.code),
      ['CHEFE', 'TEC']
    )
  })

  test('ler exige organization.read e gerir organization.manage; outro tenant dá 404', async ({
    client,
    assert,
  }) => {
    const tenant = await createActiveTenant()
    const other = await createActiveTenant()
    const admin = await newActor(client, tenant, true)
    const operator = await newActor(client, tenant)
    const outsider = await newActor(client, other, true)
    const http = api(client, tenant, admin)
    const position = (await http.post('/api/v1/positions', { code: 'P1', name: 'Cargo' })).body()
      .data

    ;(await api(client, tenant, operator).get('/api/v1/positions')).assertStatus(403)
    ;(
      await api(client, tenant, operator).post('/api/v1/positions', { code: 'P2', name: 'x' })
    ).assertStatus(403)
    const foreign = await api(client, other, outsider).get(`/api/v1/positions/${position.id}`)
    foreign.assertStatus(404)
    assert.lengthOf((await api(client, other, outsider).get('/api/v1/positions')).body().data, 0)
  })
})
