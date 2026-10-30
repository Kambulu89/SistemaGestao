import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { iamServices } from '#core/permissions/index'
import { deleteTestUsers, resetAuthState } from '#tests/support/auth_fixture'
import { createActiveTenant, deleteTestTenants } from '#tests/support/membership_fixture'
import { api, newActor } from '#tests/support/api_fixture'
import { automationServices } from '#dynamic/automations/index'
import { ChangeTenantStatus, LucidTenantStore, type Tenant } from '#platform/tenants/index'

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
  return { tenant, admin, http: api(client, tenant, admin), client }
}

const random = () => Math.random().toString(36).slice(2, 10)

async function publishEntity(http: Http) {
  const draft = await must<any>(
    await http.post('/api/v1/entity-definitions', {
      code: 'pedido',
      name: 'Pedido',
      fields: [
        { code: 'ref', label: 'Referência', type: 'TEXT', required: true },
        { code: 'qtd', label: 'Quantidade', type: 'NUMBER' },
      ],
    }),
    201
  )
  await must(
    await http.post(`/api/v1/entity-definitions/${draft.entity.id}/publish`, {
      expectedVersion: draft.entity.version,
    }),
    200
  )
}

async function publishMachine(http: Http, states: unknown[], transitions: unknown[]) {
  const draft = await must<any>(
    await http.post('/api/v1/state-machines', {
      entityCode: 'pedido',
      code: 'ciclo',
      name: 'Ciclo',
      states,
      transitions,
    }),
    201
  )
  await must(
    await http.post(`/api/v1/state-machines/${draft.id}/publish`, {
      expectedVersion: draft.version,
    }),
    200
  )
}

/** aberto → em_curso → concluido (e cancelado), o ciclo mais simples. */
const simpleMachine = (http: Http) =>
  publishMachine(
    http,
    [
      { code: 'aberto', label: 'Aberto', category: 'INITIAL' },
      { code: 'em_curso', label: 'Em curso', category: 'ACTIVE' },
      { code: 'concluido', label: 'Concluído', category: 'FINAL' },
    ],
    [
      { code: 'iniciar', label: 'Iniciar', from: ['aberto'], to: 'em_curso' },
      { code: 'concluir', label: 'Concluir', from: ['em_curso'], to: 'concluido' },
    ]
  )

const records = '/api/v1/dynamic/pedido/records'
const newRecord = (http: Http, ref = `P${random()}`) =>
  http.post(records, { data: { ref, qtd: 1 } }).then((r) => must<any>(r, 201))
const transition = (http: Http, recordId: string, code: string, expectedVersion: number) =>
  http.post(`${records}/${recordId}/transitions/${code}`, { expectedVersion })
const stateOf = async (http: Http, recordId: string) =>
  (await must<any>(await http.get(`${records}/${recordId}`), 200)).state.code as string

const rowsOf = (tenant: Tenant, sql: string) =>
  db.connection('owner').transaction(async (trx) => {
    await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [tenant.id])
    return (await trx.rawQuery(sql)).rows as any[]
  })

/** Corre o motor até já não haver nada para despachar nem executar (as falhas esperam o recuo). */
async function drain(tenant: Tenant) {
  let total = 0
  for (let i = 0; i < 30; i++) {
    const r = await automationServices().engine.processTenant(tenant.id)
    const work = r.dispatched + r.scheduled + r.executed
    total += work
    // Os eventos entregues nesta volta só se despacham na seguinte: continua enquanto houver trabalho.
    if (r.dispatched === 0 && r.scheduled === 0 && r.executed === 0) return total
  }
  throw new Error('O motor não estabilizou: provável ciclo sem fim.')
}

const onStateChange = (code: string, toState: string, actions: unknown[], extra = {}) => ({
  code,
  name: code,
  eventType: 'dynamic.record.state_changed',
  condition: { op: 'eq', left: { var: 'resource.toState' }, right: { value: toState } },
  actions,
  ...extra,
})
const doTransition = (transitionCode: string) => ({
  type: 'dynamic.record.transition',
  params: {
    entityCode: 'pedido',
    recordId: { from: 'payload.recordId' },
    transition: transitionCode,
  },
})

