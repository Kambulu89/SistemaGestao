import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { iamServices } from '#core/permissions/index'
import { capture } from '#tests/support/capture'
import { deleteTestUsers, resetAuthState } from '#tests/support/auth_fixture'
import { createActiveTenant, deleteTestTenants } from '#tests/support/membership_fixture'
import { api, newActor } from '#tests/support/api_fixture'
import type { Tenant } from '#platform/tenants/index'

type Http = ReturnType<typeof api>

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
  const http = api(client, tenant, admin)
  const detail = await must<any>(
    await http.post('/api/v1/entity-definitions', {
      code: 'encomenda',
      name: 'Encomenda',
      fields: [
        { code: 'ref', label: 'Referência', type: 'TEXT' },
        {
          code: 'desconto',
          label: 'Desconto',
          type: 'DECIMAL',
          validation: { precision: 12, scale: 2 },
        },
        { code: 'valor', label: 'Valor', type: 'DECIMAL', validation: { precision: 12, scale: 2 } },
        { code: 'segredo', label: 'Segredo', type: 'TEXT', sensitive: true },
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
  return { tenant, admin, http }
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
  return api(client, tenant, actor)
}

const over = (field: string, value: string) => ({
  op: 'gt',
  left: { var: `resource.${field}` },
  right: { value },
})
const block = (message: string, field?: string) => ({
  type: 'BLOCK',
  message,
  ...(field ? { field } : {}),
})
const newRule = (over_: Record<string, unknown> = {}) => ({
  entityCode: 'encomenda',
  code: 'desconto_alcada',
  name: 'Desconto dentro da alçada',
  conditionAst: over('desconto', '20'),
  actionAst: block('desconto excede alçada', 'desconto'),
  ...over_,
})
const records = '/api/v1/dynamic/encomenda/records'

test.group('regras | ciclo de vida, publicação imutável e aplicação aos registos', (group) => {
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

  test('rascunho → simulação → publicação: a regra bloqueia as escritas com a mensagem de negócio', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    const rule = await must<any>(await http.post('/api/v1/rules', newRule()), 201)
    assert.deepInclude(rule, {
      status: 'DRAFT',
      revision: 1,
      priority: 100,
      entityCode: 'encomenda',
    })
    // Um rascunho ainda não bloqueia nada.
    await must(await http.post(records, { data: { ref: 'A', desconto: '50.00' } }), 201)

    const fail = await must<any>(
      await http.post(`/api/v1/rules/${rule.id}/simulate`, { values: { desconto: '25.00' } }),
      200
    )
    assert.deepInclude(fail, { result: 'FAIL', message: 'desconto excede alçada' })
    const pass = await must<any>(
      await http.post(`/api/v1/rules/${rule.id}/simulate`, { values: { desconto: '5.00' } }),
      200
    )
    assert.equal(pass.result, 'PASS')
    // A simulação não grava avaliações.
    assert.lengthOf((await http.get(`/api/v1/rules/${rule.id}/evaluations`)).body().data, 0)

    const published = await must<any>(
      await http.post(`/api/v1/rules/${rule.id}/publish`, { expectedVersion: rule.version }),
      200
    )
    assert.equal(published.status, 'PUBLISHED')
    assert.exists(published.publishedAt)

    const blocked = await http.post(records, { data: { ref: 'B', desconto: '25.00' } })
    blocked.assertStatus(422)
    assert.deepInclude(blocked.body().error.details[0], {
      path: 'data.desconto',
      code: 'RULE_BLOCKED',
      message: 'desconto excede alçada',
    })
    const ok = await must<any>(
      await http.post(records, { data: { ref: 'C', desconto: '10.00' } }),
      201
    )
    // A alteração também é avaliada, sobre os valores finais (parciais + os já guardados).
    const raised = await http.patch(`${records}/${ok.id}`, {
      expectedVersion: ok.version,
      data: { desconto: '30' },
    })
    raised.assertStatus(422)
    assert.equal(raised.body().error.details[0].code, 'RULE_BLOCKED')
    const noChange = await must<any>(
      await http.patch(`${records}/${ok.id}`, { expectedVersion: ok.version, data: { ref: 'C2' } }),
      200
    )
    assert.equal(noChange.data.ref, 'C2')

    // As recusas ficam registadas (com resumo dos dados, nunca os valores).
    const log = (await http.get(`/api/v1/rules/${rule.id}/evaluations`)).body().data
    assert.lengthOf(log, 2)
    assert.sameMembers(
      log.map((e: any) => e.result),
      ['FAIL', 'FAIL']
    )
    assert.match(log[0].inputHash, /^[0-9a-f]{64}$/)
    assert.notInclude(JSON.stringify(log), '25.00')
    assert.equal(log.find((e: any) => e.resourceId === ok.id)?.resourceId, ok.id)
  })

  test('uma regra publicada é imutável; uma nova revisão substitui a anterior e a antiga continua legível', async ({
    client,
    assert,
  }) => {
    const { tenant, http } = await setup(client)
    const rule = await must<any>(await http.post('/api/v1/rules', newRule()), 201)
    const v1 = await must<any>(
      await http.post(`/api/v1/rules/${rule.id}/publish`, { expectedVersion: rule.version }),
      200
    )
    const edit = await http.patch(`/api/v1/rules/${rule.id}`, {
      expectedVersion: v1.version,
      name: 'Outro',
    })
    edit.assertStatus(409)
    assert.equal(edit.body().error.code, 'RULE_NOT_DRAFT')
    ;(
      await http.post(`/api/v1/rules/${rule.id}/publish`, { expectedVersion: v1.version })
    ).assertStatus(409)

    // Nem o SQL directo altera uma regra publicada (excepto passar a DISABLED).
    const attempt = (sql: string) =>
      capture(() =>
        db.connection('owner').transaction(async (trx) => {
          await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [tenant.id])
          await trx.rawQuery(sql)
        })
      )
    for (const sql of [
      `update rule_definitions set priority = 1 where id = '${v1.id}'`,
      `update rule_definitions set condition_ast = '{"op":"true"}' where id = '${v1.id}'`,
      `update rule_definitions set status = 'DRAFT' where id = '${v1.id}'`,
      `delete from rule_definitions where id = '${v1.id}'`,
    ]) {
      assert.match((await attempt(sql)).message, /PUBLISHED_RULE_IMMUTABLE/, sql)
    }

    // Nova revisão: copia a anterior; só uma por vez.
    const draft = await must<any>(await http.post(`/api/v1/rules/${rule.id}/revisions`, {}), 201)
    assert.deepInclude(draft, { revision: 2, status: 'DRAFT', code: 'desconto_alcada' })
    const again = await http.post(`/api/v1/rules/${rule.id}/revisions`, {})
    again.assertStatus(409)
    assert.equal(again.body().error.code, 'RULE_DRAFT_EXISTS')

    const stricter = await must<any>(
      await http.patch(`/api/v1/rules/${draft.id}`, {
        expectedVersion: draft.version,
        conditionAst: over('desconto', '10'),
      }),
      200
    )
    // Até publicar, vale a revisão 1 (limite 20).
    await must(await http.post(records, { data: { ref: 'X', desconto: '15' } }), 201)
    await must(
      await http.post(`/api/v1/rules/${draft.id}/publish`, { expectedVersion: stricter.version }),
      200
    )
    ;(await http.post(records, { data: { ref: 'Y', desconto: '15' } })).assertStatus(422)
    const all = (await http.get('/api/v1/rules?entityCode=encomenda')).body().data
    assert.deepEqual(
      all.map((r: any) => [r.revision, r.status]),
      [
        [2, 'PUBLISHED'],
        [1, 'DISABLED'],
      ]
    )
    // A revisão antiga continua legível e inalterada.
    assert.deepEqual(
      (await http.get(`/api/v1/rules/${v1.id}`)).body().data.conditionAst,
      over('desconto', '20')
    )
  })

  test('desactivar deixa de bloquear; nada se apaga', async ({ client, assert }) => {
    const { http } = await setup(client)
    const rule = await must<any>(await http.post('/api/v1/rules', newRule()), 201)
    const published = await must<any>(
      await http.post(`/api/v1/rules/${rule.id}/publish`, { expectedVersion: rule.version }),
      200
    )
    ;(await http.post(records, { data: { desconto: '99' } })).assertStatus(422)
    const disabled = await must<any>(
      await http.post(`/api/v1/rules/${rule.id}/disable`, { expectedVersion: published.version }),
      200
    )
    assert.equal(disabled.status, 'DISABLED')
    await must(await http.post(records, { data: { desconto: '99' } }), 201)
    ;(
      await http.post(`/api/v1/rules/${rule.id}/disable`, { expectedVersion: disabled.version })
    ).assertStatus(409)
    // O histórico de avaliações mantém-se.
    assert.lengthOf((await http.get(`/api/v1/rules/${rule.id}/evaluations`)).body().data, 1)
  })

  test('todas as regras em vigor avaliam-se, por prioridade; o período de vigência é respeitado', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    const publish = async (body: Record<string, unknown>) => {
      const rule = await must<any>(await http.post('/api/v1/rules', body), 201)
      return must<any>(
        await http.post(`/api/v1/rules/${rule.id}/publish`, { expectedVersion: rule.version }),
        200
      )
    }
    await publish(newRule({ code: 'baixa', priority: 10, actionAst: block('mensagem baixa') }))
    await publish(
      newRule({ code: 'alta', priority: 900, actionAst: block('mensagem alta', 'desconto') })
    )
    const future = await publish(
      newRule({
        code: 'futura',
        effectiveFrom: new Date(Date.now() + 86_400_000).toISOString(),
        actionAst: block('ainda não'),
      })
    )
    await publish(
      newRule({
        code: 'expirada',
        effectiveTo: new Date(Date.now() - 86_400_000).toISOString(),
        effectiveFrom: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        actionAst: block('já não'),
      })
    )
    const response = await http.post(records, { data: { desconto: '50' } })
    response.assertStatus(422)
    assert.deepEqual(
      response.body().error.details.map((d: any) => d.message),
      ['mensagem alta', 'mensagem baixa']
    )
    // A simulação respeita a vigência.
    const skipped = await must<any>(
      await http.post(`/api/v1/rules/${future.id}/simulate`, { values: { desconto: '50' } }),
      200
    )
    assert.equal(skipped.result, 'SKIPPED')
    const inside = await must<any>(
      await http.post(`/api/v1/rules/${future.id}/simulate`, {
        values: { desconto: '50' },
        now: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      }),
      200
    )
    assert.equal(inside.result, 'FAIL')
  })

  test('uma regra inválida não se cria nem se publica: campos desconhecidos ou sensíveis, variáveis, estrutura, acção, datas', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    const refused = async (body: Record<string, unknown>, expected: string, status = 422) => {
      const response = await http.post('/api/v1/rules', body)
      response.assertStatus(status)
      assert.include(
        response.body().error.details.map((d: any) => d.code),
        expected,
        JSON.stringify(response.body().error.details)
      )
    }
    await refused(newRule({ conditionAst: over('inexistente', '1') }), 'UNKNOWN_FIELD')
    await refused(
      newRule({
        conditionAst: { op: 'eq', left: { var: 'resource.segredo' }, right: { value: 'x' } },
      }),
      'SENSITIVE_FIELD'
    )
    await refused(
      newRule({ conditionAst: { op: 'eq', left: { var: 'env.segredo' }, right: { value: 'x' } } }),
      'INVALID_VARIABLE'
    )
    await refused(newRule({ conditionAst: { op: 'eval', code: 'process.exit()' } }), 'UNKNOWN_OP')
    await refused(
      newRule({ conditionAst: { op: 'eq', left: { var: 'system.env' }, right: { value: 1 } } }),
      'INVALID_VARIABLE'
    )
    // Orçamento: demasiado profundo.
    let deep: any = { op: 'true' }
    for (let i = 0; i < 12; i++) deep = { op: 'not', arg: deep }
    await refused(newRule({ conditionAst: deep }), 'TOO_DEEP')
    await refused(newRule({ actionAst: { type: 'SET_FIELD', message: 'x' } }), 'UNSUPPORTED_ACTION')
    await refused(newRule({ actionAst: block('') }), 'INVALID_MESSAGE')
    await refused(newRule({ actionAst: block('x', 'inexistente') }), 'UNKNOWN_FIELD')
    await refused(newRule({ code: 'Mau Codigo' }), 'INVALID_CODE')
    await refused(newRule({ effectiveFrom: 'amanhã' }), 'INVALID_DATE')
    await refused(
      newRule({ effectiveFrom: '2030-01-02T00:00:00Z', effectiveTo: '2030-01-01T00:00:00Z' }),
      'INVALID_PERIOD'
    )
    await refused(newRule({ priority: 5000 }), 'INVALID_PRIORITY')
    await refused(newRule({ entityCode: 'nao_existe' }), 'NOT_FOUND')
    // Uma entidade por publicar não aceita regras.
    await must(
      await http.post('/api/v1/entity-definitions', { code: 'rascunho', name: 'Rascunho' }),
      201
    )
    await refused(newRule({ entityCode: 'rascunho' }), 'ENTITY_NOT_PUBLISHED')
    // O código é único por entidade.
    await must(await http.post('/api/v1/rules', newRule()), 201)
    const dup = await http.post('/api/v1/rules', newRule())
    dup.assertStatus(409)
    assert.equal(dup.body().error.code, 'RULE_CODE_TAKEN')
  })

  test('conflito de versão ao alterar um rascunho', async ({ client, assert }) => {
    const { http } = await setup(client)
    const rule = await must<any>(await http.post('/api/v1/rules', newRule()), 201)
    await must(
      await http.patch(`/api/v1/rules/${rule.id}`, {
        expectedVersion: rule.version,
        name: 'Novo nome',
      }),
      200
    )
    const stale = await http.patch(`/api/v1/rules/${rule.id}`, {
      expectedVersion: rule.version,
      name: 'Outro',
    })
    stale.assertStatus(409)
    assert.equal(stale.body().error.code, 'VERSION_CONFLICT')
  })

  test('autorização: sem papel nega; rule.read só vê; rule.manage gere; o subject está disponível nas condições', async ({
    client,
    assert,
  }) => {
    const { tenant, http, admin } = await setup(client)
    const operator = await newActor(client, tenant)
    const none = api(client, tenant, operator)
    for (const [method, url] of [
      ['get', '/api/v1/rules'],
      ['post', '/api/v1/rules'],
    ] as const) {
      const response = await (none as any)[method](url, {})
      assert.equal(response.status(), 403, url)
    }
    const reader = await memberWith(client, tenant, http, ['rule.read'])
    ;(await reader.get('/api/v1/rules')).assertStatus(200)
    ;(await reader.post('/api/v1/rules', newRule())).assertStatus(403)
    const manager = await memberWith(client, tenant, http, ['rule.manage'])
    const rule = await must<any>(await manager.post('/api/v1/rules', newRule()), 201)
    ;(await manager.get(`/api/v1/rules/${rule.id}`)).assertStatus(403) // gerir não dá leitura

    // Uma regra pode usar o actor: aqui só o administrador está impedido de aplicar mais de 5 de desconto.
    const personal = await must<any>(
      await http.post(
        '/api/v1/rules',
        newRule({
          code: 'so_admin',
          conditionAst: {
            op: 'and',
            args: [
              {
                op: 'eq',
                left: { var: 'subject.membershipId' },
                right: { value: admin.membershipId },
              },
              over('desconto', '5'),
            ],
          },
          actionAst: block('o administrador não aplica descontos acima de 5'),
        })
      ),
      201
    )
    await must(
      await http.post(`/api/v1/rules/${personal.id}/publish`, {
        expectedVersion: personal.version,
      }),
      200
    )
    ;(await http.post(records, { data: { desconto: '9' } })).assertStatus(422)
    const clerk = await memberWith(client, tenant, http, ['dynamic.create', 'dynamic.read'])
    await must(await clerk.post(records, { data: { desconto: '9' } }), 201)
  })

  test('ids de outro tenant dão 404 e um tenant não vê regras do outro', async ({
    client,
    assert,
  }) => {
    const a = await setup(client)
    const b = await setup(client)
    const rule = await must<any>(await a.http.post('/api/v1/rules', newRule()), 201)
    for (const [method, url, body] of [
      ['get', `/api/v1/rules/${rule.id}`],
      ['get', `/api/v1/rules/${rule.id}/evaluations`],
      ['patch', `/api/v1/rules/${rule.id}`, { expectedVersion: 1, name: 'x' }],
      ['post', `/api/v1/rules/${rule.id}/revisions`, {}],
      ['post', `/api/v1/rules/${rule.id}/simulate`, { values: {} }],
      ['post', `/api/v1/rules/${rule.id}/publish`, { expectedVersion: 1 }],
      ['post', `/api/v1/rules/${rule.id}/disable`, { expectedVersion: 1 }],
    ] as const) {
      const response = await (b.http as any)[method](url, body)
      assert.equal(response.status(), 404, `${method} ${url}`)
    }
    assert.lengthOf((await b.http.get('/api/v1/rules')).body().data, 0)
    // As regras de A não se aplicam aos registos de B (mesmo código de entidade).
    await must(await b.http.post(records, { data: { desconto: '99' } }), 201)
  })
})
