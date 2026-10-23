import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { iamServices } from '#core/permissions/index'
import { capture } from '#tests/support/capture'
import { deleteTestUsers, resetAuthState } from '#tests/support/auth_fixture'
import { createActiveTenant, deleteTestTenants } from '#tests/support/membership_fixture'
import { api, newActor } from '#tests/support/api_fixture'
import type { Tenant } from '#platform/tenants/index'

type Http = ReturnType<typeof api>

/** «Viatura» é só um tenant a definir uma entidade pela API: o núcleo não conhece nenhum sector. */
const vehicleFields = () => [
  {
    code: 'matricula',
    label: 'Matrícula',
    type: 'TEXT',
    required: true,
    validation: { pattern: '^[A-Z]{2}-\\d{2}-[A-Z]{2}$', maxLength: 12, unique: true },
  },
  { code: 'marca', label: 'Marca', type: 'TEXT' },
  { code: 'ano', label: 'Ano', type: 'NUMBER', validation: { min: 1900, max: 2100 } },
  {
    code: 'tipo',
    label: 'Tipo',
    type: 'SELECT',
    defaultValue: 'car',
    options: [
      { code: 'car', label: 'Ligeiro' },
      { code: 'truck', label: 'Pesado' },
    ],
  },
  {
    code: 'preco',
    label: 'Preço',
    type: 'DECIMAL',
    validation: { precision: 12, scale: 2, min: '0.00' },
  },
  { code: 'compra', label: 'Data de compra', type: 'DATE' },
  { code: 'notas', label: 'Notas internas', type: 'TEXTAREA', sensitive: true },
  { code: 'condutor', label: 'Condutor', type: 'USER_REFERENCE' },
]

async function must<T>(response: { status(): number; body(): any }, status: number): Promise<T> {
  if (response.status() !== status) {
    throw new Error(
      `Esperado ${status}, obtido ${response.status()}: ${JSON.stringify(response.body())}`
    )
  }
  return response.body().data as T
}

async function setup(client: any) {
  const tenant = await createActiveTenant()
  const admin = await newActor(client, tenant, true)
  const operator = await newActor(client, tenant)
  return { tenant, admin, operator, http: api(client, tenant, admin) }
}

/** Membro com um papel só com estas permissões. */
async function memberWith(client: any, tenant: Tenant, http: Http, permissions: string[]) {
  const actor = await newActor(client, tenant)
  const role = await must<{ id: string }>(
    await http.post('/api/v1/roles', {
      code: `r_${Math.random().toString(36).slice(2, 10)}`,
      name: 'Papel de teste',
      permissionCodes: permissions,
    }),
    201
  )
  await must(
    await http.post('/api/v1/role-assignments', {
      membershipId: actor.membershipId,
      roleId: role.id,
    }),
    201
  )
  // A decisão de autorização depende do contexto: volta a iniciar sessão não é necessário (lê a base).
  return { actor, http: api(client, tenant, actor) }
}

interface Detail {
  entity: { id: string; version: number; status: string; publishedVersion: number | null }
  draft: { fields: any[] } | null
  published: { id: string; revision: number; fields: any[] } | null
  versions: { revision: number; publishedAt: string | null }[]
}

async function publishedVehicle(http: Http, extra: Record<string, unknown> = {}) {
  let detail = await must<Detail>(
    await http.post('/api/v1/entity-definitions', {
      code: 'vehicle',
      name: 'Viatura',
      fields: vehicleFields(),
      ...extra,
    }),
    201
  )
  detail = await must<Detail>(
    await http.post(`/api/v1/entity-definitions/${detail.entity.id}/publish`, {
      expectedVersion: detail.entity.version,
    }),
    200
  )
  return detail
}

const plate = (n: number) => `AB-${String(n).padStart(2, '0')}-CD`
const records = '/api/v1/dynamic/vehicle/records'

test.group('metadados | entidade dinâmica ponta a ponta (Viatura)', (group) => {
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

  test('definir, publicar, criar, ler, pesquisar, alterar e arquivar', async ({
    client,
    assert,
  }) => {
    const { http, admin } = await setup(client)
    const detail = await publishedVehicle(http)
    assert.equal(detail.entity.status, 'PUBLISHED')
    assert.equal(detail.published?.revision, 1)
    assert.isNull(detail.draft)

    const created = await http.post(records, {
      data: {
        matricula: plate(1),
        marca: 'Toyota',
        ano: 2020,
        preco: '25000.5',
        compra: '2024-05-10',
        notas: 'Avaria recorrente no travão',
        condutor: admin.membershipId,
      },
    })
    created.assertStatus(201)
    const record = created.body().data
    assert.equal(record.entityCode, 'vehicle')
    assert.equal(record.schemaVersion.revision, 1)
    assert.equal(record.data.preco, '25000.50') // decimal normalizado, em texto
    assert.equal(record.data.tipo, 'car') // valor por omissão
    assert.equal(record.data.notas, 'Avaria recorrente no travão') // o admin tem dynamic.sensitive
    assert.match(created.header('location') ?? '', new RegExp(`${records}/${record.id}$`))

    const shown = (await http.get(`${records}/${record.id}`)).body().data
    assert.equal(shown.data.matricula, plate(1))

    await must(await http.post(records, { data: { matricula: plate(2), marca: 'Volvo' } }), 201)
    const found = (await http.get(`${records}?q=toyota`)).body().data
    assert.deepEqual(
      found.map((r: any) => r.id),
      [record.id]
    )
    // A pesquisa não encontra texto sensível.
    assert.lengthOf((await http.get(`${records}?q=travão`)).body().data, 0)
    assert.lengthOf((await http.get(records)).body().data, 2)

    const updated = await must<any>(
      await http.patch(`${records}/${record.id}`, {
        expectedVersion: record.version,
        data: { marca: 'Lexus', ano: null },
      }),
      200
    )
    assert.equal(updated.data.marca, 'Lexus')
    assert.notProperty(updated.data, 'ano')
    assert.equal(updated.version, record.version + 1)

    // Versão desactualizada: 409 com a versão actual.
    const stale = await http.patch(`${records}/${record.id}`, {
      expectedVersion: record.version,
      data: { marca: 'Outra' },
    })
    stale.assertStatus(409)
    assert.equal(stale.body().error.code, 'VERSION_CONFLICT')

    const archived = await must<any>(
      await http.post(`${records}/${record.id}/archive`, { expectedVersion: updated.version }),
      200
    )
    assert.isTrue(archived.archived)
    assert.lengthOf((await http.get(`${records}?archived=true`)).body().data, 1)
    ;(
      await http.patch(`${records}/${record.id}`, {
        expectedVersion: archived.version,
        data: { marca: 'X' },
      })
    ).assertStatus(409)
  })

  test('validação: erro 422 com o caminho completo de cada campo', async ({ client, assert }) => {
    const { http } = await setup(client)
    await publishedVehicle(http)
    const response = await http.post(records, {
      data: {
        matricula: 'xx',
        ano: 1800,
        preco: '1.234',
        tipo: 'boat',
        alien: 1,
        compra: '2024-02-30',
      },
    })
    response.assertStatus(422)
    const paths = response
      .body()
      .error.details.map((d: any) => `${d.path}:${d.code}`)
      .sort()
    assert.deepEqual(
      paths,
      [
        'data.alien:UNKNOWN_FIELD',
        'data.ano:TOO_SMALL',
        'data.compra:INVALID_DATE',
        'data.matricula:PATTERN_MISMATCH',
        'data.preco:TOO_MANY_DECIMALS',
        'data.tipo:INVALID_OPTION',
      ].sort()
    )
    assert.equal(
      (await http.post(records, { data: {} })).body().error.details[0].path,
      'data.matricula'
    )
    // Número não inteiro e decimal em número JSON (float) são recusados.
    const types = await http.post(records, {
      data: { matricula: plate(3), ano: 2020.5, preco: 10.5 },
    })
    assert.deepEqual(
      types
        .body()
        .error.details.map((d: any) => d.code)
        .sort(),
      ['INVALID_TYPE', 'INVALID_TYPE']
    )
  })

  test('uma entidade por publicar ou arquivada não aceita registos; ids mal formados dão 404', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    const draft = await must<Detail>(
      await http.post('/api/v1/entity-definitions', {
        code: 'vehicle',
        name: 'Viatura',
        fields: vehicleFields(),
      }),
      201
    )
    const early = await http.post(records, { data: { matricula: plate(1) } })
    early.assertStatus(409)
    assert.equal(early.body().error.code, 'ENTITY_NOT_PUBLISHED')
    ;(await http.get('/api/v1/dynamic/inexistente/records')).assertStatus(404)
    ;(await http.get('/api/v1/dynamic/Mau-Codigo/records')).assertStatus(404)
    ;(await http.get(`${records}/nao-e-uuid`)).assertStatus(404)
    ;(await http.get('/api/v1/entity-definitions/nao-e-uuid')).assertStatus(404)

    const published = await must<Detail>(
      await http.post(`/api/v1/entity-definitions/${draft.entity.id}/publish`, {
        expectedVersion: draft.entity.version,
      }),
      200
    )
    const record = await must<any>(await http.post(records, { data: { matricula: plate(1) } }), 201)
    const archived = await must<Detail>(
      await http.post(`/api/v1/entity-definitions/${draft.entity.id}/archive`, {
        expectedVersion: published.entity.version,
      }),
      200
    )
    assert.equal(archived.entity.status, 'ARCHIVED')
    const blocked = await http.post(records, { data: { matricula: plate(2) } })
    assert.equal(blocked.body().error.code, 'ENTITY_ARCHIVED')
    // Os registos existentes continuam legíveis.
    ;(await http.get(`${records}/${record.id}`)).assertStatus(200)
  })
})