async function activate(http: Http, body: Record<string, unknown>) {
  const draft = await must<any>(await http.post('/api/v1/automations', body), 201)
  return must<any>(
    await http.post(`/api/v1/automations/${draft.id}/activate`, { expectedVersion: draft.version }),
    200
  )
}

const runsOf = (tenant: Tenant) =>
  rowsOf(
    tenant,
    `select r.status, r.error_code, r.depth, r.attempts, r.progress, a.code as automation
       from automation_runs r join automations a on a.id = r.automation_id order by r.created_at, r.id`
  )

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

group('automações | definição e activação', () => {
  test('o catálogo vem dos módulos; a definição é validada contra ele', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    await publishEntity(http)
    const catalog = await must<any>(await http.get('/api/v1/automations/catalog'), 200)
    assert.include(
      catalog.events.map((e: any) => e.type),
      'dynamic.record.state_changed'
    )
    assert.include(
      catalog.events.map((e: any) => e.type),
      'workflow.instance.approved'
    )
    assert.sameMembers(
      catalog.actions.map((a: any) => a.type),
      ['dynamic.record.transition', 'workflow.submit']
    )

    const codes = async (body: Record<string, unknown>) => {
      const created = await http.post('/api/v1/automations', {
        code: `a_${random()}`,
        name: 'x',
        actions: [doTransition('concluir')],
        eventType: 'dynamic.record.state_changed',
        ...body,
      })
      if (created.status() === 422) return created.body().error.details.map((d: any) => d.code)
      const draft = created.body().data
      const activated = await http.post(`/api/v1/automations/${draft.id}/activate`, {
        expectedVersion: draft.version,
      })
      activated.assertStatus(422)
      return activated.body().error.details.map((d: any) => `${d.path}:${d.code}`)
    }
    assert.include(await codes({ eventType: null }), 'TRIGGER_EXACTLY_ONE')
    assert.include(await codes({ schedule: '0 9 * * *' }), 'TRIGGER_EXACTLY_ONE')
    assert.include(await codes({ eventType: 'nao.existe' }), 'eventType:UNKNOWN_EVENT_TYPE')
    assert.include(
      await codes({ actions: [{ type: 'apagar.tudo', params: {} }] }),
      'actions[0].type:UNKNOWN_ACTION'
    )
    assert.include(
      await codes({
        actions: [{ type: 'dynamic.record.transition', params: { entityCode: 'pedido' } }],
      }),
      'actions[0].params.recordId:PARAM_REQUIRED'
    )
    assert.include(
      await codes({
        actions: [
          {
            type: 'dynamic.record.transition',
            params: {
              entityCode: 'pedido',
              recordId: { from: 'payload.inexistente' },
              transition: 'x_y',
            },
          },
        ],
      }),
      'actions[0].params:UNKNOWN_REFERENCE'
    )
    assert.include(
      await codes({
        condition: { op: 'eq', left: { var: 'resource.segredo' }, right: { value: 'x' } },
      }),
      'condition:UNKNOWN_FIELD'
    )
    assert.include(
      await codes({ condition: { op: 'eval', code: 'process.exit()' } }),
      'condition.:UNKNOWN_OP'.replace('.:', ':')
    )
    assert.include(await codes({ eventType: null, schedule: '* * * * *' }), 'SCHEDULE_TOO_FREQUENT')
    assert.include(
      await codes({ eventType: null, schedule: '0 9 * * *', timezone: 'Marte/Olimpo' }),
      'INVALID_TIMEZONE'
    )
  })

  test('activar fixa o membro; uma activa não se altera; pausar bloqueia; o código é único', async ({
    client,
    assert,
  }) => {
    const { http, admin } = await setup(client)
    await publishEntity(http)
    const body = onStateChange('concluir_auto', 'em_curso', [doTransition('concluir')])
    const draft = await must<any>(await http.post('/api/v1/automations', body), 201)
    assert.equal(draft.status, 'DRAFT')
    assert.isNull(draft.runAsMembershipId)
    ;(await http.post('/api/v1/automations', body)).assertStatus(409)

    const active = await must<any>(
      await http.post(`/api/v1/automations/${draft.id}/activate`, {
        expectedVersion: draft.version,
      }),
      200
    )
    assert.equal(active.status, 'ACTIVE')
    assert.equal(active.runAsMembershipId, admin.membershipId)
    assert.isNotNull(active.activatedAt)

    const blocked = await http.patch(`/api/v1/automations/${draft.id}`, {
      expectedVersion: active.version,
      name: 'Outro',
    })
    blocked.assertStatus(409)
    assert.equal(blocked.body().error.code, 'AUTOMATION_ACTIVE')

    const paused = await must<any>(
      await http.post(`/api/v1/automations/${draft.id}/pause`, { expectedVersion: active.version }),
      200
    )
    assert.equal(paused.status, 'PAUSED')
    const renamed = await must<any>(
      await http.patch(`/api/v1/automations/${draft.id}`, {
        expectedVersion: paused.version,
        name: 'Outro nome',
      }),
      200
    )
    assert.equal(renamed.name, 'Outro nome')
    assert.equal(renamed.version, paused.version + 1, 'cada alteração é uma nova versão')
  })

  test('simular avalia a condição e resolve as acções sem executar nada', async ({
    client,
    assert,
  }) => {
    const { http, tenant } = await setup(client)
    await publishEntity(http)
    const draft = await must<any>(
      await http.post(
        '/api/v1/automations',
        onStateChange('sim', 'em_curso', [doTransition('concluir')])
      ),
      201
    )
    const hit = await must<any>(
      await http.post(`/api/v1/automations/${draft.id}/simulate`, {
        payload: { toState: 'em_curso', recordId: 'r-1' },
      }),
      200
    )
    assert.isTrue(hit.conditionPassed)
    assert.deepEqual(hit.actions[0].params, {
      entityCode: 'pedido',
      recordId: 'r-1',
      transition: 'concluir',
    })
    const miss = await must<any>(
      await http.post(`/api/v1/automations/${draft.id}/simulate`, {
        payload: { toState: 'aberto', recordId: 'r-1' },
      }),
      200
    )
    assert.isFalse(miss.conditionPassed)
    const broken = await must<any>(
      await http.post(`/api/v1/automations/${draft.id}/simulate`, {
        payload: { toState: 'em_curso' },
      }),
      200
    )
    assert.match(broken.actions[0].error, /recordId/)
    assert.lengthOf(await runsOf(tenant), 0, 'simular nunca cria execuções')
  })
})

