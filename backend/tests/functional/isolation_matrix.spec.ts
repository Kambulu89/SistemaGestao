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

const PDF = Buffer.from('%PDF-1.4\n%%EOF\n')

function upload(client: any, s: Session, subjectType: string, subjectId: string) {
  return client
    .post('/api/v1/attachments')
    .header('cookie', s.cookie)
    .header('x-xsrf-token', s.xsrf)
    .header('x-tenant-id', s.tenantId)
    .field('subjectType', subjectType)
    .field('subjectId', subjectId)
    .file('file', PDF, { filename: 'a.pdf' })
}

/** Empresa A com um registo de cada tipo; devolve os ids. */
async function populate(client: any) {
  const { tenant, admin } = await tenantWithAdmin()
  const s = await signIn(client, admin.email, tenant.id)
  const ok = (r: any, status = 201) => {
    if (r.status() !== status) throw new Error(JSON.stringify(r.body()))
    return r.body().data
  }
  const le = ok(
    await as(client, s).post('/api/v1/organization/legal-entities', {
      code: 'LEA',
      legalName: 'Entidade A, Lda.',
      taxId: '5000000101',
      countryCode: 'AO',
      functionalCurrency: 'AOA',
    })
  )
  const branch = ok(
    await as(client, s).post('/api/v1/organization/branches', {
      code: 'BRA',
      name: 'Filial A',
      legalEntityId: le.id,
    })
  )
  const role = await createRole(client, s, 'aprovador_a', ['members.read'])
  const approver = await memberWithRoles(client, s, [role.id])
  const wf = ok(
    await as(client, s).post('/api/v1/approvals/workflows', {
      code: 'WFA',
      name: 'Workflow A',
      subjectType: 'manual',
      steps: [{ name: 'Etapa', approverType: 'MEMBER', approverMembershipId: approver.memberId }],
    })
  )
  ok(
    await as(client, s).post(`/api/v1/approvals/workflows/${wf.id}/publish`, {
      expectedVersion: wf.version,
    }),
    200
  )
  const request = ok(
    await as(client, s).post('/api/v1/approvals/requests', { workflowId: wf.id, title: 'Pedido A' })
  )
  const delegation = ok(
    await as(client, approver.session).post('/api/v1/approvals/delegations', {
      delegateMembershipId: (await as(client, s).get('/api/v1/context')).body().data.membershipId,
      endsAt: new Date(Date.now() + 86_400_000).toISOString(),
      reason: 'Ausência',
    })
  )
  const attachment = ok(await upload(client, s, 'legal_entity', le.id))
  const notification = (await as(client, approver.session).get('/api/v1/me/notifications')).body()
    .data[0]
  const audit = (await as(client, s).get('/api/v1/audit-events?limit=1')).body().data[0]
  return {
    tenantId: tenant.id,
    le,
    branch,
    role,
    member: approver.memberId,
    wf,
    request,
    delegation,
    attachment,
    notification,
    audit,
  }
}