test.group('metadados | versões, compatibilidade e imutabilidade', (group) => {
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

  test('valores antigos continuam legíveis depois de nova versão; a alteração migra o registo', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    const v1 = await publishedVehicle(http)
    const old = await must<any>(
      await http.post(records, { data: { matricula: plate(1), marca: 'Toyota' } }),
      201
    )

    let detail = await must<Detail>(
      await http.post(`/api/v1/entity-definitions/${v1.entity.id}/drafts`, {}),
      201
    )
    assert.equal(detail.draft?.fields.length, vehicleFields().length)
    // Nova versão: acrescenta um campo (obrigatório, com omissão), retira «marca» e uma opção.
    const fields = vehicleFields()
      .filter((f) => f.code !== 'marca')
      .map((f) => (f.code === 'tipo' ? { ...f, options: [{ code: 'car', label: 'Ligeiro' }] } : f))
    fields.push({
      code: 'cor',
      label: 'Cor',
      type: 'TEXT',
      required: true,
      defaultValue: 'branco',
    } as any)
    detail = await must<Detail>(
      await http.put(`/api/v1/entity-definitions/${v1.entity.id}/draft`, {
        expectedVersion: detail.entity.version,
        fields,
      }),
      200
    )
    const preview = await must<any>(
      await http.get(`/api/v1/entity-definitions/${v1.entity.id}/publish-preview`),
      200
    )
    assert.isTrue(preview.publishable)
    assert.deepEqual(preview.added, ['cor'])
    assert.deepEqual(preview.removed, ['marca'])
    assert.equal(preview.affectedRecords, 1)

    detail = await must<Detail>(
      await http.post(`/api/v1/entity-definitions/${v1.entity.id}/publish`, {
        expectedVersion: detail.entity.version,
      }),
      200
    )
    assert.equal(detail.published?.revision, 2)
    const marca = detail.published?.fields.find((f) => f.code === 'marca')
    assert.isTrue(marca.archived)
    const tipo = detail.published?.fields.find((f) => f.code === 'tipo')
    assert.deepInclude(
      tipo.options.find((o: any) => o.code === 'truck'),
      { archived: true }
    )
    assert.lengthOf(detail.versions, 2)

    // O registo antigo continua legível, na versão em que foi gravado, com o valor do campo retirado.
    const shown = (await http.get(`${records}/${old.id}`)).body().data
    assert.equal(shown.schemaVersion.revision, 1)
    assert.equal(shown.data.marca, 'Toyota')
    // Campo retirado já não aceita escritas; um registo novo usa a revisão 2 (com a omissão do novo campo).
    ;(await http.post(records, { data: { matricula: plate(2), marca: 'x' } })).assertStatus(422)
    const fresh = await must<any>(await http.post(records, { data: { matricula: plate(2) } }), 201)
    assert.equal(fresh.schemaVersion.revision, 2)
    assert.equal(fresh.data.cor, 'branco')
    // Alterar o registo antigo passa-o à revisão 2, sem perder o valor do campo arquivado.
    const moved = await must<any>(
      await http.patch(`${records}/${old.id}`, {
        expectedVersion: old.version,
        data: { ano: 2021 },
      }),
      200
    )
    assert.equal(moved.schemaVersion.revision, 2)
    assert.equal(moved.data.marca, 'Toyota')
    assert.equal(moved.data.cor, 'branco')
  })

  test('publicar uma versão incompatível sem migração é bloqueado, sem alterar nada', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    const v1 = await publishedVehicle(http)
    await must(await http.post(records, { data: { matricula: plate(1), marca: 'Toyota' } }), 201)
    let detail = await must<Detail>(
      await http.post(`/api/v1/entity-definitions/${v1.entity.id}/drafts`, {}),
      201
    )
    const broken = vehicleFields().map((f) => {
      if (f.code === 'ano') return { ...f, type: 'TEXT', validation: {} }
      if (f.code === 'marca') return { ...f, validation: { unique: true } }
      if (f.code === 'preco') return { ...f, validation: { precision: 12, scale: 2, min: '10.00' } }
      if (f.code === 'notas') return { ...f, sensitive: false }
      return f
    })
    broken.push({ code: 'extra', label: 'Extra', type: 'TEXT', required: true } as any)
    detail = await must<Detail>(
      await http.put(`/api/v1/entity-definitions/${v1.entity.id}/draft`, {
        expectedVersion: detail.entity.version,
        fields: broken,
      }),
      200
    )
    const preview = await must<any>(
      await http.get(`/api/v1/entity-definitions/${v1.entity.id}/publish-preview`),
      200
    )
    assert.isFalse(preview.publishable)
    const response = await http.post(`/api/v1/entity-definitions/${v1.entity.id}/publish`, {
      expectedVersion: detail.entity.version,
    })
    response.assertStatus(409)
    assert.equal(response.body().error.code, 'INCOMPATIBLE_SCHEMA')
    assert.sameMembers(
      response.body().error.details.map((d: any) => `${d.path}:${d.code}`),
      [
        'fields.ano:FIELD_TYPE_CHANGED',
        'fields.marca:UNIQUE_ON_EXISTING',
        'fields.preco:CONSTRAINT_TIGHTENED',
        'fields.notas:SENSITIVE_CHANGED',
        'fields.extra:REQUIRED_WITHOUT_DEFAULT',
      ]
    )
    const after = await must<Detail>(
      await http.get(`/api/v1/entity-definitions/${v1.entity.id}`),
      200
    )
    assert.equal(after.entity.publishedVersion, 1)
    assert.isNotNull(after.draft)
    // Descartar o rascunho devolve a entidade ao estado publicado.
    const discarded = await must<Detail>(
      await http.delete(`/api/v1/entity-definitions/${v1.entity.id}/draft`),
      200
    )
    assert.isNull(discarded.draft)
    ;(await http.delete(`/api/v1/entity-definitions/${v1.entity.id}/draft`)).assertStatus(404)
  })

  test('uma versão publicada e os seus campos são imutáveis, mesmo por SQL directo', async ({
    client,
    assert,
  }) => {
    const { tenant, http } = await setup(client)
    const v1 = await publishedVehicle(http)
    const attempt = (sql: string) =>
      capture(() =>
        db.connection('owner').transaction(async (trx) => {
          await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [tenant.id])
          await trx.rawQuery(sql)
        })
      )
    const version = v1.published!.id
    for (const sql of [
      `update field_definitions set label = 'x' where entity_schema_version_id = '${version}'`,
      `delete from field_definitions where entity_schema_version_id = '${version}'`,
      `insert into field_definitions (tenant_id, entity_schema_version_id, code, label, field_type, position)
         values ('${tenant.id}', '${version}', 'extra', 'Extra', 'TEXT', 99)`,
      `update entity_schema_versions set published_at = null where id = '${version}'`,
      `delete from entity_schema_versions where id = '${version}'`,
    ]) {
      assert.match((await attempt(sql)).message, /PUBLISHED_VERSION_IMMUTABLE/, sql)
    }
    // A conta de runtime também não consegue (nem pedir o desvio de retenção).
    const runtime = await capture(() =>
      db.connection('runtime').transaction(async (trx) => {
        await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [tenant.id])
        await trx.rawQuery("select set_config('app.audit_purge', 'on', true)")
        await trx.rawQuery(
          `delete from field_definitions where entity_schema_version_id = '${version}'`
        )
      })
    )
    assert.match(runtime.message, /PUBLISHED_VERSION_IMMUTABLE|permission denied/)
  })

  test('uma só revisão em rascunho e edições concorrentes do rascunho', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    const v1 = await publishedVehicle(http)
    ;(await http.post(`/api/v1/entity-definitions/${v1.entity.id}/drafts`, {})).assertStatus(201)
    const second = await http.post(`/api/v1/entity-definitions/${v1.entity.id}/drafts`, {})
    second.assertStatus(409)
    assert.equal(second.body().error.code, 'DRAFT_EXISTS')
    // Edições concorrentes do rascunho: a segunda, com a versão antiga, é recusada.
    const base = await must<Detail>(
      await http.get(`/api/v1/entity-definitions/${v1.entity.id}`),
      200
    )
    await must(
      await http.put(`/api/v1/entity-definitions/${v1.entity.id}/draft`, {
        expectedVersion: base.entity.version,
        fields: vehicleFields(),
      }),
      200
    )
    const stale = await http.put(`/api/v1/entity-definitions/${v1.entity.id}/draft`, {
      expectedVersion: base.entity.version,
      fields: vehicleFields(),
    })
    stale.assertStatus(409)
    assert.equal(stale.body().error.code, 'VERSION_CONFLICT')
  })

  test('uma entidade nunca publicada remove-se; uma publicada ou referenciada não', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    const draft = await must<Detail>(
      await http.post('/api/v1/entity-definitions', { code: 'rascunho', name: 'Rascunho' }),
      201
    )
    const user = await must<Detail>(
      await http.post('/api/v1/entity-definitions', {
        code: 'depende',
        name: 'Depende',
        fields: [
          {
            code: 'alvo',
            label: 'Alvo',
            type: 'ENTITY_REFERENCE',
            referenceEntityCode: 'rascunho',
          },
        ],
      }),
      201
    )
    const inUse = await http.delete(`/api/v1/entity-definitions/${draft.entity.id}`)
    inUse.assertStatus(409)
    assert.equal(inUse.body().error.code, 'ENTITY_IN_USE')
    ;(await http.delete(`/api/v1/entity-definitions/${user.entity.id}`)).assertStatus(204)
    ;(await http.delete(`/api/v1/entity-definitions/${draft.entity.id}`)).assertStatus(204)
    ;(await http.get(`/api/v1/entity-definitions/${draft.entity.id}`)).assertStatus(404)
    assert.lengthOf((await http.get('/api/v1/entity-definitions')).body().data, 0)

    const published = await publishedVehicle(http)
    const refused = await http.delete(`/api/v1/entity-definitions/${published.entity.id}`)
    refused.assertStatus(409)
    assert.equal(refused.body().error.code, 'ENTITY_PUBLISHED')
  })

  test('tipos por implementar e referências inválidas são recusados na definição', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    const response = await http.post('/api/v1/entity-definitions', {
      code: 'coisa',
      name: 'Coisa',
      fields: [
        { code: 'total', label: 'Total', type: 'CURRENCY' },
        {
          code: 'destino',
          label: 'Destino',
          type: 'ENTITY_REFERENCE',
          referenceEntityCode: 'nao_existe',
        },
        { code: 'foto', label: 'Foto', type: 'IMAGE' },
      ],
    })
    response.assertStatus(422)
    assert.sameMembers(
      response.body().error.details.map((d: any) => `${d.path}:${d.code}`),
      [
        'fields[0].type:FIELD_TYPE_NOT_SUPPORTED',
        'fields[1].referenceEntityCode:NOT_FOUND',
        'fields[2].type:FIELD_TYPE_NOT_SUPPORTED',
      ]
    )
    ;(
      await http.post('/api/v1/entity-definitions', { code: 'Mau Codigo', name: 'x' })
    ).assertStatus(422)
    ;(
      await http.post('/api/v1/entity-definitions', { code: 'coisa', name: 'x', kind: 'EXTENSION' })
    ).assertStatus(422)
    await must(await http.post('/api/v1/entity-definitions', { code: 'coisa', name: 'Coisa' }), 201)
    const dup = await http.post('/api/v1/entity-definitions', { code: 'coisa', name: 'Outra' })
    dup.assertStatus(409)
    assert.equal(dup.body().error.code, 'ENTITY_CODE_TAKEN')
  })
})

