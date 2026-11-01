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

const orderFields = () => [
  { code: 'ref', label: 'Referência', type: 'TEXT', required: true },
  { code: 'qtd', label: 'Quantidade', type: 'NUMBER' },
  { code: 'segredo', label: 'Segredo', type: 'TEXT', sensitive: true },
]

async function publishEntity(http: Http) {
  const draft = await must<Detail>(
    await http.post('/api/v1/entity-definitions', {
      code: 'pedido',
      name: 'Pedido',
      fields: orderFields(),
    }),
    201
  )
  return must<Detail>(
    await http.post(`/api/v1/entity-definitions/${draft.entity.id}/publish`, {
      expectedVersion: draft.entity.version,
    }),
    200
  )
}

const states = () => [
  { code: 'aberto', label: 'Aberto', category: 'INITIAL', color: 'info' },
  { code: 'em_curso', label: 'Em curso', category: 'ACTIVE' },
  { code: 'concluido', label: 'Concluído', category: 'FINAL' },
  { code: 'cancelado', label: 'Cancelado', category: 'CANCELLED' },
]
const transitions = () => [
  { code: 'iniciar', label: 'Iniciar', from: ['aberto'], to: 'em_curso' },
  {
    code: 'concluir',
    label: 'Concluir',
    from: ['em_curso'],
    to: 'concluido',
    guard: { op: 'gt', left: { var: 'resource.qtd' }, right: { value: 0 } },
  },
  {
    code: 'cancelar',
    label: 'Cancelar',
    from: ['aberto', 'em_curso'],
    to: 'cancelado',
    reasonRequired: true,
  },
]
const machine = (extra: Record<string, unknown> = {}) => ({
  entityCode: 'pedido',
  code: 'ciclo',
  name: 'Ciclo do pedido',
  states: states(),
  transitions: transitions(),
  ...extra,
})

async function publishMachine(http: Http, body = machine()) {
  const draft = await must<any>(await http.post('/api/v1/state-machines', body), 201)
  return must<any>(
    await http.post(`/api/v1/state-machines/${draft.id}/publish`, {
      expectedVersion: draft.version,
    }),
    200
  )
}

const records = '/api/v1/dynamic/pedido/records'

/** Linhas de uma tabela de tenant, lidas com a conta dona e o contexto desse tenant. */
const rowsOf = (tenant: Tenant, sql: string) =>
  db.connection('owner').transaction(async (trx) => {
    await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [tenant.id])
    return (await trx.rawQuery(sql)).rows as any[]
  })

const group = (name: string, body: Parameters<typeof test.group>[1]) =>
  test.group(name, (g) => {
    g.setup(async () => {
      await iamServices().syncCatalog.execute()
    })
    g.each.setup(async () => {
      await resetAuthState()
      return async () => {
        await deleteTestTenants()
        await deleteTestUsers()
      }
    })
    return body(g)
  })

