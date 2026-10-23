import { test } from '@japa/runner'
import { iamServices } from '#core/permissions/index'
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

async function publish(http: Http, body: Record<string, unknown>) {
  const draft = await must<Detail>(await http.post('/api/v1/entity-definitions', body), 201)
  return must<Detail>(
    await http.post(`/api/v1/entity-definitions/${draft.entity.id}/publish`, {
      expectedVersion: draft.entity.version,
    }),
    200
  )
}

const customerFields = () => [
  { code: 'nome', label: 'Nome', type: 'TEXT', required: true },
  {
    code: 'limite',
    label: 'Limite de crédito',
    type: 'DECIMAL',
    validation: { precision: 12, scale: 2 },
  },
  { code: 'nif', label: 'NIF', type: 'TEXT', sensitive: true },
  { code: 'tags', label: 'Etiquetas', type: 'MULTISELECT', options: [{ code: 'a', label: 'A' }] },
]

const orderFields = (extra: unknown[] = []) => [
  { code: 'ref', label: 'Referência', type: 'TEXT', required: true },
  { code: 'cliente', label: 'Cliente', type: 'ENTITY_REFERENCE', referenceEntityCode: 'cliente' },
  {
    code: 'nome_cliente',
    label: 'Nome do cliente',
    type: 'LOOKUP',
    validation: { relationField: 'cliente', sourceField: 'nome' },
  },
  {
    code: 'limite_cliente',
    label: 'Limite do cliente',
    type: 'LOOKUP',
    validation: { relationField: 'cliente', sourceField: 'limite' },
  },
  ...extra,
]

const customers = '/api/v1/dynamic/cliente/records'
const orders = '/api/v1/dynamic/ordem/records'