test.group('metadados | unicidade, referências e isolamento', (group) => {
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

  test('valores únicos concorrentes: só um passa (a base decide, não uma consulta prévia)', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    await publishedVehicle(http)
    const same = (value: string) => http.post(records, { data: { matricula: value } })
    const results = await Promise.all([
      same(plate(7)),
      same(plate(7)),
      same(plate(7)),
      same(plate(7)),
      same(plate(7)),
      same(plate(7)),
    ])
    const statuses = results.map((r) => r.status()).sort()
    assert.deepEqual(statuses, [201, 409, 409, 409, 409, 409])
    const loser = results.find((r) => r.status() === 409)!
    assert.equal(loser.body().error.code, 'UNIQUE_VALUE_TAKEN')
    assert.equal(loser.body().error.details[0].path, 'data.matricula')
    assert.lengthOf((await http.get(records)).body().data, 1)

    // Alterar para um valor de outro registo também é recusado; arquivar liberta o valor.
    const other = await must<any>(await http.post(records, { data: { matricula: plate(8) } }), 201)
    ;(
      await http.patch(`${records}/${other.id}`, {
        expectedVersion: other.version,
        data: { matricula: plate(7) },
      })
    ).assertStatus(409)
    const first = (await http.get(records))
      .body()
      .data.find((r: any) => r.data.matricula === plate(7))
    await must(
      await http.post(`${records}/${first.id}/archive`, { expectedVersion: first.version }),
      200
    )
    await must(await http.post(records, { data: { matricula: plate(7) } }), 201)
  })

  test('referências: utilizador e registo têm de existir neste tenant (um id de outro tenant falha)', async ({
    client,
    assert,
  }) => {
    const a = await setup(client)
    const b = await setup(client)
    await publishedVehicle(a.http)
    await publishedVehicle(b.http)
    const memberA = await must<any>(
      await a.http.post(records, { data: { matricula: plate(1), condutor: a.admin.membershipId } }),
      201
    )
    assert.equal(memberA.data.condutor, a.admin.membershipId)
    // Membership de outro tenant, e membership sem estado activo, são recusadas.
    for (const foreign of [b.admin.membershipId, '00000000-0000-4000-8000-000000000000']) {
      const response = await a.http.post(records, {
        data: { matricula: plate(2), condutor: foreign },
      })
      response.assertStatus(422)
      assert.equal(response.body().error.details[0].path, 'data.condutor')
      assert.equal(response.body().error.details[0].code, 'REFERENCE_NOT_FOUND')
    }

    // Referência entre entidades: o registo de destino é do mesmo tenant e da entidade certa.
    const owner = await must<Detail>(
      await a.http.post('/api/v1/entity-definitions', {
        code: 'garage',
        name: 'Garagem',
        fields: [{ code: 'nome', label: 'Nome', type: 'TEXT' }],
      }),
      201
    )
    await must(
      await a.http.post(`/api/v1/entity-definitions/${owner.entity.id}/publish`, {
        expectedVersion: owner.entity.version,
      }),
      200
    )
    const garageA = await must<any>(
      await a.http.post('/api/v1/dynamic/garage/records', { data: { nome: 'Central' } }),
      201
    )
    const detailA = await must<Detail>(
      await a.http.post('/api/v1/entity-definitions', {
        code: 'trip',
        name: 'Viagem',
        fields: [
          {
            code: 'garagem',
            label: 'Garagem',
            type: 'ENTITY_REFERENCE',
            referenceEntityCode: 'garage',
          },
        ],
      }),
      201
    )
    assert.equal(detailA.draft?.fields[0].referenceEntityCode, 'garage')
    await must(
      await a.http.post(`/api/v1/entity-definitions/${detailA.entity.id}/publish`, {
        expectedVersion: detailA.entity.version,
      }),
      200
    )
    await must(
      await a.http.post('/api/v1/dynamic/trip/records', { data: { garagem: garageA.id } }),
      201
    )
    // Registo de outro tenant, ou de outra entidade (um veículo), não serve de destino.
    const wrong = await a.http.post('/api/v1/dynamic/trip/records', {
      data: { garagem: memberA.id },
    })
    wrong.assertStatus(422)
    assert.equal(wrong.body().error.details[0].code, 'REFERENCE_NOT_FOUND')
    await must(
      await b.http.post('/api/v1/entity-definitions', {
        code: 'garage',
        name: 'Garagem',
        fields: [],
      }),
      201
    )
    // Uma referência para uma entidade não publicada impede a publicação.
    await must<Detail>(
      await a.http.post('/api/v1/entity-definitions', { code: 'rascunho', name: 'Rascunho' }),
      201
    )
    const dependent = await must<Detail>(
      await a.http.post('/api/v1/entity-definitions', {
        code: 'depende',
        name: 'Depende',
        fields: [
          {
            code: 'alvo',
            label: 'Alvo',
            type: 'ENTITY_REFERENCE',
            referenceEntityCode: 'rascunho',
          },
        ],
      }),
      201
    )
    const refused = await a.http.post(`/api/v1/entity-definitions/${dependent.entity.id}/publish`, {
      expectedVersion: dependent.entity.version,
    })
    refused.assertStatus(409)
    assert.equal(refused.body().error.details[0].code, 'REFERENCE_NOT_PUBLISHED')
  })

  test('dois tenants com a mesma entidade e os mesmos valores únicos não se vêem nem colidem', async ({
    client,
    assert,
  }) => {
    const a = await setup(client)
    const b = await setup(client)
    await publishedVehicle(a.http)
    await publishedVehicle(b.http)
    const ra = await must<any>(
      await a.http.post(records, { data: { matricula: plate(1), marca: 'Comum' } }),
      201
    )
    const rb = await must<any>(
      await b.http.post(records, { data: { matricula: plate(1), marca: 'Comum' } }),
      201
    )
    assert.notEqual(ra.id, rb.id)
    for (const [me, other] of [
      [a, rb],
      [b, ra],
    ] as const) {
      ;(await me.http.get(`${records}/${other.id}`)).assertStatus(404)
      ;(
        await me.http.patch(`${records}/${other.id}`, { expectedVersion: 1, data: { marca: 'x' } })
      ).assertStatus(404)
      ;(await me.http.post(`${records}/${other.id}/archive`, { expectedVersion: 1 })).assertStatus(
        404
      )
      assert.lengthOf((await me.http.get(`${records}?q=comum`)).body().data, 1)
    }
    const detailA = (await a.http.get('/api/v1/entity-definitions')).body().data[0]
    ;(await b.http.get(`/api/v1/entity-definitions/${detailA.id}`)).assertStatus(404)
    ;(
      await b.http.post(`/api/v1/entity-definitions/${detailA.id}/publish`, { expectedVersion: 1 })
    ).assertStatus(404)
  })
})