group('estados | desenho, validação e imutabilidade', () => {
  test('rascunho → publicação imutável → nova revisão retira a anterior; uma máquina por entidade', async ({
    client,
    assert,
  }) => {
    const { tenant, http } = await setup(client)
    await publishEntity(http)
    const draft = await must<any>(await http.post('/api/v1/state-machines', machine()), 201)
    assert.equal(draft.initialStateCode, 'aberto')
    const preview = await must<any>(
      await http.post(`/api/v1/state-machines/${draft.id}/preview`, {}),
      200
    )
    assert.deepEqual(preview.issues, [])
    const published = await must<any>(
      await http.post(`/api/v1/state-machines/${draft.id}/publish`, {
        expectedVersion: draft.version,
      }),
      200
    )
    assert.equal(published.status, 'PUBLISHED')

    const refused = await http.patch(`/api/v1/state-machines/${draft.id}`, {
      expectedVersion: published.version,
      name: 'Outro',
    })
    refused.assertStatus(409)
    assert.equal(refused.body().error.code, 'STATE_MACHINE_NOT_DRAFT')
    const attempt = (sql: string) =>
      capture(() =>
        db.connection('owner').transaction(async (trx) => {
          await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [tenant.id])
          await trx.rawQuery(sql)
        })
      )
    for (const sql of [
      `update state_machines set name = 'x' where id = '${draft.id}'`,
      `update state_machines set transitions = '[]' where id = '${draft.id}'`,
      `delete from state_machines where id = '${draft.id}'`,
    ]) {
      assert.match((await attempt(sql)).message, /PUBLISHED_STATE_MACHINE_IMMUTABLE/, sql)
    }

    const second = await must<any>(
      await http.post('/api/v1/state-machines', machine({ code: 'outra' })),
      201
    )
    // Só uma máquina em vigor por entidade (com outro código, a publicação retira a anterior).
    await must(
      await http.post(`/api/v1/state-machines/${second.id}/publish`, {
        expectedVersion: second.version,
      }),
      200
    )
    const all = await must<any[]>(await http.get('/api/v1/state-machines?entityCode=pedido'), 200)
    assert.deepEqual(all.map((m) => `${m.code}:${m.status}`).sort(), [
      'ciclo:RETIRED',
      'outra:PUBLISHED',
    ])
  })

  test('a estrutura mal formada e a integridade do grafo são recusadas com o caminho', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    await publishEntity(http)
    const codes = async (body: Record<string, unknown>) => {
      const created = await http.post(
        '/api/v1/state-machines',
        machine({ code: `m_${Math.random().toString(36).slice(2, 8)}`, ...body })
      )
      if (created.status() === 422)
        return created.body().error.details.map((d: any) => `${d.path}:${d.code}`)
      const draft = created.body().data
      const published = await http.post(`/api/v1/state-machines/${draft.id}/publish`, {
        expectedVersion: draft.version,
      })
      published.assertStatus(422)
      return published.body().error.details.map((d: any) => `${d.path}:${d.code}`)
    }
    assert.include(await codes({ states: [] }), 'states:INVALID_STATES')
    assert.include(
      await codes({ states: [{ code: 'a', label: 'A', category: 'INITIAL' }] }),
      'states[0].code:INVALID_CODE'
    )
    assert.include(
      await codes({
        states: [...states(), { code: 'aberto', label: 'Outra vez', category: 'ACTIVE' }],
      }),
      'states[4].code:DUPLICATE_STATE'
    )
    assert.include(
      await codes({
        states: [...states(), { code: 'inicio_2', label: 'Outro', category: 'INITIAL' }],
      }),
      'states:INITIAL_STATE'
    )
    assert.include(
      await codes({ states: states().filter((s) => s.category !== 'INITIAL') }),
      'states:INITIAL_STATE'
    )
    assert.include(
      await codes({
        states: [...states(), { code: 'esquecido', label: 'Esquecido', category: 'ACTIVE' }],
      }),
      'states[4]:UNREACHABLE_STATE'
    )
    assert.include(
      await codes({
        transitions: [
          ...transitions(),
          { code: 'reabrir', label: 'Reabrir', from: ['concluido'], to: 'aberto' },
        ],
      }),
      'transitions[3].from:TRANSITION_FROM_FINAL'
    )
    assert.include(
      await codes({
        transitions: [{ code: 'x_y', label: 'X', from: ['aberto'], to: 'nao_existe' }],
      }),
      'transitions[0].to:UNKNOWN_STATE'
    )
    assert.include(
      await codes({
        transitions: [
          { code: 'voltar', label: 'Voltar', from: ['em_curso'], to: 'aberto' },
          ...transitions(),
        ],
      }),
      'transitions[0].to:TRANSITION_TO_INITIAL'
    )
    assert.include(
      await codes({ transitions: [...transitions(), { ...transitions()[0], label: 'Repetida' }] }),
      'transitions[3].code:DUPLICATE_TRANSITION'
    )
    assert.include(
      await codes({
        transitions: transitions().map((t) =>
          t.code === 'concluir' ? { ...t, permission: 'inventada.permissao' } : t
        ),
      }),
      'transitions[1].permission:UNKNOWN_PERMISSION'
    )
    assert.include(
      await codes({
        transitions: transitions().map((t) =>
          t.code === 'concluir'
            ? {
                ...t,
                guard: { op: 'eq', left: { var: 'resource.segredo' }, right: { value: 'x' } },
              }
            : t
        ),
      }),
      'transitions[1].guard:UNKNOWN_FIELD'
    )
    assert.include(
      await codes({
        transitions: transitions().map((t) =>
          t.code === 'concluir' ? { ...t, guard: { op: 'eval', code: 'process.exit()' } } : t
        ),
      }),
      'transitions[1].guard:UNKNOWN_OP'
    )
  })

  test('a entidade tem de estar publicada; não se retira um estado em uso por registos', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    await must(
      await http.post('/api/v1/entity-definitions', {
        code: 'pedido',
        name: 'Pedido',
        fields: orderFields(),
      }),
      201
    )
    const unpublished = await http.post('/api/v1/state-machines', machine())
    unpublished.assertStatus(422)
    assert.equal(unpublished.body().error.details[0].code, 'ENTITY_NOT_PUBLISHED')
  })
})

