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

const MODULES = ['catalog', 'customers', 'orders', 'inventory', 'invoicing']

/**
 * Tenant com os módulos de venda e facturação: uma organização, um armazém de vendas, os produtos «Camisola» (com
 * stock), «Instalação» (serviço), um cliente com morada de facturação e as sequências dos documentos.
 */
async function setup(client: any) {
  const tenant = await createActiveTenant()
  const admin = await newActor(client, tenant, true)
  const http = api(client, tenant, admin)
  await syncTestRegistry()
  await license(tenant, MODULES)
  for (const code of MODULES) {
    await must(await http.post(`/api/v1/tenant/modules/${code}/enable`, {}), 200)
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
    ['CONTRACT', 'CT {SERIES}/{YYYY}/'],
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
    return { product, variant: product.variants[0] }
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
      variantId: shirt.variant.id,
      locationId: warehouse.locations[0].id,
      quantityDelta: '50',
      unitCost: '5',
      reason: 'Contagem inicial',
    }),
    201
  )
  return { client, tenant, admin, http, org, shirt, service, customer, party }
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

/** Encomenda confirmada; devolve o id e os ids das linhas, por ordem. */
async function confirmedOrder(ctx: Ctx, lines: { variantId: string; quantity: string }[]) {
  const order = await must<any>(
    await ctx.http.post('/api/v1/sales-orders', {
      organizationId: ctx.org.id,
      customerId: ctx.customer.id,
    }),
    201
  )
  let detail: any = order
  for (const line of lines) {
    detail = await must<any>(
      await ctx.http.post(`/api/v1/sales-orders/${order.id}/lines`, line),
      201
    )
  }
  await must(await ctx.http.post(`/api/v1/sales-orders/${order.id}/confirm`, {}), 200)
  return { id: order.id as string, lineIds: detail.lines.map((l: any) => l.id as string) }
}

async function ship(ctx: Ctx, orderId: string, orderLineId: string, quantity: string) {
  const shipment = await must<any>(
    await ctx.http.post('/api/v1/shipments', { orderId, lines: [{ orderLineId, quantity }] }),
    201
  )
  await must(await ctx.http.post(`/api/v1/shipments/${shipment.id}/post`, {}), 200)
}

const billable = async (ctx: Ctx, orderId: string) =>
  must<any[]>(await ctx.http.get(`/api/v1/sales-orders/${orderId}/billable`), 200)

const manualLine = { description: 'Consultoria', quantity: '2', unitPrice: '50', taxRate: '14' }

const manualInvoice = (ctx: Ctx, extra: Record<string, unknown> = {}) =>
  ctx.http.post('/api/v1/invoices', {
    organizationId: ctx.org.id,
    customerId: ctx.customer.id,
    lines: [manualLine],
    ...extra,
  })

const code = (r: any) => r.body().error.details?.[0]?.code ?? r.body().error.code

const common = (g: any) => {
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
}