test.group('metadados | autorização, campos sensíveis e modos de propriedade', (group) => {
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

  test('sem papel nega por omissão; cada permissão abre só o seu comando', async ({
    client,
    assert,
  }) => {
    const { tenant, http, operator } = await setup(client)
    const detail = await publishedVehicle(http)
    const none = api(client, tenant, operator)
    const calls: [string, () => Promise<{ status(): number }>][] = [
      ['listar entidades', () => none.get('/api/v1/entity-definitions')],
      ['criar entidade', () => none.post('/api/v1/entity-definitions', { code: 'x_y', name: 'X' })],
      [
        'publicar',
        () =>
          none.post(`/api/v1/entity-definitions/${detail.entity.id}/publish`, {
            expectedVersion: 1,
          }),
      ],
      ['listar registos', () => none.get(records)],
      ['criar registo', () => none.post(records, { data: { matricula: plate(1) } })],
    ]
    for (const [label, call] of calls) assert.equal((await call()).status(), 403, label)

    const designer = await memberWith(client, tenant, http, ['entity.read', 'entity.design'])
    ;(await designer.http.get('/api/v1/entity-definitions')).assertStatus(200)
    ;(
      await designer.http.post('/api/v1/entity-definitions/' + detail.entity.id + '/publish', {
        expectedVersion: 1,
      })
    ).assertStatus(403)
    ;(await designer.http.get(records)).assertStatus(403) // desenhar não dá acesso aos dados

    const reader = await memberWith(client, tenant, http, ['dynamic.read'])
    ;(await reader.http.get(records)).assertStatus(200)
    ;(await reader.http.post(records, { data: { matricula: plate(1) } })).assertStatus(403)
    ;(await reader.http.get('/api/v1/entity-definitions')).assertStatus(403)

    const clerk = await memberWith(client, tenant, http, [
      'dynamic.read',
      'dynamic.create',
      'dynamic.update',
    ])
    const created = await must<any>(
      await clerk.http.post(records, { data: { matricula: plate(1) } }),
      201
    )
    ;(
      await clerk.http.post(`${records}/${created.id}/archive`, { expectedVersion: 1 })
    ).assertStatus(403)
  })

  test('campos sensíveis: escondidos sem dynamic.sensitive, fora da pesquisa e da auditoria', async ({
    client,
    assert,
  }) => {
    const { tenant, http } = await setup(client)
    await publishedVehicle(http)
    const clerk = await memberWith(client, tenant, http, [
      'dynamic.read',
      'dynamic.create',
      'dynamic.update',
    ])
    const trusted = await memberWith(client, tenant, http, ['dynamic.read', 'dynamic.sensitive'])

    const record = await must<any>(
      await http.post(records, { data: { matricula: plate(1), notas: 'segredo-do-registo' } }),
      201
    )
    assert.equal(record.data.notas, 'segredo-do-registo')
    const asClerk = (await clerk.http.get(`${records}/${record.id}`)).body().data
    assert.notProperty(asClerk.data, 'notas')
    assert.notProperty((await clerk.http.get(records)).body().data[0].data, 'notas')
    assert.equal(
      (await trusted.http.get(`${records}/${record.id}`)).body().data.data.notas,
      'segredo-do-registo'
    )
    // Escrever um campo sensível também exige a permissão (a resposta nunca o devolve).
    ;(
      await clerk.http.patch(`${records}/${record.id}`, {
        expectedVersion: record.version,
        data: { notas: 'x' },
      })
    ).assertStatus(403)
    ;(await clerk.http.post(records, { data: { matricula: plate(2), notas: 'x' } })).assertStatus(
      403
    )
    assert.lengthOf((await clerk.http.get(`${records}?q=segredo`)).body().data, 0)

    // A auditoria regista o registo mas nunca o valor sensível.
    const audit = await db.connection('owner').transaction(async (trx) => {
      await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [tenant.id])
      return (
        await trx.rawQuery("select * from audit_logs where resource_type = 'dynamic_records'")
      ).rows as any[]
    })
    assert.isAbove(audit.length, 0)
    assert.notInclude(JSON.stringify(audit), 'segredo-do-registo')
    const logged = (await http.get('/api/v1/audit-logs?resourceType=dynamic_records')).body().data
    assert.isAbove(logged.length, 0) // com audit.read (administrador) o histórico do registo existe…
    assert.include(JSON.stringify(logged), plate(1)) // …com os valores não sensíveis…
    assert.notInclude(JSON.stringify(logged), 'segredo-do-registo') // …e nunca os sensíveis.
    // Quem só pode ler registos (sem audit.read) não vê o histórico.
    ;(await clerk.http.get('/api/v1/audit-logs?resourceType=dynamic_records')).assertStatus(403)
  })

  test('políticas ABAC restringem por entidade (resource.entity) e regras de campo escondem valores', async ({
    client,
    assert,
  }) => {
    const { tenant, http } = await setup(client)
    await publishedVehicle(http)
    const garage = await must<Detail>(
      await http.post('/api/v1/entity-definitions', {
        code: 'garage',
        name: 'Garagem',
        fields: [{ code: 'nome', label: 'Nome', type: 'TEXT' }],
      }),
      201
    )
    await must(
      await http.post(`/api/v1/entity-definitions/${garage.entity.id}/publish`, {
        expectedVersion: garage.entity.version,
      }),
      200
    )
    const reader = await memberWith(client, tenant, http, ['dynamic.read'])
    const vehicle = await must<any>(
      await http.post(records, { data: { matricula: plate(1), marca: 'Toyota' } }),
      201
    )
    await must(
      await http.post('/api/v1/dynamic/garage/records', { data: { nome: 'Central' } }),
      201
    )

    // Sem políticas: lê as duas entidades.
    ;(await reader.http.get(records)).assertStatus(200)
    ;(await reader.http.get('/api/v1/dynamic/garage/records')).assertStatus(200)
    await must(
      await http.post('/api/v1/access-policies', {
        name: 'Garagens ocultas',
        resource: 'dynamic',
        action: 'read',
        effect: 'DENY',
        status: 'ACTIVE',
        condition: { op: 'eq', left: { var: 'resource.entity' }, right: { value: 'garage' } },
      }),
      201
    )
    ;(await reader.http.get('/api/v1/dynamic/garage/records')).assertStatus(403)
    ;(await reader.http.get(records)).assertStatus(200)

    await must(
      await http.post('/api/v1/access-policies', {
        name: 'Marca oculta',
        resource: 'dynamic',
        action: 'read',
        effect: 'ALLOW',
        status: 'ACTIVE',
        condition: { op: 'eq', left: { var: 'resource.entity' }, right: { value: 'vehicle' } },
        fieldRules: [{ field: 'marca', mode: 'HIDDEN' }],
      }),
      201
    )
    const hidden = (await reader.http.get(`${records}/${vehicle.id}`)).body().data
    assert.notProperty(hidden.data, 'marca')
    assert.equal(hidden.data.matricula, plate(1))
    // O administrador (sem a regra de campo no seu papel? também sujeito a ALLOW): continua a ver o que a política deixa.
    ;(await http.get(records)).assertStatus(200)
  })

  test('modo OWNER: só o responsável vê os seus registos (dynamic.all alarga); modo UNIT exige unidade do tenant', async ({
    client,
    assert,
  }) => {
    const { tenant, http, admin } = await setup(client)
    await publishedVehicle(http, { ownershipMode: 'OWNER' })
    const alice = await memberWith(client, tenant, http, [
      'dynamic.read',
      'dynamic.create',
      'dynamic.update',
    ])
    const bob = await memberWith(client, tenant, http, [
      'dynamic.read',
      'dynamic.create',
      'dynamic.update',
    ])
    const boss = await memberWith(client, tenant, http, ['dynamic.read', 'dynamic.all'])

    const mine = await must<any>(
      await alice.http.post(records, { data: { matricula: plate(1) } }),
      201
    )
    assert.equal(mine.ownerMembershipId, alice.actor.membershipId)
    const bobs = await must<any>(
      await bob.http.post(records, { data: { matricula: plate(2) } }),
      201
    )
    assert.deepEqual(
      (await alice.http.get(records)).body().data.map((r: any) => r.id),
      [mine.id]
    )
    ;(await alice.http.get(`${records}/${bobs.id}`)).assertStatus(404)
    ;(
      await alice.http.patch(`${records}/${bobs.id}`, { expectedVersion: 1, data: { marca: 'x' } })
    ).assertStatus(404)
    assert.lengthOf((await boss.http.get(records)).body().data, 2)
    ;(await boss.http.get(`${records}/${bobs.id}`)).assertStatus(200)

    // Modo UNIT.
    const org = await must<any>(
      await http.post('/api/v1/organizations', {
        code: 'ORG-1',
        legalName: 'Empresa, Lda.',
        countryCode: 'AO',
        baseCurrency: 'AOA',
      }),
      201
    )
    const unit = await must<any>(
      await http.post('/api/v1/organization-units', {
        organizationId: org.id,
        code: 'LUA',
        name: 'Luanda',
        type: 'BRANCH',
      }),
      201
    )
    const stock = await must<Detail>(
      await http.post('/api/v1/entity-definitions', {
        code: 'stock',
        name: 'Stock',
        ownershipMode: 'UNIT',
        fields: [{ code: 'item', label: 'Item', type: 'TEXT' }],
      }),
      201
    )
    await must(
      await http.post(`/api/v1/entity-definitions/${stock.entity.id}/publish`, {
        expectedVersion: stock.entity.version,
      }),
      200
    )
    const url = '/api/v1/dynamic/stock/records'
    // Sem âmbito de acesso à unidade, nem o administrador escreve nela (nega por omissão).
    ;(await http.post(url, { data: { item: 'a' }, organizationUnitId: unit.id })).assertStatus(403)
    await must(
      await http.post('/api/v1/membership-scopes', {
        membershipId: admin.membershipId,
        organizationId: org.id,
        organizationUnitId: unit.id,
        includeDescendants: true,
      }),
      201
    )
    const missing = await http.post(url, { data: { item: 'a' } })
    missing.assertStatus(422)
    assert.equal(missing.body().error.details[0].path, 'organizationUnitId')
    // Uma unidade fora do âmbito do actor é recusada.
    ;(
      await http.post(url, {
        data: { item: 'a' },
        organizationUnitId: '00000000-0000-4000-8000-000000000000',
      })
    ).assertStatus(403)
    const ok = await must<any>(
      await http.post(url, { data: { item: 'a' }, organizationUnitId: unit.id }),
      201
    )
    assert.equal(ok.organizationUnitId, unit.id)
    assert.lengthOf((await http.get(url)).body().data, 1)
    // O modo de propriedade não muda depois de publicada.
    const locked = await http.patch(`/api/v1/entity-definitions/${stock.entity.id}`, {
      expectedVersion: stock.entity.version + 1,
      ownershipMode: 'TENANT',
    })
    locked.assertStatus(409)
    assert.equal(locked.body().error.code, 'OWNERSHIP_LOCKED')
  })
})