group('estados | registos e transições', () => {
  test('o registo nasce no estado inicial; os anteriores à máquina ficam sem estado', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    await publishEntity(http)
    const before = await must<any>(await http.post(records, { data: { ref: 'P0' } }), 201)
    assert.isNull(before.state)
    await publishMachine(http)
    const created = await must<any>(await http.post(records, { data: { ref: 'P1', qtd: 2 } }), 201)
    assert.deepInclude(created.state, {
      code: 'aberto',
      label: 'Aberto',
      category: 'INITIAL',
      editable: true,
      color: 'info',
    })
    assert.equal(created.state.version, 1)
    const listed = await must<any[]>(await http.get(records), 200)
    assert.deepEqual(listed.map((r) => [r.data.ref, r.state?.code ?? null]).sort(), [
      ['P0', null],
      ['P1', 'aberto'],
    ])
    const stuck = await http.get(`${records}/${before.id}/available-actions`)
    stuck.assertStatus(409)
    assert.equal(stuck.body().error.code, 'RECORD_WITHOUT_STATE')
  })

  test('acções disponíveis, transição com estado, histórico e evento na mesma transacção', async ({
    client,
    assert,
  }) => {
    const { tenant, http, admin } = await setup(client)
    await publishEntity(http)
    await publishMachine(http)
    const record = await must<any>(await http.post(records, { data: { ref: 'P1', qtd: 0 } }), 201)
    const base = `${records}/${record.id}`

    const first = await must<any>(await http.get(`${base}/available-actions`), 200)
    assert.deepEqual(first.state, { code: 'aberto', label: 'Aberto', version: 1 })
    assert.deepEqual(
      first.actions.map((a: any) => [a.code, a.reasonRequired]),
      [
        ['iniciar', false],
        ['cancelar', true],
      ]
    )

    // Transição inexistente a partir deste estado: 409.
    const wrong = await http.post(`${base}/transitions/concluir`, { expectedVersion: 1 })
    wrong.assertStatus(409)
    assert.equal(wrong.body().error.code, 'TRANSITION_NOT_AVAILABLE')
    // Versão desactualizada: 409.
    ;(await http.post(`${base}/transitions/iniciar`, { expectedVersion: 7 })).assertStatus(409)
    // Falhou: nada se escreveu.
    assert.lengthOf(
      await rowsOf(
        tenant,
        "select 1 from outbox_events where event_type = 'dynamic.record.state_changed'"
      ),
      0
    )

    const moved = await must<any>(
      await http.post(`${base}/transitions/iniciar`, { expectedVersion: 1 }),
      200
    )
    assert.deepInclude(moved, { fromState: 'aberto', toState: 'em_curso', version: 2 })
    assert.equal((await must<any>(await http.get(base), 200)).state.code, 'em_curso')

    // A guarda avalia os dados actuais: com qtd = 0 não conclui; depois de alterar, sim.
    const guard = await http.post(`${base}/transitions/concluir`, { expectedVersion: 2 })
    guard.assertStatus(409)
    assert.equal(guard.body().error.code, 'TRANSITION_GUARD_FAILED')
    assert.notInclude(
      (await must<any>(await http.get(`${base}/available-actions`), 200)).actions.map(
        (a: any) => a.code
      ),
      'concluir'
    )
    const current = await must<any>(await http.get(base), 200)
    await must(await http.patch(base, { expectedVersion: current.version, data: { qtd: 3 } }), 200)
    assert.include(
      (await must<any>(await http.get(`${base}/available-actions`), 200)).actions.map(
        (a: any) => a.code
      ),
      'concluir'
    )

    // O motivo obrigatório.
    const noReason = await http.post(`${base}/transitions/cancelar`, { expectedVersion: 2 })
    noReason.assertStatus(422)
    assert.equal(noReason.body().error.details[0].code, 'REASON_REQUIRED')

    const done = await must<any>(
      await http.post(`${base}/transitions/concluir`, { expectedVersion: 2 }),
      200
    )
    assert.equal(done.version, 3)
    // Estado final: sem acções e sem alterações de valores.
    assert.lengthOf((await must<any>(await http.get(`${base}/available-actions`), 200)).actions, 0)
    const locked = await http.patch(base, {
      expectedVersion: (await must<any>(await http.get(base), 200)).version,
      data: { qtd: 9 },
    })
    locked.assertStatus(409)
    assert.equal(locked.body().error.code, 'RECORD_STATE_LOCKED')
    assert.isFalse((await must<any>(await http.get(base), 200)).state.editable)
    // O estado nunca se altera por PATCH genérico: não existe nenhum campo «status» a escrever.
    const fresh = await must<any>(await http.post(records, { data: { ref: 'P2' } }), 201)
    const direct = await http.patch(`${records}/${fresh.id}`, {
      expectedVersion: fresh.version,
      data: { status: 'concluido' },
    })
    direct.assertStatus(422)
    assert.equal(direct.body().error.details[0].code, 'UNKNOWN_FIELD')

    const history = await must<any[]>(await http.get(`${base}/state-history`), 200)
    assert.deepEqual(
      history.map((h) => [h.transitionCode, h.fromState, h.toState]),
      [
        [null, null, 'aberto'],
        ['iniciar', 'aberto', 'em_curso'],
        ['concluir', 'em_curso', 'concluido'],
      ]
    )
    assert.equal(history[1].actorMembershipId, admin.membershipId)

    const events = await rowsOf(
      tenant,
      'select aggregate_id, aggregate_version, status, payload from outbox_events order by aggregate_version'
    )
    assert.deepEqual(
      events.map((e) => [e.aggregate_id, e.aggregate_version, e.status]),
      [
        [record.id, 2, 'PENDING'],
        [record.id, 3, 'PENDING'],
      ]
    )
    assert.deepInclude(events[0].payload, {
      transition: 'iniciar',
      fromState: 'aberto',
      toState: 'em_curso',
    })
    // O histórico e o estado só se acrescentam/alteram pelo caso de uso.
    const forbidden = await capture(() =>
      db.connection('owner').transaction(async (trx) => {
        await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [tenant.id])
        await trx.rawQuery("update state_history set to_state = 'x'")
      })
    )
    assert.match(forbidden.message, /imut/i)
  })

  test('dois comandos concorrentes com a mesma versão: só um executa', async ({
    client,
    assert,
  }) => {
    const { tenant, http } = await setup(client)
    await publishEntity(http)
    await publishMachine(http)
    const record = await must<any>(await http.post(records, { data: { ref: 'P1' } }), 201)
    const base = `${records}/${record.id}`
    const results = await Promise.all([
      http.post(`${base}/transitions/iniciar`, { expectedVersion: 1 }),
      http.post(`${base}/transitions/cancelar`, { expectedVersion: 1, reason: 'duplicado' }),
    ])
    const statuses = results.map((r) => r.status()).sort()
    assert.deepEqual(statuses, [200, 409])
    assert.lengthOf(
      await rowsOf(tenant, 'select 1 from state_history where transition_code is not null'),
      1
    )
    assert.lengthOf(await rowsOf(tenant, 'select 1 from outbox_events'), 1)
  })

  test('uma nova revisão mantém os estados em uso; um estado em uso não desaparece', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    await publishEntity(http)
    const v1 = await publishMachine(http)
    const record = await must<any>(await http.post(records, { data: { ref: 'P1' } }), 201)
    await must(
      await http.post(`${records}/${record.id}/transitions/iniciar`, { expectedVersion: 1 }),
      200
    )

    const revision = await must<any>(
      await http.post(`/api/v1/state-machines/${v1.id}/revisions`, {}),
      201
    )
    ;(await http.post(`/api/v1/state-machines/${v1.id}/revisions`, {})).assertStatus(409)
    // Retirar «em_curso» (em uso) é recusado.
    const dropped = await must<any>(
      await http.patch(`/api/v1/state-machines/${revision.id}`, {
        expectedVersion: revision.version,
        states: states().filter((s) => s.code !== 'em_curso'),
        transitions: [
          { code: 'cancelar', label: 'Cancelar', from: ['aberto'], to: 'cancelado' },
          { code: 'concluir', label: 'Concluir', from: ['aberto'], to: 'concluido' },
        ],
      }),
      200
    )
    const refused = await http.post(`/api/v1/state-machines/${revision.id}/publish`, {
      expectedVersion: dropped.version,
    })
    refused.assertStatus(409)
    assert.equal(refused.body().error.code, 'STATE_IN_USE')

    // Mantendo-o (e acrescentando um estado novo com as suas transições), publica e o registo segue com a nova revisão.
    const fixed = await must<any>(
      await http.patch(`/api/v1/state-machines/${revision.id}`, {
        expectedVersion: dropped.version,
        states: [...states(), { code: 'em_espera', label: 'Em espera', category: 'ACTIVE' }],
        transitions: [
          ...transitions(),
          { code: 'pausar', label: 'Pausar', from: ['em_curso'], to: 'em_espera' },
          { code: 'retomar', label: 'Retomar', from: ['em_espera'], to: 'em_curso' },
        ],
      }),
      200
    )
    await must(
      await http.post(`/api/v1/state-machines/${revision.id}/publish`, {
        expectedVersion: fixed.version,
      }),
      200
    )
    const actions = await must<any>(
      await http.get(`${records}/${record.id}/available-actions`),
      200
    )
    // «concluir» exige qtd > 0 (o registo não a tem); a nova transição «pausar» já existe para o registo em curso.
    assert.deepEqual(
      actions.actions.map((a: any) => a.code),
      ['cancelar', 'pausar']
    )
  })
})

