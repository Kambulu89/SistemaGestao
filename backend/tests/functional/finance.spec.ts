import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { iamServices } from '#core/permissions/index'
import { deleteTestUsers, resetAuthState } from '#tests/support/auth_fixture'
import { createActiveTenant, deleteTestTenants } from '#tests/support/membership_fixture'
import { api, newActor } from '#tests/support/api_fixture'
import { license, syncTestRegistry } from '#tests/support/modules_fixture'
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

const owner = <T>(sql: string, tenant?: Tenant) =>
  db.connection('owner').transaction(async (trx) => {
    if (tenant) await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [tenant.id])
    return (await trx.rawQuery(sql)).rows as T[]
  })

const MODULES = [
  'catalog',
  'customers',
  'orders',
  'inventory',
  'invoicing',
  'procurement',
  'finance',
]

/**
 * Tenant com vendas, facturação, compras e finanças: uma organização, produtos «Camisola» (com stock) e «Instalação»
 * (serviço), um cliente (prazo 15 dias), um fornecedor, as sequências dos documentos e uma conta de caixa.
 */
async function setup(client: any) {
  const tenant = await createActiveTenant()
  const admin = await newActor(client, tenant, true)
  const http = api(client, tenant, admin)
  await syncTestRegistry()
  await license(tenant, MODULES)
  for (const code of MODULES) {
    const enabled = await http.post(`/api/v1/tenant/modules/${code}/enable`, {})
    if (enabled.status() !== 200) throw new Error(`${code}: ${JSON.stringify(enabled.body())}`)
  }
  const org = await must<any>(
    await http.post('/api/v1/organizations', {
      code: 'EMP',
      legalName: 'Empresa, Lda.',
      countryCode: 'AO',
      baseCurrency: 'AOA',
    }),
    201
  )
  const unit = await must<any>(
    await http.post('/api/v1/units', {
      code: 'UN',
      name: 'Unidade',
      dimension: 'COUNT',
      precision: 0,
    }),
    201
  )
  for (const [documentType, prefixTemplate] of [
    ['QUOTE', 'PRO {SERIES}/{YYYY}/'],
    ['SALES_ORDER', 'ENC {SERIES}/{YYYY}/'],
    ['SHIPMENT', 'EXP {SERIES}/{YYYY}/'],
    ['INVOICE', 'FT {SERIES}/{YYYY}/'],
    ['CREDIT_NOTE', 'NC {SERIES}/{YYYY}/'],
    ['PURCHASE_ORDER', 'OC {SERIES}/{YYYY}/'],
    ['GOODS_RECEIPT', 'REC {SERIES}/{YYYY}/'],
  ] as const) {
    await must(
      await http.post('/api/v1/sequences', {
        organizationId: org.id,
        documentType,
        series: 'A',
        prefixTemplate,
      }),
      201
    )
  }
  const list = await must<any>(
    await http.post('/api/v1/price-lists', {
      organizationId: org.id,
      name: 'Retalho',
      currency: 'AOA',
      validFrom: '2020-01-01',
    }),
    201
  )
  const makeProduct = async (body: Record<string, unknown>) => {
    const product = await must<any>(
      await http.post('/api/v1/products', { type: 'GOODS', baseUnitId: unit.id, ...body }),
      201
    )
    await must(
      await http.post(`/api/v1/price-lists/${list.id}/items`, {
        variantId: product.variants[0].id,
        unitPrice: '100',
        maxDiscount: '0.1',
      }),
      201
    )
    return product.variants[0] as { id: string }
  }
  const shirt = await makeProduct({ code: 'CAM-001', name: 'Camisola' })
  const service = await makeProduct({ code: 'SRV-001', name: 'Instalação', type: 'SERVICE' })
  const warehouse = await must<any>(
    await http.post('/api/v1/warehouses', {
      organizationId: org.id,
      code: 'ARM-1',
      name: 'Central',
    }),
    201
  )
  await must(
    await http.patch(`/api/v1/warehouses/${warehouse.id}`, {
      expectedVersion: warehouse.version,
      salesDefault: true,
    }),
    200
  )
  const party = await must<any>(
    await http.post('/api/v1/organization-parties', {
      legalName: 'Acme, Lda.',
      taxCountry: 'AO',
      taxId: '5000012345',
    }),
    201
  )
  await must(
    await http.post(`/api/v1/parties/${party.id}/addresses`, {
      type: 'BILLING',
      line1: 'Rua Direita 1',
      city: 'Luanda',
      countryCode: 'AO',
      isPrimary: true,
    }),
    201
  )
  const customer = await must<any>(
    await http.post('/api/v1/customers', {
      partyId: party.id,
      organizationId: org.id,
      code: 'CLI-001',
      paymentTermDays: 15,
    }),
    201
  )
  await must(
    await http.post('/api/v1/stock-adjustments', {
      variantId: shirt.id,
      locationId: warehouse.locations[0].id,
      quantityDelta: '500',
      unitCost: '5',
      reason: 'Contagem inicial',
    }),
    201
  )
  const supplierParty = await must<any>(
    await http.post('/api/v1/organization-parties', {
      legalName: 'Fornecedora, SA',
      taxCountry: 'AO',
      taxId: '5000099999',
    }),
    201
  )
  const supplier = await must<any>(
    await http.post('/api/v1/suppliers', {
      partyId: supplierParty.id,
      organizationId: org.id,
      code: 'FOR-001',
      paymentTermDays: 30,
    }),
    201
  )
  const cash = await must<any>(
    await http.post('/api/v1/treasury-accounts', {
      organizationId: org.id,
      code: 'CAIXA',
      name: 'Caixa central',
      type: 'CASH',
    }),
    201
  )
  return {
    client,
    tenant,
    admin,
    http,
    org,
    shirt,
    service,
    customer,
    party,
    supplier,
    supplierParty,
    cash,
  }
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
  return api(ctx.client, ctx.tenant, actor)
}

