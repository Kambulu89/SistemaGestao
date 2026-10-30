import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { iamServices } from '#core/permissions/index'
import { capture } from '#tests/support/capture'
import { deleteTestUsers, resetAuthState } from '#tests/support/auth_fixture'
import { createActiveTenant, deleteTestTenants } from '#tests/support/membership_fixture'
import { api, newActor } from '#tests/support/api_fixture'
import type { Tenant } from '#platform/tenants/index'

type Http = ReturnType<typeof api>

interface Detail {
  entity: { id: string; version: number }
  draft: { fields: any[] } | null
  published: { fields: any[] } | null
}

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
  return { tenant, admin, http: api(client, tenant, admin) }
}

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
  return { actor, http: api(client, tenant, actor) }
}

const vehicleFields = () => [
  { code: 'matricula', label: 'Matrícula', type: 'TEXT', required: true },
  { code: 'marca', label: 'Marca', type: 'TEXT' },
  { code: 'ano', label: 'Ano', type: 'NUMBER' },
  { code: 'notas', label: 'Notas', type: 'TEXT', sensitive: true },
]

async function publishEntity(http: Http, fields: unknown[] = vehicleFields()) {
  const draft = await must<Detail>(
    await http.post('/api/v1/entity-definitions', { code: 'vehicle', name: 'Viatura', fields }),
    201
  )
  return must<Detail>(
    await http.post(`/api/v1/entity-definitions/${draft.entity.id}/publish`, {
      expectedVersion: draft.entity.version,
    }),
    200
  )
}

const item = (field: string, extra: Record<string, unknown> = {}) => ({
  kind: 'field',
  field,
  ...extra,
})
const form = (sections: unknown[], extra: Record<string, unknown> = {}) => ({
  entityCode: 'vehicle',
  code: 'ficha',
  name: 'Ficha',
  sections,
  ...extra,
})
const basic = () => [
  {
    key: 'dados',
    title: 'Dados',
    columns: 2,
    items: [item('matricula', { span: 2 }), item('marca')],
  },
]

