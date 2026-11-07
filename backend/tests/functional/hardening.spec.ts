import { writeFile } from 'node:fs/promises'
import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'
import env from '#start/env'
import {
  as,
  cleanDatabase,
  createRole,
  lastTokenFor,
  memberWithRoles,
  PASSWORD,
  signIn,
  subscribe,
  tenantWithAdmin,
  type Session,
} from '#tests/support/fixtures'

const owner = () => db.connection('owner')

function upload(client: any, s: Session, subjectId: string, content: Buffer, name = 'a.pdf') {
  return client
    .post('/api/v1/attachments')
    .header('cookie', s.cookie)
    .header('x-xsrf-token', s.xsrf)
    .header('x-tenant-id', s.tenantId)
    .field('subjectType', 'legal_entity')
    .field('subjectId', subjectId)
    .file('file', content, { filename: name })
}

async function adminWithEntity(client: any, planId?: string) {
  const { tenant, admin } = await tenantWithAdmin(undefined, !planId)
  if (planId) await subscribe(tenant.id, planId)
  const s = await signIn(client, admin.email, tenant.id)
  const le = await as(client, s).post('/api/v1/organization/legal-entities', {
    code: 'LE1',
    legalName: 'Entidade Um, Lda.',
    taxId: '5000000001',
    countryCode: 'AO',
    functionalCurrency: 'AOA',
  })
  if (le.status() !== 201) throw new Error(JSON.stringify(le.body()))
  return { s, tenantId: tenant.id, leId: le.body().data.id as string }
}

async function approvalScenario(client: any) {
  const { tenant, admin } = await tenantWithAdmin()
  const s = await signIn(client, admin.email, tenant.id)
  const requesterRole = await createRole(client, s, 'requerente', ['approvals.request'])
  const requester = await memberWithRoles(client, s, [requesterRole.id])
  const approver = await memberWithRoles(client, s, [])
  const wf = await as(client, s).post('/api/v1/approvals/workflows', {
    code: 'WF',
    name: 'Workflow',
    subjectType: 'manual',
    steps: [{ name: 'Etapa', approverType: 'MEMBER', approverMembershipId: approver.memberId }],
  })
  const published = await as(client, s).post(
    `/api/v1/approvals/workflows/${wf.body().data.id}/publish`,
    { expectedVersion: wf.body().data.version }
  )
  return { s, requester, approver, workflow: published.body().data }
}

