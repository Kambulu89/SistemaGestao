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

/**
 * Tenant com `catalog`, `customers`, `orders` e `inventory`: uma organização, um armazém de vendas (local PRINCIPAL), os
 * produtos «Camisola» (UN), «Iogurte» (por lote) e «Instalação» (serviço), um cliente e as sequências de propostas,
 * encomendas e expedições.
 */
async function setup(
  client: any,
  options: { salesWarehouse?: boolean; shipmentSequence?: boolean } = {}
) {
  const tenant = await createActiveTenant()
  const admin = await newActor(client, tenant, true)
  const http = api(client, tenant, admin)
  await syncTestRegistry()
  await license(tenant, ['catalog', 'customers', 'orders', 'inventory'])
  for (const code of ['catalog', 'customers', 'orders', 'inventory']) {
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
  const sequences: [string, string][] = [
    ['QUOTE', 'PRO {SERIES}/{YYYY}/'],
    ['SALES_ORDER', 'ENC {SERIES}/{YYYY}/'],
  ]
  if (options.shipmentSequence !== false) sequences.push(['SHIPMENT', 'EXP {SERIES}/{YYYY}/'])
  for (const [documentType, prefixTemplate] of sequences) {
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
  const yogurt = await makeProduct({ code: 'IOG-001', name: 'Iogurte', trackingMode: 'LOT' })
  const service = await makeProduct({ code: 'SRV-001', name: 'Instalação', type: 'SERVICE' })
  let warehouse = await must<any>(
    await http.post('/api/v1/warehouses', {
      organizationId: org.id,
      code: 'ARM-1',
      name: 'Central',
    }),
    201
  )
  if (options.salesWarehouse !== false) {
    warehouse = {
      ...(await must<any>(
        await http.patch(`/api/v1/warehouses/${warehouse.id}`, {
          expectedVersion: warehouse.version,
          salesDefault: true,
        }),
        200
      )),
      locations: warehouse.locations,
    }
  }
  const location = warehouse.locations[0]
  const party = await must<any>(
    await http.post('/api/v1/organization-parties', {
      legalName: 'Acme, Lda.',
      taxCountry: 'AO',
      taxId: '5000012345',
    }),
    201
  )
  const customer = await must<any>(
    await http.post('/api/v1/customers', {
      partyId: party.id,
      organizationId: org.id,
      code: 'CLI-001',
    }),
    201
  )
  return {
    client,
    tenant,
    admin,
    http,
    org,
    unit,
    shirt,
    yogurt,
    service,
    warehouse,
    location,
    customer,
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

const stock = async (
  ctx: Ctx,
  variantId: string,
  quantityDelta: string,
  extra: Record<string, unknown> = {}
) =>
  must<any>(
    await ctx.http.post('/api/v1/stock-adjustments', {
      variantId,
      locationId: ctx.location.id,
      quantityDelta,
      unitCost: '5',
      reason: 'Contagem inicial',
      ...extra,
    }),
    201
  )

const balance = async (ctx: Ctx, variantId: string) =>
  (await must<any[]>(await ctx.http.get(`/api/v1/stock-balances?variantId=${variantId}`), 200)).map(
    (b) => ({
      onHand: b.onHand,
      reserved: b.reserved,
      lot: b.lotCode,
    })
  )

/** Encomenda confirmada com as linhas pedidas; devolve o id e os ids das linhas, por ordem. */
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

const draft = async (
  ctx: Ctx,
  orderId: string,
  lines: { orderLineId: string; quantity: string }[]
) => must<any>(await ctx.http.post('/api/v1/shipments', { orderId, lines }), 201)

const orderDetail = async (ctx: Ctx, id: string) =>
  must<any>(await ctx.http.get(`/api/v1/sales-orders/${id}`), 200)

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

test.group('expedições | rascunho e saldo por linha', (g) => {
  common(g)

  test('cria em rascunho, mostra as linhas e valida a quantidade e a linha da encomenda', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    await stock(ctx, ctx.shirt.variant.id, '10')
    const order = await confirmedOrder(ctx, [{ variantId: ctx.shirt.variant.id, quantity: '10' }])
    const shipment = await draft(ctx, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '4' }])
    assert.deepInclude(shipment, { status: 'DRAFT', number: null, orderId: order.id })
    assert.lengthOf(shipment.lines, 1)
    assert.equal(shipment.lines[0].quantity, '4.000000')
    const post = (path: string, body: unknown) => ctx.http.post(path, body)
    const code = (r: any) => r.body().error.details?.[0]?.code ?? r.body().error.code
    assert.equal(
      code(
        await post(`/api/v1/shipments/${shipment.id}/lines`, {
          orderLineId: order.lineIds[0],
          quantity: '1',
        })
      ),
      'SHIPMENT_LINE_DUPLICATE'
    )
    const service = await confirmedOrder(ctx, [
      { variantId: ctx.service.variant.id, quantity: '1' },
    ])
    assert.equal(
      code(
        await post(`/api/v1/shipments/${shipment.id}/lines`, {
          orderLineId: service.lineIds[0],
          quantity: '1',
        })
      ),
      'UNKNOWN_ORDER_LINE'
    )
    const bad = await ctx.http.post('/api/v1/shipments', {
      orderId: order.id,
      lines: [{ orderLineId: order.lineIds[0], quantity: '11' }],
    })
    bad.assertStatus(422)
    assert.equal(code(bad), 'EXCEEDS_BALANCE')
    assert.equal(bad.body().error.details[0].path, 'lines[0].quantity')
    assert.equal(
      code(
        await ctx.http.post('/api/v1/shipments', {
          orderId: order.id,
          lines: [{ orderLineId: order.lineIds[0], quantity: '1.5' }],
        })
      ),
      'QUANTITY_PRECISION'
    )
    assert.equal(
      code(
        await ctx.http.post('/api/v1/shipments', {
          orderId: order.id,
          lines: [{ orderLineId: order.lineIds[0], quantity: '0' }],
        })
      ),
      'INVALID_QUANTITY'
    )
    // Edição do rascunho: quantidade e remoção de linhas.
    const edited = await must<any>(
      await ctx.http.patch(`/api/v1/shipments/${shipment.id}/lines/${shipment.lines[0].id}`, {
        quantity: '5',
      }),
      200
    )
    assert.equal(edited.lines[0].quantity, '5.000000')
    const emptied = await must<any>(
      await ctx.http.delete(`/api/v1/shipments/${shipment.id}/lines/${shipment.lines[0].id}`),
      200
    )
    assert.lengthOf(emptied.lines, 0)
    const empty = await ctx.http.post(`/api/v1/shipments/${shipment.id}/post`, {})
    empty.assertStatus(409)
    assert.equal(empty.body().error.code, 'SHIPMENT_EMPTY')
    // Um rascunho apaga-se; uma encomenda não confirmada não se expede.
    ;(await ctx.http.delete(`/api/v1/shipments/${shipment.id}`)).assertStatus(204)
    ;(await ctx.http.get(`/api/v1/shipments/${shipment.id}`)).assertStatus(404)
    const open = await must<any>(
      await ctx.http.post('/api/v1/sales-orders', {
        organizationId: ctx.org.id,
        customerId: ctx.customer.id,
      }),
      201
    )
    const notConfirmed = await ctx.http.post('/api/v1/shipments', { orderId: open.id })
    notConfirmed.assertStatus(409)
    assert.equal(notConfirmed.body().error.code, 'ORDER_NOT_SHIPPABLE')
    ;(
      await ctx.http.post('/api/v1/shipments', { orderId: '00000000-0000-4000-8000-000000000000' })
    ).assertStatus(404)
  })
})

test.group('expedições | lançar baixa o stock e consome a reserva', (g) => {
  common(g)

  test('a entrega parcial deixa o saldo correcto e a encomenda segue PARTIAL → FULFILLED', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const v = ctx.shirt.variant.id
    await stock(ctx, v, '10')
    const order = await confirmedOrder(ctx, [{ variantId: v, quantity: '10' }])
    assert.deepEqual(await balance(ctx, v), [
      { onHand: '10.000000', reserved: '10.000000', lot: null },
    ])

    const first = await draft(ctx, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '4' }])
    const posted = await must<any>(
      await ctx.http.post(`/api/v1/shipments/${first.id}/post`, {}),
      200
    )
    assert.isFalse(posted.idempotent)
    assert.equal(posted.shipment.status, 'POSTED')
    assert.match(posted.shipment.number, /^EXP A\/\d{4}\/\d+$/)
    assert.deepEqual(await balance(ctx, v), [
      { onHand: '6.000000', reserved: '6.000000', lot: null },
    ])
    let detail = await orderDetail(ctx, order.id)
    assert.equal(detail.status, 'PARTIAL')
    assert.equal(detail.lines[0].shippedQty, '4.000000')
    const [reservation] = await must<any[]>(
      await ctx.http.get(`/api/v1/stock-reservations?sourceId=${order.id}`),
      200
    )
    assert.deepInclude(reservation, { status: 'ACTIVE', consumedQty: '4.000000' })
    const moves = await must<any[]>(
      await ctx.http.get(`/api/v1/stock-movements?sourceType=SHIPMENT&sourceId=${first.id}`),
      200
    )
    assert.lengthOf(moves, 1)
    assert.deepInclude(moves[0], { kind: 'ISSUE', quantityDelta: '-4.000000', unitCost: '5.0000' })

    const second = await draft(ctx, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '6' }])
    await must(await ctx.http.post(`/api/v1/shipments/${second.id}/post`, {}), 200)
    detail = await orderDetail(ctx, order.id)
    assert.equal(detail.status, 'FULFILLED')
    assert.equal(detail.lines[0].shippedQty, '10.000000')
    assert.deepEqual(await balance(ctx, v), [
      { onHand: '0.000000', reserved: '0.000000', lot: null },
    ])
    const [done] = await must<any[]>(
      await ctx.http.get(`/api/v1/stock-reservations?sourceId=${order.id}`),
      200
    )
    assert.equal(done.status, 'CONSUMED')

    // Nada mais por expedir; a encomenda expedida já não se cancela.
    const more = await ctx.http.post('/api/v1/shipments', { orderId: order.id })
    more.assertStatus(409)
    assert.equal(more.body().error.code, 'ORDER_NOT_SHIPPABLE')
    const cancel = await ctx.http.post(`/api/v1/sales-orders/${order.id}/cancel`, { reason: 'x' })
    cancel.assertStatus(409)
    assert.equal(cancel.body().error.code, 'ORDER_NOT_CANCELLABLE')
  })

  test('lançar duas vezes não baixa duas vezes nem gasta outro número', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const v = ctx.shirt.variant.id
    await stock(ctx, v, '5')
    const order = await confirmedOrder(ctx, [{ variantId: v, quantity: '5' }])
    const shipment = await draft(ctx, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '2' }])
    const a = await must<any>(await ctx.http.post(`/api/v1/shipments/${shipment.id}/post`, {}), 200)
    const b = await must<any>(await ctx.http.post(`/api/v1/shipments/${shipment.id}/post`, {}), 200)
    assert.isTrue(b.idempotent)
    assert.equal(b.shipment.number, a.shipment.number)
    assert.equal((await balance(ctx, v))[0]!.onHand, '3.000000')
    const posted = await owner<{ n: number }>(
      `select count(*)::int as n from outbox_events where event_type = 'sales.shipment.posted'`,
      ctx.tenant
    )
    assert.equal(posted[0]!.n, 1)
    // Lançada, a expedição já não se altera nem se apaga.
    const edit = await ctx.http.patch(
      `/api/v1/shipments/${shipment.id}/lines/${shipment.lines[0].id}`,
      { quantity: '1' }
    )
    edit.assertStatus(409)
    assert.equal(edit.body().error.code, 'SHIPMENT_NOT_DRAFT')
    ;(await ctx.http.delete(`/api/v1/shipments/${shipment.id}`)).assertStatus(409)
    let blocked = 0
    for (const sql of [
      `update shipment_lines set quantity = 1`,
      `delete from shipment_lines`,
      `update shipments set notes = 'x'`,
      `delete from shipments`,
    ]) {
      try {
        await owner(sql, ctx.tenant)
      } catch {
        blocked++
      }
    }
    assert.equal(blocked, 4)
  })

  test('duas expedições concorrentes nunca entregam mais do que foi encomendado', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const v = ctx.shirt.variant.id
    await stock(ctx, v, '10')
    const order = await confirmedOrder(ctx, [{ variantId: v, quantity: '10' }])
    const drafts = await Promise.all(
      [1, 2, 3].map(() => draft(ctx, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '6' }]))
    )
    const results = await Promise.all(
      drafts.map((d) => ctx.http.post(`/api/v1/shipments/${d.id}/post`, {}))
    )
    assert.deepEqual(results.map((r) => r.status()).sort(), [200, 409, 409])
    const refused = results.find((r) => r.status() === 409)!
    assert.equal(refused.body().error.code, 'SHIPMENT_NOT_POSTABLE')
    assert.equal(refused.body().error.details[0].code, 'EXCEEDS_BALANCE')
    assert.equal((await orderDetail(ctx, order.id)).lines[0].shippedQty, '6.000000')
    assert.equal((await balance(ctx, v))[0]!.onHand, '4.000000')
  })

  test('sem stock a expedição não se lança e nada muda', async ({ client, assert }) => {
    const ctx = await setup(client)
    const v = ctx.shirt.variant.id
    // Armazém que aceita encomendas em falta: confirma com 2 reservados de 5.
    await must(
      await ctx.http.patch(`/api/v1/warehouses/${ctx.warehouse.id}`, {
        expectedVersion: ctx.warehouse.version,
        allowBackorder: true,
      }),
      200
    )
    await stock(ctx, v, '2')
    const order = await confirmedOrder(ctx, [{ variantId: v, quantity: '5' }])
    const shipment = await draft(ctx, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '5' }])
    const refused = await ctx.http.post(`/api/v1/shipments/${shipment.id}/post`, {})
    refused.assertStatus(409)
    assert.equal(refused.body().error.code, 'SHIPMENT_NOT_POSTABLE')
    assert.equal(refused.body().error.details[0].code, 'INSUFFICIENT_STOCK')
    assert.include(refused.body().error.details[0].message, '3.000000')
    assert.equal(
      (await must<any>(await ctx.http.get(`/api/v1/shipments/${shipment.id}`), 200)).status,
      'DRAFT'
    )
    assert.equal((await orderDetail(ctx, order.id)).status, 'CONFIRMED')
    assert.deepEqual(await balance(ctx, v), [
      { onHand: '2.000000', reserved: '2.000000', lot: null },
    ])
    assert.lengthOf(
      await owner(`select 1 from stock_movements where source_type = 'SHIPMENT'`, ctx.tenant),
      0
    )
    // O que se pode entregar entrega-se: 2 agora, e o resto quando chegar stock.
    await must(
      await ctx.http.patch(`/api/v1/shipments/${shipment.id}/lines/${shipment.lines[0].id}`, {
        quantity: '2',
      }),
      200
    )
    await must(await ctx.http.post(`/api/v1/shipments/${shipment.id}/post`, {}), 200)
    assert.equal((await orderDetail(ctx, order.id)).status, 'PARTIAL')
    await stock(ctx, v, '3')
    const rest = await draft(ctx, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '3' }])
    await must(await ctx.http.post(`/api/v1/shipments/${rest.id}/post`, {}), 200)
    assert.equal((await orderDetail(ctx, order.id)).status, 'FULFILLED')
    assert.equal((await balance(ctx, v))[0]!.onHand, '0.000000')
  })

  test('as reservas dos lotes são consumidas e o stock livre completa o que não estava reservado', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const v = ctx.yogurt.variant.id
    const lot = async (code: string, expiresOn: string) =>
      must<any>(await ctx.http.post('/api/v1/lots', { variantId: v, code, expiresOn }), 201)
    const soon = await lot('PROXIMO', '2098-01-01')
    const late = await lot('TARDIO', '2099-01-01')
    await stock(ctx, v, '3', { lotId: soon.id })
    await stock(ctx, v, '4', { lotId: late.id })
    // 4 reservados (3 do lote que caduca primeiro e 1 do outro); depois chega mais stock livre do lote tardio.
    const order = await confirmedOrder(ctx, [{ variantId: v, quantity: '4' }])
    await stock(ctx, v, '6', { lotId: late.id, reference: crypto.randomUUID() })
    const shipment = await draft(ctx, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '4' }])
    await must(await ctx.http.post(`/api/v1/shipments/${shipment.id}/post`, {}), 200)
    const byLot = new Map((await balance(ctx, v)).map((b) => [b.lot, b]))
    assert.deepInclude(byLot.get('PROXIMO'), { onHand: '0.000000', reserved: '0.000000' })
    assert.deepInclude(byLot.get('TARDIO'), { onHand: '9.000000', reserved: '0.000000' })
    const moves = await must<any[]>(
      await ctx.http.get(`/api/v1/stock-movements?sourceType=SHIPMENT&sourceId=${shipment.id}`),
      200
    )
    assert.lengthOf(moves, 2)
    assert.equal(
      moves.reduce((sum, m) => sum + Number(m.quantityDelta), 0),
      -4
    )
  })

  test('sem armazém de vendas nem reservas, lançar não mexe no stock; serviços nunca baixam', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client, { salesWarehouse: false })
    const order = await confirmedOrder(ctx, [
      { variantId: ctx.shirt.variant.id, quantity: '2' },
      { variantId: ctx.service.variant.id, quantity: '1' },
    ])
    const shipment = await draft(ctx, order.id, [
      { orderLineId: order.lineIds[0]!, quantity: '2' },
      { orderLineId: order.lineIds[1]!, quantity: '1' },
    ])
    await must(await ctx.http.post(`/api/v1/shipments/${shipment.id}/post`, {}), 200)
    assert.equal((await orderDetail(ctx, order.id)).status, 'FULFILLED')
    assert.lengthOf(await owner('select 1 from stock_movements', ctx.tenant), 0)
    // Com armazém de vendas, o serviço continua a não baixar.
    const withWarehouse = await setup(client)
    await stock(withWarehouse, withWarehouse.shirt.variant.id, '1')
    const o2 = await confirmedOrder(withWarehouse, [
      { variantId: withWarehouse.service.variant.id, quantity: '1' },
    ])
    const s2 = await draft(withWarehouse, o2.id, [{ orderLineId: o2.lineIds[0]!, quantity: '1' }])
    await must(await withWarehouse.http.post(`/api/v1/shipments/${s2.id}/post`, {}), 200)
    assert.lengthOf(
      await owner(
        `select 1 from stock_movements where source_type = 'SHIPMENT'`,
        withWarehouse.tenant
      ),
      0
    )
  })

  test('sem a sequência de expedições o lançamento falha por inteiro', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client, { shipmentSequence: false })
    const v = ctx.shirt.variant.id
    await stock(ctx, v, '3')
    const order = await confirmedOrder(ctx, [{ variantId: v, quantity: '3' }])
    const shipment = await draft(ctx, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '3' }])
    const failed = await ctx.http.post(`/api/v1/shipments/${shipment.id}/post`, {})
    assert.isAbove(failed.status(), 399)
    assert.equal(
      (await must<any>(await ctx.http.get(`/api/v1/shipments/${shipment.id}`), 200)).status,
      'DRAFT'
    )
    assert.equal((await balance(ctx, v))[0]!.onHand, '3.000000')
  })
})