test.group('formulários | ciclo de vida e imutabilidade', (group) => {
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

  test('rascunho → publicação imutável → nova revisão retira a anterior', async ({
    client,
    assert,
  }) => {
    const { tenant, http } = await setup(client)
    await publishEntity(http)
    const draft = await must<any>(await http.post('/api/v1/forms', form(basic())), 201)
    assert.equal(draft.status, 'DRAFT')
    assert.equal(draft.revision, 1)
    assert.deepEqual(draft.modes, ['create', 'edit', 'read'])

    const edited = await must<any>(
      await http.patch(`/api/v1/forms/${draft.id}`, {
        expectedVersion: draft.version,
        name: 'Ficha de viatura',
        sections: [
          {
            key: 'dados',
            title: 'Dados',
            columns: 2,
            items: [item('matricula'), item('marca', { help: 'Marca do fabricante' }), item('ano')],
          },
        ],
      }),
      200
    )
    assert.equal(edited.name, 'Ficha de viatura')
    ;(
      await http.patch(`/api/v1/forms/${draft.id}`, { expectedVersion: draft.version, name: 'x' })
    ).assertStatus(409) // versão antiga

    const preview = await must<any>(await http.post(`/api/v1/forms/${draft.id}/preview`, {}), 200)
    assert.deepEqual(preview.issues, [])
    assert.isTrue(preview.publishable)

    const published = await must<any>(
      await http.post(`/api/v1/forms/${draft.id}/publish`, { expectedVersion: edited.version }),
      200
    )
    assert.equal(published.status, 'PUBLISHED')
    assert.equal(published.schemaRevision, 1)

    // Imutável: pela API e directamente na base.
    const refused = await http.patch(`/api/v1/forms/${draft.id}`, {
      expectedVersion: published.version,
      name: 'outro',
    })
    refused.assertStatus(409)
    assert.equal(refused.body().error.code, 'FORM_NOT_DRAFT')
    const attempt = (sql: string) =>
      capture(() =>
        db.connection('owner').transaction(async (trx) => {
          await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [tenant.id])
          await trx.rawQuery(sql)
        })
      )
    for (const sql of [
      `update form_definitions set name = 'x' where id = '${draft.id}'`,
      `update form_definitions set layout = '{"sections":[]}' where id = '${draft.id}'`,
      `update form_definitions set status = 'DRAFT' where id = '${draft.id}'`,
      `delete from form_definitions where id = '${draft.id}'`,
    ]) {
      assert.match((await attempt(sql)).message, /PUBLISHED_FORM_IMMUTABLE/, sql)
    }

    const revision = await must<any>(
      await http.post(`/api/v1/forms/${draft.id}/revisions`, {}),
      201
    )
    assert.equal(revision.revision, 2)
    assert.equal(revision.status, 'DRAFT')
    assert.equal(revision.sections[0].items.length, 3)
    ;(await http.post(`/api/v1/forms/${draft.id}/revisions`, {})).assertStatus(409)
    await must(
      await http.post(`/api/v1/forms/${revision.id}/publish`, {
        expectedVersion: revision.version,
      }),
      200
    )
    const all = await must<any[]>(await http.get('/api/v1/forms?entityCode=vehicle'), 200)
    assert.deepEqual(all.map((f) => `${f.revision}:${f.status}`).sort(), [
      '1:RETIRED',
      '2:PUBLISHED',
    ])
    // Retirar (o formulário em vigor deixa de aparecer a quem lê os registos).
    const current = all.find((f) => f.status === 'PUBLISHED')
    await must(
      await http.post(`/api/v1/forms/${current.id}/retire`, { expectedVersion: current.version }),
      200
    )
    assert.lengthOf(await must<any[]>(await http.get('/api/v1/dynamic/vehicle/forms'), 200), 0)
  })

  test('só um formulário por omissão por modo; o código não se repete', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    await publishEntity(http)
    const first = await must<any>(
      await http.post('/api/v1/forms', form(basic(), { isDefault: true })),
      201
    )
    await must(
      await http.post(`/api/v1/forms/${first.id}/publish`, { expectedVersion: first.version }),
      200
    )
    const dup = await http.post('/api/v1/forms', form(basic()))
    dup.assertStatus(409)
    assert.equal(dup.body().error.code, 'FORM_CODE_TAKEN')

    const second = await must<any>(
      await http.post(
        '/api/v1/forms',
        form(basic(), { code: 'curta', isDefault: true, modes: ['create'] })
      ),
      201
    )
    const clash = await http.post(`/api/v1/forms/${second.id}/publish`, {
      expectedVersion: second.version,
    })
    clash.assertStatus(409)
    assert.equal(clash.body().error.code, 'FORM_DEFAULT_TAKEN')
    // Noutro modo já não colide.
    const other = await must<any>(
      await http.patch(`/api/v1/forms/${second.id}`, {
        expectedVersion: second.version,
        isDefault: false,
      }),
      200
    )
    await must(
      await http.post(`/api/v1/forms/${second.id}/publish`, { expectedVersion: other.version }),
      200
    )
  })

  test('a entidade tem de estar publicada para lhe definir formulários', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    await must(
      await http.post('/api/v1/entity-definitions', {
        code: 'vehicle',
        name: 'Viatura',
        fields: vehicleFields(),
      }),
      201
    )
    const response = await http.post('/api/v1/forms', form(basic()))
    response.assertStatus(422)
    assert.equal(response.body().error.details[0].code, 'ENTITY_NOT_PUBLISHED')
    ;(
      await http.post('/api/v1/forms', { ...form(basic()), entityCode: 'nao_existe' })
    ).assertStatus(422)
  })
})