test.group('facturas | rascunho e emissão', (g) => {
  common(g)

  test('uma factura livre calcula os totais exactos e emite com número, vencimento e instantâneo do cliente', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const draft = await must<any>(await manualInvoice(ctx), 201)
    assert.deepInclude(draft, { status: 'DRAFT', number: null, currency: 'AOA' })
    assert.deepEqual(draft.totals, { net: '100.0000', tax: '14.0000', total: '114.0000' })
    assert.lengthOf(draft.lines, 1)
    assert.equal(draft.dueOn, new Date(Date.now() + 15 * 86_400_000).toISOString().slice(0, 10))
    assert.isNull(draft.customerSnapshot)

    const withLine = await must<any>(
      await ctx.http.post(`/api/v1/invoices/${draft.id}/lines`, {
        description: 'Isento',
        quantity: '1',
        unitPrice: '10',
        taxRate: '0',
        exemptionReason: 'Artigo 9.º',
      }),
      201
    )
    assert.deepEqual(withLine.totals, { net: '110.0000', tax: '14.0000', total: '124.0000' })
    const noReason = await ctx.http.post(`/api/v1/invoices/${draft.id}/lines`, {
      description: 'Isento',
      quantity: '1',
      unitPrice: '10',
      taxRate: '0',
    })
    noReason.assertStatus(422)
    assert.equal(code(noReason), 'EXEMPTION_REQUIRED')
    const trimmed = await must<any>(
      await ctx.http.delete(`/api/v1/invoices/${draft.id}/lines/${withLine.lines[1].id}`),
      200
    )
    assert.equal(trimmed.totals.total, '114.0000')

    const issued = await must<any>(
      await ctx.http.post(`/api/v1/invoices/${draft.id}/issue`, {}),
      200
    )
    assert.isFalse(issued.idempotent)
    assert.match(issued.invoice.number, /^FT A\/\d{4}\/\d+$/)
    assert.deepInclude(issued.invoice, { status: 'ISSUED', fiscalStatus: 'NOT_REQUIRED' })
    assert.deepInclude(issued.invoice.customerSnapshot, {
      customerCode: 'CLI-001',
      name: 'Acme, Lda.',
      taxId: '5000012345',
      taxCountry: 'AO',
    })
    assert.deepInclude(issued.invoice.customerSnapshot.billingAddress, {
      line1: 'Rua Direita 1',
      city: 'Luanda',
    })
    const events = await owner<any>(
      `select payload from outbox_events where event_type = 'invoicing.invoice.issued'`,
      ctx.tenant
    )
    assert.lengthOf(events, 1)
    assert.equal(events[0].payload.number, issued.invoice.number)
  })

  test('emitir duas vezes devolve a mesma factura, sem novo número nem novo evento', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const draft = await must<any>(await manualInvoice(ctx), 201)
    const a = await must<any>(await ctx.http.post(`/api/v1/invoices/${draft.id}/issue`, {}), 200)
    const b = await must<any>(await ctx.http.post(`/api/v1/invoices/${draft.id}/issue`, {}), 200)
    assert.isTrue(b.idempotent)
    assert.equal(a.invoice.number, b.invoice.number)
    const other = await must<any>(await manualInvoice(ctx), 201)
    const c = await must<any>(await ctx.http.post(`/api/v1/invoices/${other.id}/issue`, {}), 200)
    assert.notEqual(c.invoice.number, a.invoice.number)
    assert.lengthOf(
      await owner(
        'select 1 from outbox_events where event_type = $$invoicing.invoice.issued$$',
        ctx.tenant
      ),
      2
    )
  })

  test('uma factura emitida não se altera: nem pela API nem pela base de dados', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const draft = await must<any>(await manualInvoice(ctx), 201)
    const { invoice } = await must<any>(
      await ctx.http.post(`/api/v1/invoices/${draft.id}/issue`, {}),
      200
    )
    for (const request of [
      ctx.http.patch(`/api/v1/invoices/${draft.id}`, {
        expectedVersion: invoice.version,
        notes: 'x',
      }),
      ctx.http.delete(`/api/v1/invoices/${draft.id}`),
      ctx.http.post(`/api/v1/invoices/${draft.id}/lines`, manualLine),
      ctx.http.delete(`/api/v1/invoices/${draft.id}/lines/${invoice.lines[0].id}`),
    ]) {
      const response = await request
      response.assertStatus(409)
      assert.equal(response.body().error.code, 'INVOICE_NOT_DRAFT')
    }
    const attempts = [
      `update invoices set total = 1 where id = '${draft.id}'`,
      `update invoices set number = 'X' where id = '${draft.id}'`,
      `update invoice_lines set quantity = 9 where invoice_id = '${draft.id}'`,
      `delete from invoice_lines where invoice_id = '${draft.id}'`,
      `delete from invoices where id = '${draft.id}'`,
    ]
    for (const sql of attempts) {
      let failed = false
      try {
        await owner(sql, ctx.tenant)
      } catch {
        failed = true
      }
      assert.isTrue(failed, sql)
    }
    const [row] = await owner<any>(
      `select total, number from invoices where id = '${draft.id}'`,
      ctx.tenant
    )
    assert.equal(row.total, '114.0000')
  })

  test('recusa factura vazia, vencimento anterior à emissão e datas inválidas', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const empty = await must<any>(
      await ctx.http.post('/api/v1/invoices', {
        organizationId: ctx.org.id,
        customerId: ctx.customer.id,
      }),
      201
    )
    const noLines = await ctx.http.post(`/api/v1/invoices/${empty.id}/issue`, {})
    noLines.assertStatus(409)
    assert.equal(noLines.body().error.code, 'INVOICE_EMPTY')
    const past = await must<any>(await manualInvoice(ctx, { dueOn: '2020-01-01' }), 201)
    const late = await ctx.http.post(`/api/v1/invoices/${past.id}/issue`, {})
    late.assertStatus(409)
    assert.equal(late.body().error.code, 'DUE_BEFORE_ISSUE')
    const fixed = await must<any>(
      await ctx.http.patch(`/api/v1/invoices/${past.id}`, {
        expectedVersion: past.version,
        dueOn: '2099-01-01',
      }),
      200
    )
    assert.equal(fixed.dueOn, '2099-01-01')
    ;(await ctx.http.post(`/api/v1/invoices/${past.id}/issue`, {})).assertStatus(200)
    const bad = await manualInvoice(ctx, { dueOn: '2026-02-30' })
    bad.assertStatus(422)
    assert.equal(code(bad), 'INVALID_DATE')
    const stale = await ctx.http.patch(`/api/v1/invoices/${empty.id}`, {
      expectedVersion: 99,
      notes: 'x',
    })
    stale.assertStatus(409)
  })
})

