import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { iamServices } from '#core/permissions/index'
import { customerServices } from '#modules/customers/index'
import { deleteTestUsers, resetAuthState } from '#tests/support/auth_fixture'
import { createActiveTenant, deleteTestTenants } from '#tests/support/membership_fixture'
import { api, newActor } from '#tests/support/api_fixture'
import { license, syncTestRegistry } from '#tests/support/modules_fixture'
import { serviceTenantContext } from '#core/tenancy/index'
import type { Tenant } from '#platform/tenants/index'

type Http = ReturnType<typeof api>

async function must<T>(response: { status(): number; body(): any }, status: number): Promise<T> {
  if (response.status() !== status) {
    throw new Error(
      `Esperado ${status}, obtido ${response.status()}: ${JSON.stringify(response.body())}`
    )
  }
  return response.body().data as T
}

let counter = 0
const uid = () => `${Date.now().toString(36)}${counter++}`

/** Tenant com `customers` licenciado e activo, uma organização e duas Party (pessoa e organização). */
async function setup(client: any, enable = true) {
  const tenant = await createActiveTenant()
  const admin = await newActor(client, tenant, true)
  const http = api(client, tenant, admin)
  await syncTestRegistry()
  await license(tenant, ['customers'])
  if (enable) await must(await http.post('/api/v1/tenant/modules/customers/enable', {}), 200)
  const org = await must<any>(
    await http.post('/api/v1/organizations', {
      code: 'EMP',
      legalName: 'Empresa, Lda.',
      countryCode: 'AO',
      baseCurrency: 'AOA',
    }),
    201
  )
  const org2 = await must<any>(
    await http.post('/api/v1/organizations', {
      code: 'EMP2',
      legalName: 'Empresa Dois, Lda.',
      countryCode: 'PT',
      baseCurrency: 'EUR',
    }),
    201
  )
  const maria = await must<any>(
    await http.post('/api/v1/people', {
      givenNames: 'Maria',
      familyName: `Silva ${uid()}`,
      contacts: [{ type: 'EMAIL', value: `maria.${uid()}@exemplo.invalid` }],
    }),
    201
  )
  const acme = await must<any>(
    await http.post('/api/v1/organization-parties', {
      legalName: `Acme ${uid()}, Lda.`,
      taxCountry: 'AO',
      taxId: '5000012345',
    }),
    201
  )
  return { tenant, admin, http, org, org2, maria, acme, client }
}

type Ctx = Awaited<ReturnType<typeof setup>>

async function memberWith(ctx: { client: any; tenant: Tenant; http: Http }, permissions: string[]) {
  const actor = await newActor(ctx.client, ctx.tenant)
  const role = await must<{ id: string }>(
    await ctx.http.post('/api/v1/roles', {
      code: `r_${Math.random().toString(36).slice(2, 10)}`,
      name: 'Papel de teste',
      permissionCodes: permissions,
    }),
    201
  )
  await must(
    await ctx.http.post('/api/v1/role-assignments', {
      membershipId: actor.membershipId,
      roleId: role.id,
    }),
    201
  )
  return { http: api(ctx.client, ctx.tenant, actor), actor }
}

const newCustomer = (ctx: Ctx, extra: Record<string, unknown> = {}) => ({
  partyId: ctx.acme.id,
  organizationId: ctx.org.id,
  code: 'CLI-001',
  ...extra,
})

const rowsOf = (tenant: Tenant, sql: string) =>
  db.connection('owner').transaction(async (trx) => {
    await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [tenant.id])
    return (await trx.rawQuery(sql)).rows as any[]
  })

