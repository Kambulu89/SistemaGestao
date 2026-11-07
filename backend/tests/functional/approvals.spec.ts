import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import {
  as,
  cleanDatabase,
  createRole,
  memberWithRoles,
  signIn,
  tenantWithAdmin,
  type Session,
} from '#tests/support/fixtures'

const A = '/api/v1/approvals'

async function adminSession(client: any) {
  const { tenant, admin } = await tenantWithAdmin()
  return signIn(client, admin.email, tenant.id)
}

/**
 * Cenário base: requerente (pode pedir), aprovador directo da etapa 1 (membro), dois titulares do perfil aprovador da
 * etapa 2 e um membro sem relação. O workflow tem duas etapas e fica publicado.
 */
async function scenario(client: any, required = 1) {
  const admin = await adminSession(client)
  const requesterRole = await createRole(client, admin, 'requerente', ['approvals.request'])
  const approverRole = await createRole(client, admin, 'aprovador', ['members.read'])
  const requester = await memberWithRoles(client, admin, [requesterRole.id])
  const first = await memberWithRoles(client, admin, [])
  const b1 = await memberWithRoles(client, admin, [approverRole.id])
  const b2 = await memberWithRoles(client, admin, [approverRole.id])
  const outsider = await memberWithRoles(client, admin, [])
  const created = await as(client, admin).post(`${A}/workflows`, {
    code: 'DESPESA',
    name: 'Aprovação de despesas',
    subjectType: 'manual',
    steps: [
      { name: 'Chefia', approverType: 'MEMBER', approverMembershipId: first.memberId },
      {
        name: 'Direcção',
        approverType: 'ROLE',
        approverRoleId: approverRole.id,
        requiredApprovals: required,
      },
    ],
  })
  created.assertStatus(201)
  const published = await as(client, admin).post(
    `${A}/workflows/${created.body().data.id}/publish`,
    {
      expectedVersion: created.body().data.version,
    }
  )
  published.assertStatus(200)
  return {
    admin,
    requester,
    first,
    b1,
    b2,
    outsider,
    approverRole,
    workflow: published.body().data,
  }
}

async function submit(client: any, s: Session, workflowId: string, title = 'Compra de portáteis') {
  const r = await as(client, s).post(`${A}/requests`, {
    workflowId,
    title,
    description: '3 unidades',
  })
  if (r.status() !== 201) throw new Error(JSON.stringify(r.body()))
  return r.body().data
}

const decide = (client: any, s: Session, id: string, body: object) =>
  as(client, s).post(`${A}/requests/${id}/decisions`, body)