test.group('facturas | a partir de encomendas', (g) => {
  common(g)

  test('os bens com stock facturam-se pelo expedido e os serviços pelo encomendado', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const order = await confirmedOrder(ctx, [
      { variantId: ctx.shirt.variant.id, quantity: '10' },
      { variantId: ctx.service.variant.id, quantity: '1' },
    ])
    const before = await billable(ctx, order.id)
    assert.deepInclude(before[0], { stockTracked: true, shipped: '0.000000', billable: '0.000000' })
    assert.deepInclude(before[1], { stockTracked: false, billable: '1.000000' })
    // Só o serviço está por facturar: a linha dos bens fica de fora do rascunho por omissão.
    const first = await must<any>(
      await ctx.http.post('/api/v1/invoices', { orderId: order.id }),
      201
    )
    assert.lengthOf(first.lines, 1)
    assert.equal(first.lines[0].salesOrderLineId, order.lineIds[1])
    const tooMuch = await ctx.http.post('/api/v1/invoices', {
      orderId: order.id,
      lines: [{ orderLineId: order.lineIds[0], quantity: '1' }],
    })
    tooMuch.assertStatus(422)
    assert.equal(code(tooMuch), 'EXCEEDS_BILLABLE')

    await ship(ctx, order.id, order.lineIds[0]!, '4')
    assert.equal((await billable(ctx, order.id))[0].billable, '4.000000')
    const second = await must<any>(
      await ctx.http.post(`/api/v1/invoices/${first.id}/lines`, {
        orderLineId: order.lineIds[0],
      }),
      201
    )
    assert.equal(second.lines[1].quantity, '4.000000')
    assert.deepEqual(second.totals, { net: '500.0000', tax: '0.0000', total: '500.0000' })
    const dup = await ctx.http.post(`/api/v1/invoices/${first.id}/lines`, {
      orderLineId: order.lineIds[0],
    })
    dup.assertStatus(409)
    assert.equal(dup.body().error.code, 'INVOICE_LINE_DUPLICATE')
    const manual = await ctx.http.post(`/api/v1/invoices/${first.id}/lines`, manualLine)
    manual.assertStatus(422)
    assert.equal(code(manual), 'ORDER_LINE_REQUIRED')

    ;(await ctx.http.post(`/api/v1/invoices/${first.id}/issue`, {})).assertStatus(200)
    const after = await billable(ctx, order.id)
    assert.equal(after[0].billable, '0.000000')
    assert.equal(after[0].billed, '4.000000')
    assert.equal(after[1].billable, '0.000000')

    await ship(ctx, order.id, order.lineIds[0]!, '6')
    assert.equal((await billable(ctx, order.id))[0].billable, '6.000000')
    const rest = await must<any>(
      await ctx.http.post('/api/v1/invoices', { orderId: order.id }),
      201
    )
    assert.equal(rest.lines[0].quantity, '6.000000')
    // Um rascunho não reserva a quantidade; depois de emitido, não há mais nada por facturar.
    ;(await ctx.http.post(`/api/v1/invoices/${rest.id}/issue`, {})).assertStatus(200)
    const done = await ctx.http.post('/api/v1/invoices', { orderId: order.id })
    done.assertStatus(409)
    assert.equal(done.body().error.code, 'NOTHING_TO_INVOICE')
  })

  test('facturar parte de uma linha e a quantidade toda dá os valores da encomenda', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const order = await confirmedOrder(ctx, [{ variantId: ctx.service.variant.id, quantity: '3' }])
    const detail = await must<any>(await ctx.http.get(`/api/v1/sales-orders/${order.id}`), 200)
    const whole = await must<any>(
      await ctx.http.post('/api/v1/invoices', { orderId: order.id }),
      201
    )
    assert.deepEqual(whole.totals, detail.totals)
    ;(await ctx.http.delete(`/api/v1/invoices/${whole.id}`)).assertStatus(204)
    const part = await must<any>(
      await ctx.http.post('/api/v1/invoices', {
        orderId: order.id,
        lines: [{ orderLineId: order.lineIds[0], quantity: '1' }],
      }),
      201
    )
    assert.equal(part.lines[0].quantity, '1.000000')
    assert.equal((await billable(ctx, order.id))[0].billable, '3.000000')
  })

  test('duas facturas emitidas ao mesmo tempo nunca facturam duas vezes a mesma quantidade', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const order = await confirmedOrder(ctx, [{ variantId: ctx.shirt.variant.id, quantity: '10' }])
    await ship(ctx, order.id, order.lineIds[0]!, '4')
    const a = await must<any>(await ctx.http.post('/api/v1/invoices', { orderId: order.id }), 201)
    const b = await must<any>(await ctx.http.post('/api/v1/invoices', { orderId: order.id }), 201)
    const results = await Promise.all([
      ctx.http.post(`/api/v1/invoices/${a.id}/issue`, {}),
      ctx.http.post(`/api/v1/invoices/${b.id}/issue`, {}),
    ])
    assert.sameMembers(results.map((r) => r.status()).sort(), [200, 409])
    const loser = results.find((r) => r.status() === 409)
    assert.equal(loser?.body().error.code, 'INVOICE_NOT_ISSUABLE')
    assert.equal((await billable(ctx, order.id))[0].billed, '4.000000')
    const issued = await owner(
      `select 1 from invoices where status = 'ISSUED' and order_id = '${order.id}'`,
      ctx.tenant
    )
    assert.lengthOf(issued, 1)
  })

  test('uma encomenda não confirmada ou de outro cliente não se factura', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const open = await must<any>(
      await ctx.http.post('/api/v1/sales-orders', {
        organizationId: ctx.org.id,
        customerId: ctx.customer.id,
      }),
      201
    )
    const response = await ctx.http.post('/api/v1/invoices', { orderId: open.id })
    response.assertStatus(409)
    assert.equal(response.body().error.code, 'ORDER_NOT_BILLABLE')
    ;(
      await ctx.http.post('/api/v1/invoices', { orderId: '00000000-0000-4000-8000-000000000000' })
    ).assertStatus(404)
    const missing = await ctx.http.post('/api/v1/invoices', {
      organizationId: ctx.org.id,
      customerId: '00000000-0000-4000-8000-000000000000',
    })
    missing.assertStatus(422)
    assert.equal(code(missing), 'UNKNOWN_CUSTOMER')
  })
})

