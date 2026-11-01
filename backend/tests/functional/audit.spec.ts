import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { AUDIT_EXEMPT_TABLES } from '#core/audit/index'
import { iamServices } from '#core/permissions/index'
import { capture } from '#tests/support/capture'
import { deleteTestUsers, resetAuthState } from '#tests/support/auth_fixture'
import { createActiveTenant, deleteTestTenants } from '#tests/support/membership_fixture'
import { api, login, newActor } from '#tests/support/api_fixture'
import type { Tenant } from '#platform/tenants/index'

let counter = 0
const uid = () => `${process.pid}${counter++}`

async function setup(client: any) {
  const tenant = await createActiveTenant()
  const admin = await newActor(client, tenant, true)
  const operator = await newActor(client, tenant)
  return { tenant, admin, operator, http: api(client, tenant, admin) }
}

const auditRows = (tenant: Tenant, where = '') =>
  db.connection('owner').transaction(async (trx) => {
    await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [tenant.id])
    const result = await trx.rawQuery(`select * from audit_logs ${where} order by occurred_at`)
    return result.rows as any[]
  })

test.group('auditoria | histórico de alterações', (group) => {
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

  test('uma alteração gera uma entrada com actor, correlação, antes e depois', async ({
    client,
    assert,
  }) => {
    const { tenant, admin, http } = await setup(client)
    const created = await http.post('/api/v1/people', {
      givenNames: 'Ana',
      familyName: `Silva${uid()}`,
      identityType: 'BI',
      identityNumber: '004567AB',
    })
    created.assertStatus(201)
    const partyId = created.body().data.id

    const rows = await auditRows(tenant, `where resource_id = '${partyId}'`)
    const insert = rows.find((r) => r.action === 'parties.INSERT')
    assert.exists(insert)
    assert.strictEqual(insert.actor_type, 'USER')
    assert.strictEqual(insert.actor_user_id, admin.userId)
    assert.strictEqual(insert.actor_membership_id, admin.membershipId)
    assert.isNull(insert.before_data)
    assert.exists(insert.after_data)
    assert.strictEqual(insert.correlation_id, created.header('x-correlation-id'))

    // Campos sensíveis nunca chegam em claro à auditoria.
    const people = await auditRows(tenant, `where resource_type = 'people'`)
    assert.isAbove(people.length, 0)
    assert.notInclude(JSON.stringify(people), '004567AB')
    assert.include(JSON.stringify(people), '[REDACTED]')
  })

  test('atualização guarda antes e depois; só o admin (audit.read) consulta', async ({
    client,
    assert,
  }) => {
    const { tenant, operator, http } = await setup(client)
    const party = (
      await http.post('/api/v1/organization-parties', { legalName: `Forn ${uid()}, Lda.` })
    ).body().data
    ;(
      await http.patch(`/api/v1/parties/${party.id}`, {
        expectedVersion: party.version,
        displayName: 'Novo Nome',
      })
    ).assertStatus(200)

    const list = await http.get(`/api/v1/audit-logs?resourceId=${party.id}&action=parties.UPDATE`)
    list.assertStatus(200)
    const [entry] = list.body().data
    assert.strictEqual(entry.before.displayName, party.displayName)
    assert.strictEqual(entry.after.displayName, 'Novo Nome')

    ;(await api(client, tenant, operator).get('/api/v1/audit-logs')).assertStatus(403)
    ;(await api(client, tenant, operator).get('/api/v1/security-events')).assertStatus(403)
    ;(await http.get('/api/v1/audit-logs?limit=1000')).assertStatus(422)
    ;(await http.get('/api/v1/audit-logs?resourceId=nao-uuid')).assertStatus(422)
  })

  test('cada recurso só aparece a quem o pode ler e os campos escondidos saem do antes/depois', async ({
    client,
    assert,
  }) => {
    const { tenant, operator, http } = await setup(client)
    const person = (
      await http.post('/api/v1/people', {
        givenNames: 'Ana',
        familyName: `Silva${uid()}`,
        birthDate: '1990-05-17',
      })
    ).body().data

    const role = (
      await http.post('/api/v1/roles', {
        code: 'auditor_party',
        name: 'Auditor de party',
        permissionCodes: ['audit.read', 'party.read'],
      })
    ).body().data
    await http.post('/api/v1/role-assignments', {
      membershipId: operator.membershipId,
      roleId: role.id,
    })
    const asOperator = api(client, tenant, operator)

    const visible = (await asOperator.get('/api/v1/audit-logs?limit=100')).body().data as any[]
    assert.isAbove(visible.length, 0)
    // Sem iam.read/member.read, histórico de papéis e membros não aparece.
    assert.isTrue(
      visible.every((e) =>
        [
          'parties',
          'people',
          'contacts',
          'addresses',
          'organization_parties',
          'party_relationships',
        ].includes(e.resourceType)
      )
    )
    const personEntry = visible.find(
      (e) => e.resourceType === 'people' && e.after?.partyId === person.id
    )
    assert.exists(personEntry)

    ;(
      await http.post('/api/v1/access-policies', {
        name: 'esconde nascimento',
        resource: 'party',
        action: 'read',
        effect: 'ALLOW',
        status: 'ACTIVE',
        fieldRules: [{ field: 'birthDate', mode: 'HIDDEN' }],
      })
    ).assertStatus(201)
    const after = (await asOperator.get('/api/v1/audit-logs?limit=100')).body().data as any[]
    assert.notInclude(JSON.stringify(after), '1990-05-17')
    assert.notInclude(JSON.stringify(after), 'birthDate')
  })

  test('o histórico não atravessa tenants', async ({ client, assert }) => {
    const a = await setup(client)
    const b = await setup(client)
    await a.http.post('/api/v1/organization-parties', { legalName: `Forn A ${uid()}` })
    await b.http.post('/api/v1/organization-parties', { legalName: `Forn B ${uid()}` })
    const seenByA = (await a.http.get('/api/v1/audit-logs?limit=100')).body().data as any[]
    const ownRows = await auditRows(a.tenant)
    assert.isAbove(seenByA.length, 0)
    assert.isTrue(seenByA.every((e) => ownRows.some((r) => r.id === e.id)))
    assert.notInclude(JSON.stringify(seenByA), 'Forn B')
    // Selector alheio: 403 igual a "sem membership".
    ;(await api(client, b.tenant, a.admin).get('/api/v1/audit-logs')).assertStatus(403)
  })

  test('as entradas são imutáveis (nem a conta dona as altera sem o desvio explícito)', async ({
    client,
    assert,
  }) => {
    const { tenant, http } = await setup(client)
    await http.post('/api/v1/organization-parties', { legalName: `Forn ${uid()}` })
    const [row] = await auditRows(tenant)
    assert.exists(row)

    const attempt = (sql: string) =>
      capture(() =>
        db.connection('owner').transaction(async (trx) => {
          await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [tenant.id])
          await trx.rawQuery(sql)
        })
      )
    assert.match(
      (await attempt(`update audit_logs set reason = 'x' where id = '${row.id}'`)).message,
      /imut|immutable|audit/i
    )
    assert.match(
      (await attempt(`delete from audit_logs where id = '${row.id}'`)).message,
      /imut|immutable|audit/i
    )
    // A conta de runtime nem consegue pedir o desvio: o GUC só vale numa sessão dona.
    const runtime = await capture(() =>
      db.connection('runtime').transaction(async (trx) => {
        await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [tenant.id])
        await trx.rawQuery("select set_config('app.audit_purge', 'on', true)")
        await trx.rawQuery(`delete from audit_logs where id = '${row.id}'`)
      })
    )
    assert.match(runtime.message, /permission denied/)
  })
})