test.group('metadados | apresentação, ordenação, filtros e total', (group) => {
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

  const seed = async (http: Http) => {
    const rows = [
      { matricula: plate(1), marca: 'Toyota', ano: 2020, preco: '9.00', tipo: 'car' },
      { matricula: plate(2), marca: 'Volvo', ano: 2015, preco: '10.00', tipo: 'truck' },
      { matricula: plate(3), marca: 'toyota', ano: 2022, preco: '100.50', tipo: 'car' },
      { matricula: plate(4), marca: 'Audi', ano: 2018, preco: '2.25', tipo: 'truck' },
      { matricula: plate(5), marca: 'Opel', ano: 2020, preco: '50.00', tipo: 'car' },
    ]
    for (const data of rows) await must(await http.post(records, { data }), 201)
  }
  const plates = async (http: Http, query: string) => {
    const response = await http.get(`${records}?${query}`)
    response.assertStatus(200)
    return {
      plates: response.body().data.map((r: any) => r.data.matricula) as string[],
      meta: response.body().meta,
    }
  }

  test('a apresentação da entidade e dos campos é guardada e devolvida; valores inválidos são recusados', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    const detail = await must<Detail>(
      await http.post('/api/v1/entity-definitions', {
        code: 'vehicle',
        name: 'Viatura',
        presentation: { pluralName: 'Viaturas', icon: 'truck' },
        fields: [
          {
            code: 'marca',
            label: 'Marca',
            type: 'TEXT',
            presentation: {
              description: 'Fabricante',
              placeholder: 'Ex.: Toyota',
              searchable: true,
              sortable: true,
            },
          },
        ],
      }),
      201
    )
    assert.deepEqual((detail.entity as any).presentation, { pluralName: 'Viaturas', icon: 'truck' })
    assert.deepEqual(detail.draft?.fields[0].presentation, {
      description: 'Fabricante',
      placeholder: 'Ex.: Toyota',
      searchable: true,
      sortable: true,
    })
    const changed = await must<Detail>(
      await http.patch(`/api/v1/entity-definitions/${detail.entity.id}`, {
        expectedVersion: detail.entity.version,
        presentation: { pluralName: 'Veículos', icon: 'car' },
      }),
      200
    )
    assert.equal((changed.entity as any).presentation.pluralName, 'Veículos')

    const badEntity = await http.post('/api/v1/entity-definitions', {
      code: 'coisa',
      name: 'Coisa',
      presentation: { icon: 'Má Icone', alien: 1 },
    })
    badEntity.assertStatus(422)
    assert.sameMembers(
      badEntity.body().error.details.map((d: any) => `${d.path}:${d.code}`),
      ['presentation.icon:INVALID_ICON', 'presentation.alien:UNKNOWN_PRESENTATION']
    )
    const badFields = await http.post('/api/v1/entity-definitions', {
      code: 'coisa',
      name: 'Coisa',
      fields: [
        { code: 'texto', label: 'Texto', type: 'TEXTAREA', presentation: { sortable: true } },
        {
          code: 'segredo',
          label: 'Segredo',
          type: 'TEXT',
          sensitive: true,
          presentation: { filterable: true },
        },
        {
          code: 'nota',
          label: 'Nota',
          type: 'TEXT',
          presentation: { description: 5, colour: 'x' },
        },
      ],
    })
    badFields.assertStatus(422)
    assert.sameMembers(
      badFields.body().error.details.map((d: any) => `${d.path}:${d.code}`),
      [
        'fields[0].presentation.sortable:NOT_SUPPORTED',
        'fields[1].presentation.filterable:SENSITIVE',
        'fields[2].presentation.description:INVALID_TEXT',
        'fields[2].presentation.colour:UNKNOWN_PRESENTATION',
      ]
    )
  })

  test('total, paginação e ordenação (números e decimais pelo valor, texto sem distinção de maiúsculas)', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    await publishedVehicle(http)
    await seed(http)

    const first = await plates(http, 'limit=2&offset=0&sort=matricula:asc')
    assert.deepEqual(first.plates, [plate(1), plate(2)])
    assert.deepEqual(
      { total: first.meta.total, limit: first.meta.limit, offset: first.meta.offset },
      { total: 5, limit: 2, offset: 0 }
    )
    assert.deepEqual((await plates(http, 'limit=2&offset=4&sort=matricula:asc')).plates, [plate(5)])
    // Inteiros pelo valor (2022 > 2020 > 2018 > 2015).
    const byYear = (await plates(http, 'sort=ano:desc')).plates
    assert.equal(byYear[0], plate(3))
    assert.equal(byYear[4], plate(2))
    // Decimais pelo valor: 2.25 < 9.00 < 10.00 < 50.00 < 100.50 (e não por texto).
    assert.deepEqual((await plates(http, 'sort=preco:asc')).plates, [
      plate(4),
      plate(1),
      plate(2),
      plate(5),
      plate(3),
    ])
    // Texto sem distinção de maiúsculas: Audi, Opel, Toyota/toyota, Volvo.
    const byBrand = (await plates(http, 'sort=marca:asc')).plates
    assert.equal(byBrand[0], plate(4))
    assert.equal(byBrand[4], plate(2))
    assert.deepEqual((await plates(http, 'sort=createdAt:desc')).plates[0], plate(5))
  })

  test('filtros por valor exacto (texto sem distinção de maiúsculas, inteiros, decimais, listas), com total', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    await publishedVehicle(http)
    await seed(http)

    const toyota = await plates(http, 'filter.marca=TOYOTA&sort=matricula:asc')
    assert.deepEqual(toyota.plates, [plate(1), plate(3)])
    assert.equal(toyota.meta.total, 2)
    assert.deepEqual((await plates(http, 'filter.ano=2020&sort=matricula:asc')).plates, [
      plate(1),
      plate(5),
    ])
    assert.deepEqual((await plates(http, 'filter.preco=10&sort=matricula:asc')).plates, [plate(2)])
    assert.deepEqual((await plates(http, 'filter.tipo=truck&sort=matricula:asc')).plates, [
      plate(2),
      plate(4),
    ])
    assert.deepEqual(
      (await plates(http, 'filter.tipo=car&filter.ano=2020&sort=matricula:asc')).plates,
      [plate(1), plate(5)]
    )
    const none = await plates(http, 'filter.marca=ferrari')
    assert.deepEqual([none.plates.length, none.meta.total], [0, 0])
    // A pesquisa continua a funcionar em conjunto com filtros.
    assert.deepEqual((await plates(http, 'q=toyota&filter.ano=2022')).plates, [plate(3)])
  })

  test('ordenações e filtros inválidos, sensíveis ou desconhecidos são recusados com o caminho', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    await publishedVehicle(http)
    await seed(http)
    const refused = async (query: string, path: string, code: string) => {
      const response = await http.get(`${records}?${query}`)
      response.assertStatus(422)
      assert.deepInclude(response.body().error.details[0], { path, code }, query)
    }
    await refused('sort=notas:asc', 'sort', 'NOT_SORTABLE') // sensível
    await refused('sort=inexistente:asc', 'sort', 'NOT_SORTABLE')
    await refused('sort=ano', 'sort', 'INVALID_SORT')
    await refused('filter.notas=x', 'filter.notas', 'NOT_FILTERABLE') // sensível
    await refused('filter.alien=x', 'filter.alien', 'NOT_FILTERABLE')
    await refused('filter.ano=abc', 'filter.ano', 'INVALID_FILTER')
    await refused('filter.preco=1.234', 'filter.preco', 'INVALID_FILTER')
    await refused('filter.tipo=boat', 'filter.tipo', 'INVALID_FILTER')
    // Nada de SQL: um código com aspas é só um campo desconhecido.
    await refused("filter.ano'--=1", "filter.ano'--", 'NOT_FILTERABLE')
  })

  test('uma regra de campo que esconde um campo impede ordenar, filtrar e pesquisar por ele', async ({
    client,
    assert,
  }) => {
    const { tenant, http } = await setup(client)
    await publishedVehicle(http)
    await seed(http)
    const reader = await memberWith(client, tenant, http, ['dynamic.read'])
    await must(
      await http.post('/api/v1/access-policies', {
        name: 'Marca oculta',
        resource: 'dynamic',
        action: 'read',
        effect: 'ALLOW',
        status: 'ACTIVE',
        condition: { op: 'eq', left: { var: 'resource.entity' }, right: { value: 'vehicle' } },
        fieldRules: [{ field: 'marca', mode: 'HIDDEN' }],
      }),
      201
    )
    ;(await reader.http.get(`${records}?sort=ano:asc`)).assertStatus(200)
    for (const query of ['sort=marca:asc', 'filter.marca=audi']) {
      const response = await reader.http.get(`${records}?${query}`)
      response.assertStatus(422)
    }
    const search = await reader.http.get(`${records}?q=audi`)
    search.assertStatus(422)
    assert.equal(search.body().error.details[0].code, 'SEARCH_UNAVAILABLE')
  })

  test('um campo com searchable=false deixa de entrar na pesquisa de texto', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    const detail = await must<Detail>(
      await http.post('/api/v1/entity-definitions', {
        code: 'vehicle',
        name: 'Viatura',
        fields: [
          { code: 'marca', label: 'Marca', type: 'TEXT', presentation: { searchable: false } },
          { code: 'modelo', label: 'Modelo', type: 'TEXT' },
        ],
      }),
      201
    )
    await must(
      await http.post(`/api/v1/entity-definitions/${detail.entity.id}/publish`, {
        expectedVersion: detail.entity.version,
      }),
      200
    )
    await must(await http.post(records, { data: { marca: 'Zeta', modelo: 'Omega' } }), 201)
    assert.lengthOf((await http.get(`${records}?q=omega`)).body().data, 1)
    assert.lengthOf((await http.get(`${records}?q=zeta`)).body().data, 0)
  })
})