const code = (r: any) => r.body().error.details?.[0]?.code ?? r.body().error.code

/** Factura emitida com uma linha manual: `quantity × 50` + 14 % de imposto. Devolve o id e o recebível criado. */
async function issuedInvoice(ctx: Ctx, quantity = '2') {
  const created = await must<any>(
    await ctx.http.post('/api/v1/invoices', {
      organizationId: ctx.org.id,
      customerId: ctx.customer.id,
      lines: [{ description: 'Serviço', quantity, unitPrice: '50', taxRate: '14' }],
    }),
    201
  )
  const issued = await must<any>(
    await ctx.http.post(`/api/v1/invoices/${created.id}/issue`, {}),
    200
  )
  const receivable = await receivableOf(ctx, created.id)
  return { id: created.id as string, invoice: issued.invoice ?? issued, receivable }
}

async function receivableOf(ctx: Ctx, invoiceId: string) {
  const list = await must<any[]>(await ctx.http.get('/api/v1/receivables?limit=200'), 200)
  return list.find((r) => r.sourceId === invoiceId)
}

const inbound = (
  ctx: Ctx,
  receivableId: string,
  amount: string,
  extra: Record<string, unknown> = {}
) => ({
  organizationId: ctx.org.id,
  direction: 'INBOUND',
  partyId: ctx.party.id,
  treasuryAccountId: ctx.cash.id,
  amount,
  allocations: [{ receivableId, amount }],
  ...extra,
})

async function confirmedPayment(ctx: Ctx, receivableId: string, amount: string) {
  const payment = await must<any>(
    await ctx.http.post('/api/v1/payments', inbound(ctx, receivableId, amount)),
    201
  )
  return must<any>(await ctx.http.post(`/api/v1/payments/${payment.id}/confirm`, {}), 200)
}

const accountBalance = async (ctx: Ctx) =>
  (await must<any>(await ctx.http.get(`/api/v1/treasury-accounts/${ctx.cash.id}`), 200))
    .balance as string

const hooks = (group: any) => {
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
}

test.group('finanças | contas de tesouraria', (group) => {
  hooks(group)

  test('cria, lista, altera e valida contas; o identificador é sensível', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    assert.equal(ctx.cash.currency, 'AOA')
    assert.equal(ctx.cash.balance, '0.0000')
    const bank = await must<any>(
      await ctx.http.post('/api/v1/treasury-accounts', {
        organizationId: ctx.org.id,
        code: 'BAI-01',
        name: 'Banco',
        type: 'BANK',
        bankName: 'BAI',
        accountIdentifier: 'AO06000000000000000000000',
      }),
      201
    )
    assert.equal(
      (
        await ctx.http.post('/api/v1/treasury-accounts', {
          organizationId: ctx.org.id,
          code: 'BAI-01',
          name: 'x',
          type: 'BANK',
        })
      ).status(),
      409
    )
    assert.equal(
      code(
        await ctx.http.post('/api/v1/treasury-accounts', {
          organizationId: ctx.org.id,
          code: 'X1',
          name: 'x',
          type: 'COFRE',
        })
      ),
      'INVALID_TYPE'
    )
    const stale = await ctx.http.patch(`/api/v1/treasury-accounts/${bank.id}`, {
      expectedVersion: 99,
      name: 'Y',
    })
    assert.equal(stale.status(), 409)
    assert.equal(
      code(
        await ctx.http.patch(`/api/v1/treasury-accounts/${bank.id}`, {
          expectedVersion: bank.version,
          currency: 'USD',
        })
      ),
      'IMMUTABLE'
    )
    const renamed = await must<any>(
      await ctx.http.patch(`/api/v1/treasury-accounts/${bank.id}`, {
        expectedVersion: bank.version,
        name: 'Banco BAI',
      }),
      200
    )
    assert.equal(renamed.name, 'Banco BAI')

    const reader = await memberWith(ctx, ['treasury.read'])
    const seen = await must<any>(await reader.get(`/api/v1/treasury-accounts/${bank.id}`), 200)
    assert.isNull(seen.accountIdentifier)
    const full = await must<any>(await ctx.http.get(`/api/v1/treasury-accounts/${bank.id}`), 200)
    assert.equal(full.accountIdentifier, 'AO06000000000000000000000')
    assert.equal(
      (
        await reader.post('/api/v1/treasury-accounts', {
          organizationId: ctx.org.id,
          code: 'Z',
          name: 'z',
          type: 'CASH',
        })
      ).status(),
      403
    )
    assert.equal((await ctx.http.get('/api/v1/treasury-accounts/não-é-uuid')).status(), 404)
  })
})

