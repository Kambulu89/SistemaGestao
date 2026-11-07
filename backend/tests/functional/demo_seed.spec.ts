import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { DEMO_USERS, seedDemo } from '#database/seeders/demo'
import { as, cleanDatabase, signIn } from '#tests/support/fixtures'

const PASSWORD = 'demo-palavra-passe-longa'

test.group('dados de demonstração', (group) => {
  group.each.setup(() => cleanDatabase())
  group.each.setup(() => {
    process.env.DEMO_PASSWORD = PASSWORD
    return () => {
      delete process.env.DEMO_PASSWORD
    }
  })

  test('cria uma empresa de demonstração utilizável e não repete', async ({ client, assert }) => {
    const first = await seedDemo()
    assert.isTrue(first.created)
    assert.isNull(first.generatedPassword)
    const again = await seedDemo()
    assert.isFalse(again.created)
    const tenants = await db
      .connection('owner')
      .rawQuery(`select id from tenants where code = 'DEMO'`)
    assert.lengthOf(tenants.rows, 1)
    const tenantId = tenants.rows[0].id

    // O colaborador submete um pedido no workflow de demonstração; a aprovação recebe a tarefa.
    const employee = await signIn(client, DEMO_USERS.employee.email, tenantId, PASSWORD)
    const workflows = (
      await as(client, employee).get('/api/v1/approvals/available-workflows')
    ).body().data
    assert.equal(workflows[0].code, 'DESPESAS')
    const request = await as(client, employee).post('/api/v1/approvals/requests', {
      workflowId: workflows[0].id,
      title: 'Despesa de demonstração',
    })
    request.assertStatus(201)
    const approver = await signIn(client, DEMO_USERS.approver.email, tenantId, PASSWORD)
    const tasks = (await as(client, approver).get('/api/v1/me/tasks')).body().data
    assert.lengthOf(tasks, 1)

    const admin = await signIn(client, DEMO_USERS.admin.email, tenantId, PASSWORD)
    const entities = await as(client, admin).get('/api/v1/organization/departments')
    assert.equal(entities.body().meta.total, 2)
    // Os dados de demonstração ficam auditados como qualquer outro.
    const audit = await as(client, admin).get('/api/v1/audit-events?action=legal_entity.created')
    assert.equal(audit.body().data[0].requestId, 'demo-seed')
  })
})
