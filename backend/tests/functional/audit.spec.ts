import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { redact } from '#modules/audit/index'
import {
  as,
  cleanDatabase,
  createRole,
  memberWithRoles,
  signIn,
  tenantWithAdmin,
} from '#tests/support/fixtures'

const AUDIT = '/api/v1/audit-events'

async function adminSession(client: any) {
  const { tenant, admin } = await tenantWithAdmin()
  return { session: await signIn(client, admin.email, tenant.id), tenant, admin }
}

test.group('auditoria | eventos só de acrescentar', (group) => {
  group.each.setup(() => cleanDatabase())

  test('operações sensíveis ficam registadas com actor, alterações e sem segredos', async ({
    client,
    assert,
  }) => {
    const { session, admin } = await adminSession(client)
    const le = await as(client, session).post('/api/v1/organization/legal-entities', {
      code: 'LE1',
      legalName: 'Entidade Um, Lda.',
      taxId: '5000000001',
      countryCode: 'AO',
      functionalCurrency: 'AOA',
    })
    le.assertStatus(201)
    const id = le.body().data.id
    const updated = await as(client, session).patch(`/api/v1/organization/legal-entities/${id}`, {
      expectedVersion: 1,
      tradeName: 'Um',
    })
    updated.assertStatus(200)
    // Uma gravação sem alterações não gera evento.
    await as(client, session).patch(`/api/v1/organization/legal-entities/${id}`, {
      expectedVersion: 2,
      tradeName: 'Um',
    })

    const role = await createRole(client, session, 'leitor', ['members.read'])
    const member = await memberWithRoles(client, session, [role.id])
    const current = (await as(client, session).get(`/api/v1/members/${member.memberId}`)).body()
      .data
    const suspend = await as(client, session).post(`/api/v1/members/${member.memberId}/suspend`, {
      expectedVersion: current.version,
    })
    suspend.assertStatus(200)

    const list = await as(client, session).get(`${AUDIT}?limit=100`)
    list.assertStatus(200)
    const actions = list.body().data.map((e: any) => e.action)
    assert.includeMembers(actions, [
      'tenant.created',
      'legal_entity.created',
      'legal_entity.updated',
      'role.created',
      'member.invited',
      'member.invitation_accepted',
      'member.suspended',
    ])
    assert.lengthOf(
      actions.filter((a: string) => a === 'legal_entity.updated'),
      1
    )

    const entityHistory = await as(client, session).get(
      `${AUDIT}?entityType=legal_entity&entityId=${id}`
    )
    const [latest, first] = entityHistory.body().data
    assert.deepEqual(latest.changes, { tradeName: { from: null, to: 'Um' } })
    assert.equal(latest.actor.email, admin.email)
    assert.equal(first.changes.code.to, 'LE1')

    const accepted = (
      await as(client, session).get(`${AUDIT}?action=member.invitation_accepted`)
    ).body().data[0]
    assert.equal(accepted.actor.email, member.email)

    const prefix = await as(client, session).get(`${AUDIT}?action=member.*`)
    assert.isTrue(prefix.body().data.every((e: any) => e.action.startsWith('member.')))
    ;(await as(client, session).get(`${AUDIT}?action=member'--`)).assertStatus(422)

    const raw = await db
      .connection('owner')
      .rawQuery(
        "select count(*)::int as n from audit_events where metadata::text ilike '%password%'"
      )
    assert.equal(raw.rows[0].n, 0)
  })

  test('consulta exige audit.read e só mostra a própria empresa', async ({ client, assert }) => {
    const a = await adminSession(client)
    const b = await adminSession(client)
    const member = await memberWithRoles(client, a.session, [])
    ;(await as(client, member.session).get(AUDIT)).assertStatus(403)

    const aEvents = (await as(client, a.session).get(`${AUDIT}?limit=200`)).body().data
    const bEvents = (await as(client, b.session).get(`${AUDIT}?limit=200`)).body().data
    const aIds = new Set(aEvents.map((e: any) => e.id))
    assert.isTrue(bEvents.every((e: any) => !aIds.has(e.id)))
    assert.isTrue(bEvents.every((e: any) => e.entityId !== a.tenant.id))
  })

  test('a conta de runtime não altera nem apaga eventos; o trigger também recusa', async ({
    assert,
  }) => {
    const { tenant } = await tenantWithAdmin()
    const runtime = db.connection('runtime')
    await assert.rejects(() =>
      runtime.transaction(async (trx) => {
        await trx.rawQuery(`select set_config('app.tenant_id', ?, true)`, [tenant.id])
        await trx.rawQuery(`update audit_events set action = 'x'`)
      })
    )
    await assert.rejects(() =>
      runtime.transaction(async (trx) => {
        await trx.rawQuery(`select set_config('app.tenant_id', ?, true)`, [tenant.id])
        await trx.rawQuery(`delete from audit_events`)
      })
    )
    await assert.rejects(() =>
      db.connection('owner').rawQuery(`update audit_events set action = 'x'`)
    )
    const count = await db
      .connection('owner')
      .rawQuery('select count(*)::int as n from audit_events where tenant_id = ?', [tenant.id])
    assert.isAbove(count.rows[0].n, 0)
  })

  test('redact retira chaves sensíveis em qualquer nível', ({ assert }) => {
    assert.deepEqual(
      redact({ email: 'a@b', password: 'x', nested: [{ resetToken: 't', ok: 1 }] }),
      { email: 'a@b', password: '[REDACTED]', nested: [{ resetToken: '[REDACTED]', ok: 1 }] }
    )
  })
})

test.group('notificações | caixa pessoal', (group) => {
  group.each.setup(() => cleanDatabase())

  test('cada membro só vê e marca as suas notificações', async ({ client, assert }) => {
    const { session } = await adminSession(client)
    const one = await memberWithRoles(client, session, [])
    const two = await memberWithRoles(client, session, [])
    const owner = db.connection('owner')
    const tenantId = session.tenantId
    for (const [recipient, title] of [
      [one.memberId, 'Primeira'],
      [one.memberId, 'Segunda'],
      [two.memberId, 'Da outra pessoa'],
    ]) {
      await owner.rawQuery(
        `insert into notifications (tenant_id, recipient_membership_id, type, title) values (?, ?, 'teste', ?)`,
        [tenantId, recipient, title]
      )
    }
    const inbox = await as(client, one.session).get('/api/v1/me/notifications')
    inbox.assertStatus(200)
    assert.equal(inbox.body().meta.total, 2)
    assert.equal(inbox.body().meta.unread, 2)
    const othersId = (await as(client, two.session).get('/api/v1/me/notifications')).body().data[0]
      .id
    ;(await as(client, one.session).post(`/api/v1/me/notifications/${othersId}/read`)).assertStatus(
      404
    )

    const first = inbox.body().data[0]
    const read = await as(client, one.session).post(`/api/v1/me/notifications/${first.id}/read`)
    read.assertStatus(200)
    assert.isNotNull(read.body().data.readAt)
    const unread = await as(client, one.session).get('/api/v1/me/notifications?unread=true')
    assert.equal(unread.body().meta.total, 1)
    const all = await as(client, one.session).post('/api/v1/me/notifications/read-all')
    assert.equal(all.body().data.updated, 1)
    assert.equal(
      (await as(client, two.session).get('/api/v1/me/notifications')).body().meta.unread,
      1
    )
  })
})