test.group('finanças | recebíveis e pagamentos', (group) => {
  hooks(group)

  test('emitir uma factura cria o recebível; pagar parcial e total move a conta e fecha-o', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const { receivable, invoice } = await issuedInvoice(ctx)
    assert.exists(receivable)
    assert.equal(receivable.originalAmount, '114.0000')
    assert.equal(receivable.balance, '114.0000')
    assert.equal(receivable.view, 'OPEN')
    assert.equal(receivable.dueOn, invoice.dueOn)
    assert.equal(receivable.partyId, ctx.party.id)

    assert.equal((await confirmedPayment(ctx, receivable.id, '40')).status, 'CONFIRMED')
    let detail = await must<any>(await ctx.http.get(`/api/v1/receivables/${receivable.id}`), 200)
    assert.equal(detail.balance, '74.0000')
    assert.equal(detail.view, 'PARTIAL')
    assert.lengthOf(detail.allocations, 1)
    assert.equal(await accountBalance(ctx), '40.0000')

    await confirmedPayment(ctx, receivable.id, '74')
    detail = await must<any>(await ctx.http.get(`/api/v1/receivables/${receivable.id}`), 200)
    assert.equal(detail.balance, '0.0000')
    assert.equal(detail.status, 'CLOSED')
    assert.equal(detail.view, 'CLOSED')
    assert.equal(await accountBalance(ctx), '114.0000')

    const entries = await must<any[]>(
      await ctx.http.get(`/api/v1/treasury-accounts/${ctx.cash.id}/entries`),
      200
    )
    assert.lengthOf(entries, 2)
  })

  test('um pagamento nunca excede o saldo, a moeda ou a entidade; a soma das alocações iguala o montante', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const { receivable } = await issuedInvoice(ctx)
    const over = await must<any>(
      await ctx.http.post('/api/v1/payments', inbound(ctx, receivable.id, '200')),
      201
    )
    const refused = await ctx.http.post(`/api/v1/payments/${over.id}/confirm`, {})
    assert.equal(refused.status(), 409)
    assert.equal(refused.body().error.code, 'PAYMENT_NOT_APPLICABLE')
    assert.equal(refused.body().error.details[0].code, 'OVERPAYMENT')
    assert.equal(await accountBalance(ctx), '0.0000')

    const mismatch = await ctx.http.post('/api/v1/payments', {
      ...inbound(ctx, receivable.id, '50'),
      allocations: [{ receivableId: receivable.id, amount: '30' }],
    })
    assert.equal(code(mismatch), 'ALLOCATION_MISMATCH')
    const wrongSide = await ctx.http.post('/api/v1/payments', {
      ...inbound(ctx, receivable.id, '50'),
      allocations: [{ payableId: receivable.id, amount: '50' }],
    })
    assert.equal(wrongSide.status(), 422)
    const otherParty = await must<any>(
      await ctx.http.post('/api/v1/organization-parties', {
        legalName: 'Outra, Lda.',
        taxCountry: 'AO',
        taxId: '5000055555',
      }),
      201
    )
    const wrongParty = await ctx.http.post(
      '/api/v1/payments',
      inbound(ctx, receivable.id, '50', { partyId: otherParty.id })
    )
    assert.equal(code(wrongParty), 'OBLIGATION_MISMATCH')
    const usd = await must<any>(
      await ctx.http.post('/api/v1/treasury-accounts', {
        organizationId: ctx.org.id,
        code: 'USD',
        name: 'Caixa USD',
        type: 'CASH',
        currency: 'USD',
      }),
      201
    )
    const wrongCurrency = await ctx.http.post(
      '/api/v1/payments',
      inbound(ctx, receivable.id, '50', { treasuryAccountId: usd.id })
    )
    assert.equal(code(wrongCurrency), 'CURRENCY_MISMATCH')
    const decimal = await ctx.http.post('/api/v1/payments', inbound(ctx, receivable.id, '0.00001'))
    assert.equal(decimal.status(), 422)
    assert.equal(
      (await ctx.http.post('/api/v1/payments', inbound(ctx, receivable.id, '-5'))).status(),
      422
    )
  })

  test('confirmar é idempotente; reverter repõe saldo e conta; um confirmado não se apaga nem edita', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const { receivable } = await issuedInvoice(ctx)
    const payment = await must<any>(
      await ctx.http.post('/api/v1/payments', inbound(ctx, receivable.id, '114')),
      201
    )
    await must(await ctx.http.post(`/api/v1/payments/${payment.id}/submit`, {}), 200)
    await must(await ctx.http.post(`/api/v1/payments/${payment.id}/confirm`, {}), 200)
    await must(await ctx.http.post(`/api/v1/payments/${payment.id}/confirm`, {}), 200)
    assert.equal(await accountBalance(ctx), '114.0000')
    assert.equal((await ctx.http.delete(`/api/v1/payments/${payment.id}`)).status(), 409)

    assert.equal(
      (await ctx.http.post(`/api/v1/payments/${payment.id}/reverse`, { reason: '' })).status(),
      422
    )
    const reversed = await must<any>(
      await ctx.http.post(`/api/v1/payments/${payment.id}/reverse`, { reason: 'Cheque devolvido' }),
      200
    )
    assert.equal(reversed.status, 'REVERSED')
    await must(
      await ctx.http.post(`/api/v1/payments/${payment.id}/reverse`, { reason: 'Cheque devolvido' }),
      200
    )
    const reopened = await must<any>(
      await ctx.http.get(`/api/v1/receivables/${receivable.id}`),
      200
    )
    assert.equal(reopened.status, 'OPEN')
    assert.equal(reopened.balance, '114.0000')
    assert.equal(await accountBalance(ctx), '0.0000')
    assert.equal((await ctx.http.post(`/api/v1/payments/${payment.id}/confirm`, {})).status(), 409)
    const entries = await owner<{ n: number }>(
      `select count(*)::int as n from treasury_entries where payment_id = '${payment.id}'`,
      ctx.tenant
    )
    assert.equal(entries[0]?.n, 2)

    await assert.rejects(
      () => owner(`update payments set amount = 1 where id = '${payment.id}'`, ctx.tenant),
      /PAYMENT_IMMUTABLE/
    )
    await assert.rejects(
      () => owner(`delete from treasury_entries where payment_id = '${payment.id}'`, ctx.tenant),
      /FINANCE_APPEND_ONLY/
    )
  })

  test('falhar um pagamento pendente não mexe em saldos; rascunho apaga-se', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const { receivable } = await issuedInvoice(ctx)
    const failing = await must<any>(
      await ctx.http.post('/api/v1/payments', inbound(ctx, receivable.id, '50')),
      201
    )
    await must(await ctx.http.post(`/api/v1/payments/${failing.id}/submit`, {}), 200)
    assert.equal(
      (await ctx.http.post(`/api/v1/payments/${failing.id}/fail`, { reason: '' })).status(),
      422
    )
    const failed = await must<any>(
      await ctx.http.post(`/api/v1/payments/${failing.id}/fail`, { reason: 'Recusado pelo banco' }),
      200
    )
    assert.equal(failed.status, 'FAILED')
    assert.equal((await ctx.http.post(`/api/v1/payments/${failing.id}/confirm`, {})).status(), 409)
    assert.equal((await receivableOf(ctx, receivable.sourceId)).balance, '114.0000')
    const draft = await must<any>(
      await ctx.http.post('/api/v1/payments', inbound(ctx, receivable.id, '10')),
      201
    )
    assert.equal((await ctx.http.delete(`/api/v1/payments/${draft.id}`)).status(), 204)
    assert.equal((await ctx.http.get(`/api/v1/payments/${draft.id}`)).status(), 404)
  })

  test('a mesma Idempotency-Key devolve o mesmo pagamento; com outros dados é um conflito', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const { receivable } = await issuedInvoice(ctx)
    const send = (body: unknown, key: string) =>
      client
        .post('/api/v1/payments')
        .header('cookie', ctx.admin.cookie)
        .header('x-tenant-id', ctx.tenant.id)
        .header('x-csrf-token', ctx.admin.csrf)
        .header('idempotency-key', key)
        .json(body)
    const first = await send(inbound(ctx, receivable.id, '30'), 'pedido-1')
    assert.equal(first.status(), 201)
    const again = await send(inbound(ctx, receivable.id, '30'), 'pedido-1')
    assert.equal(again.status(), 200)
    assert.equal(again.body().data.id, first.body().data.id)
    const other = await send(inbound(ctx, receivable.id, '31'), 'pedido-1')
    assert.equal(other.status(), 409)
    assert.equal(other.body().error.code, 'IDEMPOTENCY_KEY_REUSED')
    const bad = await send(inbound(ctx, receivable.id, '30'), 'chave com espaços')
    assert.equal(bad.status(), 422)
    const list = await must<any[]>(await ctx.http.get('/api/v1/payments'), 200)
    assert.lengthOf(list, 1)
  })

  test('duas confirmações concorrentes não pagam a mais (bloqueio da obrigação)', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const { receivable } = await issuedInvoice(ctx)
    const a = await must<any>(
      await ctx.http.post('/api/v1/payments', inbound(ctx, receivable.id, '80')),
      201
    )
    const b = await must<any>(
      await ctx.http.post('/api/v1/payments', inbound(ctx, receivable.id, '80')),
      201
    )
    const results = await Promise.all([
      ctx.http.post(`/api/v1/payments/${a.id}/confirm`, {}),
      ctx.http.post(`/api/v1/payments/${b.id}/confirm`, {}),
    ])
    assert.sameMembers(results.map((r) => r.status()).sort(), [200, 409])
    assert.equal(await accountBalance(ctx), '80.0000')
    const detail = await must<any>(await ctx.http.get(`/api/v1/receivables/${receivable.id}`), 200)
    assert.equal(detail.balance, '34.0000')
  })

  test('uma nota de crédito abate o recebível; creditar tudo fecha-o', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const { id, invoice, receivable } = await issuedInvoice(ctx)
    const note = await must<any>(
      await ctx.http.post('/api/v1/credit-notes', {
        invoiceId: id,
        reason: 'Desconto',
        lines: [{ invoiceLineId: invoice.lines[0].id, quantity: '1' }],
      }),
      201
    )
    await must(await ctx.http.post(`/api/v1/credit-notes/${note.id}/issue`, {}), 200)
    let detail = await must<any>(await ctx.http.get(`/api/v1/receivables/${receivable.id}`), 200)
    assert.equal(detail.credits, '57.0000')
    assert.equal(detail.balance, '57.0000')
    assert.lengthOf(detail.creditApplications, 1)
    await confirmedPayment(ctx, receivable.id, '57')
    detail = await must<any>(await ctx.http.get(`/api/v1/receivables/${receivable.id}`), 200)
    assert.equal(detail.status, 'CLOSED')
    const applications = await owner<{ n: number }>(
      `select count(*)::int as n from credit_applications`,
      ctx.tenant
    )
    assert.equal(applications[0]?.n, 1)
  })

  test('vistas: vencido e filtros; a leitura exige a permissão certa', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const { receivable } = await issuedInvoice(ctx)
    const open = await must<any[]>(await ctx.http.get('/api/v1/receivables?view=OPEN'), 200)
    assert.lengthOf(open, 1)
    const overdue = await must<any[]>(await ctx.http.get('/api/v1/receivables?view=OVERDUE'), 200)
    assert.lengthOf(overdue, 0)
    const dueSoon = await must<any[]>(
      await ctx.http.get('/api/v1/receivables?dueBefore=2000-01-01'),
      200
    )
    assert.lengthOf(dueSoon, 0)
    assert.equal((await ctx.http.get('/api/v1/receivables?view=NAO')).status(), 422)
    const nobody = await memberWith(ctx, ['payable.read'])
    assert.equal((await nobody.get('/api/v1/receivables')).status(), 403)
    assert.equal((await nobody.get('/api/v1/payables')).status(), 200)
    const payer = await memberWith(ctx, ['payment.manage', 'payment.read', 'receivable.read'])
    const payment = await must<any>(
      await payer.post('/api/v1/payments', inbound(ctx, receivable.id, '10')),
      201
    )
    assert.equal((await payer.post(`/api/v1/payments/${payment.id}/confirm`, {})).status(), 403)
  })
})