test.group('metadados | valores relacionados (LOOKUP)', (group) => {
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

  test('o valor lê-se em tempo real do registo de origem; não se escreve nem se guarda', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    await publish(http, { code: 'cliente', name: 'Cliente', fields: customerFields() })
    const detail = await publish(http, { code: 'ordem', name: 'Ordem', fields: orderFields() })

    const lookup = detail.published?.fields.find((f) => f.code === 'limite_cliente')
    assert.isTrue(lookup.readOnly)
    assert.deepInclude(lookup.validation, {
      relationField: 'cliente',
      sourceField: 'limite',
      onMissing: 'empty',
      sourceType: 'DECIMAL',
      scale: 2,
    })

    const customer = await must<any>(
      await http.post(customers, { data: { nome: 'Ana', limite: '1500.00' } }),
      201
    )
    const order = await must<any>(
      await http.post(orders, { data: { ref: 'O1', cliente: customer.id } }),
      201
    )
    assert.equal(order.data.nome_cliente, 'Ana')
    assert.equal(order.data.limite_cliente, '1500.00')

    // Ao vivo: alterar a origem reflecte-se na leitura seguinte, sem tocar na ordem.
    await must(
      await http.patch(`${customers}/${customer.id}`, {
        expectedVersion: customer.version,
        data: { nome: 'Ana Maria' },
      }),
      200
    )
    const read = await must<any>(await http.get(`${orders}/${order.id}`), 200)
    assert.equal(read.data.nome_cliente, 'Ana Maria')
    assert.equal(read.version, order.version)
    const list = await must<any[]>(await http.get(orders), 200)
    assert.equal(list[0].data.nome_cliente, 'Ana Maria')

    // Sem referência: vazio.
    const lonely = await must<any>(await http.post(orders, { data: { ref: 'O2' } }), 201)
    assert.isNull(lonely.data.nome_cliente)

    // O cliente nunca escreve o valor.
    const write = await http.post(orders, { data: { ref: 'O3', nome_cliente: 'x' } })
    write.assertStatus(422)
    assert.equal(write.body().error.details[0].code, 'READ_ONLY')
  })

  test('a definição é verificada: relação, origem, tipo e fuga de dados sensíveis', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    await publish(http, { code: 'cliente', name: 'Cliente', fields: customerFields() })
    const attempt = async (lookup: Record<string, unknown>, extra: unknown[] = []) => {
      const response = await http.post('/api/v1/entity-definitions', {
        code: `ordem_${Math.random().toString(36).slice(2, 8)}`,
        name: 'Ordem',
        fields: [
          {
            code: 'cliente',
            label: 'Cliente',
            type: 'ENTITY_REFERENCE',
            referenceEntityCode: 'cliente',
          },
          { code: 'ref', label: 'Ref', type: 'TEXT' },
          { code: 'valor', label: 'Valor', type: 'LOOKUP', ...lookup },
          ...extra,
        ],
      })
      response.assertStatus(422)
      return response.body().error.details.map((d: any) => d.code)
    }
    assert.include(
      await attempt({ validation: { relationField: 'nao_existe', sourceField: 'nome' } }),
      'LOOKUP_UNKNOWN_RELATION'
    )
    assert.include(
      await attempt({ validation: { relationField: 'ref', sourceField: 'nome' } }),
      'LOOKUP_RELATION_NOT_REFERENCE'
    )
    assert.include(
      await attempt({ validation: { relationField: 'cliente', sourceField: 'inexistente' } }),
      'LOOKUP_UNKNOWN_SOURCE'
    )
    assert.include(
      await attempt({ validation: { relationField: 'cliente', sourceField: 'tags' } }),
      'LOOKUP_SOURCE_TYPE'
    )
    assert.include(
      await attempt({ validation: { relationField: 'cliente', sourceField: 'nif' } }),
      'LOOKUP_LEAKS_SENSITIVE'
    )
    assert.include(
      await attempt({
        validation: { relationField: 'cliente', sourceField: 'nome' },
        required: true,
      }),
      'LOOKUP_REQUIRED'
    )
    assert.include(
      await attempt({
        validation: { relationField: 'cliente', sourceField: 'nome', onMissing: 'talvez' },
      }),
      'INVALID_VALIDATION'
    )
    assert.include(
      await attempt({
        validation: { relationField: 'cliente', sourceField: 'nome' },
        presentation: { sortable: true },
      }),
      'NOT_SUPPORTED'
    )
    // Um valor relacionado sobre um campo sensível é aceite se for também sensível.
    const ok = await http.post('/api/v1/entity-definitions', {
      code: 'ordem_ok',
      name: 'Ordem',
      fields: [
        {
          code: 'cliente',
          label: 'Cliente',
          type: 'ENTITY_REFERENCE',
          referenceEntityCode: 'cliente',
        },
        {
          code: 'nif_cliente',
          label: 'NIF',
          type: 'LOOKUP',
          sensitive: true,
          validation: { relationField: 'cliente', sourceField: 'nif' },
        },
      ],
    })
    ok.assertStatus(201)
  })

  test('onMissing=error exige a relação ao gravar; uma referência inexistente continua recusada', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    await publish(http, { code: 'cliente', name: 'Cliente', fields: customerFields() })
    await publish(http, {
      code: 'ordem',
      name: 'Ordem',
      fields: [
        { code: 'ref', label: 'Ref', type: 'TEXT' },
        {
          code: 'cliente',
          label: 'Cliente',
          type: 'ENTITY_REFERENCE',
          referenceEntityCode: 'cliente',
        },
        {
          code: 'nome_cliente',
          label: 'Nome',
          type: 'LOOKUP',
          validation: { relationField: 'cliente', sourceField: 'nome', onMissing: 'error' },
        },
      ],
    })
    const missing = await http.post(orders, { data: { ref: 'O1' } })
    missing.assertStatus(422)
    assert.deepInclude(missing.body().error.details[0], {
      path: 'data.cliente',
      code: 'LOOKUP_RELATION_REQUIRED',
    })
    const customer = await must<any>(await http.post(customers, { data: { nome: 'Rui' } }), 201)
    const created = await must<any>(
      await http.post(orders, { data: { ref: 'O1', cliente: customer.id } }),
      201
    )
    assert.equal(created.data.nome_cliente, 'Rui')
  })

  test('só vê o valor quem pode ler o registo de origem (ABAC), o campo (regra de campo) e o sensível', async ({
    client,
    assert,
  }) => {
    const { tenant, http } = await setup(client)
    await publish(http, { code: 'cliente', name: 'Cliente', fields: customerFields() })
    await publish(http, {
      code: 'ordem',
      name: 'Ordem',
      fields: orderFields([
        {
          code: 'nif_cliente',
          label: 'NIF do cliente',
          type: 'LOOKUP',
          sensitive: true,
          validation: { relationField: 'cliente', sourceField: 'nif' },
        },
      ]),
    })
    const customer = await must<any>(
      await http.post(customers, { data: { nome: 'Ana', limite: '10.00', nif: '123456789' } }),
      201
    )
    const order = await must<any>(
      await http.post(orders, { data: { ref: 'O1', cliente: customer.id } }),
      201
    )
    const admin = await must<any>(await http.get(`${orders}/${order.id}`), 200)
    assert.equal(admin.data.nif_cliente, '123456789')

    // Sem dynamic.sensitive: o valor sensível nunca aparece (nem o campo).
    const reader = await memberWith(client, tenant, http, ['dynamic.read'])
    const plain = await must<any>(await reader.http.get(`${orders}/${order.id}`), 200)
    assert.equal(plain.data.nome_cliente, 'Ana')
    assert.notProperty(plain.data, 'nif_cliente')

    // Com dynamic.sensitive só na ordem não chega: a origem também exige essa permissão (a mesma, no destino).
    const sensitive = await memberWith(client, tenant, http, ['dynamic.read', 'dynamic.sensitive'])
    assert.equal(
      (await must<any>(await sensitive.http.get(`${orders}/${order.id}`), 200)).data.nif_cliente,
      '123456789'
    )

    // Política ABAC: negar a leitura de «cliente» esvazia os valores relacionados, mas a ordem lê-se.
    await must(
      await http.post('/api/v1/access-policies', {
        name: 'Clientes ocultos',
        resource: 'dynamic',
        action: 'read',
        effect: 'DENY',
        status: 'ACTIVE',
        condition: { op: 'eq', left: { var: 'resource.entity' }, right: { value: 'cliente' } },
      }),
      201
    )
    ;(await reader.http.get(customers)).assertStatus(403)
    const denied = await must<any>(await reader.http.get(`${orders}/${order.id}`), 200)
    assert.equal(denied.data.ref, 'O1')
    assert.isNull(denied.data.nome_cliente)
    assert.isNull(denied.data.limite_cliente)
  })

  test('regra de campo escondida no destino e origem em modo OWNER esvaziam o valor', async ({
    client,
    assert,
  }) => {
    const { tenant, http } = await setup(client)
    await publish(http, {
      code: 'cliente',
      name: 'Cliente',
      ownershipMode: 'OWNER',
      fields: customerFields(),
    })
    await publish(http, { code: 'ordem', name: 'Ordem', fields: orderFields() })
    const customer = await must<any>(
      await http.post(customers, { data: { nome: 'Ana', limite: '10.00' } }),
      201
    )
    const order = await must<any>(
      await http.post(orders, { data: { ref: 'O1', cliente: customer.id } }),
      201
    )
    // O registo de origem é do administrador (OWNER): um leitor sem dynamic.all não o vê.
    const reader = await memberWith(client, tenant, http, ['dynamic.read'])
    const asReader = await must<any>(await reader.http.get(`${orders}/${order.id}`), 200)
    assert.isNull(asReader.data.nome_cliente)
    const all = await memberWith(client, tenant, http, ['dynamic.read', 'dynamic.all'])
    assert.equal(
      (await must<any>(await all.http.get(`${orders}/${order.id}`), 200)).data.nome_cliente,
      'Ana'
    )

    // Regra de campo: esconder o limite no destino esconde-o também no valor relacionado.
    await must(
      await http.post('/api/v1/access-policies', {
        name: 'Limite oculto',
        resource: 'dynamic',
        action: 'read',
        effect: 'ALLOW',
        status: 'ACTIVE',
        condition: {
          op: 'or',
          args: [
            { op: 'eq', left: { var: 'resource.entity' }, right: { value: 'cliente' } },
            { op: 'eq', left: { var: 'resource.entity' }, right: { value: 'ordem' } },
          ],
        },
        fieldRules: [{ field: 'limite', mode: 'HIDDEN' }],
      }),
      201
    )
    const hiddenLimit = await must<any>(await all.http.get(`${orders}/${order.id}`), 200)
    assert.equal(hiddenLimit.data.nome_cliente, 'Ana')
    assert.isNull(hiddenLimit.data.limite_cliente)
  })

  test('os valores relacionados não entram em regras, e a relação não se pode retirar enquanto for usada', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    await publish(http, { code: 'cliente', name: 'Cliente', fields: customerFields() })
    const detail = await publish(http, { code: 'ordem', name: 'Ordem', fields: orderFields() })

    const rule = await http.post('/api/v1/rules', {
      entityCode: 'ordem',
      code: 'sobre_lookup',
      name: 'Sobre lookup',
      conditionAst: { op: 'eq', left: { var: 'resource.nome_cliente' }, right: { value: 'x' } },
      actionAst: { type: 'BLOCK', message: 'não' },
    })
    rule.assertStatus(422)
    assert.equal(rule.body().error.details[0].code, 'UNKNOWN_FIELD')

    // Retirar o campo de relação deixa o valor relacionado sem origem: recusado ao gravar o rascunho.
    const reopened = await must<Detail>(
      await http.post(`/api/v1/entity-definitions/${detail.entity.id}/drafts`, {}),
      201
    )
    const drop = await http.put(`/api/v1/entity-definitions/${detail.entity.id}/draft`, {
      expectedVersion: reopened.entity.version,
      fields: orderFields().filter((f: any) => f.code !== 'cliente'),
    })
    drop.assertStatus(422)
    assert.include(
      drop.body().error.details.map((d: any) => d.code),
      'LOOKUP_UNKNOWN_RELATION'
    )
  })

  test('os registos escritos antes do campo existir também mostram o valor (segue a versão em vigor)', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    await publish(http, { code: 'cliente', name: 'Cliente', fields: customerFields() })
    const first = await publish(http, {
      code: 'ordem',
      name: 'Ordem',
      fields: orderFields().filter((f: any) => f.type !== 'LOOKUP'),
    })
    const customer = await must<any>(await http.post(customers, { data: { nome: 'Rui' } }), 201)
    const order = await must<any>(
      await http.post(orders, { data: { ref: 'O1', cliente: customer.id } }),
      201
    )
    assert.notProperty(order.data, 'nome_cliente')

    const reopened = await must<Detail>(
      await http.post(`/api/v1/entity-definitions/${first.entity.id}/drafts`, {}),
      201
    )
    const saved = await must<Detail>(
      await http.put(`/api/v1/entity-definitions/${first.entity.id}/draft`, {
        expectedVersion: reopened.entity.version,
        fields: orderFields(),
      }),
      200
    )
    await must(
      await http.post(`/api/v1/entity-definitions/${first.entity.id}/publish`, {
        expectedVersion: saved.entity.version,
      }),
      200
    )
    const read = await must<any>(await http.get(`${orders}/${order.id}`), 200)
    assert.equal(read.schemaVersion.revision, 1)
    assert.equal(read.data.nome_cliente, 'Rui')
  })
})
