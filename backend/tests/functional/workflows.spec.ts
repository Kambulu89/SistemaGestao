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

const random = () => Math.random().toString(36).slice(2, 10)

async function setup(client: any) {
  const tenant = await createActiveTenant()
  const admin = await newActor(client, tenant, true)
  return { tenant, admin, http: api(client, tenant, admin), client }
}

async function createRole(http: Http, permissions: string[]) {
  return must<{ id: string }>(
    await http.post('/api/v1/roles', {
      code: `r_${random()}`,
      name: 'Papel de teste',
      permissionCodes: permissions,
    }),
    201
  )
}

async function assign(http: Http, membershipId: string, roleId: string) {
  await must(await http.post('/api/v1/role-assignments', { membershipId, roleId }), 201)
}

async function memberWith(ctx: { client: any; tenant: Tenant; http: Http }, permissions: string[]) {
  const actor = await newActor(ctx.client, ctx.tenant)
  const role = await createRole(ctx.http, permissions)
  await assign(ctx.http, actor.membershipId, role.id)
  return { actor, http: api(ctx.client, ctx.tenant, actor) }
}

const REQUESTER = [
  'dynamic.read',
  'dynamic.create',
  'dynamic.update',
  'dynamic.archive',
  'workflow.submit',
]
const APPROVER = ['approval.decide']