test.group('expedições | reversão', (g) => {
  common(g)

  test('reverter repõe o stock ao custo original e reabre o saldo da encomenda', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const v = ctx.shirt.variant.id
    await stock(ctx, v, '10')
    const order = await confirmedOrder(ctx, [{ variantId: v, quantity: '10' }])
    const shipment = await draft(ctx, order.id, [
      { orderLineId: order.lineIds[0]!, quantity: '10' },
    ])
    await must(await ctx.http.post(`/api/v1/shipments/${shipment.id}/post`, {}), 200)
    assert.equal((await orderDetail(ctx, order.id)).status, 'FULFILLED')
    assert.equal((await balance(ctx, v))[0]!.onHand, '0.000000')

    const missingReason = await ctx.http.post(`/api/v1/shipments/${shipment.id}/reverse`, {
      reason: ' ',
    })
    missingReason.assertStatus(422)
    const reversed = await must<any>(
      await ctx.http.post(`/api/v1/shipments/${shipment.id}/reverse`, {
        reason: 'Devolvida pelo cliente',
      }),
      200
    )
    assert.equal(reversed.shipment.status, 'REVERSED')
    assert.equal(reversed.shipment.reverseReason, 'Devolvida pelo cliente')
    assert.equal((await balance(ctx, v))[0]!.onHand, '10.000000')
    const moves = await must<any[]>(
      await ctx.http.get(`/api/v1/stock-movements?variantId=${v}`),
      200
    )
    const back = moves.find((m) => m.kind === 'REVERSAL')
    assert.deepInclude(back, { quantityDelta: '10.000000', unitCost: '5.0000' })
    const order2 = await orderDetail(ctx, order.id)
    assert.equal(order2.status, 'CONFIRMED')
    assert.equal(order2.lines[0].shippedQty, '0.000000')
    // Idempotente: reverter outra vez não repõe duas vezes; e a revertida já não se lança.
    const twice = await must<any>(
      await ctx.http.post(`/api/v1/shipments/${shipment.id}/reverse`, { reason: 'Outra vez' }),
      200
    )
    assert.isTrue(twice.idempotent)
    assert.equal((await balance(ctx, v))[0]!.onHand, '10.000000')
    const repost = await ctx.http.post(`/api/v1/shipments/${shipment.id}/post`, {})
    repost.assertStatus(409)
    assert.equal(repost.body().error.code, 'SHIPMENT_REVERSED')
    // Volta a expedir-se a partir do stock livre (a reserva consumida não se restaura).
    const again = await draft(ctx, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '10' }])
    await must(await ctx.http.post(`/api/v1/shipments/${again.id}/post`, {}), 200)
    assert.equal((await balance(ctx, v))[0]!.onHand, '0.000000')
    assert.equal((await orderDetail(ctx, order.id)).status, 'FULFILLED')
  })

  test('só uma expedição lançada se reverte', async ({ client, assert }) => {
    const ctx = await setup(client)
    await stock(ctx, ctx.shirt.variant.id, '2')
    const order = await confirmedOrder(ctx, [{ variantId: ctx.shirt.variant.id, quantity: '2' }])
    const shipment = await draft(ctx, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '2' }])
    const early = await ctx.http.post(`/api/v1/shipments/${shipment.id}/reverse`, { reason: 'x' })
    early.assertStatus(409)
    assert.equal(early.body().error.code, 'SHIPMENT_NOT_POSTED')
  })
})

