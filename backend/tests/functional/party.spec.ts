import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { iamServices } from '#core/permissions/index'
import { LucidTenantDatabase, serviceTenantContext } from '#core/tenancy/index'
import { capture } from '#tests/support/capture'
import { deleteTestUsers, resetAuthState } from '#tests/support/auth_fixture'
import { createActiveTenant, deleteTestTenants } from '#tests/support/membership_fixture'
import { api, newActor } from '#tests/support/api_fixture'
import type { Tenant } from '#platform/tenants/index'

type Http = ReturnType<typeof api>
let counter = 0
const uid = () => `${process.pid}${counter++}`
const email = (tag = 'p') => `${tag}${uid()}@exemplo.invalid`

const personBody = (extra: Record<string, unknown> = {}) => ({
  givenNames: 'Ana',
  familyName: `Silva${uid()}`,
  ...extra,
})
const orgBody = (extra: Record<string, unknown> = {}) => ({
  legalName: `Fornecedor ${uid()}, Lda.`,
  ...extra,
})

async function setup(client: any) {
  const tenant = await createActiveTenant()
  const admin = await newActor(client, tenant, true)
  const operator = await newActor(client, tenant)
  return { tenant, admin, operator, http: api(client, tenant, admin) }
}

async function newPerson(http: Http, extra: Record<string, unknown> = {}) {
  const response = await http.post('/api/v1/people', personBody(extra))
  response.assertStatus(201)
  return response.body().data
}

async function newOrg(http: Http, extra: Record<string, unknown> = {}) {
  const response = await http.post('/api/v1/organization-parties', orgBody(extra))
  response.assertStatus(201)
  return response.body().data
}

async function countRows(tenant: Tenant, sql: string, params: unknown[] = []) {
  return db.connection('owner').transaction(async (trx) => {
    await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [tenant.id])
    const result = await trx.rawQuery(sql, params as never)
    return (result.rows as { n: number }[])[0].n
  })
}