test.group('clientes | cadastro', (group) => {
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

  test('um cliente liga-se a uma Party existente, sem a duplicar, e leva a moeda da organização', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const created = await must<any>(await ctx.http.post('/api/v1/customers', newCustomer(ctx)), 201)
    assert.deepInclude(created, {
      partyId: ctx.acme.id,
      organizationId: ctx.org.id,
      code: 'CLI-001',
      status: 'ACTIVE',
      currency: 'AOA',
      creditLimit: '0.0000',
      paymentTermDays: 0,
      taxId: '5000012345',
    })
    assert.equal(created.partyName, ctx.acme.displayName)
    // O cliente não criou nenhuma Party nova.
    const parties = await rowsOf(ctx.tenant, 'select 1 from parties')
    assert.lengthOf(parties, 2)

    // A mesma Party na mesma organização não se repete; noutra organização é outro cliente (com a moeda dela).
    const dup = await ctx.http.post('/api/v1/customers', newCustomer(ctx, { code: 'CLI-002' }))
    dup.assertStatus(409)
    assert.equal(dup.body().error.code, 'CUSTOMER_EXISTS')
    const other = await must<any>(
      await ctx.http.post(
        '/api/v1/customers',
        newCustomer(ctx, { code: 'CLI-002', organizationId: ctx.org2.id })
      ),
      201
    )
    assert.equal(other.currency, 'EUR')
    // Código repetido.
    const sameCode = await ctx.http.post(
      '/api/v1/customers',
      newCustomer(ctx, { partyId: ctx.maria.id })
    )
    sameCode.assertStatus(409)
    assert.equal(sameCode.body().error.code, 'CUSTOMER_CODE_TAKEN')
    // A falha desfez tudo: continuam os dois clientes.
    const all = await must<any[]>(await ctx.http.get('/api/v1/customers'), 200)
    assert.lengthOf(all, 2)
  })

  test('Party ou organização inexistentes (ou de outro tenant) são recusadas; os dados de identidade não mudam', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const other = await setup(client)
    const foreignParty = await ctx.http.post(
      '/api/v1/customers',
      newCustomer(ctx, { partyId: other.acme.id })
    )
    foreignParty.assertStatus(422)
    assert.equal(foreignParty.body().error.details[0].code, 'UNKNOWN_PARTY')
    const foreignOrg = await ctx.http.post(
      '/api/v1/customers',
      newCustomer(ctx, { organizationId: other.org.id })
    )
    foreignOrg.assertStatus(422)
    assert.equal(foreignOrg.body().error.details[0].code, 'UNKNOWN_ORGANIZATION')
    const created = await must<any>(await ctx.http.post('/api/v1/customers', newCustomer(ctx)), 201)
    const immutable = await ctx.http.patch(`/api/v1/customers/${created.id}`, {
      expectedVersion: created.version,
      code: 'OUTRO',
    })
    immutable.assertStatus(422)
    assert.equal(immutable.body().error.details[0].code, 'IMMUTABLE')
  })

  test('a lista pesquisa por nome, código e NIF e filtra por segmento, gestor e estado', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const segment = await must<any>(
      await ctx.http.post('/api/v1/customer-segments', { code: 'VIP', name: 'Clientes VIP' }),
      201
    )
    const manager = await memberWith(ctx, ['customer.read'])
    const acme = await must<any>(
      await ctx.http.post(
        '/api/v1/customers',
        newCustomer(ctx, {
          segmentId: segment.id,
          accountManagerMembershipId: manager.actor.membershipId,
          paymentTermDays: 30,
        })
      ),
      201
    )
    assert.equal(acme.segmentName, 'Clientes VIP')
    await must(
      await ctx.http.post(
        '/api/v1/customers',
        newCustomer(ctx, { partyId: ctx.maria.id, code: 'CLI-777', status: 'INACTIVE' })
      ),
      201
    )
    const codes = async (query: string) =>
      (await must<any[]>(await ctx.http.get(`/api/v1/customers?${query}`), 200)).map((c) => c.code)
    assert.sameMembers(await codes(''), ['CLI-001', 'CLI-777'])
    assert.deepEqual(await codes('q=acme'), ['CLI-001'])
    assert.deepEqual(await codes('q=5000012345'), ['CLI-001'])
    assert.deepEqual(await codes('q=cli-777'), ['CLI-777'])
    assert.deepEqual(await codes('q=maria'), ['CLI-777'])
    assert.deepEqual(await codes(`segmentId=${segment.id}`), ['CLI-001'])
    assert.deepEqual(await codes(`accountManagerMembershipId=${manager.actor.membershipId}`), [
      'CLI-001',
    ])
    assert.deepEqual(await codes('status=INACTIVE'), ['CLI-777'])
    assert.deepEqual(await codes('q=%25'), [])
    const page = await ctx.http.get('/api/v1/customers?limit=1')
    assert.equal(page.body().meta.total, 2)
    assert.lengthOf(page.body().data, 1)
  })

  test('segmento e gestor de conta têm de existir e estar activos', async ({ client, assert }) => {
    const ctx = await setup(client)
    const segment = await must<any>(
      await ctx.http.post('/api/v1/customer-segments', { code: 'PME', name: 'PME' }),
      201
    )
    ;(
      await ctx.http.post('/api/v1/customer-segments', { code: 'PME', name: 'Repetido' })
    ).assertStatus(409)
    const off = await must<any>(
      await ctx.http.patch(`/api/v1/customer-segments/${segment.id}`, {
        expectedVersion: segment.version,
        active: false,
      }),
      200
    )
    assert.isFalse(off.active)
    const inactive = await ctx.http.post(
      '/api/v1/customers',
      newCustomer(ctx, { segmentId: segment.id })
    )
    inactive.assertStatus(422)
    assert.equal(inactive.body().error.details[0].code, 'UNKNOWN_SEGMENT')
    const stranger = await ctx.http.post(
      '/api/v1/customers',
      newCustomer(ctx, { accountManagerMembershipId: '33333333-3333-4333-8333-333333333333' })
    )
    stranger.assertStatus(422)
    assert.equal(stranger.body().error.details[0].code, 'UNKNOWN_MEMBER')
    // Versão desactualizada.
    ;(
      await ctx.http.patch(`/api/v1/customer-segments/${segment.id}`, {
        expectedVersion: segment.version,
        name: 'x',
      })
    ).assertStatus(409)
  })
})