test.group('expedições | autorização e isolamento', (g) => {
  common(g)

  test('cada operação exige a sua permissão e a funcionalidade licenciada', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    await stock(ctx, ctx.shirt.variant.id, '5')
    const order = await confirmedOrder(ctx, [{ variantId: ctx.shirt.variant.id, quantity: '5' }])
    const shipment = await draft(ctx, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '1' }])
    const reader = await memberWith(ctx, ['shipment.read'])
    ;(await reader.get('/api/v1/shipments')).assertStatus(200)
    ;(await reader.get(`/api/v1/shipments/${shipment.id}`)).assertStatus(200)
    ;(await reader.post('/api/v1/shipments', { orderId: order.id })).assertStatus(403)
    ;(await reader.post(`/api/v1/shipments/${shipment.id}/post`, {})).assertStatus(403)
    const manager = await memberWith(ctx, ['shipment.read', 'shipment.manage'])
    ;(await manager.post('/api/v1/shipments', { orderId: order.id })).assertStatus(201)
    ;(await manager.post(`/api/v1/shipments/${shipment.id}/post`, {})).assertStatus(403)
    ;(await manager.post(`/api/v1/shipments/${shipment.id}/reverse`, { reason: 'x' })).assertStatus(
      403
    )
    const poster = await memberWith(ctx, ['shipment.post'])
    ;(await poster.post(`/api/v1/shipments/${shipment.id}/post`, {})).assertStatus(200)
    ;(await (await memberWith(ctx, ['party.read'])).get('/api/v1/shipments')).assertStatus(403)
    // Sem a funcionalidade, nem os administradores acedem.
    await must(
      await ctx.http.put('/api/v1/tenant/features/orders.shipments', {
        override: false,
        reason: 'Teste',
      }),
      200
    )
    const off = await ctx.http.get('/api/v1/shipments')
    off.assertStatus(403)
    assert.equal(off.body().error.code, 'FEATURE_NOT_AVAILABLE')
  })

  test('as alterações ficam na auditoria e os dados de outro tenant não se vêem nem se tocam', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    await stock(ctx, ctx.shirt.variant.id, '2')
    const order = await confirmedOrder(ctx, [{ variantId: ctx.shirt.variant.id, quantity: '2' }])
    const shipment = await draft(ctx, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '2' }])
    await must(await ctx.http.post(`/api/v1/shipments/${shipment.id}/post`, {}), 200)
    const logs = await must<any[]>(
      await ctx.http.get(`/api/v1/audit-logs?resourceId=${shipment.id}`),
      200
    )
    assert.isAbove(logs.length, 1)
    const other = await setup(client)
    ;(await other.http.get(`/api/v1/shipments/${shipment.id}`)).assertStatus(404)
    ;(await other.http.post(`/api/v1/shipments/${shipment.id}/post`, {})).assertStatus(404)
    ;(
      await other.http.post(`/api/v1/shipments/${shipment.id}/reverse`, { reason: 'x' })
    ).assertStatus(404)
    ;(await other.http.delete(`/api/v1/shipments/${shipment.id}`)).assertStatus(404)
    ;(await other.http.post('/api/v1/shipments', { orderId: order.id })).assertStatus(404)
    assert.lengthOf(await must<any[]>(await other.http.get('/api/v1/shipments'), 200), 0)
    assert.lengthOf(await owner('select 1 from shipments', other.tenant), 0)
    assert.lengthOf(await owner('select 1 from shipments', ctx.tenant), 1)
  })
})