test.group('auditoria | eventos de segurança', (group) => {
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

  test('login, falha, logout e permissão negada ficam registados sem segredos', async ({
    client,
    assert,
  }) => {
    const { tenant, admin, operator, http } = await setup(client)
    ;(
      await client
        .post('/api/v1/auth/login')
        .json({ email: operator.email, password: 'errada-123' })
    ).assertStatus(401)
    ;(await api(client, tenant, operator).get('/api/v1/roles')).assertStatus(403)
    const second = await login(client, operator.email)
    ;(
      await client
        .post('/api/v1/auth/logout')
        .header('cookie', second.cookie)
        .header('x-csrf-token', second.csrf)
    ).assertStatus(204)

    const mine = (await api(client, tenant, operator).get('/api/v1/me/security-events')).body()
      .data as any[]
    const types = mine.map((e) => e.type)
    assert.include(types, 'LOGIN_SUCCEEDED')
    assert.include(types, 'LOGOUT')
    assert.include(types, 'PERMISSION_DENIED')
    assert.notInclude(JSON.stringify(mine), 'errada-123')
    assert.notInclude(JSON.stringify(mine), operator.email)

    const events = (await http.get('/api/v1/security-events')).body().data as any[]
    assert.isTrue(events.every((e) => e.tenantId === tenant.id))
    assert.include(
      events.map((e) => e.type),
      'PERMISSION_DENIED'
    )

    const other = (await api(client, tenant, admin).get('/api/v1/me/security-events')).body()
      .data as any[]
    assert.isTrue(other.every((e) => e.userId === admin.userId))
  })

  test('CSRF inválido gera evento; mudanças de conta e tenant geram eventos por trigger', async ({
    client,
    assert,
  }) => {
    const { tenant, admin } = await setup(client)
    const bad = await client
      .post('/api/v1/organization-parties')
      .header('cookie', admin.cookie)
      .header('x-tenant-id', tenant.id)
      .header('x-csrf-token', 'invalido')
      .json({ legalName: 'X' })
    bad.assertStatus(403)

    const rows = await db
      .connection('owner')
      .from('security_events')
      .where('user_id', admin.userId)
      .orWhere('tenant_id', tenant.id)
    const types = rows.map((r: any) => r.event_type)
    assert.include(types, 'CSRF_REJECTED')
    assert.include(types, 'USER_CREATED')
    assert.include(types, 'TENANT_CREATED')
    assert.notInclude(JSON.stringify(rows), 'password_hash')
  })
})

test.group('auditoria | conformidade do esquema', () => {
  test('toda a tabela de tenant tem trigger de auditoria ou isenção justificada', async ({
    assert,
  }) => {
    const owner = db.connection('owner')
    const tenantTables = (
      await owner.rawQuery(
        `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
         where n.nspname = 'public' and c.relkind = 'r' and c.relname not in ('security_events')`
      )
    ).rows.map((r: any) => r.name as string)
    const audited = new Set(
      (
        await owner.rawQuery(
          `select c.relname as name from pg_trigger t join pg_class c on c.oid = t.tgrelid
           where t.tgname = c.relname || '_audit' and not t.tgisinternal`
        )
      ).rows.map((r: any) => r.name as string)
    )
    const missing = tenantTables.filter(
      (t: string) => !audited.has(t) && !(t in AUDIT_EXEMPT_TABLES)
    )
    assert.deepEqual(missing, [], 'tabelas de tenant sem auditoria nem isenção justificada')
    for (const [table, reason] of Object.entries(AUDIT_EXEMPT_TABLES)) {
      assert.isAbove(reason.length, 10, `${table}: motivo da isenção`)
      assert.notInclude([...audited], table, `${table}: isenta mas auditada`)
    }
  })
})