test.group('party | cadastro', (group) => {
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

  test('exige party.read / party.create / party.update', async ({ client, assert }) => {
    const { tenant, operator, http } = await setup(client)
    const party = await newPerson(http)
    const asOperator = api(client, tenant, operator)
    ;(await asOperator.get('/api/v1/parties')).assertStatus(403)
    ;(await asOperator.get(`/api/v1/parties/${party.id}`)).assertStatus(403)
    ;(await asOperator.post('/api/v1/people', personBody())).assertStatus(403)
    ;(await asOperator.patch(`/api/v1/parties/${party.id}`, { expectedVersion: 1 })).assertStatus(
      403
    )

    const role = (
      await http.post('/api/v1/roles', {
        code: 'leitor_party',
        name: 'Leitor',
        permissionCodes: ['party.read'],
      })
    ).body().data
    await http.post('/api/v1/role-assignments', {
      membershipId: operator.membershipId,
      roleId: role.id,
    })
    ;(await asOperator.get('/api/v1/parties')).assertStatus(200)
    ;(await asOperator.post('/api/v1/people', personBody())).assertStatus(403)
    assert.lengthOf((await asOperator.get('/api/v1/parties')).body().data, 1)
  })

  test('cria uma pessoa com subtipo, contactos e moradas na mesma operação', async ({
    client,
    assert,
  }) => {
    const { tenant, http } = await setup(client)
    const created = await http.post('/api/v1/people', {
      givenNames: 'Ana',
      familyName: 'Silva',
      birthDate: '1990-05-17',
      nationality: 'AO',
      identityType: 'BI',
      identityNumber: '004567AB',
      contacts: [
        { type: 'EMAIL', value: email(), label: 'trabalho' },
        { type: 'PHONE', value: '+244 923 456 789' },
      ],
      addresses: [{ type: 'BILLING', line1: 'Rua 1', city: 'Luanda', countryCode: 'AO' }],
    })
    created.assertStatus(201)
    const party = created.body().data
    assert.match(String(created.header('location')), new RegExp(`/api/v1/parties/${party.id}$`))
    assert.strictEqual(party.kind, 'PERSON')
    assert.strictEqual(party.displayName, 'Ana Silva')
    assert.strictEqual(party.person.birthDate, '1990-05-17')
    assert.isNull(party.organization)
    assert.lengthOf(party.contacts, 2)
    assert.isTrue(
      party.contacts.every((c: any) => c.isPrimary),
      'o primeiro de cada tipo é o principal'
    )
    assert.lengthOf(party.addresses, 1)
    assert.deepEqual(party.possibleDuplicates, [])
    assert.strictEqual(await countRows(tenant, 'select count(*)::int as n from people'), 1)
  })

  test('validações na criação (caminhos completos)', async ({ client, assert }) => {
    const { http } = await setup(client)
    const bad = await http.post('/api/v1/people', {
      givenNames: 'Ana',
      familyName: 'Silva',
      birthDate: '2999-01-01',
      nationality: 'ao',
      identityType: 'BI',
      contacts: [{ type: 'EMAIL', value: 'sem-arroba' }],
      addresses: [{ type: 'BILLING', line1: 'Rua', city: 'Luanda', countryCode: 'ao' }],
    })
    bad.assertStatus(422)
    const paths = bad.body().error.details.map((d: any) => d.path)
    assert.includeMembers(paths, [
      'birthDate',
      'nationality',
      'identityNumber',
      'contacts[0].value',
    ])
    ;(await http.post('/api/v1/people', { givenNames: '', familyName: 'x' })).assertStatus(422)
    ;(
      await http.post('/api/v1/organization-parties', { legalName: 'E', taxId: '123' })
    ).assertStatus(422)
  })

  test('fornecedor empresarial não exige Person; o subtipo é coerente com o kind (também na base)', async ({
    client,
    assert,
  }) => {
    const { tenant, http } = await setup(client)
    const org = await newOrg(http, { taxCountry: 'AO', taxId: '5417123456' })
    assert.strictEqual(org.kind, 'ORGANIZATION')
    assert.isNull(org.person)
    assert.strictEqual(org.displayName, org.organization.legalName)
    assert.strictEqual(await countRows(tenant, 'select count(*)::int as n from people'), 0)

    const person = await newPerson(http)
    const context = serviceTenantContext(tenant.id, 'teste')
    const raw = (sql: string, params: unknown[]) =>
      capture(() =>
        new LucidTenantDatabase().run((scope) => (scope as any).trx.rawQuery(sql, params), context)
      )

    const personOnOrg = await raw(
      `insert into people (tenant_id, party_id, given_names, family_name) values (?, ?, 'x', 'y')`,
      [tenant.id, org.id]
    )
    assert.match(personOnOrg.message, /people_party_kind_fk/)
    const orgOnPerson = await raw(
      `insert into organization_parties (tenant_id, party_id, legal_name) values (?, ?, 'x')`,
      [tenant.id, person.id]
    )
    assert.match(orgOnPerson.message, /organization_parties_party_kind_fk/)
    const twice = await raw(
      `insert into people (tenant_id, party_id, given_names, family_name) values (?, ?, 'x', 'y')`,
      [tenant.id, person.id]
    )
    assert.match(twice.message, /people_party_unique/)
  })

  test('contactos: um principal por tipo e party; novo valor deixa de estar verificado', async ({
    client,
    assert,
  }) => {
    const { tenant, http } = await setup(client)
    const party = await newPerson(http)
    const first = (
      await http.post(`/api/v1/parties/${party.id}/contacts`, { type: 'EMAIL', value: email() })
    ).body().data
    assert.isTrue(first.isPrimary)
    const second = (
      await http.post(`/api/v1/parties/${party.id}/contacts`, {
        type: 'EMAIL',
        value: email(),
        isPrimary: true,
      })
    ).body().data
    assert.isTrue(second.isPrimary)
    const phone = (
      await http.post(`/api/v1/parties/${party.id}/contacts`, { type: 'PHONE', value: '923456789' })
    ).body().data
    assert.isTrue(phone.isPrimary, 'cada tipo tem o seu principal')

    const detail = (await http.get(`/api/v1/parties/${party.id}`)).body().data
    const emails = detail.contacts.filter((c: any) => c.type === 'EMAIL')
    assert.deepEqual(emails.map((c: any) => c.isPrimary).sort(), [false, true])
    assert.strictEqual(emails.find((c: any) => c.isPrimary).id, second.id)

    // A base também recusa dois principais do mesmo tipo.
    const context = serviceTenantContext(tenant.id, 'teste')
    const error = await capture(() =>
      new LucidTenantDatabase().run(
        (scope) =>
          (scope as any).trx.rawQuery(`update contacts set is_primary = true where id = ?`, [
            first.id,
          ]),
        context
      )
    )
    assert.match(error.message, /contacts_one_primary/)

    await db.connection('owner').transaction(async (trx) => {
      await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [tenant.id])
      await trx.rawQuery('update contacts set verified_at = now() where id = ?', [second.id])
    })
    const changed = await http.patch(`/api/v1/contacts/${second.id}`, {
      expectedVersion: (await http.get(`/api/v1/parties/${party.id}`))
        .body()
        .data.contacts.find((c: any) => c.id === second.id).version,
      value: email('novo'),
    })
    changed.assertStatus(200)
    assert.isNull(changed.body().data.verifiedAt)

    const stale = await http.patch(`/api/v1/contacts/${second.id}`, {
      expectedVersion: 1,
      label: 'x',
    })
    stale.assertStatus(409)
    ;(
      await http.patch(`/api/v1/contacts/${second.id}`, {
        expectedVersion: changed.body().data.version,
        value: 'inválido',
      })
    ).assertStatus(422)
    ;(await http.delete(`/api/v1/contacts/${first.id}`)).assertStatus(204)
    ;(await http.delete(`/api/v1/contacts/${first.id}`)).assertStatus(404)
  })

  test('moradas: um principal por tipo; validação e remoção', async ({ client, assert }) => {
    const { http } = await setup(client)
    const party = await newOrg(http)
    const body = (extra: Record<string, unknown> = {}) => ({
      type: 'DELIVERY',
      line1: 'Rua 1',
      city: 'Luanda',
      countryCode: 'AO',
      ...extra,
    })
    const a = (await http.post(`/api/v1/parties/${party.id}/addresses`, body())).body().data
    const b = (
      await http.post(
        `/api/v1/parties/${party.id}/addresses`,
        body({ line1: 'Rua 2', isPrimary: true })
      )
    ).body().data
    assert.isTrue(a.isPrimary)
    assert.isTrue(b.isPrimary)
    const detail = (await http.get(`/api/v1/parties/${party.id}`)).body().data
    assert.deepEqual(detail.addresses.map((x: any) => x.isPrimary).sort(), [false, true])

    ;(
      await http.post(`/api/v1/parties/${party.id}/addresses`, body({ countryCode: 'ao' }))
    ).assertStatus(422)
    const updated = await http.patch(`/api/v1/addresses/${a.id}`, {
      expectedVersion: a.version,
      city: 'Benguela',
    })
    updated.assertStatus(200)
    assert.strictEqual(updated.body().data.city, 'Benguela')
    ;(
      await http.patch(`/api/v1/addresses/${a.id}`, { expectedVersion: a.version, city: 'X' })
    ).assertStatus(409)
    ;(await http.delete(`/api/v1/addresses/${a.id}`)).assertStatus(204)
    ;(await http.delete(`/api/v1/addresses/${a.id}`)).assertStatus(404)
  })

  test('avisa de possíveis duplicados por identificação ou contacto, sem fundir nem bloquear', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    const shared = email('dup')
    const first = await newPerson(http, {
      identityType: 'BI',
      identityNumber: '004.567-AB',
      contacts: [{ type: 'EMAIL', value: shared }],
    })
    assert.deepEqual(first.possibleDuplicates, [])

    const second = await newPerson(http, {
      identityType: 'bi',
      identityNumber: '004567ab',
      contacts: [{ type: 'EMAIL', value: shared.toUpperCase() }],
    })
    assert.lengthOf(second.possibleDuplicates, 1)
    assert.strictEqual(second.possibleDuplicates[0].partyId, first.id)
    assert.sameMembers(second.possibleDuplicates[0].reasons, ['IDENTITY', 'CONTACT'])

    const fromFirst = (await http.get(`/api/v1/parties/${first.id}/possible-duplicates`)).body()
      .data
    assert.strictEqual(fromFirst[0].partyId, second.id)
    assert.lengthOf(
      (await http.get('/api/v1/parties')).body().data,
      2,
      'continuam a ser dois registos'
    )

    const orgA = await newOrg(http, { taxCountry: 'AO', taxId: '5417 123-456' })
    const orgB = await newOrg(http, { taxCountry: 'ao'.toUpperCase(), taxId: '5417123456' })
    assert.deepEqual(
      orgB.possibleDuplicates.map((d: any) => [d.partyId, d.reasons]),
      [[orgA.id, ['TAX_ID']]]
    )

    // Mudar o NIF para um valor novo desfaz o aviso.
    const fixed = await http.patch(`/api/v1/parties/${orgB.id}`, {
      expectedVersion: orgB.version,
      organization: { taxId: '9999999999' },
    })
    assert.deepEqual(fixed.body().data.possibleDuplicates, [])
    ;(await http.get(`/api/v1/parties/${orgA.id}/possible-duplicates`)).assertStatus(200)
  })

  test('o mesmo email noutro tenant não é duplicado', async ({ client, assert }) => {
    const a = await setup(client)
    const b = await setup(client)
    const shared = email('x')
    await newPerson(a.http, { contacts: [{ type: 'EMAIL', value: shared }] })
    const other = await newPerson(b.http, { contacts: [{ type: 'EMAIL', value: shared }] })
    assert.deepEqual(other.possibleDuplicates, [])
  })

  test('alteração: expectedVersion, subtipo coerente, estado e chaves actualizadas', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    const person = await newPerson(http, { identityType: 'BI', identityNumber: '111' })
    const org = await newOrg(http)

    const updated = await http.patch(`/api/v1/parties/${person.id}`, {
      expectedVersion: person.version,
      displayName: 'Ana M. Silva',
      status: 'INACTIVE',
      person: { familyName: 'Santos' },
    })
    updated.assertStatus(200)
    assert.strictEqual(updated.body().data.displayName, 'Ana M. Silva')
    assert.strictEqual(updated.body().data.status, 'INACTIVE')
    assert.strictEqual(updated.body().data.person.familyName, 'Santos')
    assert.isAbove(updated.body().data.version, person.version)

    const stale = await http.patch(`/api/v1/parties/${person.id}`, {
      expectedVersion: person.version,
      displayName: 'X',
    })
    stale.assertStatus(409)
    assert.strictEqual(stale.body().error.code, 'VERSION_CONFLICT')

    const mismatch = await http.patch(`/api/v1/parties/${org.id}`, {
      expectedVersion: org.version,
      person: { givenNames: 'x' },
    })
    mismatch.assertStatus(422)
    assert.strictEqual(mismatch.body().error.details[0].code, 'KIND_MISMATCH')
    ;(
      await http.patch(`/api/v1/parties/${person.id}`, {
        expectedVersion: updated.body().data.version,
        person: { identityType: 'BI', identityNumber: null },
      })
    ).assertStatus(422)

    const inactive = (await http.get('/api/v1/parties?status=INACTIVE')).body().data
    assert.deepEqual(
      inactive.map((p: any) => p.id),
      [person.id]
    )
  })

  test('pesquisa por nome e contacto (escapada), filtros e paginação; nunca por campos sensíveis', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    const tag = `Zeta${uid()}`
    const mail = email('busca')
    await newPerson(http, {
      givenNames: tag,
      familyName: 'Um',
      contacts: [{ type: 'EMAIL', value: mail }],
      identityType: 'BI',
      identityNumber: 'SEGREDO123',
    })
    await newPerson(http, { givenNames: tag, familyName: 'Dois' })
    await newOrg(http, { legalName: `${tag} Lda.` })

    const names = (await http.get(`/api/v1/parties?q=${tag}`)).body().data
    assert.lengthOf(names, 3)
    assert.lengthOf((await http.get(`/api/v1/parties?q=${tag}&kind=ORGANIZATION`)).body().data, 1)
    assert.lengthOf((await http.get(`/api/v1/parties?q=${mail.toUpperCase()}`)).body().data, 1)
    assert.lengthOf(
      (await http.get('/api/v1/parties?q=SEGREDO123')).body().data,
      0,
      'não procura em identificação'
    )
    assert.lengthOf((await http.get('/api/v1/parties?q=%25%25')).body().data, 0, '% é literal')
    const page1 = (await http.get(`/api/v1/parties?q=${tag}&limit=2`)).body().data
    const page2 = (await http.get(`/api/v1/parties?q=${tag}&limit=2&offset=2`)).body().data
    assert.lengthOf(page1, 2)
    assert.lengthOf(page2, 1)
    ;(await http.get('/api/v1/parties?limit=1000')).assertStatus(422)
    ;(await http.get('/api/v1/parties?q=a')).assertStatus(422)
  })

  test('relações entre parties do mesmo tenant', async ({ client, assert }) => {
    const { http } = await setup(client)
    const other = await setup(client)
    const person = await newPerson(http)
    const org = await newOrg(http)
    const foreign = await newOrg(other.http)
    const url = `/api/v1/parties/${person.id}/relationships`

    const created = await http.post(url, {
      targetPartyId: org.id,
      relationshipType: 'REPRESENTANTE',
      startsOn: '2026-01-01',
    })
    created.assertStatus(201)
    ;(
      await http.post(url, { targetPartyId: org.id, relationshipType: 'REPRESENTANTE' })
    ).assertStatus(409)
    ;(await http.post(url, { targetPartyId: person.id, relationshipType: 'X' })).assertStatus(422)
    ;(
      await http.post(url, {
        targetPartyId: org.id,
        relationshipType: 'X',
        startsOn: '2026-05-01',
        endsOn: '2026-04-01',
      })
    ).assertStatus(422)
    ;(await http.post(url, { targetPartyId: foreign.id, relationshipType: 'X' })).assertStatus(404)

    assert.lengthOf((await http.get(url)).body().data, 1)
    assert.lengthOf(
      (await http.get(`/api/v1/parties/${org.id}/relationships`)).body().data,
      1,
      'visível dos dois lados'
    )
    ;(await http.delete(`/api/v1/party-relationships/${created.body().data.id}`)).assertStatus(204)
    ;(await http.delete(`/api/v1/party-relationships/${created.body().data.id}`)).assertStatus(404)
  })

  test('regras de campo (C06) escondem e protegem campos sensíveis da pessoa', async ({
    client,
    assert,
  }) => {
    const { tenant, operator, http } = await setup(client)
    const person = await newPerson(http, {
      birthDate: '1990-05-17',
      identityType: 'BI',
      identityNumber: '004567AB',
      nationality: 'AO',
    })
    const role = (
      await http.post('/api/v1/roles', {
        code: 'party_total',
        name: 'Party',
        permissionCodes: ['party.read', 'party.update'],
      })
    ).body().data
    await http.post('/api/v1/role-assignments', {
      membershipId: operator.membershipId,
      roleId: role.id,
    })
    const asOperator = api(client, tenant, operator)

    const before = (await asOperator.get(`/api/v1/parties/${person.id}`)).body().data
    assert.strictEqual(before.person.birthDate, '1990-05-17')

    for (const [action, mode, field] of [
      ['read', 'HIDDEN', 'birthDate'],
      ['read', 'HIDDEN', 'identityNumber'],
      ['update', 'READ_ONLY', 'nationality'],
    ] as const) {
      ;(
        await http.post('/api/v1/access-policies', {
          name: `${action} ${field}`,
          resource: 'party',
          action,
          effect: 'ALLOW',
          status: 'ACTIVE',
          fieldRules: [{ field, mode }],
        })
      ).assertStatus(201)
    }

    const hidden = (await asOperator.get(`/api/v1/parties/${person.id}`)).body().data
    assert.notProperty(hidden.person, 'birthDate')
    assert.notProperty(hidden.person, 'identityNumber')
    assert.strictEqual(hidden.person.identityType, 'BI')
    assert.notInclude(JSON.stringify(hidden), '004567AB')

    // Também na resposta de uma alteração.
    const renamed = await asOperator.patch(`/api/v1/parties/${person.id}`, {
      expectedVersion: hidden.version,
      displayName: 'Ana S.',
    })
    renamed.assertStatus(200)
    assert.notProperty(renamed.body().data.person, 'birthDate')

    const forbidden = await asOperator.patch(`/api/v1/parties/${person.id}`, {
      expectedVersion: renamed.body().data.version,
      person: { nationality: 'PT' },
    })
    forbidden.assertStatus(403)
    assert.strictEqual(forbidden.body().error.code, 'FIELD_FORBIDDEN')
    assert.strictEqual(forbidden.body().error.details[0].path, 'nationality')

    // O administrador não é afectado (as políticas ALLOW aplicam-se a todos os que têm o recurso);
    // confirma-se que o campo continua intacto na base.
    const stored = await countRows(
      tenant,
      `select count(*)::int as n from people where nationality = 'AO' and birth_date = '1990-05-17'`
    )
    assert.strictEqual(stored, 1)
  })

  test('liga uma membership a uma pessoa (uma por membership) e desliga', async ({
    client,
    assert,
  }) => {
    const { tenant, admin, operator, http } = await setup(client)
    const person = await newPerson(http)
    const org = await newOrg(http)
    const link = (membershipId: string, partyId: string | null) =>
      http.put(`/api/v1/memberships/${membershipId}/person`, { partyId })

    const linked = await link(operator.membershipId, person.id)
    linked.assertStatus(200)
    assert.strictEqual(linked.body().data.personId, person.person.id)
    const listed = (await http.get('/api/v1/memberships')).body().data
    assert.strictEqual(
      listed.find((m: any) => m.id === operator.membershipId).personId,
      person.person.id
    )

    const taken = await link(admin.membershipId, person.id)
    taken.assertStatus(409)
    assert.strictEqual(taken.body().error.code, 'PERSON_ALREADY_LINKED')
    ;(await link(admin.membershipId, org.id)).assertStatus(422)
    ;(await link(admin.membershipId, '00000000-0000-4000-8000-000000000000')).assertStatus(404)
    ;(
      await api(client, tenant, operator).put(`/api/v1/memberships/${admin.membershipId}/person`, {
        partyId: null,
      })
    ).assertStatus(403)

    ;(await link(operator.membershipId, null)).assertStatus(200)
    ;(await link(admin.membershipId, person.id)).assertStatus(200)
  })

  test('isolamento: parties de outro tenant dão 404 e a RLS esconde-os', async ({
    client,
    assert,
  }) => {
    const a = await setup(client)
    const b = await setup(client)
    const partyB = await newPerson(b.http, { contacts: [{ type: 'EMAIL', value: email() }] })

    ;(await a.http.get(`/api/v1/parties/${partyB.id}`)).assertStatus(404)
    ;(
      await a.http.patch(`/api/v1/parties/${partyB.id}`, { expectedVersion: 1, displayName: 'x' })
    ).assertStatus(404)
    ;(
      await a.http.post(`/api/v1/parties/${partyB.id}/contacts`, { type: 'EMAIL', value: email() })
    ).assertStatus(404)
    ;(
      await a.http.post(`/api/v1/parties/${partyB.id}/addresses`, {
        type: 'OTHER',
        line1: 'x',
        city: 'y',
        countryCode: 'AO',
      })
    ).assertStatus(404)
    ;(await a.http.get(`/api/v1/parties/${partyB.id}/possible-duplicates`)).assertStatus(404)
    ;(await a.http.get(`/api/v1/parties/${partyB.id}/relationships`)).assertStatus(404)
    ;(await a.http.delete(`/api/v1/contacts/${partyB.contacts[0].id}`)).assertStatus(404)
    ;(
      await a.http.patch(`/api/v1/contacts/${partyB.contacts[0].id}`, {
        expectedVersion: 1,
        label: 'x',
      })
    ).assertStatus(404)
    ;(await a.http.get('/api/v1/parties/nao-e-uuid')).assertStatus(404)
    assert.lengthOf((await a.http.get('/api/v1/parties')).body().data, 0)

    for (const table of [
      'parties',
      'people',
      'contacts',
      'addresses',
      'organization_parties',
      'party_relationships',
    ]) {
      assert.lengthOf(await db.connection('runtime').from(table), 0, table)
    }
  })
})