test.group('finanças | crédito do cliente', (group) => {
  hooks(group)

  const order = async (ctx: Ctx, quantity: string) => {
    const created = await must<any>(
      await ctx.http.post('/api/v1/sales-orders', {
        organizationId: ctx.org.id,
        customerId: ctx.customer.id,
      }),
      201
    )
    await must(
      await ctx.http.post(`/api/v1/sales-orders/${created.id}/lines`, {
        variantId: ctx.shirt.id,
        quantity,
      }),
      201
    )
    return created.id as string
  }

  test('confirmar acima do limite é recusado; cancelar liberta; facturar converte a reserva em recebível', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const customer = await must<any>(
      await ctx.http.get(`/api/v1/customers/${ctx.customer.id}`),
      200
    )
    await must(
      await ctx.http.patch(`/api/v1/customers/${ctx.customer.id}`, {
        expectedVersion: customer.version,
        creditLimit: '250',
      }),
      200
    )
    const first = await order(ctx, '2')
    await must(await ctx.http.post(`/api/v1/sales-orders/${first}/confirm`, {}), 200)
    let credit = await must<any>(
      await ctx.http.get(`/api/v1/customers/${ctx.customer.id}/credit`),
      200
    )
    assert.equal(credit.reservations, '200.0000')
    assert.equal(credit.exposure, '200.0000')
    assert.equal(credit.headroom, '50.0000')
    assert.isTrue(credit.controlled)

    const second = await order(ctx, '1')
    const refused = await ctx.http.post(`/api/v1/sales-orders/${second}/confirm`, {})
    assert.include([409, 422], refused.status())
    assert.include(JSON.stringify(refused.body()), 'CREDIT_LIMIT_EXCEEDED')

    await must(
      await ctx.http.post(`/api/v1/sales-orders/${first}/cancel`, { reason: 'Desistência' }),
      200
    )
    credit = await must<any>(await ctx.http.get(`/api/v1/customers/${ctx.customer.id}/credit`), 200)
    assert.equal(credit.reservations, '0.0000')
    await must(await ctx.http.post(`/api/v1/sales-orders/${second}/confirm`, {}), 200)

    // Só se factura o expedido: expede-se e lança-se a expedição antes.
    const detail = await must<any>(await ctx.http.get(`/api/v1/sales-orders/${second}`), 200)
    const shipment = await must<any>(
      await ctx.http.post('/api/v1/shipments', {
        orderId: second,
        lines: [{ orderLineId: detail.lines[0].id, quantity: '1' }],
      }),
      201
    )
    await must(await ctx.http.post(`/api/v1/shipments/${shipment.id}/post`, {}), 200)
    const invoice = await must<any>(
      await ctx.http.post('/api/v1/invoices', {
        organizationId: ctx.org.id,
        customerId: ctx.customer.id,
        orderId: second,
      }),
      201
    )
    await must(await ctx.http.post(`/api/v1/invoices/${invoice.id}/issue`, {}), 200)
    credit = await must<any>(await ctx.http.get(`/api/v1/customers/${ctx.customer.id}/credit`), 200)
    assert.equal(credit.reservations, '0.0000')
    assert.equal(credit.openReceivables, '100.0000')
    assert.equal(credit.exposure, '100.0000')
  })

  test('limite 0 não controla; o limite só é visível a quem gere crédito; cliente bloqueado ainda paga', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const big = await order(ctx, '50')
    await must(await ctx.http.post(`/api/v1/sales-orders/${big}/confirm`, {}), 200)
    const credit = await must<any>(
      await ctx.http.get(`/api/v1/customers/${ctx.customer.id}/credit`),
      200
    )
    assert.isFalse(credit.controlled)
    assert.isNull(credit.headroom)

    const finance = await memberWith(ctx, ['receivable.read'])
    const masked = await must<any>(
      await finance.get(`/api/v1/customers/${ctx.customer.id}/credit`),
      200
    )
    assert.isNull(masked.creditLimit)
    assert.equal(masked.reservations, '5000.0000')
    const nobody = await memberWith(ctx, ['payable.read'])
    assert.equal((await nobody.get(`/api/v1/customers/${ctx.customer.id}/credit`)).status(), 403)
    assert.equal(
      (
        await ctx.http.get('/api/v1/customers/00000000-0000-4000-8000-000000000000/credit')
      ).status(),
      404
    )

    const { receivable } = await issuedInvoice(ctx)
    const customer = await must<any>(
      await ctx.http.get(`/api/v1/customers/${ctx.customer.id}`),
      200
    )
    await must(
      await ctx.http.post(`/api/v1/customers/${ctx.customer.id}/block`, {
        expectedVersion: customer.version,
        reason: 'Atraso',
      }),
      200
    )
    assert.equal((await confirmedPayment(ctx, receivable.id, '114')).status, 'CONFIRMED')
  })
})