test.group('notas de crédito', (g) => {
  common(g)

  const issuedInvoice = async (ctx: Ctx) => {
    const draft = await must<any>(await manualInvoice(ctx), 201)
    const { invoice } = await must<any>(
      await ctx.http.post(`/api/v1/invoices/${draft.id}/issue`, {}),
      200
    )
    return invoice
  }

  test('credita parte, emite com número e vai somando até a factura ficar creditada', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const invoice = await issuedInvoice(ctx)
    const lineId = invoice.lines[0].id
    const note = await must<any>(
      await ctx.http.post('/api/v1/credit-notes', {
        invoiceId: invoice.id,
        reason: 'Devolução parcial',
        lines: [{ invoiceLineId: lineId, quantity: '1' }],
      }),
      201
    )
    assert.deepInclude(note, { status: 'DRAFT', number: null })
    assert.deepEqual(note.totals, { net: '50.0000', tax: '7.0000', total: '57.0000' })
    const issued = await must<any>(
      await ctx.http.post(`/api/v1/credit-notes/${note.id}/issue`, {}),
      200
    )
    assert.isFalse(issued.idempotent)
    assert.match(issued.creditNote.number, /^NC A\/\d{4}\/\d+$/)
    const again = await must<any>(
      await ctx.http.post(`/api/v1/credit-notes/${note.id}/issue`, {}),
      200
    )
    assert.isTrue(again.idempotent)
    let current = await must<any>(await ctx.http.get(`/api/v1/invoices/${invoice.id}`), 200)
    assert.equal(current.status, 'ISSUED')

    // Mais do que falta creditar é recusado, por quantidade e por valor.
    const over = await ctx.http.post('/api/v1/credit-notes', {
      invoiceId: invoice.id,
      reason: 'Demais',
      lines: [{ invoiceLineId: lineId, quantity: '2' }],
    })
    over.assertStatus(422)
    assert.equal(code(over), 'EXCEEDS_CREDITABLE')
    const overAmount = await ctx.http.post('/api/v1/credit-notes', {
      invoiceId: invoice.id,
      reason: 'Demais',
      lines: [{ invoiceLineId: lineId, quantity: '1', amount: '50.0001' }],
    })
    overAmount.assertStatus(422)

    const rest = await must<any>(
      await ctx.http.post('/api/v1/credit-notes', {
        invoiceId: invoice.id,
        reason: 'O resto',
        lines: [{ invoiceLineId: lineId, quantity: '1' }],
      }),
      201
    )
    assert.deepEqual(rest.totals, { net: '50.0000', tax: '7.0000', total: '57.0000' })
    ;(await ctx.http.post(`/api/v1/credit-notes/${rest.id}/issue`, {})).assertStatus(200)
    current = await must<any>(await ctx.http.get(`/api/v1/invoices/${invoice.id}`), 200)
    assert.equal(current.status, 'CREDITED')
    const closed = await ctx.http.post('/api/v1/credit-notes', {
      invoiceId: invoice.id,
      reason: 'x',
    })
    closed.assertStatus(409)
    assert.equal(closed.body().error.code, 'INVOICE_FULLY_CREDITED')
    const events = await owner(
      `select 1 from outbox_events where event_type = 'invoicing.credit_note.issued'`,
      ctx.tenant
    )
    assert.lengthOf(events, 2)
  })

  test('só se credita uma factura emitida; uma nota emitida não se altera', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const draft = await must<any>(await manualInvoice(ctx), 201)
    const notIssued = await ctx.http.post('/api/v1/credit-notes', {
      invoiceId: draft.id,
      reason: 'x',
    })
    notIssued.assertStatus(409)
    assert.equal(notIssued.body().error.code, 'INVOICE_NOT_ISSUED')
    const invoice = await issuedInvoice(ctx)
    const note = await must<any>(
      await ctx.http.post('/api/v1/credit-notes', {
        invoiceId: invoice.id,
        reason: 'x',
        lines: [{ invoiceLineId: invoice.lines[0].id, quantity: '2' }],
      }),
      201
    )
    ;(await ctx.http.post(`/api/v1/credit-notes/${note.id}/issue`, {})).assertStatus(200)
    for (const request of [
      ctx.http.patch(`/api/v1/credit-notes/${note.id}`, { reason: 'y' }),
      ctx.http.delete(`/api/v1/credit-notes/${note.id}`),
      ctx.http.post(`/api/v1/credit-notes/${note.id}/lines`, {
        invoiceLineId: invoice.lines[0].id,
        quantity: '1',
      }),
    ]) {
      const response = await request
      response.assertStatus(409)
      assert.equal(response.body().error.code, 'CREDIT_NOTE_NOT_DRAFT')
    }
    let failed = false
    try {
      await owner(`update credit_notes set reason = 'z' where id = '${note.id}'`, ctx.tenant)
    } catch {
      failed = true
    }
    assert.isTrue(failed)
    const closed = await ctx.http.post('/api/v1/credit-notes', {
      invoiceId: invoice.id,
      reason: 'y',
    })
    closed.assertStatus(409)
    assert.equal(closed.body().error.code, 'INVOICE_FULLY_CREDITED')
  })

  test('duas notas emitidas ao mesmo tempo nunca creditam mais do que a factura', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const invoice = await issuedInvoice(ctx)
    const make = () =>
      ctx.http
        .post('/api/v1/credit-notes', {
          invoiceId: invoice.id,
          reason: 'Total',
          lines: [{ invoiceLineId: invoice.lines[0].id, quantity: '2' }],
        })
        .then((response) => must<any>(response, 201))
    const [a, b] = [await make(), await make()]
    const results = await Promise.all([
      ctx.http.post(`/api/v1/credit-notes/${a.id}/issue`, {}),
      ctx.http.post(`/api/v1/credit-notes/${b.id}/issue`, {}),
    ])
    assert.sameMembers(results.map((r) => r.status()).sort(), [200, 409])
    const loser = results.find((r) => r.status() === 409)
    assert.include(['CREDIT_NOTE_NOT_ISSUABLE', 'INVOICE_FULLY_CREDITED'], loser?.body().error.code)
    const [row] = await owner<any>(
      `select coalesce(sum(l.amount), 0) as credited from credit_note_lines l
         join credit_notes n on n.id = l.credit_note_id where n.status = 'ISSUED'`,
      ctx.tenant
    )
    assert.equal(row.credited, '100.0000')
  })

  test('creditar repõe o facturável da encomenda mas nunca devolve stock', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const order = await confirmedOrder(ctx, [{ variantId: ctx.shirt.variant.id, quantity: '5' }])
    await ship(ctx, order.id, order.lineIds[0]!, '5')
    const draft = await must<any>(
      await ctx.http.post('/api/v1/invoices', { orderId: order.id }),
      201
    )
    const { invoice } = await must<any>(
      await ctx.http.post(`/api/v1/invoices/${draft.id}/issue`, {}),
      200
    )
    const onHand = async () =>
      (
        await must<any[]>(
          await ctx.http.get(`/api/v1/stock-balances?variantId=${ctx.shirt.variant.id}`),
          200
        )
      )[0].onHand
    const stockBefore = await onHand()
    const note = await must<any>(
      await ctx.http.post('/api/v1/credit-notes', {
        invoiceId: invoice.id,
        reason: 'Erro de preço',
        lines: [{ invoiceLineId: invoice.lines[0].id, quantity: '2' }],
      }),
      201
    )
    ;(await ctx.http.post(`/api/v1/credit-notes/${note.id}/issue`, {})).assertStatus(200)
    assert.equal((await billable(ctx, order.id))[0].billable, '2.000000')
    assert.equal(await onHand(), stockBefore)
  })
})