test.group('clientes | crédito, bloqueio e permissões', (group) => {
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

  test('o limite de crédito só se vê e altera com customer.credit_manage', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const finance = await memberWith(ctx, [
      'customer.read',
      'customer.create',
      'customer.update',
      'customer.credit_manage',
    ])
    const sales = await memberWith(ctx, ['customer.read', 'customer.create', 'customer.update'])
    const created = await must<any>(
      await finance.http.post(
        '/api/v1/customers',
        newCustomer(ctx, { creditLimit: '250000.5000', currency: 'AOA' })
      ),
      201
    )
    assert.equal(created.creditLimit, '250000.5000')

    // Vendas vê o cliente, mas não o crédito; nem o detalhe nem a lista o revelam.
    const asSales = await must<any>(await sales.http.get(`/api/v1/customers/${created.id}`), 200)
    assert.isNull(asSales.creditLimit)
    const list = await must<any[]>(await sales.http.get('/api/v1/customers'), 200)
    assert.isNull(list[0].creditLimit)
    const asFinance = await must<any>(
      await finance.http.get(`/api/v1/customers/${created.id}`),
      200
    )
    assert.equal(asFinance.creditLimit, '250000.5000')

    // Vendas não cria com crédito nem o altera, mas altera as restantes condições.
    ;(
      await sales.http.post(
        '/api/v1/customers',
        newCustomer(ctx, { partyId: ctx.maria.id, code: 'CLI-2', creditLimit: '1' })
      )
    ).assertStatus(403)
    ;(
      await sales.http.patch(`/api/v1/customers/${created.id}`, {
        expectedVersion: created.version,
        creditLimit: '999999',
      })
    ).assertStatus(403)
    const terms = await must<any>(
      await sales.http.patch(`/api/v1/customers/${created.id}`, {
        expectedVersion: created.version,
        paymentTermDays: 45,
      }),
      200
    )
    assert.equal(terms.paymentTermDays, 45)
    assert.isNull(terms.creditLimit)
    // O crédito não mudou com a alteração das condições.
    const rows = await rowsOf(ctx.tenant, 'select credit_limit::text as c from customers')
    assert.equal(rows[0].c, '250000.5000')

    const bad = await finance.http.patch(`/api/v1/customers/${created.id}`, {
      expectedVersion: terms.version,
      creditLimit: '10.12345',
    })
    bad.assertStatus(422)
    assert.equal(bad.body().error.details[0].code, 'INVALID_MONEY')
    const raised = await must<any>(
      await finance.http.patch(`/api/v1/customers/${created.id}`, {
        expectedVersion: terms.version,
        creditLimit: '300000',
      }),
      200
    )
    assert.equal(raised.creditLimit, '300000.0000')
  })

  test('bloquear exige motivo e permissão própria; bloqueado e inactivo não aceitam novas vendas', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const created = await must<any>(await ctx.http.post('/api/v1/customers', newCustomer(ctx)), 201)
    const context = serviceTenantContext(ctx.tenant.id, 'teste')
    const sales = customerServices().customers

    // Cliente activo: a venda é permitida.
    assert.equal((await sales.assertSaleAllowed(context, created.id)).id, created.id)

    const noReason = await ctx.http.post(`/api/v1/customers/${created.id}/block`, {
      expectedVersion: created.version,
      reason: '  ',
    })
    noReason.assertStatus(422)
    const blocked = await must<any>(
      await ctx.http.post(`/api/v1/customers/${created.id}/block`, {
        expectedVersion: created.version,
        reason: 'Dívida em atraso',
      }),
      200
    )
    assert.deepInclude(blocked, { status: 'BLOCKED', statusReason: 'Dívida em atraso' })
    const again = await ctx.http.post(`/api/v1/customers/${created.id}/block`, {
      expectedVersion: blocked.version,
      reason: 'Outra vez',
    })
    again.assertStatus(409)
    assert.equal(again.body().error.code, 'ALREADY_BLOCKED')
    const refused = await sales.assertSaleAllowed(context, created.id).catch((e) => e)
    assert.equal(refused.code, 'CUSTOMER_BLOCKED')
    assert.equal(refused.status, 409)

    // Um cliente bloqueado não se reactiva por edição, mas as outras condições continuam a poder regularizar-se.
    const sneaky = await ctx.http.patch(`/api/v1/customers/${created.id}`, {
      expectedVersion: blocked.version,
      status: 'ACTIVE',
    })
    sneaky.assertStatus(422)
    assert.equal(sneaky.body().error.details[0].code, 'USE_UNBLOCK')
    const terms = await must<any>(
      await ctx.http.patch(`/api/v1/customers/${created.id}`, {
        expectedVersion: blocked.version,
        paymentTermDays: 60,
      }),
      200
    )
    assert.equal(terms.status, 'BLOCKED')

    const open = await must<any>(
      await ctx.http.post(`/api/v1/customers/${created.id}/unblock`, {
        expectedVersion: terms.version,
      }),
      200
    )
    assert.deepInclude(open, { status: 'ACTIVE', statusReason: null })
    ;(
      await ctx.http.post(`/api/v1/customers/${created.id}/unblock`, {
        expectedVersion: open.version,
      })
    ).assertStatus(409)
    await sales.assertSaleAllowed(context, created.id)

    const inactive = await must<any>(
      await ctx.http.patch(`/api/v1/customers/${created.id}`, {
        expectedVersion: open.version,
        status: 'INACTIVE',
      }),
      200
    )
    assert.equal(inactive.status, 'INACTIVE')
    const gone = await sales.assertSaleAllowed(context, created.id).catch((e) => e)
    assert.equal(gone.code, 'CUSTOMER_INACTIVE')
    // Um cliente inexistente é 404, nunca "permitido".
    const missing = await sales
      .assertSaleAllowed(context, '33333333-3333-4333-8333-333333333333')
      .catch((e) => e)
    assert.equal(missing.status, 404)
  })

  test('cada operação tem a sua permissão; sem o módulo activo a API recusa', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const created = await must<any>(await ctx.http.post('/api/v1/customers', newCustomer(ctx)), 201)
    const reader = await memberWith(ctx, ['customer.read'])
    await must(await reader.http.get('/api/v1/customers'), 200)
    await must(await reader.http.get('/api/v1/customer-segments'), 200)
    ;(await reader.http.post('/api/v1/customers', newCustomer(ctx, { code: 'X' }))).assertStatus(
      403
    )
    ;(
      await reader.http.patch(`/api/v1/customers/${created.id}`, {
        expectedVersion: 1,
        paymentTermDays: 1,
      })
    ).assertStatus(403)
    ;(
      await reader.http.post(`/api/v1/customers/${created.id}/block`, {
        expectedVersion: 1,
        reason: 'x',
      })
    ).assertStatus(403)
    ;(await reader.http.post('/api/v1/customer-segments', { code: 'S', name: 'S' })).assertStatus(
      403
    )
    const updater = await memberWith(ctx, ['customer.update'])
    ;(await updater.http.get('/api/v1/customers')).assertStatus(403)
    const nobody = await memberWith(ctx, ['party.read'])
    ;(await nobody.http.get(`/api/v1/customers/${created.id}`)).assertStatus(403)
    ;(await nobody.http.get('/api/v1/interactions')).assertStatus(403)

    const off = await setup(client, false)
    const response = await off.http.get('/api/v1/customers')
    response.assertStatus(403)
    assert.equal(response.body().error.code, 'FEATURE_NOT_AVAILABLE')
    ;(await off.http.get('/api/v1/interactions')).assertStatus(403)
  })

  test('o detalhe só traz os contactos da Party a quem pode ler a Party', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const created = await must<any>(
      await ctx.http.post('/api/v1/customers', newCustomer(ctx, { partyId: ctx.maria.id })),
      201
    )
    const full = await must<any>(await ctx.http.get(`/api/v1/customers/${created.id}`), 200)
    assert.lengthOf(full.contacts, 1)
    const limited = await memberWith(ctx, ['customer.read'])
    const detail = await must<any>(await limited.http.get(`/api/v1/customers/${created.id}`), 200)
    assert.deepEqual(detail.contacts, [])
    assert.equal(detail.partyName, ctx.maria.displayName)
  })
})