group('automações | eventos, causalidade e deduplicação', () => {
  test('um evento dispara a acção em nome de quem activou; o evento duplicado não repete', async ({
    client,
    assert,
  }) => {
    const { http, tenant, admin } = await setup(client)
    await publishEntity(http)
    await simpleMachine(http)
    await activate(http, onStateChange('concluir_auto', 'em_curso', [doTransition('concluir')]))

    const record = await newRecord(http)
    await must(await transition(http, record.id, 'iniciar', 1), 200)
    await drain(tenant)

    assert.equal(await stateOf(http, record.id), 'concluido', 'a automação concluiu o registo')
    const runs = await runsOf(tenant)
    assert.deepEqual(
      runs.map((r) => [r.automation, r.status, r.depth, r.progress]),
      [['concluir_auto', 'SUCCEEDED', 1, 1]]
    )
    const history = await must<any[]>(await http.get(`${records}/${record.id}/state-history`), 200)
    assert.equal(history.at(-1).transitionCode, 'concluir')
    assert.equal(history.at(-1).actorMembershipId, admin.membershipId, 'em nome de quem activou')

    // O evento que a acção produziu leva a causalidade.
    const events = await rowsOf(
      tenant,
      `select causation_run_id, causation_depth, payload->>'toState' as to_state from outbox_events
        where event_type = 'dynamic.record.state_changed' order by created_at, id`
    )
    assert.deepEqual(
      events.map((e) => [e.to_state, e.causation_depth]),
      [
        ['em_curso', 0],
        ['concluido', 1],
      ]
    )
    assert.isNull(events[0].causation_run_id)
    assert.isNotNull(events[1].causation_run_id)

    // Entregar de novo o mesmo evento (replay) não cria uma segunda execução.
    await db.connection('owner').transaction(async (trx) => {
      await trx.rawQuery(
        "select set_config('app.tenant_id', ?, true), set_config('app.audit_purge', 'on', true)",
        [tenant.id]
      )
      await trx.rawQuery('delete from outbox_deliveries')
    })
    await drain(tenant)
    assert.lengthOf(await runsOf(tenant), 1)
  })

  test('uma condição falsa não cria execução; eventos anteriores à activação são ignorados', async ({
    client,
    assert,
  }) => {
    const { http, tenant } = await setup(client)
    await publishEntity(http)
    await simpleMachine(http)
    const early = await newRecord(http)
    await must(await transition(http, early.id, 'iniciar', 1), 200)

    await activate(http, onStateChange('concluir_auto', 'concluido', [doTransition('concluir')]))
    await drain(tenant)
    assert.lengthOf(await runsOf(tenant), 0, 'o evento anterior à activação não conta')
    const late = await newRecord(http)
    await must(await transition(http, late.id, 'iniciar', 1), 200)
    await drain(tenant)
    assert.lengthOf(await runsOf(tenant), 0, 'toState = em_curso não é o que a automação quer')
    assert.equal(await stateOf(http, late.id), 'em_curso')
  })

  test('um ciclo A→B→A é interrompido pela profundidade da cadeia', async ({ client, assert }) => {
    const { http, tenant } = await setup(client)
    await publishEntity(http)
    await publishMachine(
      http,
      [
        { code: 'inicio', label: 'Início', category: 'INITIAL' },
        { code: 'est_a', label: 'A', category: 'ACTIVE' },
        { code: 'est_b', label: 'B', category: 'ACTIVE' },
      ],
      [
        { code: 'entrar_a', label: 'Entrar em A', from: ['inicio', 'est_b'], to: 'est_a' },
        { code: 'entrar_b', label: 'Entrar em B', from: ['est_a'], to: 'est_b' },
      ]
    )
    await activate(http, onStateChange('de_a_para_b', 'est_a', [doTransition('entrar_b')]))
    await activate(http, onStateChange('de_b_para_a', 'est_b', [doTransition('entrar_a')]))

    const record = await newRecord(http)
    await must(await transition(http, record.id, 'entrar_a', 1), 200)
    await drain(tenant)

    const runs = await runsOf(tenant)
    assert.deepEqual(
      runs.map((r) => [r.automation, r.depth, r.status, r.error_code]),
      [
        ['de_a_para_b', 1, 'SUCCEEDED', null],
        ['de_b_para_a', 2, 'SUCCEEDED', null],
        ['de_a_para_b', 3, 'SUCCEEDED', null],
        ['de_b_para_a', 4, 'SUCCEEDED', null],
        ['de_a_para_b', 5, 'DEAD', 'CAUSALITY_DEPTH'],
      ]
    )
    // Nada mais acontece: o motor está parado e o registo ficou onde o ciclo parou.
    assert.equal(await drain(tenant), 0)
    assert.equal(await stateOf(http, record.id), 'est_a')
    // Uma execução fechada pelo motor não se reprocessa.
    const dead = await must<any[]>(await http.get('/api/v1/automation-runs?status=DEAD'), 200)
    const retry = await http.post(`/api/v1/automation-runs/${dead[0].id}/retry`, {
      expectedVersion: dead[0].version,
    })
    retry.assertStatus(409)
    assert.equal(retry.body().error.code, 'RUN_BLOCKED_BY_RULE')
  })

  test('uma automação não reage ao evento que ela própria causou', async ({ client, assert }) => {
    const { http, tenant } = await setup(client)
    await publishEntity(http)
    await publishMachine(
      http,
      [
        { code: 'inicio', label: 'Início', category: 'INITIAL' },
        { code: 'est_a', label: 'A', category: 'ACTIVE' },
        { code: 'est_b', label: 'B', category: 'ACTIVE' },
      ],
      [
        { code: 'entrar_a', label: 'Entrar em A', from: ['inicio'], to: 'est_a' },
        { code: 'entrar_b', label: 'Entrar em B', from: ['est_a'], to: 'est_b' },
        { code: 'voltar_a', label: 'Voltar a A', from: ['est_b'], to: 'est_a' },
      ]
    )
    // Reage a qualquer mudança de estado e muda de estado: o segundo evento é dela.
    await activate(http, {
      code: 'sempre',
      name: 'sempre',
      eventType: 'dynamic.record.state_changed',
      actions: [doTransition('entrar_b')],
    })
    const record = await newRecord(http)
    await must(await transition(http, record.id, 'entrar_a', 1), 200)
    await drain(tenant)
    const runs = await runsOf(tenant)
    assert.deepEqual(
      runs.map((r) => [r.status, r.error_code]),
      [
        ['SUCCEEDED', null],
        ['DEAD', 'CAUSALITY_LOOP'],
      ]
    )
  })

  test('o limite de execuções por hora fecha as que excedem', async ({ client, assert }) => {
    const { http, tenant } = await setup(client)
    await publishEntity(http)
    await simpleMachine(http)
    await activate(http, {
      ...onStateChange('limitada', 'em_curso', [doTransition('concluir')]),
      maxRunsPerPeriod: 2,
    })
    for (let i = 0; i < 3; i++) {
      const record = await newRecord(http)
      await must(await transition(http, record.id, 'iniciar', 1), 200)
    }
    await drain(tenant)
    const runs = await runsOf(tenant)
    assert.deepEqual(runs.map((r) => r.status).sort(), ['DEAD', 'SUCCEEDED', 'SUCCEEDED'])
    assert.equal(runs.find((r) => r.status === 'DEAD').error_code, 'PERIOD_LIMIT')
  })

  test('pausar bloqueia novas execuções e fecha as pendentes, sem apagar o histórico', async ({
    client,
    assert,
  }) => {
    const { http, tenant } = await setup(client)
    await publishEntity(http)
    await simpleMachine(http)
    const active = await activate(
      http,
      onStateChange('concluir_auto', 'em_curso', [doTransition('concluir')])
    )
    const first = await newRecord(http)
    await must(await transition(http, first.id, 'iniciar', 1), 200)
    // Despacha mas não executa: fica uma execução pendente.
    await automationServices().engine.dispatchEvents(
      (await import('#core/tenancy/index')).serviceTenantContext(tenant.id, 'teste')
    )
    assert.deepEqual(
      (await runsOf(tenant)).map((r) => r.status),
      ['PENDING']
    )

    await must(
      await http.post(`/api/v1/automations/${active.id}/pause`, {
        expectedVersion: active.version,
      }),
      200
    )
    await drain(tenant)
    const runs = await runsOf(tenant)
    assert.deepEqual(
      runs.map((r) => [r.status, r.error_code]),
      [['DEAD', 'AUTOMATION_NOT_ACTIVE']]
    )
    assert.equal(await stateOf(http, first.id), 'em_curso', 'nada executou')

    const second = await newRecord(http)
    await must(await transition(http, second.id, 'iniciar', 1), 200)
    await drain(tenant)
    assert.lengthOf(await runsOf(tenant), 1, 'pausada não cria execuções')
  })
})