group('estados | autorização', () => {
  test('dynamic.transition, a permissão da transição e as políticas ABAC por estado', async ({
    client,
    assert,
  }) => {
    const { tenant, http } = await setup(client)
    await publishEntity(http)
    await publishMachine(
      http,
      machine({
        transitions: transitions().map((t) =>
          t.code === 'iniciar' ? { ...t, permission: 'audit.read' } : t
        ),
      })
    )
    const record = await must<any>(await http.post(records, { data: { ref: 'P1' } }), 201)
    const base = `${records}/${record.id}`

    const reader = await memberWith(client, tenant, http, ['dynamic.read'])
    assert.lengthOf(
      (await must<any>(await reader.http.get(`${base}/available-actions`), 200)).actions,
      0
    )
    ;(await reader.http.post(`${base}/transitions/iniciar`, { expectedVersion: 1 })).assertStatus(
      403
    )

    const mover = await memberWith(client, tenant, http, ['dynamic.read', 'dynamic.transition'])
    // Sem a permissão própria da transição («iniciar» exige audit.read) só vê «cancelar».
    assert.deepEqual(
      (await must<any>(await mover.http.get(`${base}/available-actions`), 200)).actions.map(
        (a: any) => a.code
      ),
      ['cancelar']
    )
    ;(await mover.http.post(`${base}/transitions/iniciar`, { expectedVersion: 1 })).assertStatus(
      403
    )

    const both = await memberWith(client, tenant, http, [
      'dynamic.read',
      'dynamic.transition',
      'audit.read',
    ])
    assert.deepEqual(
      (await must<any>(await both.http.get(`${base}/available-actions`), 200)).actions.map(
        (a: any) => a.code
      ),
      ['iniciar', 'cancelar']
    )

    // ABAC: negar `dynamic.transition` quando o registo está em «aberto».
    await must(
      await http.post('/api/v1/access-policies', {
        name: 'Abertos não se movem',
        resource: 'dynamic',
        action: 'transition',
        effect: 'DENY',
        status: 'ACTIVE',
        condition: { op: 'eq', left: { var: 'resource.state' }, right: { value: 'aberto' } },
      }),
      201
    )
    ;(await both.http.post(`${base}/transitions/iniciar`, { expectedVersion: 1 })).assertStatus(403)
    assert.lengthOf(
      (await must<any>(await both.http.get(`${base}/available-actions`), 200)).actions,
      0
    )
    // A leitura do histórico exige dynamic.read; sem permissões nada se vê.
    const none = await memberWith(client, tenant, http, [])
    ;(await none.http.get(`${base}/state-history`)).assertStatus(403)
    ;(await none.http.get('/api/v1/state-machines')).assertStatus(403)
    const designer = await memberWith(client, tenant, http, ['state.read', 'state.design'])
    const draft = await must<any>(
      await designer.http.post('/api/v1/state-machines', machine({ code: 'nova' })),
      201
    )
    ;(
      await designer.http.post(`/api/v1/state-machines/${draft.id}/publish`, {
        expectedVersion: draft.version,
      })
    ).assertStatus(403)
  })
})