async function publishEntity(http: Http) {
  const draft = await must<Detail>(
    await http.post('/api/v1/entity-definitions', {
      code: 'despesa',
      name: 'Despesa',
      fields: [
        { code: 'descricao', label: 'Descrição', type: 'TEXT', required: true },
        {
          code: 'valor',
          label: 'Valor',
          type: 'DECIMAL',
          validation: { precision: 12, scale: 2 },
        },
        { code: 'moeda', label: 'Moeda', type: 'TEXT' },
        { code: 'segredo', label: 'Segredo', type: 'TEXT', sensitive: true },
      ],
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

const member = (id: string) => ({ type: 'MEMBERSHIP', id })
const role = (id: string) => ({ type: 'ROLE', id })
const stage = (code: string, approvers: unknown[], extra: Record<string, unknown> = {}) => ({
  code,
  label: code,
  criteria: 'ALL',
  approvers,
  ...extra,
})
const workflow = (stages: unknown[], extra: Record<string, unknown> = {}) => ({
  entityCode: 'despesa',
  code: 'aprovacao',
  name: 'Aprovação de despesa',
  graph: { amountField: 'valor', currencyField: 'moeda', stages },
  ...extra,
})

async function publishWorkflow(http: Http, body: Record<string, unknown>) {
  const draft = await must<any>(await http.post('/api/v1/workflows', body), 201)
  return must<any>(
    await http.post(`/api/v1/workflows/${draft.id}/publish`, { expectedVersion: draft.version }),
    200
  )
}

const inFuture = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()

const records = '/api/v1/dynamic/despesa/records'

async function createRecord(http: Http, valor = '500.00', extra: Record<string, unknown> = {}) {
  return must<any>(
    await http.post(records, {
      data: { descricao: `Despesa ${random()}`, valor, moeda: 'EUR', ...extra },
    }),
    201
  )
}

const submit = (http: Http, recordId: string, workflowCode = 'aprovacao') =>
  http.post('/api/v1/workflow-instances', { entityCode: 'despesa', workflowCode, recordId })

const inbox = async (http: Http, view = 'pending') =>
  must<any[]>(await http.get(`/api/v1/approval-tasks?view=${view}`), 200)

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

group('workflows | definições', () => {
  test('rascunho → publicação imutável → nova revisão retira a anterior', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    await publishEntity(ctx.http)
    const chef = await memberWith(ctx, APPROVER)
    const draft = await must<any>(
      await ctx.http.post(
        '/api/v1/workflows',
        workflow([stage('chefia', [member(chef.actor.membershipId)])])
      ),
      201
    )
    const preview = await must<any>(
      await ctx.http.post(`/api/v1/workflows/${draft.id}/preview`, {}),
      200
    )
    assert.deepEqual(preview, { issues: [], publishable: true })
    const published = await must<any>(
      await ctx.http.post(`/api/v1/workflows/${draft.id}/publish`, {
        expectedVersion: draft.version,
      }),
      200
    )
    assert.equal(published.status, 'PUBLISHED')

    const refused = await ctx.http.patch(`/api/v1/workflows/${draft.id}`, {
      expectedVersion: published.version,
      name: 'Outro',
    })
    refused.assertStatus(409)
    assert.equal(refused.body().error.code, 'WORKFLOW_NOT_DRAFT')
    for (const sql of [
      `update workflow_definitions set name = 'x' where id = '${draft.id}'`,
      `update workflow_definitions set graph = '{}' where id = '${draft.id}'`,
      `delete from workflow_definitions where id = '${draft.id}'`,
    ]) {
      const failure = await capture(() =>
        db.connection('owner').transaction(async (trx) => {
          await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [ctx.tenant.id])
          await trx.rawQuery(sql)
        })
      )
      assert.match(failure.message, /PUBLISHED_WORKFLOW_IMMUTABLE/, sql)
    }

    const revision = await must<any>(
      await ctx.http.post(`/api/v1/workflows/${draft.id}/revisions`, {}),
      201
    )
    assert.equal(revision.revision, 2)
    assert.equal(revision.status, 'DRAFT')
    await must(
      await ctx.http.post(`/api/v1/workflows/${revision.id}/publish`, {
        expectedVersion: revision.version,
      }),
      200
    )
    const all = await must<any[]>(await ctx.http.get('/api/v1/workflows?entityCode=despesa'), 200)
    assert.deepEqual(all.map((w) => `${w.revision}:${w.status}`).sort(), [
      '1:RETIRED',
      '2:PUBLISHED',
    ])
  })

  test('a estrutura, as condições, os campos e os responsáveis são verificados', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    await publishEntity(ctx.http)
    const chef = await memberWith(ctx, APPROVER)
    const emptyRole = await createRole(ctx.http, APPROVER)
    const unknown = '99999999-9999-4999-8999-999999999999'
    const publishCodes = async (body: Record<string, unknown>) => {
      const created = await ctx.http.post('/api/v1/workflows', { ...body, code: `w_${random()}` })
      if (created.status() === 422) return created.body().error.details.map((d: any) => d.code)
      const draft = created.body().data
      const response = await ctx.http.post(`/api/v1/workflows/${draft.id}/publish`, {
        expectedVersion: draft.version,
      })
      response.assertStatus(422)
      return response.body().error.details.map((d: any) => `${d.path}:${d.code}`)
    }
    const ok = [stage('chefia', [member(chef.actor.membershipId)])]
    assert.include(await publishCodes(workflow([])), 'INVALID_STAGES')
    assert.include(
      await publishCodes(workflow([stage('chefia', [member(unknown)])])),
      'graph.stages[0].approvers[0]:APPROVER_UNRESOLVABLE'
    )
    assert.include(
      await publishCodes(workflow([stage('chefia', [role(unknown)])])),
      'graph.stages[0].approvers[0]:APPROVER_UNRESOLVABLE'
    )
    assert.include(
      await publishCodes(workflow([stage('chefia', [role(emptyRole.id)])])),
      'graph.stages[0].approvers[0]:APPROVER_UNRESOLVABLE',
      'um papel sem titulares activos não é resolvível'
    )
    assert.include(
      await publishCodes(
        workflow([
          stage('chefia', [member(chef.actor.membershipId)], {
            condition: { op: 'gt', left: { var: 'resource.segredo' }, right: { value: 'x' } },
          }),
        ])
      ),
      'graph.stages[0].condition:UNKNOWN_FIELD'
    )
    assert.include(
      await publishCodes(
        workflow([
          stage('chefia', [member(chef.actor.membershipId)], {
            condition: { op: 'eval', code: 'process.exit()' },
          }),
        ])
      ),
      'graph.stages[0].condition:UNKNOWN_OP'
    )
    assert.include(
      await publishCodes({
        ...workflow(ok),
        graph: { stages: ok, amountField: 'descricao' },
      }),
      'graph.amountField:INVALID_AMOUNT_FIELD'
    )
    assert.include(
      await publishCodes({
        ...workflow(ok),
        graph: { stages: ok, amountField: 'valor', currencyField: 'valor' },
      }),
      'graph.currencyField:INVALID_CURRENCY_FIELD'
    )

    const suspended = await memberWith(ctx, APPROVER)
    const current = await must<any>(
      await ctx.http.get(`/api/v1/memberships/${suspended.actor.membershipId}`),
      200
    )
    await must(
      await ctx.http.patch(`/api/v1/memberships/${suspended.actor.membershipId}`, {
        status: 'SUSPENDED',
        expectedVersion: current.version,
      }),
      200
    )
    assert.include(
      await publishCodes(workflow([stage('chefia', [member(suspended.actor.membershipId)])])),
      'graph.stages[0].approvers[0]:APPROVER_UNRESOLVABLE',
      'um membro suspenso não é resolvível'
    )
  })

  test('a entidade tem de estar publicada; sem permissão não se desenha nem se publica', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    await must(
      await ctx.http.post('/api/v1/entity-definitions', {
        code: 'despesa',
        name: 'Despesa',
        fields: [{ code: 'descricao', label: 'Descrição', type: 'TEXT' }],
      }),
      201
    )
    const chef = await memberWith(ctx, APPROVER)
    const unpublished = await ctx.http.post(
      '/api/v1/workflows',
      workflow([stage('chefia', [member(chef.actor.membershipId)])])
    )
    unpublished.assertStatus(422)
    assert.equal(unpublished.body().error.details[0].code, 'ENTITY_NOT_PUBLISHED')

    const reader = await memberWith(ctx, ['workflow.read'])
    ;(await reader.http.post('/api/v1/workflows', workflow([]))).assertStatus(403)
    ;(
      await reader.http.post(`/api/v1/workflows/99999999-9999-4999-8999-999999999999/publish`, {
        expectedVersion: 1,
      })
    ).assertStatus(403)
    ;(await reader.http.get('/api/v1/workflows')).assertStatus(200)
  })
})