group('automações | falhas, tenant e permissões', () => {
  test('falha → recuo → fila de falhas → reprocessamento auditado que retoma a seguir à última acção', async ({
    client,
    assert,
  }) => {
    const { http, tenant, admin } = await setup(client)
    await publishEntity(http)
    await simpleMachine(http)
    // 1.ª acção: iniciar o registo (aberto → em_curso); 2.ª acção: uma transição que não existe a partir daí.
    const auto = await activate(http, {
      code: 'duas_accoes',
      name: 'duas',
      eventType: 'dynamic.record.state_changed',
      condition: { op: 'eq', left: { var: 'resource.toState' }, right: { value: 'aberto' } },
      actions: [doTransition('iniciar'), doTransition('inventada')],
    })
    // Criar um registo não emite evento (só as transições emitem): escreve-se no outbox o evento «toState = aberto».
    const record = await newRecord(http)
    await db.connection('owner').transaction(async (trx) => {
      await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [tenant.id])
      await trx.rawQuery(
        `insert into outbox_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, payload)
         values (?, 'dynamic_record', ?, 1, 'dynamic.record.state_changed', ?::jsonb)`,
        [
          tenant.id,
          record.id,
          JSON.stringify({ recordId: record.id, toState: 'aberto', entityCode: 'pedido' }),
        ]
      )
    })
    await drain(tenant)

    let [run] = await runsOf(tenant)
    assert.equal(run.status, 'PENDING', 'a falha agenda nova tentativa')
    assert.equal(run.attempts, 1)
    assert.equal(run.progress, 1, 'a primeira acção ficou concluída')
    assert.equal(run.error_code, 'ACTION_FAILED')
    assert.equal(await stateOf(http, record.id), 'em_curso')

    // Cada tentativa espera o recuo; forçado aqui até esgotar as tentativas.
    for (let attempt = 2; attempt <= 5; attempt++) {
      await db.connection('owner').transaction(async (trx) => {
        await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [tenant.id])
        await trx.rawQuery(
          "update automation_runs set next_attempt_at = now() - interval '1 second' where status = 'PENDING'"
        )
      })
      await automationServices().engine.processTenant(tenant.id)
    }
    ;[run] = await runsOf(tenant)
    assert.deepInclude(run, { status: 'DEAD', attempts: 5, progress: 1 })

    // A 1.ª acção não se repete ao reprocessar: o registo já está em curso e a 2.ª continua a falhar.
    const dead = (await must<any[]>(await http.get('/api/v1/automation-runs?status=DEAD'), 200))[0]
    assert.equal(dead.errorCode, 'ACTION_FAILED')
    const requeued = await must<any>(
      await http.post(`/api/v1/automation-runs/${dead.id}/retry`, {
        expectedVersion: dead.version,
      }),
      200
    )
    assert.deepInclude(requeued, {
      status: 'PENDING',
      attempts: 0,
      progress: 1,
      retriedByMembershipId: admin.membershipId,
    })
    assert.isNotNull(requeued.retriedAt)
    await automationServices().engine.processTenant(tenant.id)
    ;[run] = await runsOf(tenant)
    assert.equal(run.attempts, 1)
    const history = await must<any[]>(await http.get(`${records}/${record.id}/state-history`), 200)
    assert.equal(
      history.filter((h) => h.transitionCode === 'iniciar').length,
      1,
      'iniciar só correu uma vez'
    )

    // O reprocessamento fica na auditoria.
    const audit = await rowsOf(
      tenant,
      `select count(*)::int as n from audit_logs where resource_type = 'automation_runs' and resource_id = '${dead.id}'`
    )
    assert.isAbove(audit[0].n, 1)
    assert.equal(auto.status, 'ACTIVE')
  })

  test('um tenant suspenso não executa; ao reactivar, a execução prossegue', async ({
    client,
    assert,
  }) => {
    const { http, tenant } = await setup(client)
    await publishEntity(http)
    await simpleMachine(http)
    await activate(http, onStateChange('concluir_auto', 'em_curso', [doTransition('concluir')]))
    const record = await newRecord(http)
    await must(await transition(http, record.id, 'iniciar', 1), 200)
    await automationServices().engine.dispatchEvents(
      (await import('#core/tenancy/index')).serviceTenantContext(tenant.id, 'teste')
    )
    assert.deepEqual(
      (await runsOf(tenant)).map((r) => r.status),
      ['PENDING']
    )

    const store = new LucidTenantStore()
    const change = new ChangeTenantStatus(store)
    await change.execute(tenant.code, 'SUSPENDED')
    const worker = automationServices().worker()
    await worker.tick()
    assert.deepEqual(
      (await runsOf(tenant)).map((r) => r.status),
      ['PENDING'],
      'nenhuma escrita empresarial'
    )

    await change.execute(tenant.code, 'ACTIVE')
    await worker.tick()
    assert.deepEqual(
      (await runsOf(tenant)).map((r) => r.status),
      ['SUCCEEDED']
    )
    assert.equal(await stateOf(http, record.id), 'concluido')
  })

  test('um membro suspenso deixa a automação sem actor: falha, e retoma quando volta', async ({
    client,
    assert,
  }) => {
    const { http, tenant, client: c } = await setup(client)
    await publishEntity(http)
    await simpleMachine(http)
    // Um segundo administrador activa a automação.
    const other = await newActor(c, tenant, true)
    const otherHttp = api(c, tenant, other)
    await activate(
      otherHttp,
      onStateChange('concluir_auto', 'em_curso', [doTransition('concluir')])
    )
    const member = await must<any>(await http.get(`/api/v1/memberships/${other.membershipId}`), 200)
    await must(
      await http.patch(`/api/v1/memberships/${other.membershipId}`, {
        status: 'SUSPENDED',
        expectedVersion: member.version,
      }),
      200
    )
    const record = await newRecord(http)
    await must(await transition(http, record.id, 'iniciar', 1), 200)
    await drain(tenant)
    const [failed] = await runsOf(tenant)
    assert.deepInclude(failed, { status: 'PENDING', error_code: 'RUN_AS_UNAVAILABLE', attempts: 1 })
    assert.equal(await stateOf(http, record.id), 'em_curso')

    const suspended = await must<any>(
      await http.get(`/api/v1/memberships/${other.membershipId}`),
      200
    )
    await must(
      await http.patch(`/api/v1/memberships/${other.membershipId}`, {
        status: 'ACTIVE',
        expectedVersion: suspended.version,
      }),
      200
    )
    await db.connection('owner').transaction(async (trx) => {
      await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [tenant.id])
      await trx.rawQuery("update automation_runs set next_attempt_at = now() - interval '1 second'")
    })
    await drain(tenant)
    assert.equal((await runsOf(tenant))[0]?.status, 'SUCCEEDED')
    assert.equal(await stateOf(http, record.id), 'concluido')
  })

  test('a automação não ganha permissões: executa com as de quem a activou', async ({
    client,
    assert,
  }) => {
    const { http, tenant, client: c } = await setup(client)
    await publishEntity(http)
    await simpleMachine(http)
    // Quem activa pode gerir automações e ler registos, mas não executar transições.
    const role = await must<any>(
      await http.post('/api/v1/roles', {
        code: `r_${random()}`,
        name: 'Gestor de automações',
        permissionCodes: ['automation.read', 'automation.manage', 'dynamic.read', 'entity.read'],
      }),
      201
    )
    const manager = await newActor(c, tenant)
    await must(
      await http.post('/api/v1/role-assignments', {
        membershipId: manager.membershipId,
        roleId: role.id,
      }),
      201
    )
    const managerHttp = api(c, tenant, manager)
    await activate(
      managerHttp,
      onStateChange('concluir_auto', 'em_curso', [doTransition('concluir')])
    )

    const record = await newRecord(http)
    await must(await transition(http, record.id, 'iniciar', 1), 200)
    await drain(tenant)
    const [run] = await runsOf(tenant)
    assert.equal(run.status, 'PENDING')
    assert.equal(run.error_code, 'ACTION_FAILED')
    const runs = await must<any[]>(await managerHttp.get('/api/v1/automation-runs'), 200)
    assert.match(runs[0].error, /permiss/i)
    assert.equal(await stateOf(http, record.id), 'em_curso', 'sem a permissão, nada mudou')
  })

  test('ver e gerir exigem permissões próprias', async ({ client, assert }) => {
    const { http, tenant, client: c } = await setup(client)
    await publishEntity(http)
    const none = await newActor(c, tenant)
    const noneHttp = api(c, tenant, none)
    ;(await noneHttp.get('/api/v1/automations')).assertStatus(403)
    ;(await noneHttp.get('/api/v1/automation-runs')).assertStatus(403)
    ;(
      await noneHttp.post(
        '/api/v1/automations',
        onStateChange('x_y', 'a', [doTransition('concluir')])
      )
    ).assertStatus(403)

    const role = await must<any>(
      await http.post('/api/v1/roles', {
        code: `r_${random()}`,
        name: 'Leitor',
        permissionCodes: ['automation.read'],
      }),
      201
    )
    await must(
      await http.post('/api/v1/role-assignments', {
        membershipId: none.membershipId,
        roleId: role.id,
      }),
      201
    )
    await must(await noneHttp.get('/api/v1/automations'), 200)
    ;(
      await noneHttp.post(
        '/api/v1/automations',
        onStateChange('x_y', 'a', [doTransition('concluir')])
      )
    ).assertStatus(403)
    const draft = await must<any>(
      await http.post('/api/v1/automations', onStateChange('x_y', 'a', [doTransition('concluir')])),
      201
    )
    ;(
      await noneHttp.post(`/api/v1/automations/${draft.id}/activate`, { expectedVersion: 1 })
    ).assertStatus(403)
    assert.isNotNull(draft.id)
  })
})