test.group('clientes | interacções', (group) => {
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

  test('regista-se uma interacção com uma Party (mesmo sem cliente) e o responsável é quem a regista', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const rep = await memberWith(ctx, ['customer.read', 'customer.update'])
    const first = await must<any>(
      await rep.http.post('/api/v1/interactions', {
        partyId: ctx.maria.id,
        channel: 'CALL',
        subject: 'Primeiro contacto',
        occurredAt: '2026-10-20T09:00:00Z',
        summary: 'Interessada na gama nova.',
        followUpAt: '2026-10-30T09:00:00Z',
      }),
      201
    )
    assert.equal(first.ownerMembershipId, rep.actor.membershipId)
    assert.equal(first.followUpAt, '2026-10-30T09:00:00.000Z')
    await must(
      await rep.http.post('/api/v1/interactions', {
        partyId: ctx.maria.id,
        channel: 'EMAIL',
        subject: 'Proposta enviada',
        occurredAt: '2026-10-22T09:00:00Z',
      }),
      201
    )
    await must(
      await rep.http.post('/api/v1/interactions', {
        partyId: ctx.acme.id,
        channel: 'NOTE',
        subject: 'Nota interna',
      }),
      201
    )
    const ofMaria = await must<any[]>(
      await rep.http.get(`/api/v1/interactions?partyId=${ctx.maria.id}`),
      200
    )
    assert.deepEqual(
      ofMaria.map((i) => i.subject),
      ['Proposta enviada', 'Primeiro contacto']
    )
    const due = await must<any[]>(
      await rep.http.get('/api/v1/interactions?followUpBefore=2026-11-01T00:00:00Z'),
      200
    )
    assert.deepEqual(
      due.map((i) => i.subject),
      ['Primeiro contacto']
    )
    const mine = await must<any[]>(
      await rep.http.get(`/api/v1/interactions?ownerMembershipId=${rep.actor.membershipId}`),
      200
    )
    assert.lengthOf(mine, 3)

    const edited = await must<any>(
      await rep.http.patch(`/api/v1/interactions/${first.id}`, {
        expectedVersion: first.version,
        summary: 'Pediu orçamento.',
        followUpAt: null,
      }),
      200
    )
    assert.deepInclude(edited, { summary: 'Pediu orçamento.', followUpAt: null })
    assert.equal(edited.ownerMembershipId, rep.actor.membershipId)
    ;(
      await rep.http.patch(`/api/v1/interactions/${first.id}`, {
        expectedVersion: first.version,
        summary: 'Desactualizada',
      })
    ).assertStatus(409)
    const move = await rep.http.patch(`/api/v1/interactions/${first.id}`, {
      expectedVersion: edited.version,
      partyId: ctx.acme.id,
    })
    move.assertStatus(422)
    assert.equal(move.body().error.details[0].code, 'IMMUTABLE')
  })

  test('datas incoerentes, Party inexistente ou de outro tenant e permissão em falta são recusadas', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const other = await setup(client)
    const body = { partyId: ctx.maria.id, channel: 'CALL', subject: 'Chamada' }
    const future = await ctx.http.post('/api/v1/interactions', {
      ...body,
      occurredAt: '2999-01-01T00:00:00Z',
    })
    future.assertStatus(422)
    assert.equal(future.body().error.details[0].code, 'FUTURE')
    const early = await ctx.http.post('/api/v1/interactions', {
      ...body,
      occurredAt: '2026-10-20T09:00:00Z',
      followUpAt: '2026-10-19T09:00:00Z',
    })
    early.assertStatus(422)
    assert.equal(early.body().error.details[0].code, 'BEFORE_OCCURRED')
    ;(await ctx.http.post('/api/v1/interactions', { ...body, channel: 'SMS' })).assertStatus(422)
    const foreign = await ctx.http.post('/api/v1/interactions', {
      ...body,
      partyId: other.maria.id,
    })
    foreign.assertStatus(422)
    assert.equal(foreign.body().error.details[0].code, 'UNKNOWN_PARTY')
    const reader = await memberWith(ctx, ['customer.read'])
    ;(await reader.http.post('/api/v1/interactions', body)).assertStatus(403)
  })

  test('as alterações ficam na auditoria e as tabelas de clientes cumprem o isolamento', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const created = await must<any>(await ctx.http.post('/api/v1/customers', newCustomer(ctx)), 201)
    await must(
      await ctx.http.patch(`/api/v1/customers/${created.id}`, {
        expectedVersion: created.version,
        paymentTermDays: 90,
      }),
      200
    )
    const logs = await must<any[]>(
      await ctx.http.get(`/api/v1/audit-logs?resourceType=customers&resourceId=${created.id}`),
      200
    )
    assert.isAbove(logs.length, 1)
    const other = await setup(client)
    ;(await other.http.get(`/api/v1/customers/${created.id}`)).assertStatus(404)
    assert.lengthOf(await rowsOf(other.tenant, 'select 1 from customers'), 0)
    assert.lengthOf(await rowsOf(ctx.tenant, 'select 1 from customers'), 1)
  })
})