test.group('endurecimento | convites, concorrência, workflows e anexos', (group) => {
  group.each.setup(() => cleanDatabase())

  test('convite: duas aceitações simultâneas do mesmo token, só uma vale', async ({
    client,
    assert,
  }) => {
    const { tenant, admin } = await tenantWithAdmin()
    const s = await signIn(client, admin.email, tenant.id)
    await as(client, s).post('/api/v1/members/invitations', { email: 'dupla@teste.invalid' })
    const token = await lastTokenFor('dupla@teste.invalid', 'INVITATION')
    const results = await Promise.all(
      [0, 1].map(() =>
        client.post('/api/v1/auth/invitations/accept').json({ token, password: PASSWORD })
      )
    )
    assert.sameMembers(
      results.map((r) => r.status()),
      [200, 400]
    )
    const m = await owner().rawQuery(
      `select m.status from tenant_memberships m join users u on u.id = m.user_id where u.email = ?`,
      ['dupla@teste.invalid']
    )
    assert.deepEqual(
      m.rows.map((r: any) => r.status),
      ['ACTIVE']
    )
  })

  test('convite expirado é recusado e a membership continua convidada', async ({
    client,
    assert,
  }) => {
    const { tenant, admin } = await tenantWithAdmin()
    const s = await signIn(client, admin.email, tenant.id)
    await as(client, s).post('/api/v1/members/invitations', { email: 'tarde@teste.invalid' })
    const token = await lastTokenFor('tarde@teste.invalid', 'INVITATION')
    await owner().rawQuery(
      `update one_time_tokens set expires_at = now() - interval '1 minute' where purpose = 'INVITATION'`
    )
    const late = await client
      .post('/api/v1/auth/invitations/accept')
      .json({ token, password: PASSWORD })
    late.assertStatus(400)
    assert.equal(late.body().error.code, 'TOKEN_INVALID')
    const m = await owner().rawQuery(
      `select m.status from tenant_memberships m join users u on u.id = m.user_id where u.email = ?`,
      ['tarde@teste.invalid']
    )
    assert.equal(m.rows[0].status, 'INVITED')
    ;(
      await client
        .post('/api/v1/auth/invitations/accept')
        .json({ token: 'inventado', password: PASSWORD })
    ).assertStatus(400)
  })

  test('decidir e cancelar em simultâneo: só um ganha e o estado fica coerente', async ({
    client,
    assert,
  }) => {
    const sc = await approvalScenario(client)
    const req = await as(client, sc.requester.session).post('/api/v1/approvals/requests', {
      workflowId: sc.workflow.id,
      title: 'Corrida',
    })
    const id = req.body().data.id
    const [decide, cancel] = await Promise.all([
      as(client, sc.approver.session).post(`/api/v1/approvals/requests/${id}/decisions`, {
        decision: 'APPROVE',
      }),
      as(client, sc.requester.session).post(`/api/v1/approvals/requests/${id}/cancel`, {}),
    ])
    assert.sameMembers([decide.status(), cancel.status()], [200, 409])
    const row = await owner().rawQuery(
      `select r.status, (select count(*)::int from approval_decisions d where d.request_id = r.id) as decisions
         from approval_requests r where r.id = ?`,
      [id]
    )
    const { status, decisions } = row.rows[0]
    if (decide.status() === 200)
      assert.deepEqual({ status, decisions }, { status: 'APPROVED', decisions: 1 })
    else assert.deepEqual({ status, decisions }, { status: 'CANCELLED', decisions: 0 })
  })

  test('workflow retirado não aceita pedidos novos; os pendentes continuam a ser decididos', async ({
    client,
    assert,
  }) => {
    const sc = await approvalScenario(client)
    const pending = await as(client, sc.requester.session).post('/api/v1/approvals/requests', {
      workflowId: sc.workflow.id,
      title: 'Antes de retirar',
    })
    pending.assertStatus(201)
    ;(
      await as(client, sc.s).post(`/api/v1/approvals/workflows/${sc.workflow.id}/retire`, {
        expectedVersion: sc.workflow.version,
      })
    ).assertStatus(200)
    const after = await as(client, sc.requester.session).post('/api/v1/approvals/requests', {
      workflowId: sc.workflow.id,
      title: 'Depois de retirar',
    })
    after.assertStatus(422)
    const decided = await as(client, sc.approver.session).post(
      `/api/v1/approvals/requests/${pending.body().data.id}/decisions`,
      { decision: 'APPROVE' }
    )
    decided.assertStatus(200)
    assert.equal(decided.body().data.status, 'APPROVED')
  })

  test('quota de anexos: carregamentos simultâneos não a ultrapassam', async ({
    client,
    assert,
  }) => {
    const { PlatformSubscriptionService } = await import('#modules/subscription/index')
    const plans = new PlatformSubscriptionService()
    const plan = await plans.createPlan({
      code: 'QUOTA1',
      name: 'Quota de 1 MB',
      features: [
        { featureCode: 'organization' },
        { featureCode: 'legal_entities.max', limitValue: 5 },
        { featureCode: 'attachments.storage_mb', limitValue: 1 },
      ],
    })
    await plans.setPlanStatus(plan.id, 'ACTIVE')
    const { s, tenantId, leId } = await adminWithEntity(client, plan.id)
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(600 * 1024, 0x20)])
    const results = await Promise.all([
      upload(client, s, leId, big, 'um.pdf'),
      upload(client, s, leId, big, 'dois.pdf'),
    ])
    assert.sameMembers(
      results.map((r) => r.status()),
      [201, 409]
    )
    const n = await owner().rawQuery(
      'select count(*)::int as n from attachments where tenant_id = ?',
      [tenantId]
    )
    assert.equal(n.rows[0].n, 1)
  })

  test('anexo alterado no disco é detectado na descarga (integridade SHA-256)', async ({
    client,
    assert,
  }) => {
    const { s, leId } = await adminWithEntity(client)
    const created = await upload(client, s, leId, Buffer.from('%PDF-1.4\noriginal\n'))
    created.assertStatus(201)
    const row = await owner().rawQuery('select storage_key from attachments where id = ?', [
      created.body().data.id,
    ])
    const dir = env.get('ATTACHMENTS_DIR') ?? 'storage/attachments'
    await writeFile(app.makePath(dir, row.rows[0].storage_key), '%PDF-1.4\nadulterado\n')
    const download = await as(client, s).get(
      `/api/v1/attachments/${created.body().data.id}/content`
    )
    download.assertStatus(500)
    assert.notInclude(JSON.stringify(download.body()), 'adulterado')
  })
})