group('workflows | submissão e decisões', () => {
  test('duas etapas: pessoa, depois papel com tarefa de grupo reclamada atomicamente', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    await publishEntity(ctx.http)
    const chef = await memberWith(ctx, APPROVER)
    const directors = await createRole(ctx.http, APPROVER)
    const d1 = await newActor(client, ctx.tenant)
    const d2 = await newActor(client, ctx.tenant)
    await assign(ctx.http, d1.membershipId, directors.id)
    await assign(ctx.http, d2.membershipId, directors.id)
    const requester = await memberWith(ctx, REQUESTER)
    await publishWorkflow(
      ctx.http,
      workflow([
        stage('chefia', [member(chef.actor.membershipId)], { dueInHours: 48 }),
        stage('direcao', [role(directors.id)], { criteria: 'ANY' }),
      ])
    )
    const record = await createRecord(requester.http, '1500.00')
    const submitted = await must<any>(await submit(requester.http, record.id), 201)
    assert.equal(submitted.instance.status, 'WAITING')
    assert.equal(submitted.instance.resourceVersion, record.version)
    assert.equal(submitted.instance.snapshot.valor, '1500.00')
    assert.equal(submitted.instance.workflowRevision, 1)
    assert.lengthOf(submitted.tasks, 1)

    // Minha caixa: valor, solicitante, etapa, prazo e versão.
    const [item] = await inbox(chef.http)
    assert.equal(item.stage.label, 'chefia')
    assert.equal(item.amount, '1500.00')
    assert.equal(item.currency, 'EUR')
    assert.equal(item.submittedByMembershipId, requester.actor.membershipId)
    assert.equal(item.resourceVersion, record.version)
    assert.isNotNull(item.task.dueAt)
    assert.isTrue(item.can.decide)
    assert.deepEqual(await inbox(api(client, ctx.tenant, d1)), [])

    // Quem não tem a tarefa não a vê (404), mesmo com `approval.decide`.
    const outsider = await memberWith(ctx, APPROVER)
    ;(await outsider.http.get(`/api/v1/approval-tasks/${item.task.id}`)).assertStatus(404)
    ;(await outsider.http.post(`/api/v1/approval-tasks/${item.task.id}/approve`, {})).assertStatus(
      404
    )

    await must(await chef.http.post(`/api/v1/approval-tasks/${item.task.id}/approve`, {}), 200)

    // Etapa 2: tarefa de grupo para o papel; só uma pessoa a reclama.
    const dir1 = api(client, ctx.tenant, d1)
    const dir2 = api(client, ctx.tenant, d2)
    const [group1] = await inbox(dir1)
    const [group2] = await inbox(dir2)
    assert.equal(group1.task.id, group2.task.id)
    assert.isTrue(group1.can.claim)
    assert.isFalse(group1.can.decide, 'sem reclamar não se decide')
    const premature = await dir1.post(`/api/v1/approval-tasks/${group1.task.id}/approve`, {})
    premature.assertStatus(409)
    assert.equal(premature.body().error.code, 'TASK_NOT_CLAIMED')

    const [first, second] = await Promise.all([
      dir1.post(`/api/v1/approval-tasks/${group1.task.id}/claim`, {}),
      dir2.post(`/api/v1/approval-tasks/${group1.task.id}/claim`, {}),
    ])
    assert.sameMembers([first.status(), second.status()], [200, 409], 'só um reclama')
    const winner = first.status() === 200 ? dir1 : dir2
    const loser = first.status() === 200 ? dir2 : dir1
    const blocked = await loser.post(`/api/v1/approval-tasks/${group1.task.id}/approve`, {})
    assert.include([409], blocked.status())
    assert.include(['TASK_NOT_OPEN', 'TASK_CLAIMED_BY_OTHER'], blocked.body().error.code)

    const done = await must<any>(
      await winner.post(`/api/v1/approval-tasks/${group1.task.id}/approve`, { reason: 'ok' }),
      200
    )
    assert.isFalse(done.idempotent)
    const final = await must<any>(
      await requester.http.get(`/api/v1/workflow-instances/${submitted.instance.id}`),
      200
    )
    assert.equal(final.instance.status, 'APPROVED')
    assert.equal(final.instance.endReason, 'APPROVED')
    assert.deepEqual(
      final.tasks.map((t: any) => t.status),
      ['APPROVED', 'APPROVED']
    )

    // A aprovação sai por outbox, na mesma transacção, com o registo e a versão aprovados.
    const events = await rowsOf(
      ctx.tenant,
      `select event_type, payload from outbox_events where event_type like 'workflow.%'`
    )
    assert.lengthOf(events, 1)
    assert.equal(events[0].event_type, 'workflow.instance.approved')
    assert.equal(events[0].payload.recordId, record.id)
    assert.equal(events[0].payload.resourceVersion, record.version)
    // Aprovar não escreve no registo.
    const unchanged = await must<any>(await requester.http.get(`${records}/${record.id}`), 200)
    assert.equal(unchanged.version, record.version)
  })

  test('a decisão é idempotente e duas decisões simultâneas não duplicam efeitos', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    await publishEntity(ctx.http)
    const chef = await memberWith(ctx, APPROVER)
    const requester = await memberWith(ctx, REQUESTER)
    await publishWorkflow(ctx.http, workflow([stage('chefia', [member(chef.actor.membershipId)])]))
    const record = await createRecord(requester.http)
    await must(await submit(requester.http, record.id), 201)
    const [item] = await inbox(chef.http)
    const url = `/api/v1/approval-tasks/${item.task.id}`

    const results = await Promise.all([
      chef.http.post(`${url}/approve`, {}),
      chef.http.post(`${url}/approve`, {}),
      chef.http.post(`${url}/approve`, {}),
    ])
    for (const r of results) assert.equal(r.status(), 200)
    assert.equal(results.filter((r) => r.body().data.idempotent === false).length, 1)

    const events = await rowsOf(
      ctx.tenant,
      `select 1 from outbox_events where event_type like 'workflow.%'`
    )
    assert.lengthOf(events, 1, 'um só efeito')
    // Contradizer a decisão tomada é conflito, não "troca de ideias".
    const contradiction = await chef.http.post(`${url}/reject`, { reason: 'afinal não' })
    contradiction.assertStatus(409)
    assert.equal(contradiction.body().error.code, 'TASK_ALREADY_DECIDED')
    // Uma decisão tomada nem por SQL directo se desfaz.
    const failure = await capture(() =>
      db.connection('owner').transaction(async (trx) => {
        await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [ctx.tenant.id])
        await trx.rawQuery(
          `update workflow_tasks set status = 'REJECTED' where id = '${item.task.id}'`
        )
      })
    )
    assert.match(failure.message, /WORKFLOW_TERMINAL_IMMUTABLE/)
  })

  test('rejeitar e devolver terminam o processo e cancelam o que falta; o motivo é obrigatório', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    await publishEntity(ctx.http)
    const a = await memberWith(ctx, APPROVER)
    const b = await memberWith(ctx, APPROVER)
    const requester = await memberWith(ctx, REQUESTER)
    await publishWorkflow(
      ctx.http,
      workflow([stage('chefia', [member(a.actor.membershipId), member(b.actor.membershipId)])])
    )

    const first = await createRecord(requester.http)
    const one = await must<any>(await submit(requester.http, first.id), 201)
    const [taskA] = await inbox(a.http)
    const noReason = await a.http.post(`/api/v1/approval-tasks/${taskA.task.id}/reject`, {})
    noReason.assertStatus(422)
    assert.equal(noReason.body().error.details[0].code, 'REASON_REQUIRED')
    await must(
      await a.http.post(`/api/v1/approval-tasks/${taskA.task.id}/reject`, { reason: 'Sem verba' }),
      200
    )
    const rejected = await must<any>(
      await requester.http.get(`/api/v1/workflow-instances/${one.instance.id}`),
      200
    )
    assert.equal(rejected.instance.status, 'REJECTED')
    assert.sameMembers(
      rejected.tasks.map((t: any) => t.status),
      ['REJECTED', 'CANCELLED']
    )
    assert.deepEqual(await inbox(b.http), [], 'a tarefa cancelada sai da caixa')
    const late = await b.http.post(
      `/api/v1/approval-tasks/${rejected.tasks.find((t: any) => t.status === 'CANCELLED').id}/approve`,
      {}
    )
    late.assertStatus(409)
    assert.equal(late.body().error.code, 'TASK_NOT_OPEN')

    const second = await createRecord(requester.http)
    const two = await must<any>(await submit(requester.http, second.id), 201)
    const [taskB] = await inbox(b.http)
    await must(
      await b.http.post(`/api/v1/approval-tasks/${taskB.task.id}/return`, {
        reason: 'Falta o recibo',
      }),
      200
    )
    const returned = await must<any>(
      await requester.http.get(`/api/v1/workflow-instances/${two.instance.id}`),
      200
    )
    assert.equal(returned.instance.status, 'CANCELLED')
    assert.equal(returned.instance.endReason, 'RETURNED')
    // O processo devolvido pode ser submetido de novo.
    await must(await submit(requester.http, second.id), 201)
    const decided = await inbox(a.http, 'decided')
    assert.lengthOf(decided, 1)
    assert.equal(decided[0].task.status, 'REJECTED')
  })

  test('QUORUM: n de m aprovações; ninguém decide duas tarefas da mesma etapa', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    await publishEntity(ctx.http)
    const people = [
      await memberWith(ctx, APPROVER),
      await memberWith(ctx, APPROVER),
      await memberWith(ctx, APPROVER),
    ]
    const requester = await memberWith(ctx, REQUESTER)
    await publishWorkflow(
      ctx.http,
      workflow([
        stage(
          'comite',
          people.map((p) => member(p.actor.membershipId)),
          {
            criteria: 'QUORUM',
            quorum: 2,
          }
        ),
      ])
    )
    const record = await createRecord(requester.http)
    const sub = await must<any>(await submit(requester.http, record.id), 201)
    assert.lengthOf(sub.tasks, 3)
    const task = async (p: (typeof people)[number]) => (await inbox(p.http))[0].task.id
    await must(
      await people[0]!.http.post(`/api/v1/approval-tasks/${await task(people[0]!)}/approve`, {}),
      200
    )
    let state = await must<any>(
      await requester.http.get(`/api/v1/workflow-instances/${sub.instance.id}`),
      200
    )
    assert.equal(state.instance.status, 'WAITING', 'uma aprovação não chega')
    await must(
      await people[1]!.http.post(`/api/v1/approval-tasks/${await task(people[1]!)}/approve`, {}),
      200
    )
    state = await must<any>(
      await requester.http.get(`/api/v1/workflow-instances/${sub.instance.id}`),
      200
    )
    assert.equal(state.instance.status, 'APPROVED')
    assert.sameMembers(
      state.tasks.map((t: any) => t.status),
      ['APPROVED', 'APPROVED', 'CANCELLED']
    )
  })

  test('uma pessoa com dois papéis não cumpre sozinha uma etapa de grupo', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    await publishEntity(ctx.http)
    const roleA = await createRole(ctx.http, APPROVER)
    const roleB = await createRole(ctx.http, APPROVER)
    const both = await newActor(client, ctx.tenant)
    await assign(ctx.http, both.membershipId, roleA.id)
    await assign(ctx.http, both.membershipId, roleB.id)
    const requester = await memberWith(ctx, REQUESTER)
    await publishWorkflow(ctx.http, workflow([stage('duplo', [role(roleA.id), role(roleB.id)])]))
    const record = await createRecord(requester.http)
    await must(await submit(requester.http, record.id), 201)
    const http = api(client, ctx.tenant, both)
    const tasks = await inbox(http)
    assert.lengthOf(tasks, 2)
    await must(await http.post(`/api/v1/approval-tasks/${tasks[0].task.id}/claim`, {}), 200)
    const second = await http.post(`/api/v1/approval-tasks/${tasks[1].task.id}/claim`, {})
    second.assertStatus(409)
    assert.equal(second.body().error.code, 'ALREADY_ACTED_IN_STAGE')
  })

  test('quem submete não decide: nem como responsável, nem pelo papel (salvo se a etapa o permitir)', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    await publishEntity(ctx.http)
    const both = await memberWith(ctx, [...REQUESTER, ...APPROVER])
    // Único responsável é quem submete: não há aprovador possível.
    await publishWorkflow(ctx.http, workflow([stage('chefia', [member(both.actor.membershipId)])]))
    const record = await createRecord(both.http)
    const refused = await submit(both.http, record.id)
    refused.assertStatus(409)
    assert.equal(refused.body().error.code, 'NO_RESOLVABLE_APPROVER')
    assert.lengthOf(
      await rowsOf(ctx.tenant, 'select 1 from workflow_instances'),
      0,
      'nada ficou criado'
    )

    // Pelo papel: vê a tarefa de grupo mas não a pode reclamar.
    const circle = await createRole(ctx.http, APPROVER)
    await assign(ctx.http, both.actor.membershipId, circle.id)
    const other = await newActor(client, ctx.tenant)
    await assign(ctx.http, other.membershipId, circle.id)
    const wf = await must<any>(await ctx.http.get('/api/v1/workflows?status=PUBLISHED'), 200)
    await must(
      await ctx.http.post(`/api/v1/workflows/${wf[0].id}/retire`, {
        expectedVersion: wf[0].version,
      }),
      200
    )
    await publishWorkflow(
      ctx.http,
      workflow([stage('grupo', [role(circle.id)])], { code: 'grupo' })
    )
    const [task] = await (async () => {
      await must(await submit(both.http, record.id, 'grupo'), 201)
      return inbox(both.http)
    })()
    assert.isFalse(task.can.claim)
    const claim = await both.http.post(`/api/v1/approval-tasks/${task.task.id}/claim`, {})
    claim.assertStatus(403)
    assert.equal(claim.body().error.code, 'TASK_NOT_ALLOWED')
    // Outra pessoa do mesmo papel reclama e decide.
    const http = api(client, ctx.tenant, other)
    await must(await http.post(`/api/v1/approval-tasks/${task.task.id}/claim`, {}), 200)
    await must(await http.post(`/api/v1/approval-tasks/${task.task.id}/approve`, {}), 200)
  })

  test('etapas com condição são dispensadas; sem nenhuma aplicável não há processo', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    await publishEntity(ctx.http)
    const chef = await memberWith(ctx, APPROVER)
    const dir = await memberWith(ctx, APPROVER)
    const requester = await memberWith(ctx, REQUESTER)
    const above = (limit: string) => ({
      op: 'gt',
      left: { var: 'resource.valor' },
      right: { value: limit },
    })
    await publishWorkflow(
      ctx.http,
      workflow([
        stage('chefia', [member(chef.actor.membershipId)], { condition: above('100') }),
        stage('direcao', [member(dir.actor.membershipId)], { condition: above('1000') }),
      ])
    )

    const small = await createRecord(requester.http, '500.00')
    const sub = await must<any>(await submit(requester.http, small.id), 201)
    assert.deepEqual(
      sub.tasks.map((t: any) => t.stageCode),
      ['chefia']
    )
    const [task] = await inbox(chef.http)
    await must(await chef.http.post(`/api/v1/approval-tasks/${task.task.id}/approve`, {}), 200)
    const done = await must<any>(
      await requester.http.get(`/api/v1/workflow-instances/${sub.instance.id}`),
      200
    )
    assert.equal(done.instance.status, 'APPROVED', 'a etapa da direcção não se aplicava')
    assert.deepEqual(await inbox(dir.http), [])

    const big = await createRecord(requester.http, '5000.00')
    const bigSub = await must<any>(await submit(requester.http, big.id), 201)
    assert.deepEqual(
      bigSub.tasks.map((t: any) => t.stageCode),
      ['chefia']
    )
    const [bigTask] = await inbox(chef.http)
    await must(await chef.http.post(`/api/v1/approval-tasks/${bigTask.task.id}/approve`, {}), 200)
    assert.lengthOf(await inbox(dir.http), 1, 'acima da alçada a direcção também aprova')

    const tiny = await createRecord(requester.http, '50.00')
    const none = await submit(requester.http, tiny.id)
    none.assertStatus(409)
    assert.equal(none.body().error.code, 'NO_APPLICABLE_STAGE')
  })

  test('alterar ou arquivar o registo cancela o processo: a versão antiga não aprova o valor novo', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    await publishEntity(ctx.http)
    const chef = await memberWith(ctx, APPROVER)
    const requester = await memberWith(ctx, REQUESTER)
    await publishWorkflow(ctx.http, workflow([stage('chefia', [member(chef.actor.membershipId)])]))

    const record = await createRecord(requester.http, '500.00')
    const sub = await must<any>(await submit(requester.http, record.id), 201)
    const [task] = await inbox(chef.http)
    const duplicate = await submit(requester.http, record.id)
    duplicate.assertStatus(409)
    assert.equal(duplicate.body().error.code, 'WORKFLOW_ALREADY_RUNNING')

    await must(
      await requester.http.patch(`${records}/${record.id}`, {
        expectedVersion: record.version,
        data: { valor: '9999.00' },
      }),
      200
    )
    const cancelled = await must<any>(
      await requester.http.get(`/api/v1/workflow-instances/${sub.instance.id}`),
      200
    )
    assert.equal(cancelled.instance.status, 'CANCELLED')
    assert.equal(cancelled.instance.endReason, 'RESOURCE_CHANGED')
    assert.equal(cancelled.instance.snapshot.valor, '500.00', 'o que se submeteu fica preservado')
    const stale = await chef.http.post(`/api/v1/approval-tasks/${task.task.id}/approve`, {})
    stale.assertStatus(409)
    assert.equal(stale.body().error.code, 'TASK_NOT_OPEN')
    assert.deepEqual(await inbox(chef.http), [])

    // Nova submissão reinicia a aprovação com os valores novos.
    const again = await must<any>(await submit(requester.http, record.id), 201)
    assert.equal(again.instance.snapshot.valor, '9999.00')
    assert.equal(again.instance.resourceVersion, record.version + 1)
    const current = await must<any>(await requester.http.get(`${records}/${record.id}`), 200)
    await must(
      await requester.http.post(`${records}/${record.id}/archive`, {
        expectedVersion: current.version,
      }),
      200
    )
    const archived = await must<any>(
      await requester.http.get(`/api/v1/workflow-instances/${again.instance.id}`),
      200
    )
    assert.equal(archived.instance.endReason, 'RESOURCE_CHANGED')
    const events = await rowsOf(
      ctx.tenant,
      `select event_type from outbox_events where event_type like 'workflow.%'`
    )
    assert.deepEqual(
      events.map((e) => e.event_type),
      ['workflow.instance.cancelled', 'workflow.instance.cancelled']
    )
  })

  test('quem submeteu cancela o seu processo; outros não o veem nem cancelam', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    await publishEntity(ctx.http)
    const chef = await memberWith(ctx, APPROVER)
    const requester = await memberWith(ctx, REQUESTER)
    const other = await memberWith(ctx, REQUESTER)
    await publishWorkflow(ctx.http, workflow([stage('chefia', [member(chef.actor.membershipId)])]))
    const record = await createRecord(requester.http)
    const sub = await must<any>(await submit(requester.http, record.id), 201)
    const url = `/api/v1/workflow-instances/${sub.instance.id}`
    ;(await other.http.get(url)).assertStatus(404)
    ;(await other.http.post(`${url}/cancel`, {})).assertStatus(404)
    await must(await chef.http.get(url), 200)
    await must(await ctx.http.get(url), 200) // quem lê workflows
    const cancelled = await must<any>(await requester.http.post(`${url}/cancel`, {}), 200)
    assert.equal(cancelled.instance.endReason, 'CANCELLED_BY_SUBMITTER')
    assert.equal(cancelled.tasks[0].status, 'CANCELLED')
    const again = await requester.http.post(`${url}/cancel`, {})
    again.assertStatus(409)
    assert.equal(again.body().error.code, 'INSTANCE_NOT_ACTIVE')
    const listed = await must<any[]>(
      await requester.http.get(`${records}/${record.id}/workflow-instances`),
      200
    )
    assert.lengthOf(listed, 1)
  })

  test('permissões: submeter, decidir e ver a caixa exigem as permissões próprias', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    await publishEntity(ctx.http)
    const chef = await memberWith(ctx, APPROVER)
    const reader = await memberWith(ctx, ['dynamic.read', 'dynamic.create'])
    await publishWorkflow(ctx.http, workflow([stage('chefia', [member(chef.actor.membershipId)])]))
    const record = await createRecord(reader.http)
    ;(await submit(reader.http, record.id)).assertStatus(403)
    ;(await reader.http.get('/api/v1/approval-tasks')).assertStatus(403)
    ;(await reader.http.get('/api/v1/approval-delegations')).assertStatus(403)
    // Um registo que não existe (ou de outro tenant) é 404, não 403/409.
    const submitter = await memberWith(ctx, REQUESTER)
    const ghost = await submit(submitter.http, '99999999-9999-4999-8999-999999999999')
    ghost.assertStatus(404)
    const offered = await must<any[]>(
      await submitter.http.get('/api/v1/dynamic/despesa/workflows'),
      200
    )
    assert.deepEqual(offered, [
      {
        code: 'aprovacao',
        name: 'Aprovação de despesa',
        revision: 1,
        stages: [{ code: 'chefia', label: 'chefia' }],
      },
    ])
    ;(await reader.http.get('/api/v1/dynamic/despesa/workflows')).assertStatus(403)
    const noWorkflow = await submit(submitter.http, record.id, 'inexistente')
    noWorkflow.assertStatus(409)
    assert.equal(noWorkflow.body().error.code, 'WORKFLOW_NOT_PUBLISHED')
  })
})