test.group('formulários | validação', (group) => {
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

  test('a estrutura mal formada é recusada com o caminho completo', async ({ client, assert }) => {
    const { http } = await setup(client)
    await publishEntity(http)
    const codes = async (sections: unknown[], extra: Record<string, unknown> = {}) => {
      const response = await http.post('/api/v1/forms', form(sections, extra))
      response.assertStatus(422)
      return response.body().error.details.map((d: any) => `${d.path}:${d.code}`)
    }
    assert.include(await codes([]), 'sections:INVALID_SECTIONS')
    assert.include(
      await codes([{ key: 'a', title: 'A', columns: 4, items: [] }]),
      'sections[0].columns:INVALID_COLUMNS'
    )
    assert.include(
      await codes([
        { key: 'a', title: 'A', items: [] },
        { key: 'a', title: 'B', items: [] },
      ]),
      'sections[1].key:DUPLICATE_SECTION'
    )
    assert.include(
      await codes([{ key: 'a', title: 'A', items: [item('matricula', { span: 9 })] }]),
      'sections[0].items[0].span:INVALID_SPAN'
    )
    assert.include(
      await codes([{ key: 'a', title: 'A', items: [{ kind: 'group', items: [] }] }]),
      'sections[0].items[0].kind:UNSUPPORTED_ITEM'
    )
    assert.include(
      await codes([{ key: 'a', title: 'A', items: [item('matricula', { cor: 'x' })] }]),
      'sections[0].items[0].cor:UNKNOWN_KEY'
    )
    assert.include(
      await codes([
        {
          key: 'a',
          title: 'A',
          items: [item('matricula', { visibleWhen: { op: 'eval', code: 'process.exit()' } })],
        },
      ]),
      'sections[0].items[0].visibleWhen:UNKNOWN_OP'
    )
    assert.include(await codes(basic(), { modes: ['create', 'create'] }), 'modes:INVALID_MODES')
    let nested: any = { op: 'empty', field: 'marca' }
    for (let i = 0; i < 10; i++) nested = { op: 'not', condition: nested }
    assert.include(
      (
        await codes([{ key: 'a', title: 'A', items: [item('matricula', { visibleWhen: nested })] }])
      ).join(),
      'CONDITION_TOO_DEEP'
    )
  })

  test('a publicação verifica o formulário contra a entidade e o que o torna impossível de preencher', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    await publishEntity(http)
    const publishCodes = async (sections: unknown[], extra: Record<string, unknown> = {}) => {
      const created = await must<any>(
        await http.post(
          '/api/v1/forms',
          form(sections, { code: `f_${Math.random().toString(36).slice(2, 8)}`, ...extra })
        ),
        201
      )
      const response = await http.post(`/api/v1/forms/${created.id}/publish`, {
        expectedVersion: created.version,
      })
      response.assertStatus(422)
      const preview = await must<any>(
        await http.post(`/api/v1/forms/${created.id}/preview`, {}),
        200
      )
      assert.isFalse(preview.publishable)
      return response.body().error.details.map((d: any) => d.code)
    }
    const section = (items: unknown[], extra: Record<string, unknown> = {}) => [
      { key: 'a', title: 'A', columns: 2, items, ...extra },
    ]
    assert.include(
      await publishCodes(section([item('matricula'), item('nao_existe')])),
      'FORM_UNKNOWN_FIELD'
    )
    assert.include(
      await publishCodes(section([item('matricula'), item('matricula')])),
      'FORM_DUPLICATE_FIELD'
    )
    assert.include(await publishCodes(section([item('marca')])), 'FORM_MISSING_REQUIRED')
    assert.include(
      await publishCodes(section([item('matricula', { visible: false })])),
      'FORM_HIDES_REQUIRED'
    )
    assert.include(
      await publishCodes(
        section([item('matricula'), item('marca')], {
          visibleWhen: { op: 'notEmpty', field: 'marca' },
        })
      ),
      'FORM_HIDES_REQUIRED'
    )
    assert.include(
      await publishCodes(section([item('matricula', { editable: false })])),
      'FORM_HIDES_REQUIRED'
    )
    assert.include(
      await publishCodes(
        section([item('matricula', { visibleWhen: { op: 'eq', field: 'notas', value: 'x' } })])
      ),
      'FORM_SENSITIVE_CONDITION'
    )
    assert.include(
      await publishCodes([
        { key: 'a', title: 'A', columns: 1, items: [item('matricula', { span: 2 })] },
      ]),
      'FORM_SPAN_TOO_WIDE'
    )
    // Só de leitura: o formulário de consulta pode deixar de fora ou esconder o obrigatório.
    const read = await must<any>(
      await http.post(
        '/api/v1/forms',
        form(section([item('marca', { visible: false })]), { code: 'consulta', modes: ['read'] })
      ),
      201
    )
    await must(
      await http.post(`/api/v1/forms/${read.id}/publish`, { expectedVersion: read.version }),
      200
    )
  })

  test('um campo obrigatório com valor por omissão pode ficar de fora; fórmulas e lookups não se tornam obrigatórios', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    await publishEntity(http, [
      { code: 'matricula', label: 'Matrícula', type: 'TEXT', required: true, defaultValue: 'SEM' },
      { code: 'qtd', label: 'Qtd', type: 'NUMBER' },
      {
        code: 'dobro',
        label: 'Dobro',
        type: 'FORMULA',
        validation: { expression: 'qtd * 2', scale: 0 },
      },
    ])
    const ok = await must<any>(
      await http.post(
        '/api/v1/forms',
        form([{ key: 'a', title: 'A', items: [item('qtd'), item('dobro')] }])
      ),
      201
    )
    await must(
      await http.post(`/api/v1/forms/${ok.id}/publish`, { expectedVersion: ok.version }),
      200
    )
    const bad = await must<any>(
      await http.post(
        '/api/v1/forms',
        form([{ key: 'a', title: 'A', items: [item('qtd'), item('dobro', { required: true })] }], {
          code: 'mau',
        })
      ),
      201
    )
    const response = await http.post(`/api/v1/forms/${bad.id}/publish`, {
      expectedVersion: bad.version,
    })
    response.assertStatus(422)
    assert.include(
      response.body().error.details.map((d: any) => d.code),
      'FORM_REQUIRED_READ_ONLY'
    )
  })
})