test.group('contratos', (g) => {
  common(g)

  const contract = (ctx: Ctx, extra: Record<string, unknown> = {}) =>
    ctx.http.post('/api/v1/contracts', {
      organizationId: ctx.org.id,
      partyId: ctx.party.id,
      title: 'Manutenção anual',
      startDate: '2026-01-01',
      endDate: '2099-12-31',
      amount: '1200',
      noticeDays: 30,
      ...extra,
    })

  test('rascunho → activo (com número) → terminado, com campos bloqueados depois de activo', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const created = await must<any>(await contract(ctx), 201)
    assert.deepInclude(created, {
      status: 'DRAFT',
      effectiveStatus: 'DRAFT',
      number: null,
      currency: 'AOA',
      noticeDeadline: '2099-12-01',
    })
    const edited = await must<any>(
      await ctx.http.patch(`/api/v1/contracts/${created.id}`, {
        expectedVersion: created.version,
        amount: '1500',
        title: 'Manutenção 2026',
      }),
      200
    )
    assert.equal(edited.amount, '1500.0000')
    const activated = await must<any>(
      await ctx.http.post(`/api/v1/contracts/${created.id}/activate`, {}),
      200
    )
    assert.isFalse(activated.idempotent)
    assert.match(activated.contract.number, /^CT A\/\d{4}\/\d+$/)
    assert.equal(activated.contract.status, 'ACTIVE')
    const again = await must<any>(
      await ctx.http.post(`/api/v1/contracts/${created.id}/activate`, {}),
      200
    )
    assert.isTrue(again.idempotent)
    assert.equal(again.contract.number, activated.contract.number)
    const locked = await ctx.http.patch(`/api/v1/contracts/${created.id}`, {
      expectedVersion: activated.contract.version,
      startDate: '2026-02-01',
    })
    locked.assertStatus(409)
    assert.equal(locked.body().error.code, 'CONTRACT_FIELD_LOCKED')
    const renewed = await must<any>(
      await ctx.http.patch(`/api/v1/contracts/${created.id}`, {
        expectedVersion: activated.contract.version,
        endDate: '2100-12-31',
        renewalMode: 'MANUAL',
      }),
      200
    )
    assert.equal(renewed.endDate, '2100-12-31')
    const noReason = await ctx.http.post(`/api/v1/contracts/${created.id}/terminate`, {})
    noReason.assertStatus(422)
    const ended = await must<any>(
      await ctx.http.post(`/api/v1/contracts/${created.id}/terminate`, { reason: 'Fim acordado' }),
      200
    )
    assert.equal(ended.contract.status, 'TERMINATED')
    const reopened = await ctx.http.post(`/api/v1/contracts/${created.id}/activate`, {})
    reopened.assertStatus(409)
    assert.equal(reopened.body().error.code, 'CONTRACT_TERMINATED')
    ;(
      await ctx.http.patch(`/api/v1/contracts/${created.id}`, {
        expectedVersion: ended.contract.version,
        title: 'x',
      })
    ).assertStatus(409)
    let failed = false
    try {
      await owner(`update contracts set title = 'z' where id = '${created.id}'`, ctx.tenant)
    } catch {
      failed = true
    }
    assert.isTrue(failed)
  })

  test('um contrato activo cujo fim passou aparece como expirado e filtra-se por estado efectivo', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const old = await must<any>(
      await contract(ctx, { startDate: '2020-01-01', endDate: '2020-12-31' }),
      201
    )
    await must(await ctx.http.post(`/api/v1/contracts/${old.id}/activate`, {}), 200)
    const current = await must<any>(await contract(ctx), 201)
    await must(await ctx.http.post(`/api/v1/contracts/${current.id}/activate`, {}), 200)
    const expired = await must<any[]>(await ctx.http.get('/api/v1/contracts?status=EXPIRED'), 200)
    assert.deepEqual(
      expired.map((c) => c.id),
      [old.id]
    )
    assert.equal(expired[0].effectiveStatus, 'EXPIRED')
    const active = await must<any[]>(await ctx.http.get('/api/v1/contracts?status=ACTIVE'), 200)
    assert.deepEqual(
      active.map((c) => c.id),
      [current.id]
    )
  })

  test('valida datas, renovação sem fim e contrapartes inexistentes', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const reversed = await contract(ctx, { endDate: '2025-01-01' })
    reversed.assertStatus(422)
    assert.equal(code(reversed), 'END_BEFORE_START')
    const noEnd = await contract(ctx, { endDate: null, renewalMode: 'AUTO' })
    noEnd.assertStatus(422)
    assert.equal(code(noEnd), 'END_REQUIRED')
    const unknown = await contract(ctx, { partyId: '00000000-0000-4000-8000-000000000000' })
    unknown.assertStatus(422)
    assert.equal(code(unknown), 'UNKNOWN_PARTY')
  })

  test('uma factura ao abrigo de um contrato exige-o activo e do mesmo cliente', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const created = await must<any>(await contract(ctx), 201)
    const inactive = await manualInvoice(ctx, { contractId: created.id })
    inactive.assertStatus(409)
    assert.equal(inactive.body().error.code, 'CONTRACT_NOT_ACTIVE')
    await must(await ctx.http.post(`/api/v1/contracts/${created.id}/activate`, {}), 200)
    const invoice = await must<any>(await manualInvoice(ctx, { contractId: created.id }), 201)
    assert.equal(invoice.contractId, created.id)
    const byContract = await must<any[]>(
      await ctx.http.get(`/api/v1/invoices?contractId=${created.id}`),
      200
    )
    assert.lengthOf(byContract, 1)
    const stranger = await must<any>(
      await ctx.http.post('/api/v1/organization-parties', { legalName: 'Outra, SA' }),
      201
    )
    const other = await must<any>(
      await contract(ctx, { partyId: stranger.id, title: 'Outro' }),
      201
    )
    await must(await ctx.http.post(`/api/v1/contracts/${other.id}/activate`, {}), 200)
    const mismatch = await manualInvoice(ctx, { contractId: other.id })
    mismatch.assertStatus(422)
    assert.equal(code(mismatch), 'CONTRACT_MISMATCH')
  })
})

