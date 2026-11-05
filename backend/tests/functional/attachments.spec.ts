import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import {
  as,
  cleanDatabase,
  createRole,
  memberWithRoles,
  signIn,
  subscribe,
  tenantWithAdmin,
  type Session,
} from '#tests/support/fixtures'

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n')
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

function upload(
  client: any,
  s: Session,
  subjectType: string,
  subjectId: string,
  content: Buffer,
  filename: string
) {
  return client
    .post('/api/v1/attachments')
    .header('cookie', s.cookie)
    .header('x-xsrf-token', s.xsrf)
    .header('x-tenant-id', s.tenantId)
    .field('subjectType', subjectType)
    .field('subjectId', subjectId)
    .file('file', content, { filename, contentType: 'application/octet-stream' })
}

async function setup(client: any) {
  const { tenant, admin } = await tenantWithAdmin()
  const session = await signIn(client, admin.email, tenant.id)
  const le = await as(client, session).post('/api/v1/organization/legal-entities', {
    code: 'LE1',
    legalName: 'Entidade Um, Lda.',
    taxId: '5000000001',
    countryCode: 'AO',
    functionalCurrency: 'AOA',
  })
  le.assertStatus(201)
  return { session, tenant, legalEntityId: le.body().data.id as string }
}

test.group('anexos | acesso herdado do registo', (group) => {
  group.each.setup(() => cleanDatabase())

  test('carrega, lista e descarrega com cabeçalhos seguros; nome sem caminho; auditado', async ({
    client,
    assert,
  }) => {
    const { session, legalEntityId } = await setup(client)
    const uploaded = await upload(
      client,
      session,
      'legal_entity',
      legalEntityId,
      PDF,
      '../../etc/Relatório "final".pdf'
    )
    uploaded.assertStatus(201)
    const attachment = uploaded.body().data
    assert.equal(attachment.fileName, 'Relatório _final_.pdf')
    assert.equal(attachment.contentType, 'application/pdf')
    assert.equal(attachment.sizeBytes, PDF.length)
    assert.lengthOf(attachment.sha256, 64)

    const list = await as(client, session).get(
      `/api/v1/attachments?subjectType=legal_entity&subjectId=${legalEntityId}`
    )
    assert.lengthOf(list.body().data, 1)

    const download = await as(client, session).get(`/api/v1/attachments/${attachment.id}/content`)
    download.assertStatus(200)
    assert.equal(download.header('content-type'), 'application/pdf')
    assert.equal(download.header('x-content-type-options'), 'nosniff')
    assert.match(download.header('content-disposition'), /^attachment; /)
    assert.include(download.header('content-disposition'), "filename*=UTF-8''Relat%C3%B3rio")
    assert.isTrue(Buffer.from(download.body() as Buffer).equals(PDF))

    const stored = await db
      .connection('owner')
      .rawQuery('select storage_key from attachments where id = ?', [attachment.id])
    assert.match(stored.rows[0].storage_key, new RegExp(`^${session.tenantId}/`))
    assert.notInclude(stored.rows[0].storage_key, 'Relat')

    const events = (
      await as(client, session).get(
        `/api/v1/audit-events?entityType=attachment&entityId=${attachment.id}`
      )
    ).body().data
    assert.sameMembers(
      events.map((e: any) => e.action),
      ['attachment.uploaded', 'attachment.downloaded']
    )
  })

  test('rejeita tipos não aceites, conteúdo que não corresponde e ficheiros vazios', async ({
    client,
    assert,
  }) => {
    const { session, legalEntityId } = await setup(client)
    const exe = await upload(client, session, 'legal_entity', legalEntityId, PDF, 'virus.exe')
    exe.assertStatus(422)
    assert.equal(exe.body().error.details[0].code, 'TYPE_NOT_ALLOWED')
    const html = await upload(
      client,
      session,
      'legal_entity',
      legalEntityId,
      Buffer.from('<script>'),
      'a.html'
    )
    assert.equal(html.body().error.details[0].code, 'TYPE_NOT_ALLOWED')
    const fake = await upload(client, session, 'legal_entity', legalEntityId, PNG, 'falso.pdf')
    assert.equal(fake.body().error.details[0].code, 'CONTENT_MISMATCH')
    const binaryText = await upload(
      client,
      session,
      'legal_entity',
      legalEntityId,
      Buffer.from([0x41, 0, 0x42]),
      'notas.txt'
    )
    assert.equal(binaryText.body().error.details[0].code, 'CONTENT_MISMATCH')
    const png = await upload(client, session, 'legal_entity', legalEntityId, PNG, 'imagem.PNG')
    png.assertStatus(201)
    assert.equal(png.body().data.contentType, 'image/png')
    ;(await upload(client, session, 'tipo_desconhecido', legalEntityId, PDF, 'a.pdf')).assertStatus(
      404
    )
    ;(
      await upload(client, session, 'legal_entity', crypto.randomUUID(), PDF, 'a.pdf')
    ).assertStatus(404)
  })

  test('herda permissões: leitura sem escrita, sem leitura não vê, eliminação lógica', async ({
    client,
    assert,
  }) => {
    const { session, legalEntityId } = await setup(client)
    const reader = await createRole(client, session, 'leitor_org', ['organization.read'])
    const readerMember = await memberWithRoles(client, session, [reader.id])
    const stranger = await memberWithRoles(client, session, [])
    const { id } = (
      await upload(client, session, 'legal_entity', legalEntityId, PDF, 'a.pdf')
    ).body().data

    ;(await as(client, readerMember.session).get(`/api/v1/attachments/${id}/content`)).assertStatus(
      200
    )
    ;(
      await upload(client, readerMember.session, 'legal_entity', legalEntityId, PDF, 'b.pdf')
    ).assertStatus(403)
    ;(await as(client, readerMember.session).delete(`/api/v1/attachments/${id}`)).assertStatus(403)
    ;(await as(client, stranger.session).get(`/api/v1/attachments/${id}/content`)).assertStatus(404)
    ;(
      await as(client, stranger.session).get(
        `/api/v1/attachments?subjectType=legal_entity&subjectId=${legalEntityId}`
      )
    ).assertStatus(404)

    ;(await as(client, session).delete(`/api/v1/attachments/${id}`)).assertStatus(204)
    ;(await as(client, session).get(`/api/v1/attachments/${id}/content`)).assertStatus(404)
    const row = await db
      .connection('owner')
      .rawQuery('select status, deleted_at from attachments where id = ?', [id])
    assert.equal(row.rows[0].status, 'DELETED')
    assert.isNotNull(row.rows[0].deleted_at)
  })

  test('isolamento entre empresas e quota contratada de armazenamento', async ({
    client,
    assert,
  }) => {
    const a = await setup(client)
    const { id } = (
      await upload(client, a.session, 'legal_entity', a.legalEntityId, PDF, 'a.pdf')
    ).body().data
    const b = await setup(client)
    ;(await as(client, b.session).get(`/api/v1/attachments/${id}/content`)).assertStatus(404)
    ;(await as(client, b.session).delete(`/api/v1/attachments/${id}`)).assertStatus(404)
    // Anexar a um registo de outra empresa: o registo não existe neste tenant.
    ;(await upload(client, b.session, 'legal_entity', a.legalEntityId, PDF, 'x.pdf')).assertStatus(
      404
    )

    // Plano com 1 MB: o segundo ficheiro de 600 KB ultrapassa a quota.
    const { PlatformSubscriptionService } = await import('#modules/subscription/index')
    const plans = new PlatformSubscriptionService()
    const plan = await plans.createPlan({
      code: 'UM_MEGA',
      name: 'Plano de 1 MB',
      features: [
        { featureCode: 'organization' },
        { featureCode: 'legal_entities.max', limitValue: 5 },
        { featureCode: 'attachments.storage_mb', limitValue: 1 },
      ],
    })
    await plans.setPlanStatus(plan.id, 'ACTIVE')
    const { tenant, admin } = await tenantWithAdmin(undefined, false)
    await subscribe(tenant.id, plan.id)
    const small = await signIn(client, admin.email, tenant.id)
    const le = await as(client, small).post('/api/v1/organization/legal-entities', {
      code: 'LE9',
      legalName: 'Entidade Nove, Lda.',
      taxId: '5000000009',
      countryCode: 'AO',
      functionalCurrency: 'AOA',
    })
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(600 * 1024, 0x20)])
    ;(await upload(client, small, 'legal_entity', le.body().data.id, big, 'um.pdf')).assertStatus(
      201
    )
    const over = await upload(client, small, 'legal_entity', le.body().data.id, big, 'dois.pdf')
    over.assertStatus(409)
    assert.equal(over.body().error.code, 'QUOTA_EXCEEDED')
    const count = await db
      .connection('owner')
      .rawQuery('select count(*)::int as n from attachments where tenant_id = ?', [tenant.id])
    assert.equal(count.rows[0].n, 1)
  })

  test('anexos de pedidos de aprovação: o requerente anexa enquanto pendente, o aprovador lê', async ({
    client,
    assert,
  }) => {
    const { session } = await setup(client)
    const requesterRole = await createRole(client, session, 'requerente', ['approvals.request'])
    const requester = await memberWithRoles(client, session, [requesterRole.id])
    const approver = await memberWithRoles(client, session, [])
    const outsider = await memberWithRoles(client, session, [])
    const wf = await as(client, session).post('/api/v1/approvals/workflows', {
      code: 'COMPRA',
      name: 'Compras',
      subjectType: 'manual',
      steps: [{ name: 'Chefia', approverType: 'MEMBER', approverMembershipId: approver.memberId }],
    })
    await as(client, session).post(`/api/v1/approvals/workflows/${wf.body().data.id}/publish`, {
      expectedVersion: wf.body().data.version,
    })
    const request = (
      await as(client, requester.session).post('/api/v1/approvals/requests', {
        workflowId: wf.body().data.id,
        title: 'Compra de cadeiras',
      })
    ).body().data
    const att = await upload(
      client,
      requester.session,
      'approval_request',
      request.id,
      PDF,
      'orc.pdf'
    )
    att.assertStatus(201)
    ;(
      await as(client, approver.session).get(`/api/v1/attachments/${att.body().data.id}/content`)
    ).assertStatus(200)
    ;(
      await upload(client, approver.session, 'approval_request', request.id, PDF, 'x.pdf')
    ).assertStatus(403)
    ;(
      await as(client, outsider.session).get(`/api/v1/attachments/${att.body().data.id}/content`)
    ).assertStatus(404)

    await as(client, approver.session).post(`/api/v1/approvals/requests/${request.id}/decisions`, {
      decision: 'APPROVE',
    })
    const late = await upload(
      client,
      requester.session,
      'approval_request',
      request.id,
      PDF,
      'y.pdf'
    )
    late.assertStatus(403)
    assert.equal(late.body().error.code, 'FORBIDDEN')
  })
})