test.group('metadados | campos fórmula calculados no servidor', (group) => {
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

  const orderFields = () => [
    { code: 'ref', label: 'Referência', type: 'TEXT', required: true },
    { code: 'qtd', label: 'Quantidade', type: 'NUMBER' },
    { code: 'preco', label: 'Preço', type: 'DECIMAL', validation: { precision: 12, scale: 2 } },
    {
      code: 'desconto',
      label: 'Desconto',
      type: 'DECIMAL',
      validation: { precision: 12, scale: 2 },
    },
    {
      code: 'total',
      label: 'Total',
      type: 'FORMULA',
      validation: { expression: 'qtd * preco - desconto', scale: 2 },
      presentation: { sortable: true, filterable: true },
    },
  ]
  const url = '/api/v1/dynamic/pedido/records'
  const publishedOrders = async (http: Http, fields: unknown[] = orderFields()) => {
    const draft = await must<Detail>(
      await http.post('/api/v1/entity-definitions', { code: 'pedido', name: 'Pedido', fields }),
      201
    )
    return must<Detail>(
      await http.post(`/api/v1/entity-definitions/${draft.entity.id}/publish`, {
        expectedVersion: draft.entity.version,
      }),
      200
    )
  }

  test('o total é calculado ao criar e ao alterar; o cliente não o escreve; faltar um valor apaga-o', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    const detail = await publishedOrders(http)
    const total = detail.published?.fields.find((f) => f.code === 'total')
    assert.isTrue(total.readOnly)
    assert.sameMembers(total.validation.dependencies, ['qtd', 'preco', 'desconto'])

    const created = await must<any>(
      await http.post(url, { data: { ref: 'P1', qtd: 3, preco: '19.99', desconto: '0.50' } }),
      201
    )
    assert.equal(created.data.total, '59.47')
    const changed = await must<any>(
      await http.patch(`${url}/${created.id}`, {
        expectedVersion: created.version,
        data: { qtd: 10 },
      }),
      200
    )
    assert.equal(changed.data.total, '199.40')
    const incomplete = await must<any>(
      await http.patch(`${url}/${created.id}`, {
        expectedVersion: changed.version,
        data: { desconto: null },
      }),
      200
    )
    assert.notProperty(incomplete.data, 'total')

    const forged = await http.post(url, { data: { ref: 'P2', total: '1.00' } })
    forged.assertStatus(422)
    assert.deepInclude(forged.body().error.details[0], { path: 'data.total', code: 'READ_ONLY' })
  })

  test('ordenar e filtrar pelo valor calculado (números, não texto)', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    await publishedOrders(http)
    for (const [ref, qtd, preco] of [
      ['A', 1, '9.00'],
      ['B', 1, '100.00'],
      ['C', 1, '20.00'],
    ] as const) {
      await must(await http.post(url, { data: { ref, qtd, preco, desconto: '0' } }), 201)
    }
    const refs = async (query: string) =>
      (await http.get(`${url}?${query}`)).body().data.map((r: any) => r.data.ref)
    assert.deepEqual(await refs('sort=total:asc'), ['A', 'C', 'B'])
    assert.deepEqual(await refs('sort=total:desc'), ['B', 'C', 'A'])
    assert.deepEqual(await refs('filter.total=20'), ['C'])
  })

  test('a fórmula é recusada se tiver ciclo, campo desconhecido ou fuga de dados sensíveis; divisão por zero dá vazio', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    const refuse = async (fields: unknown[]) => {
      const response = await http.post('/api/v1/entity-definitions', {
        code: 'cobaia',
        name: 'Cobaia',
        fields,
      })
      response.assertStatus(422)
      return response.body().error.details.map((d: any) => d.code)
    }
    const formula = (code: string, expression: string, extra = {}) => ({
      code,
      label: code,
      type: 'FORMULA',
      validation: { expression },
      ...extra,
    })
    assert.include(
      await refuse([formula('aa', 'bb + 1'), formula('bb', 'aa + 1')]),
      'CIRCULAR_FORMULA'
    )
    assert.include(await refuse([formula('aa', 'inexistente * 2')]), 'FORMULA_UNKNOWN_FIELD')
    assert.include(await refuse([formula('aa', 'process(1)')]), 'INVALID_FORMULA')
    assert.include(
      await refuse([
        { code: 'sal', label: 'Salário', type: 'NUMBER', sensitive: true },
        formula('bonus', 'sal * 2'),
      ]),
      'FORMULA_LEAKS_SENSITIVE'
    )

    await publishedOrders(http, [
      { code: 'qtd', label: 'Qtd', type: 'NUMBER' },
      { code: 'peso', label: 'Peso', type: 'NUMBER' },
      formula('media', 'peso / qtd'),
    ])
    const zero = await must<any>(await http.post(url, { data: { qtd: 0, peso: 10 } }), 201)
    assert.notProperty(zero.data, 'media')
    const ok = await must<any>(await http.post(url, { data: { qtd: 4, peso: 10 } }), 201)
    assert.equal(ok.data.media, '2.50')
  })

  test('uma nova versão pode mudar a fórmula (valores antigos mantêm-se até o registo ser alterado); retirar um campo usado por uma fórmula é recusado', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    const v1 = await publishedOrders(http)
    const record = await must<any>(
      await http.post(url, { data: { ref: 'P1', qtd: 2, preco: '10', desconto: '0' } }),
      201
    )
    assert.equal(record.data.total, '20.00')

    let detail = await must<Detail>(
      await http.post(`/api/v1/entity-definitions/${v1.entity.id}/drafts`, {}),
      201
    )
    // Retirar «desconto» (usado pela fórmula) é recusado logo ao guardar o rascunho.
    const draftFields = (detail.draft?.fields ?? []) as any[]
    const removal = await http.put(`/api/v1/entity-definitions/${v1.entity.id}/draft`, {
      expectedVersion: detail.entity.version,
      fields: draftFields.filter((f) => f.code !== 'desconto'),
    })
    removal.assertStatus(422)
    assert.include(
      removal.body().error.details.map((d: any) => d.code),
      'FORMULA_UNKNOWN_FIELD'
    )

    // Mudar a fórmula é permitido (a árvore e as dependências são recalculadas).
    const changedFields = draftFields.map((f) =>
      f.code === 'total' ? { ...f, validation: { expression: 'qtd * preco * 2', scale: 2 } } : f
    )
    detail = await must<Detail>(
      await http.put(`/api/v1/entity-definitions/${v1.entity.id}/draft`, {
        expectedVersion: detail.entity.version,
        fields: changedFields,
      }),
      200
    )
    detail = await must<Detail>(
      await http.post(`/api/v1/entity-definitions/${v1.entity.id}/publish`, {
        expectedVersion: detail.entity.version,
      }),
      200
    )
    assert.equal(detail.published?.revision, 2)
    // O registo antigo mantém o valor com que foi calculado…
    assert.equal((await http.get(`${url}/${record.id}`)).body().data.data.total, '20.00')
    // …e recalcula-se quando é alterado (passa à revisão 2).
    const moved = await must<any>(
      await http.patch(`${url}/${record.id}`, {
        expectedVersion: record.version,
        data: { qtd: 3 },
      }),
      200
    )
    assert.equal(moved.data.total, '60.00')
    assert.equal(moved.schemaVersion.revision, 2)
  })
})