group('workflows | delegações', () => {
  test('o delegado decide dentro do âmbito e do montante; fora deles não; revogar corta o acesso', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    await publishEntity(ctx.http)
    const chef = await memberWith(ctx, [...APPROVER, 'approval.delegate'])
    const deputy = await memberWith(ctx, APPROVER)
    const requester = await memberWith(ctx, REQUESTER)
    await publishWorkflow(ctx.http, workflow([stage('chefia', [member(chef.actor.membershipId)])]))
    await publishWorkflow(
      ctx.http,
      workflow([stage('chefia', [member(chef.actor.membershipId)])], { code: 'outro' })
    )

    const delegation = await must<any>(
      await chef.http.post('/api/v1/approval-delegations', {
        toMembershipId: deputy.actor.membershipId,
        validUntil: inFuture(7),
        scope: { workflowCodes: ['aprovacao'] },
        maxAmount: '1000.00',
        currency: 'EUR',
        reason: 'Férias',
      }),
      201
    )
    assert.equal(delegation.maxAmount, '1000.0000')

    const small = await createRecord(requester.http, '800.00')
    await must(await submit(requester.http, small.id), 201)
    const [seen] = await inbox(deputy.http)
    assert.isTrue(seen.delegated)
    assert.isTrue(seen.can.decide)
    await must(await deputy.http.post(`/api/v1/approval-tasks/${seen.task.id}/approve`, {}), 200)
    const rows = await rowsOf(
      ctx.tenant,
      'select decided_by_membership_id, via_delegation_id, assignee_membership_id from workflow_tasks'
    )
    assert.equal(rows[0].decided_by_membership_id, deputy.actor.membershipId)
    assert.equal(rows[0].assignee_membership_id, chef.actor.membershipId)
    assert.equal(rows[0].via_delegation_id, delegation.id)

    // Acima do máximo da delegação: a menor alçada prevalece.
    const big = await createRecord(requester.http, '5000.00')
    await must(await submit(requester.http, big.id), 201)
    const [tooBig] = await inbox(deputy.http)
    assert.isFalse(tooBig.can.decide)
    const blocked = await deputy.http.post(`/api/v1/approval-tasks/${tooBig.task.id}/approve`, {})
    blocked.assertStatus(403)
    assert.equal(blocked.body().error.code, 'TASK_NOT_ALLOWED')
    // O delegante continua a poder decidir.
    await must(await chef.http.post(`/api/v1/approval-tasks/${tooBig.task.id}/approve`, {}), 200)

    // Fora do âmbito (outro workflow): não aparece nem decide.
    const third = await createRecord(requester.http, '100.00')
    await must(await submit(requester.http, third.id, 'outro'), 201)
    const outOfScope = (await inbox(deputy.http)).find((i) => i.workflow.code === 'outro')
    assert.isTrue(outOfScope === undefined || outOfScope.can.decide === false)

    // Revogada, deixa de valer; só quem delegou revoga.
    ;(
      await deputy.http.post(`/api/v1/approval-delegations/${delegation.id}/revoke`, {
        expectedVersion: delegation.version,
      })
    ).assertStatus(403)
    await must(
      await chef.http.post(`/api/v1/approval-delegations/${delegation.id}/revoke`, {
        expectedVersion: delegation.version,
      }),
      200
    )
    const afterRevoke = (await inbox(deputy.http)).filter((i) => i.workflow.code === 'outro')
    assert.lengthOf(afterRevoke, 0)
  })

  test('recusa ciclos, delegar em si, períodos inválidos e destinatários inactivos', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const a = await memberWith(ctx, ['approval.delegate'])
    const b = await memberWith(ctx, ['approval.delegate'])
    const c = await memberWith(ctx, ['approval.delegate'])
    const create = (who: typeof a, to: string, extra: Record<string, unknown> = {}) =>
      who.http.post('/api/v1/approval-delegations', {
        toMembershipId: to,
        validUntil: inFuture(3),
        reason: 'Ausência',
        ...extra,
      })
    await must(await create(a, b.actor.membershipId), 201)
    await must(await create(b, c.actor.membershipId), 201)
    const cycle = await create(c, a.actor.membershipId)
    cycle.assertStatus(409)
    assert.equal(cycle.body().error.code, 'DELEGATION_CYCLE')
    const direct = await create(b, a.actor.membershipId)
    direct.assertStatus(409)
    assert.equal(direct.body().error.code, 'DELEGATION_CYCLE')
    const self = await create(a, a.actor.membershipId)
    self.assertStatus(422)
    assert.equal(self.body().error.details[0].code, 'SELF_DELEGATION')

    const codes = async (extra: Record<string, unknown>) => {
      const response = await create(a, c.actor.membershipId, extra)
      response.assertStatus(422)
      return response.body().error.details.map((d: any) => d.code)
    }
    assert.include(await codes({ validUntil: inFuture(400) }), 'PERIOD_TOO_LONG')
    assert.include(await codes({ validUntil: inFuture(-1) }), 'IN_THE_PAST')
    assert.include(await codes({ maxAmount: '10.00' }), 'INVALID_CURRENCY')
    assert.include(await codes({ currency: 'EUR' }), 'CURRENCY_WITHOUT_AMOUNT')
    assert.include(await codes({ maxAmount: '1e3', currency: 'EUR' }), 'INVALID_AMOUNT')
    assert.include(await codes({ scope: { workflowCodes: ['Maiúsculas'] } }), 'INVALID_SCOPE')
    assert.include(
      await codes({ toMembershipId: '99999999-9999-4999-8999-999999999999' }),
      'NOT_ACTIVE'
    )
    const mine = await must<any[]>(await a.http.get('/api/v1/approval-delegations'), 200)
    assert.lengthOf(mine, 1)
    assert.equal(mine[0].direction, 'GIVEN')
    const received = await must<any[]>(await c.http.get('/api/v1/approval-delegations'), 200)
    assert.lengthOf(received, 1)
    assert.equal(received[0].direction, 'RECEIVED')
  })
})