test.group('facturação | autorização, funcionalidades, auditoria e isolamento', (g) => {
  common(g)

  test('cada permissão abre só o seu conjunto de operações', async ({ client }) => {
    const ctx = await setup(client)
    const draft = await must<any>(await manualInvoice(ctx), 201)
    const reader = await memberWith(ctx, ['invoice.read'])
    ;(await reader.get('/api/v1/invoices')).assertStatus(200)
    ;(await reader.get(`/api/v1/invoices/${draft.id}`)).assertStatus(200)
    ;(await reader.get('/api/v1/credit-notes')).assertStatus(200)
    ;(await reader.get('/api/v1/contracts')).assertStatus(403)
    ;(await reader.post('/api/v1/invoices', { orderId: draft.id })).assertStatus(403)
    ;(await reader.post(`/api/v1/invoices/${draft.id}/issue`, {})).assertStatus(403)
    const manager = await memberWith(ctx, ['invoice.read', 'invoice.manage'])
    ;(await manager.post(`/api/v1/invoices/${draft.id}/lines`, manualLine)).assertStatus(201)
    ;(await manager.post(`/api/v1/invoices/${draft.id}/issue`, {})).assertStatus(403)
    const issuer = await memberWith(ctx, ['invoice.issue'])
    ;(await issuer.post(`/api/v1/invoices/${draft.id}/issue`, {})).assertStatus(200)
    const noteManager = await memberWith(ctx, ['credit_note.manage'])
    const invoice = await must<any>(await ctx.http.get(`/api/v1/invoices/${draft.id}`), 200)
    const note = await must<any>(
      await noteManager.post('/api/v1/credit-notes', {
        invoiceId: invoice.id,
        reason: 'x',
        lines: [{ invoiceLineId: invoice.lines[0].id, quantity: '1' }],
      }),
      201
    )
    ;(await noteManager.post(`/api/v1/credit-notes/${note.id}/issue`, {})).assertStatus(403)
    ;(
      await (
        await memberWith(ctx, ['credit_note.issue'])
      ).post(`/api/v1/credit-notes/${note.id}/issue`, {})
    ).assertStatus(200)
    const contractReader = await memberWith(ctx, ['contract.read'])
    ;(await contractReader.get('/api/v1/contracts')).assertStatus(200)
    ;(
      await contractReader.post('/api/v1/contracts', {
        organizationId: ctx.org.id,
        partyId: ctx.party.id,
        title: 'x',
        startDate: '2026-01-01',
      })
    ).assertStatus(403)
    ;(await (await memberWith(ctx, ['party.read'])).get('/api/v1/invoices')).assertStatus(403)
  })

  test('sem a funcionalidade, nem os administradores acedem', async ({ client, assert }) => {
    const ctx = await setup(client)
    await must(
      await ctx.http.put('/api/v1/tenant/features/invoicing.invoices', {
        override: false,
        reason: 'Teste',
      }),
      200
    )
    for (const path of ['/api/v1/invoices', '/api/v1/credit-notes']) {
      const off = await ctx.http.get(path)
      off.assertStatus(403)
      assert.equal(off.body().error.code, 'FEATURE_NOT_AVAILABLE')
    }
    ;(await ctx.http.get('/api/v1/contracts')).assertStatus(200)
    await must(
      await ctx.http.put('/api/v1/tenant/features/invoicing.contracts', {
        override: false,
        reason: 'Teste',
      }),
      200
    )
    ;(await ctx.http.get('/api/v1/contracts')).assertStatus(403)
  })

  test('as alterações ficam na auditoria e os dados de outro tenant não se vêem nem se tocam', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const draft = await must<any>(await manualInvoice(ctx), 201)
    const { invoice } = await must<any>(
      await ctx.http.post(`/api/v1/invoices/${draft.id}/issue`, {}),
      200
    )
    const note = await must<any>(
      await ctx.http.post('/api/v1/credit-notes', {
        invoiceId: invoice.id,
        reason: 'x',
        lines: [{ invoiceLineId: invoice.lines[0].id, quantity: '1' }],
      }),
      201
    )
    const logs = await must<any[]>(
      await ctx.http.get(`/api/v1/audit-logs?resourceId=${invoice.id}`),
      200
    )
    assert.isAbove(logs.length, 1)
    const other = await setup(client)
    for (const request of [
      other.http.get(`/api/v1/invoices/${invoice.id}`),
      other.http.post(`/api/v1/invoices/${invoice.id}/issue`, {}),
      other.http.delete(`/api/v1/invoices/${invoice.id}`),
      other.http.get(`/api/v1/credit-notes/${note.id}`),
      other.http.post(`/api/v1/credit-notes/${note.id}/issue`, {}),
      other.http.post('/api/v1/credit-notes', { invoiceId: invoice.id, reason: 'x' }),
    ]) {
      ;(await request).assertStatus(404)
    }
    assert.lengthOf(await must<any[]>(await other.http.get('/api/v1/invoices'), 200), 0)
    assert.lengthOf(await owner('select 1 from invoices', other.tenant), 0)
    assert.lengthOf(await owner('select 1 from invoices', ctx.tenant), 1)
  })
})