group('automações | calendário', () => {
  test('o calendário dispara no instante, uma só vez, e avança a próxima execução', async ({
    client,
    assert,
  }) => {
    const { http, tenant } = await setup(client)
    await publishEntity(http)
    await simpleMachine(http)
    const record = await newRecord(http)
    const auto = await activate(http, {
      code: 'diaria',
      name: 'diária',
      schedule: '0 9 * * *',
      timezone: 'Africa/Luanda',
      actions: [
        {
          type: 'dynamic.record.transition',
          params: { entityCode: 'pedido', recordId: record.id, transition: 'iniciar' },
        },
      ],
    })
    assert.isNotNull(auto.nextRunAt)
    assert.isAbove(new Date(auto.nextRunAt).getTime(), Date.now())
    // 09:00 em Luanda são 08:00 UTC.
    assert.equal(new Date(auto.nextRunAt).getUTCHours(), 8)
    assert.equal(new Date(auto.nextRunAt).getUTCMinutes(), 0)
    await drain(tenant)
    assert.lengthOf(await runsOf(tenant), 0, 'ainda não chegou a hora')

    const due = new Date(Date.now() - 60_000)
    const setNext = async (instant: Date) =>
      db.connection('owner').transaction(async (trx) => {
        await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [tenant.id])
        await trx.rawQuery('update automations set next_run_at = ?', [instant.toISOString()])
      })
    await setNext(due)
    await drain(tenant)
    const runs = await rowsOf(tenant, 'select status, scheduled_for, depth from automation_runs')
    assert.deepEqual(
      runs.map((r) => r.status),
      ['SUCCEEDED']
    )
    assert.equal(new Date(runs[0].scheduled_for).getTime(), due.getTime())
    assert.equal(await stateOf(http, record.id), 'em_curso')
    const after = await must<any>(await http.get(`/api/v1/automations/${auto.id}`), 200)
    assert.isAbove(new Date(after.nextRunAt).getTime(), Date.now())

    // O mesmo instante agendado nunca produz duas execuções.
    await setNext(due)
    await drain(tenant)
    assert.lengthOf(await runsOf(tenant), 1)

    const simulation = await must<any>(
      await http.post(`/api/v1/automations/${auto.id}/simulate`, {}),
      200
    )
    assert.lengthOf(simulation.nextRuns, 5)
  })
})