test.group('aprovações | workflows, pedidos, decisões e delegações', (group) => {
  group.each.setup(() => cleanDatabase())

  test('workflow: valida etapas, publica só com aprovadores suficientes e fica imutável', async ({
    client,
    assert,
  }) => {
    const admin = await adminSession(client)
    const lonely = await createRole(client, admin, 'sozinho', ['members.read'])
    const invalid = await as(client, admin).post(`${A}/workflows`, {
      code: 'x',
      name: 'ab',
      subjectType: 'outro',
      steps: [{ name: 'E', approverType: 'MEMBER', approverRoleId: lonely.id }],
    })
    invalid.assertStatus(422)
    assert.includeMembers(
      invalid.body().error.details.map((d: any) => d.path),
      ['code', 'name', 'subjectType', 'steps.0.name', 'steps.0.approverMembershipId']
    )

    // O perfil não tem nenhum membro activo: guardar em rascunho é possível, publicar não.
    const draft = await as(client, admin).post(`${A}/workflows`, {
      code: 'FERIAS',
      name: 'Férias',
      subjectType: 'manual',
      steps: [
        { name: 'RH', approverType: 'ROLE', approverRoleId: lonely.id, requiredApprovals: 2 },
      ],
    })
    draft.assertStatus(201)
    const wf = draft.body().data
    assert.equal(wf.status, 'DRAFT')
    const publish = await as(client, admin).post(`${A}/workflows/${wf.id}/publish`, {
      expectedVersion: wf.version,
    })
    publish.assertStatus(422)
    assert.equal(publish.body().error.details[0].code, 'NOT_ENOUGH_APPROVERS')

    // Corrige para o próprio administrador e publica.
    const adminMember = (await as(client, admin).get('/api/v1/context')).body().data
    const fixed = await as(client, admin).patch(`${A}/workflows/${wf.id}`, {
      expectedVersion: wf.version,
      steps: [
        { name: 'RH', approverType: 'MEMBER', approverMembershipId: adminMember.membershipId },
      ],
    })
    fixed.assertStatus(200)
    const stale = await as(client, admin).patch(`${A}/workflows/${wf.id}`, {
      expectedVersion: wf.version,
      name: 'Outro nome',
    })
    stale.assertStatus(409)
    const ok = await as(client, admin).post(`${A}/workflows/${wf.id}/publish`, {
      expectedVersion: fixed.body().data.version,
    })
    ok.assertStatus(200)
    assert.equal(ok.body().data.status, 'ACTIVE')

    const edit = await as(client, admin).patch(`${A}/workflows/${wf.id}`, {
      expectedVersion: ok.body().data.version,
      name: 'Mudado',
    })
    edit.assertStatus(409)
    assert.equal(edit.body().error.code, 'WORKFLOW_IMMUTABLE')
    ;(await as(client, admin).delete(`${A}/workflows/${wf.id}`)).assertStatus(409)

    // Nem directamente na base: o trigger recusa alterar etapas de um workflow publicado.
    await assert.rejects(() =>
      db
        .connection('owner')
        .rawQuery('update approval_workflow_steps set name = ? where workflow_id = ?', ['X', wf.id])
    )
  })

  test('fluxo de duas etapas: tarefas, notificações, segregação de funções e conclusão', async ({
    client,
    assert,
  }) => {
    const s = await scenario(client)
    const request = await submit(client, s.requester.session, s.workflow.id)
    assert.equal(request.status, 'PENDING')
    assert.equal(request.currentStep, 1)

    // O aprovador da etapa 1 tem a tarefa e a notificação; os da etapa 2 ainda não.
    const tasks = (await as(client, s.first.session).get('/api/v1/me/tasks')).body().data
    assert.lengthOf(tasks, 1)
    assert.deepInclude(tasks[0], { type: 'APPROVAL', subjectId: request.id, onBehalfOf: null })
    assert.lengthOf((await as(client, s.b1.session).get('/api/v1/me/tasks')).body().data, 0)
    const inbox = await as(client, s.first.session).get('/api/v1/me/notifications')
    assert.equal(inbox.body().meta.unread, 1)
    assert.equal(inbox.body().data[0].subjectId, request.id)

    // Quem ainda não participa (aprovador de uma etapa futura, ou sem relação) nem vê o pedido.
    ;(await decide(client, s.b1.session, request.id, { decision: 'APPROVE' })).assertStatus(404)
    ;(await decide(client, s.outsider.session, request.id, { decision: 'APPROVE' })).assertStatus(
      404
    )
    ;(await as(client, s.outsider.session).get(`${A}/requests/${request.id}`)).assertStatus(404)

    const step1 = await decide(client, s.first.session, request.id, {
      decision: 'APPROVE',
      comment: 'ok',
    })
    step1.assertStatus(200)
    assert.equal(step1.body().data.currentStep, 2)
    const again = await decide(client, s.first.session, request.id, { decision: 'APPROVE' })
    again.assertStatus(403)

    // A etapa 2 chega aos dois titulares do perfil; basta um.
    assert.lengthOf((await as(client, s.b2.session).get('/api/v1/me/tasks')).body().data, 1)
    const final = await decide(client, s.b2.session, request.id, { decision: 'APPROVE' })
    final.assertStatus(200)
    assert.equal(final.body().data.status, 'APPROVED')
    assert.isNotNull(final.body().data.completedAt)
    assert.lengthOf(final.body().data.decisions, 2)
    assert.lengthOf((await as(client, s.b1.session).get('/api/v1/me/tasks')).body().data, 0)
    ;(await decide(client, s.b1.session, request.id, { decision: 'APPROVE' })).assertStatus(409)

    const requesterInbox = (
      await as(client, s.requester.session).get('/api/v1/me/notifications')
    ).body().data
    assert.equal(requesterInbox[0].type, 'approval.approved')

    // O requerente vê o seu pedido; a lista sem approvals.read só traz os pedidos em que participa.
    const mine = await as(client, s.requester.session).get(`${A}/requests`)
    assert.equal(mine.body().meta.total, 1)
    assert.equal((await as(client, s.outsider.session).get(`${A}/requests`)).body().meta.total, 0)
    assert.equal((await as(client, s.admin).get(`${A}/requests`)).body().meta.total, 1)

    const events = (
      await as(client, s.admin).get(
        `/api/v1/audit-events?entityType=approval_request&entityId=${request.id}`
      )
    ).body().data
    assert.includeMembers(
      events.map((e: any) => e.action),
      ['approval_request.submitted', 'approval_request.approved_step', 'approval_request.completed']
    )
  })

  test('o requerente que também é aprovador não aprova o próprio pedido', async ({
    client,
    assert,
  }) => {
    const s = await scenario(client)
    const self = await submit(client, s.b1.session, s.workflow.id).catch(() => null)
    assert.isNull(self) // b1 não pode pedir (sem approvals.request)
    // Dá-se ao requerente o perfil aprovador da etapa 2.
    await as(client, s.admin).post(`/api/v1/members/${s.requester.memberId}/roles`, {
      roleId: s.approverRole.id,
    })
    const request = await submit(client, s.requester.session, s.workflow.id)
    ;(await decide(client, s.first.session, request.id, { decision: 'APPROVE' })).assertStatus(200)
    const own = await decide(client, s.requester.session, request.id, { decision: 'APPROVE' })
    own.assertStatus(403)
    assert.equal(own.body().error.code, 'SEGREGATION_OF_DUTIES')
    assert.lengthOf((await as(client, s.requester.session).get('/api/v1/me/tasks')).body().data, 0)
  })

  test('rejeitar exige motivo e fecha o pedido; cancelar só pelo requerente ou gestor', async ({
    client,
    assert,
  }) => {
    const s = await scenario(client)
    const request = await submit(client, s.requester.session, s.workflow.id)
    ;(await decide(client, s.first.session, request.id, { decision: 'REJECT' })).assertStatus(422)
    const rejected = await decide(client, s.first.session, request.id, {
      decision: 'REJECT',
      comment: 'Sem orçamento',
    })
    rejected.assertStatus(200)
    assert.equal(rejected.body().data.status, 'REJECTED')
    ;(
      await as(client, s.requester.session).post(`${A}/requests/${request.id}/cancel`)
    ).assertStatus(409)

    const other = await submit(client, s.requester.session, s.workflow.id, 'Outro pedido')
    ;(await as(client, s.first.session).post(`${A}/requests/${other.id}/cancel`)).assertStatus(403)
    const cancelled = await as(client, s.requester.session).post(
      `${A}/requests/${other.id}/cancel`,
      {
        reason: 'Já não é preciso',
      }
    )
    cancelled.assertStatus(200)
    assert.equal(cancelled.body().data.status, 'CANCELLED')
    assert.lengthOf((await as(client, s.first.session).get('/api/v1/me/tasks')).body().data, 0)
  })

  test('várias aprovações na etapa: cada pessoa conta uma vez', async ({ client, assert }) => {
    const s = await scenario(client, 2)
    const request = await submit(client, s.requester.session, s.workflow.id)
    await decide(client, s.first.session, request.id, { decision: 'APPROVE' })
    const one = await decide(client, s.b1.session, request.id, { decision: 'APPROVE' })
    assert.equal(one.body().data.status, 'PENDING')
    assert.equal(one.body().data.currentStep, 2)
    ;(await decide(client, s.b1.session, request.id, { decision: 'APPROVE' })).assertStatus(409)
    const two = await decide(client, s.b2.session, request.id, { decision: 'APPROVE' })
    assert.equal(two.body().data.status, 'APPROVED')
  })

  test('delegação: o delegado decide em nome de quem delegou, uma vez, e deixa de poder após revogação', async ({
    client,
    assert,
  }) => {
    const s = await scenario(client)
    const delegate = await memberWithRoles(client, s.admin, [])
    const ends = new Date(Date.now() + 7 * 86_400_000).toISOString()

    const self = await as(client, s.first.session).post(`${A}/delegations`, {
      delegateMembershipId: s.first.memberId,
      endsAt: ends,
      reason: 'Férias',
    })
    self.assertStatus(422)

    const created = await as(client, s.first.session).post(`${A}/delegations`, {
      delegateMembershipId: delegate.memberId,
      endsAt: ends,
      reason: 'Férias',
    })
    created.assertStatus(201)
    const delegation = created.body().data
    assert.equal(delegation.delegator.membershipId, s.first.memberId)

    const request = await submit(client, s.requester.session, s.workflow.id)
    const tasks = (await as(client, delegate.session).get('/api/v1/me/tasks')).body().data
    assert.lengthOf(tasks, 1)
    assert.equal(tasks[0].onBehalfOf, s.first.memberId)
    // Sem indicar em nome de quem, o delegado não é aprovador.
    ;(await decide(client, delegate.session, request.id, { decision: 'APPROVE' })).assertStatus(403)
    const byDelegate = await decide(client, delegate.session, request.id, {
      decision: 'APPROVE',
      onBehalfOf: s.first.memberId,
    })
    byDelegate.assertStatus(200)
    const decision = byDelegate.body().data.decisions[0]
    assert.equal(decision.decidedBy.membershipId, delegate.memberId)
    assert.equal(decision.onBehalfOf.membershipId, s.first.memberId)

    // O voto de quem delegou já foi usado.
    const second = await submit(client, s.requester.session, s.workflow.id, 'Segundo pedido')
    ;(
      await as(client, delegate.session).post(`${A}/delegations/${delegation.id}/revoke`)
    ).assertStatus(403)
    ;(
      await as(client, s.first.session).post(`${A}/delegations/${delegation.id}/revoke`)
    ).assertStatus(200)
    ;(
      await decide(client, delegate.session, second.id, {
        decision: 'APPROVE',
        onBehalfOf: s.first.memberId,
      })
    ).assertStatus(404)
    assert.lengthOf((await as(client, delegate.session).get('/api/v1/me/tasks')).body().data, 0)
  })

  test('delegação limitada a outro workflow não se aplica', async ({ client, assert }) => {
    const s = await scenario(client)
    const delegate = await memberWithRoles(client, s.admin, [])
    const other = await as(client, s.admin).post(`${A}/workflows`, {
      code: 'OUTRO',
      name: 'Outro workflow',
      subjectType: 'manual',
      steps: [{ name: 'Única', approverType: 'MEMBER', approverMembershipId: s.first.memberId }],
    })
    await as(client, s.first.session).post(`${A}/delegations`, {
      delegateMembershipId: delegate.memberId,
      workflowId: other.body().data.id,
      endsAt: new Date(Date.now() + 86_400_000).toISOString(),
      reason: 'Só para o outro',
    })
    await submit(client, s.requester.session, s.workflow.id)
    assert.lengthOf((await as(client, delegate.session).get('/api/v1/me/tasks')).body().data, 0)
  })

  test('decisões simultâneas na última etapa: só uma conta', async ({ client, assert }) => {
    const s = await scenario(client)
    const request = await submit(client, s.requester.session, s.workflow.id)
    await decide(client, s.first.session, request.id, { decision: 'APPROVE' })
    const results = await Promise.all([
      decide(client, s.b1.session, request.id, { decision: 'APPROVE' }),
      decide(client, s.b2.session, request.id, { decision: 'APPROVE' }),
    ])
    assert.sameMembers(
      results.map((r) => r.status()),
      [200, 409]
    )
    const stored = await db
      .connection('owner')
      .rawQuery(
        'select count(*)::int as n from approval_decisions where request_id = ? and step_sequence = 2',
        [request.id]
      )
    assert.equal(stored.rows[0].n, 1)
  })

  test('isolamento: outra empresa não vê nem decide; sem a funcionalidade contratada é negado', async ({
    client,
    assert,
  }) => {
    const s = await scenario(client)
    const request = await submit(client, s.requester.session, s.workflow.id)
    const other = await adminSession(client)
    ;(await as(client, other).get(`${A}/requests/${request.id}`)).assertStatus(404)
    ;(await decide(client, other, request.id, { decision: 'APPROVE' })).assertStatus(404)
    assert.equal((await as(client, other).get(`${A}/requests`)).body().meta.total, 0)

    const { tenant, admin } = await tenantWithAdmin(undefined, false)
    const bare = await signIn(client, admin.email, tenant.id)
    const denied = await as(client, bare).get(`${A}/requests`)
    denied.assertStatus(403)
    assert.equal(denied.body().error.code, 'NOT_ENTITLED')
    assert.lengthOf((await as(client, bare).get('/api/v1/me/tasks')).body().data, 0)
  })
})