test.group('finanças | facturas de fornecedor e contas a pagar', (group) => {
  hooks(group)

  /** Encomenda confirmada de 10 unidades de «Instalação» a 5 (+14 %) e uma recepção de `received` unidades. */
  async function receivedPurchase(ctx: Ctx, received: string) {
    const order = await must<any>(
      await ctx.http.post('/api/v1/purchase-orders', {
        supplierId: ctx.supplier.id,
        lines: [{ variantId: ctx.service.id, quantity: '10', unitCost: '5', taxRate: '14' }],
      }),
      201
    )
    await must(await ctx.http.post(`/api/v1/purchase-orders/${order.id}/confirm`, {}), 200)
    const receipt = await must<any>(
      await ctx.http.post('/api/v1/goods-receipts', {
        purchaseOrderId: order.id,
        lines: [{ purchaseLineId: order.lines[0].id, quantity: received }],
      }),
      201
    )
    await must(await ctx.http.post(`/api/v1/goods-receipts/${receipt.id}/post`, {}), 200)
    return { id: order.id as string, lineId: order.lines[0].id as string }
  }

  const draftInvoice = (ctx: Ctx, extra: Record<string, unknown>) =>
    ctx.http.post('/api/v1/supplier-invoices', {
      supplierId: ctx.supplier.id,
      externalNumber: 'FF-001',
      ...extra,
    })

  test('rascunho com linhas e totais exactos; validar sem encomenda cria o pagável; validada é imutável', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const draft = await must<any>(
      await draftInvoice(ctx, {
        invoiceDate: '2026-03-01',
        lines: [{ description: 'Renda', quantity: '3', unitPrice: '33.3333', taxRate: '14' }],
      }),
      201
    )
    assert.equal(draft.status, 'DRAFT')
    assert.equal(draft.totals.net, '99.9999')
    assert.equal(draft.totals.tax, '14.0000')
    assert.equal(draft.totals.total, '113.9999')
    assert.equal(draft.dueOn, '2026-03-31')
    assert.equal(code(await draftInvoice(ctx, {})), 'SUPPLIER_INVOICE_NUMBER_EXISTS')

    const withLine = await must<any>(
      await ctx.http.post(`/api/v1/supplier-invoices/${draft.id}/lines`, {
        description: 'Água',
        quantity: '1',
        unitPrice: '10',
      }),
      201
    )
    assert.equal(withLine.totals.total, '123.9999')
    const removed = await must<any>(
      await ctx.http.delete(`/api/v1/supplier-invoices/${draft.id}/lines/${withLine.lines[1].id}`),
      200
    )
    assert.equal(removed.totals.total, '113.9999')

    const validated = await must<any>(
      await ctx.http.post(`/api/v1/supplier-invoices/${draft.id}/validate`, {}),
      200
    )
    assert.equal(validated.status, 'VALIDATED')
    await must(await ctx.http.post(`/api/v1/supplier-invoices/${draft.id}/validate`, {}), 200)
    const payables = await must<any[]>(await ctx.http.get('/api/v1/payables'), 200)
    assert.lengthOf(payables, 1)
    assert.equal(payables[0].originalAmount, '113.9999')
    assert.equal(payables[0].partyId, ctx.supplierParty.id)
    assert.equal(payables[0].dueOn, '2026-03-31')

    assert.equal((await ctx.http.delete(`/api/v1/supplier-invoices/${draft.id}`)).status(), 409)
    assert.equal(
      (
        await ctx.http.post(`/api/v1/supplier-invoices/${draft.id}/lines`, {
          description: 'x',
          quantity: '1',
          unitPrice: '1',
        })
      ).status(),
      409
    )
    await assert.rejects(
      () => owner(`update supplier_invoices set total = 1 where id = '${draft.id}'`, ctx.tenant),
      /SUPPLIER_INVOICE_IMMUTABLE|supplier_invoices_totals_check/
    )

    // Pagar ao fornecedor: saída da conta, o pagável fecha.
    const payment = await must<any>(
      await ctx.http.post('/api/v1/payments', {
        organizationId: ctx.org.id,
        direction: 'OUTBOUND',
        partyId: ctx.supplierParty.id,
        treasuryAccountId: ctx.cash.id,
        amount: '113.9999',
        allocations: [{ payableId: payables[0].id, amount: '113.9999' }],
      }),
      201
    )
    await must(await ctx.http.post(`/api/v1/payments/${payment.id}/confirm`, {}), 200)
    const paid = await must<any>(await ctx.http.get(`/api/v1/payables/${payables[0].id}`), 200)
    assert.equal(paid.status, 'CLOSED')
    assert.equal(await accountBalance(ctx), '-113.9999')
  })

  test('conferência a três vias: acima do recebido fica em disputa; a excepção exige permissão e motivo', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const purchase = await receivedPurchase(ctx, '6')
    const draft = await must<any>(
      await draftInvoice(ctx, {
        purchaseOrderId: purchase.id,
        lines: [
          {
            purchaseLineId: purchase.lineId,
            description: 'Instalação',
            quantity: '8',
            unitPrice: '5',
            taxRate: '14',
          },
        ],
      }),
      201
    )
    const disputed = await must<any>(
      await ctx.http.post(`/api/v1/supplier-invoices/${draft.id}/validate`, {}),
      200
    )
    assert.equal(disputed.status, 'DISPUTED')
    assert.equal(disputed.matching[0].code, 'NOT_RECEIVED')
    assert.lengthOf(await must<any[]>(await ctx.http.get('/api/v1/payables'), 200), 0)

    const validator = await memberWith(ctx, ['supplier_invoice.validate', 'supplier_invoice.read'])
    assert.equal(
      (
        await validator.post(`/api/v1/supplier-invoices/${draft.id}/validate`, {
          overrideReason: 'Urgente',
        })
      ).status(),
      403
    )
    const approver = await memberWith(ctx, [
      'supplier_invoice.validate',
      'supplier_invoice.override',
      'supplier_invoice.read',
    ])
    const forced = await must<any>(
      await approver.post(`/api/v1/supplier-invoices/${draft.id}/validate`, {
        overrideReason: 'Entrega em curso, confirmada por telefone',
      }),
      200
    )
    assert.equal(forced.status, 'VALIDATED')
    assert.equal(forced.overrideReason, 'Entrega em curso, confirmada por telefone')
    assert.lengthOf(await must<any[]>(await ctx.http.get('/api/v1/payables'), 200), 1)
  })

  test('conferência: o já facturado conta; preço acima da encomenda diverge; conforme valida sem excepção', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const purchase = await receivedPurchase(ctx, '6')
    const line = (quantity: string, unitPrice: string) => ({
      purchaseLineId: purchase.lineId,
      description: 'Instalação',
      quantity,
      unitPrice,
      taxRate: '14',
    })
    const ok = await must<any>(
      await draftInvoice(ctx, { purchaseOrderId: purchase.id, lines: [line('4', '5')] }),
      201
    )
    assert.equal(
      (await must<any>(await ctx.http.post(`/api/v1/supplier-invoices/${ok.id}/validate`, {}), 200))
        .status,
      'VALIDATED'
    )
    const second = await must<any>(
      await draftInvoice(ctx, {
        externalNumber: 'FF-002',
        purchaseOrderId: purchase.id,
        lines: [line('3', '5')],
      }),
      201
    )
    const tooMuch = await must<any>(
      await ctx.http.post(`/api/v1/supplier-invoices/${second.id}/validate`, {}),
      200
    )
    assert.equal(tooMuch.status, 'DISPUTED')
    const pricey = await must<any>(
      await draftInvoice(ctx, {
        externalNumber: 'FF-003',
        purchaseOrderId: purchase.id,
        lines: [line('2', '6')],
      }),
      201
    )
    const priced = await must<any>(
      await ctx.http.post(`/api/v1/supplier-invoices/${pricey.id}/validate`, {}),
      200
    )
    assert.deepEqual(
      priced.matching.map((d: any) => d.code),
      ['PRICE_ABOVE_ORDER']
    )
    // Em disputa corrige-se e volta a validar.
    const fixed = await must<any>(
      await ctx.http.post(`/api/v1/supplier-invoices/${second.id}/void`, {}),
      200
    )
    assert.equal(fixed.status, 'VOID')
    assert.equal(
      (await ctx.http.post(`/api/v1/supplier-invoices/${second.id}/validate`, {})).status(),
      409
    )
  })

  test('validações: fornecedor, encomenda e linhas alheias; factura sem linhas não se valida', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    assert.equal(
      code(await draftInvoice(ctx, { supplierId: '00000000-0000-4000-8000-000000000000' })),
      'UNKNOWN_SUPPLIER'
    )
    assert.equal(
      code(await draftInvoice(ctx, { purchaseOrderId: '00000000-0000-4000-8000-000000000000' })),
      'UNKNOWN_PURCHASE_ORDER'
    )
    assert.equal(
      code(await draftInvoice(ctx, { dueOn: '2020-01-01', invoiceDate: '2026-01-01' })),
      'DUE_BEFORE_DATE'
    )
    const empty = await must<any>(await draftInvoice(ctx, {}), 201)
    assert.equal(
      code(await ctx.http.post(`/api/v1/supplier-invoices/${empty.id}/validate`, {})),
      'REQUIRED'
    )
    assert.equal(
      code(
        await ctx.http.post(`/api/v1/supplier-invoices/${empty.id}/lines`, {
          description: 'Linha',
          quantity: '1',
          unitPrice: '1',
          purchaseLineId: '00000000-0000-4000-8000-000000000000',
        })
      ),
      'NO_PURCHASE_ORDER'
    )
    assert.equal((await ctx.http.delete(`/api/v1/supplier-invoices/${empty.id}`)).status(), 204)
  })
})