test.group('isolamento | matriz entre empresas', (group) => {
  group.each.setup(() => cleanDatabase())

  test('o administrador de outra empresa (todas as permissões) não lê, altera nem refere registos de A', async ({
    client,
    assert,
  }) => {
    const a = await populate(client)
    const { tenant, admin } = await tenantWithAdmin()
    const b = await signIn(client, admin.email, tenant.id)
    const B = as(client, b)
    const v = { expectedVersion: 1 }

    const attempts: [string, Promise<any>][] = [
      ['GET entidade', B.get(`/api/v1/organization/legal-entities/${a.le.id}`)],
      [
        'PATCH entidade',
        B.patch(`/api/v1/organization/legal-entities/${a.le.id}`, { ...v, tradeName: 'x' }),
      ],
      ['GET filial', B.get(`/api/v1/organization/branches/${a.branch.id}`)],
      ['GET perfil', B.get(`/api/v1/roles/${a.role.id}`)],
      ['PATCH perfil', B.patch(`/api/v1/roles/${a.role.id}`, { ...v, name: 'x' })],
      ['DELETE perfil', B.delete(`/api/v1/roles/${a.role.id}`)],
      ['GET membro', B.get(`/api/v1/members/${a.member}`)],
      ['suspender membro', B.post(`/api/v1/members/${a.member}/suspend`, v)],
      ['GET workflow', B.get(`/api/v1/approvals/workflows/${a.wf.id}`)],
      ['retirar workflow', B.post(`/api/v1/approvals/workflows/${a.wf.id}/retire`, v)],
      ['GET pedido', B.get(`/api/v1/approvals/requests/${a.request.id}`)],
      [
        'decidir pedido',
        B.post(`/api/v1/approvals/requests/${a.request.id}/decisions`, { decision: 'APPROVE' }),
      ],
      ['cancelar pedido', B.post(`/api/v1/approvals/requests/${a.request.id}/cancel`, {})],
      ['revogar delegação', B.post(`/api/v1/approvals/delegations/${a.delegation.id}/revoke`)],
      ['descarregar anexo', B.get(`/api/v1/attachments/${a.attachment.id}/content`)],
      ['eliminar anexo', B.delete(`/api/v1/attachments/${a.attachment.id}`)],
      [
        'listar anexos de A',
        B.get(`/api/v1/attachments?subjectType=legal_entity&subjectId=${a.le.id}`),
      ],
      ['marcar notificação', B.post(`/api/v1/me/notifications/${a.notification.id}/read`)],
    ]
    const wrong: string[] = []
    for (const [name, promise] of attempts) {
      const status = (await promise).status()
      if (status !== 404) wrong.push(`${name} → ${status}`)
    }
    assert.deepEqual(wrong, [])

    // Referências a ids de A em escritas de B: recusadas (nunca ligam linhas de empresas diferentes).
    const crossRef = await B.post('/api/v1/organization/branches', {
      code: 'BRX',
      name: 'Filial cruzada',
      legalEntityId: a.le.id,
    })
    assert.include([404, 422], crossRef.status())
    ;(await upload(client, b, 'legal_entity', a.le.id)).assertStatus(404)
    const wfCross = await B.post('/api/v1/approvals/workflows', {
      code: 'WFX',
      name: 'Workflow cruzado',
      subjectType: 'manual',
      steps: [{ name: 'Etapa', approverType: 'MEMBER', approverMembershipId: a.member }],
    })
    wfCross.assertStatus(422)
    const assignCross = await B.post(
      `/api/v1/members/${(await B.get('/api/v1/context')).body().data.membershipId}/roles`,
      { roleId: a.role.id }
    )
    assert.include([403, 404, 422], assignCross.status())

    // Listas de B não contêm nada de A.
    const lists = await Promise.all([
      B.get('/api/v1/organization/legal-entities'),
      B.get('/api/v1/roles'),
      B.get('/api/v1/members'),
      B.get('/api/v1/approvals/workflows'),
      B.get('/api/v1/approvals/requests'),
      B.get('/api/v1/approvals/delegations?all=true'),
      B.get('/api/v1/audit-events?limit=200'),
      B.get('/api/v1/me/notifications'),
      B.get('/api/v1/me/tasks'),
    ])
    const idsOfA = new Set(
      [
        a.le.id,
        a.branch.id,
        a.role.id,
        a.member,
        a.wf.id,
        a.request.id,
        a.delegation.id,
        a.audit.id,
      ].map(String)
    )
    const leaked = lists.flatMap((r) =>
      (r.body().data as any[]).filter((item) => idsOfA.has(item.id) || idsOfA.has(item.subjectId))
    )
    assert.deepEqual(leaked, [])

    // Nada de A mudou.
    const owner = db.connection('owner')
    const le = await owner.rawQuery('select version, trade_name from legal_entities where id = ?', [
      a.le.id,
    ])
    assert.deepEqual(le.rows[0], { version: 1, trade_name: null })
    const req = await owner.rawQuery('select status from approval_requests where id = ?', [
      a.request.id,
    ])
    assert.equal(req.rows[0].status, 'PENDING')
    const att = await owner.rawQuery('select status from attachments where id = ?', [
      a.attachment.id,
    ])
    assert.equal(att.rows[0].status, 'ACTIVE')
  })

  test('com a sessão de B e X-Tenant-Id de A todas as rotas de empresa são negadas', async ({
    client,
    assert,
  }) => {
    const a = await populate(client)
    const { tenant, admin } = await tenantWithAdmin()
    const b = await signIn(client, admin.email, tenant.id)
    const spoof = as(client, { ...b, tenantId: a.tenantId })
    for (const url of [
      '/api/v1/context',
      '/api/v1/organization/legal-entities',
      `/api/v1/organization/legal-entities/${a.le.id}`,
      '/api/v1/members',
      '/api/v1/approvals/requests',
      `/api/v1/attachments/${a.attachment.id}/content`,
      '/api/v1/audit-events',
      '/api/v1/me/notifications',
    ]) {
      const r = await spoof.get(url)
      assert.equal(r.status(), 403, url)
      assert.equal(r.body().error.code, 'TENANT_ACCESS_DENIED', url)
    }
  })
})