test.group('formulários | autorização e coerência com a entidade', (group) => {
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

  test('permissões separadas: ver, desenhar e publicar; quem lê registos vê só os publicados', async ({
    client,
    assert,
  }) => {
    const { tenant, http } = await setup(client)
    await publishEntity(http)
    const none = await memberWith(client, tenant, http, [])
    ;(await none.http.get('/api/v1/forms')).assertStatus(403)
    const reader = await memberWith(client, tenant, http, ['dynamic.read'])
    ;(await reader.http.get('/api/v1/forms')).assertStatus(403)
    const designer = await memberWith(client, tenant, http, ['form.read', 'form.design'])
    const draft = await must<any>(await designer.http.post('/api/v1/forms', form(basic())), 201)
    ;(
      await designer.http.post(`/api/v1/forms/${draft.id}/publish`, {
        expectedVersion: draft.version,
      })
    ).assertStatus(403)
    // O rascunho não chega a quem lê registos.
    assert.lengthOf(
      await must<any[]>(await reader.http.get('/api/v1/dynamic/vehicle/forms'), 200),
      0
    )
    const publisher = await memberWith(client, tenant, http, ['form.read', 'form.publish'])
    ;(await publisher.http.post('/api/v1/forms', form(basic(), { code: 'outra' }))).assertStatus(
      403
    )
    await must(
      await publisher.http.post(`/api/v1/forms/${draft.id}/publish`, {
        expectedVersion: draft.version,
      }),
      200
    )
    const seen = await must<any[]>(await reader.http.get('/api/v1/dynamic/vehicle/forms'), 200)
    assert.lengthOf(seen, 1)
    assert.deepEqual(seen[0].issues, [])
    // Id mal formado ou alheio: 404.
    ;(await http.get('/api/v1/forms/nao-e-uuid')).assertStatus(404)
    ;(await http.get('/api/v1/forms/00000000-0000-4000-8000-000000000000')).assertStatus(404)
  })

  test('um campo escondido no formulário continua sujeito à autorização da entidade', async ({
    client,
    assert,
  }) => {
    const { tenant, http } = await setup(client)
    await publishEntity(http)
    // O formulário esconde «notas» (sensível)…
    const hidden = await must<any>(
      await http.post(
        '/api/v1/forms',
        form([
          {
            key: 'a',
            title: 'A',
            items: [item('matricula'), item('notas', { visible: false })],
          },
        ])
      ),
      201
    )
    await must(
      await http.post(`/api/v1/forms/${hidden.id}/publish`, { expectedVersion: hidden.version }),
      200
    )
    // …mas um pedido com «notas» feito por quem não tem dynamic.sensitive é recusado pelo servidor.
    const clerk = await memberWith(client, tenant, http, ['dynamic.read', 'dynamic.create'])
    const forged = await clerk.http.post('/api/v1/dynamic/vehicle/records', {
      data: { matricula: 'AA-00-AA', notas: 'segredo' },
    })
    forged.assertStatus(403)
    // E um valor inválido continua a ser recusado, com o caminho completo do campo.
    const invalid = await clerk.http.post('/api/v1/dynamic/vehicle/records', { data: { marca: 3 } })
    invalid.assertStatus(422)
    assert.include(
      invalid.body().error.details.map((d: any) => d.path),
      'data.marca'
    )
  })

  test('uma nova versão da entidade que retira um campo usado deixa o formulário com problemas', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    const detail = await publishEntity(http)
    const created = await must<any>(
      await http.post(
        '/api/v1/forms',
        form([{ key: 'a', title: 'A', items: [item('matricula'), item('marca'), item('ano')] }])
      ),
      201
    )
    await must(
      await http.post(`/api/v1/forms/${created.id}/publish`, { expectedVersion: created.version }),
      200
    )

    const reopened = await must<Detail>(
      await http.post(`/api/v1/entity-definitions/${detail.entity.id}/drafts`, {}),
      201
    )
    const saved = await must<Detail>(
      await http.put(`/api/v1/entity-definitions/${detail.entity.id}/draft`, {
        expectedVersion: reopened.entity.version,
        fields: vehicleFields().filter((f) => f.code !== 'ano'),
      }),
      200
    )
    await must(
      await http.post(`/api/v1/entity-definitions/${detail.entity.id}/publish`, {
        expectedVersion: saved.entity.version,
      }),
      200
    )
    const seen = await must<any[]>(await http.get('/api/v1/dynamic/vehicle/forms'), 200)
    assert.deepEqual(
      seen[0].issues.map((i: any) => i.code),
      ['FORM_UNKNOWN_FIELD']
    )
    assert.equal(seen[0].issues[0].path, 'sections[0].items[2].field')
  })
})
