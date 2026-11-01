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

const MODULES = ['catalog', 'inventory', 'procurement']

/**
 * Tenant com `catalog`, `inventory` e `procurement`: uma organização, um armazém (local PRINCIPAL), os produtos «Camisola»
 * (com stock), «Iogurte» (por lote) e «Instalação» (serviço), um fornecedor e as sequências dos documentos de compra.
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
    ['PURCHASE_REQUISITION', 'REQ {SERIES}/{YYYY}/'],
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
  const makeProduct = async (body: Record<string, unknown>) => {
    const product = await must<any>(
      await http.post('/api/v1/products', { type: 'GOODS', baseUnitId: unit.id, ...body }),
      201
    )
    return product.variants[0] as { id: string; sku: string }
  }
  const shirt = await makeProduct({ code: 'CAM-001', name: 'Camisola' })
  const yogurt = await makeProduct({ code: 'IOG-001', name: 'Iogurte', trackingMode: 'LOT' })
  const service = await makeProduct({ code: 'SRV-001', name: 'Instalação', type: 'SERVICE' })
  const warehouse = await must<any>(
    await http.post('/api/v1/warehouses', {
      organizationId: org.id,
      code: 'ARM-1',
      name: 'Central',
    }),
    201
  )
  const party = await must<any>(
    await http.post('/api/v1/organization-parties', {
      legalName: 'Fornecedora, SA',
      taxCountry: 'AO',
      taxId: '5000099999',
    }),
    201
  )
  const supplier = await must<any>(
    await http.post('/api/v1/suppliers', {
      partyId: party.id,
      organizationId: org.id,
      code: 'FOR-001',
      paymentTermDays: 30,
    }),
    201
  )
  return { client, tenant, admin, http, org, shirt, yogurt, service, warehouse, party, supplier }
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

/** Encomenda confirmada com as linhas pedidas (`variantId`, `quantity`, `unitCost`). */
async function confirmedOrder(
  ctx: Ctx,
  lines: { variantId: string; quantity: string; unitCost: string; taxRate?: string }[]
) {
  const draft = await must<any>(
    await ctx.http.post('/api/v1/purchase-orders', { supplierId: ctx.supplier.id, lines }),
    201
  )
  await must(await ctx.http.post(`/api/v1/purchase-orders/${draft.id}/confirm`, {}), 200)
  return { id: draft.id as string, lineIds: draft.lines.map((l: any) => l.id as string) }
}

const draftReceipt = async (
  ctx: Ctx,
  orderId: string,
  lines: { purchaseLineId: string; quantity: string; lotCode?: string; expiresOn?: string }[],
  extra: Record<string, unknown> = {}
) =>
  must<any>(
    await ctx.http.post('/api/v1/goods-receipts', {
      purchaseOrderId: orderId,
      warehouseId: ctx.warehouse.id,
      lines,
      ...extra,
    }),
    201
  )

const balances = async (ctx: Ctx, variantId: string) =>
  (await must<any[]>(await ctx.http.get(`/api/v1/stock-balances?variantId=${variantId}`), 200)).map(
    (b) => ({ onHand: b.onHand, lot: b.lotCode })
  )

const orderDetail = async (ctx: Ctx, id: string) =>
  must<any>(await ctx.http.get(`/api/v1/purchase-orders/${id}`), 200)

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

test.group('fornecedores', (g) => {
  common(g)

  test('cria sobre a Party, recusa duplicados e campos imutáveis, e bloquear exige motivo', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    assert.deepInclude(ctx.supplier, {
      code: 'FOR-001',
      currency: 'AOA',
      status: 'ACTIVE',
      partyName: 'Fornecedora, SA',
      taxId: '5000099999',
    })
    const dupCode = await ctx.http.post('/api/v1/suppliers', {
      partyId: ctx.party.id,
      organizationId: ctx.org.id,
      code: 'FOR-001',
    })
    dupCode.assertStatus(409)
    assert.equal(dupCode.body().error.code, 'SUPPLIER_CODE_EXISTS')
    const dupParty = await ctx.http.post('/api/v1/suppliers', {
      partyId: ctx.party.id,
      organizationId: ctx.org.id,
      code: 'FOR-002',
    })
    dupParty.assertStatus(409)
    assert.equal(dupParty.body().error.code, 'SUPPLIER_EXISTS')
    const immutable = await ctx.http.patch(`/api/v1/suppliers/${ctx.supplier.id}`, {
      expectedVersion: ctx.supplier.version,
      code: 'OUTRO',
    })
    immutable.assertStatus(422)
    assert.equal(code(immutable), 'IMMUTABLE')
    const noReason = await ctx.http.patch(`/api/v1/suppliers/${ctx.supplier.id}`, {
      expectedVersion: ctx.supplier.version,
      status: 'BLOCKED',
    })
    noReason.assertStatus(422)
    assert.equal(code(noReason), 'REASON_REQUIRED')
    const blocked = await must<any>(
      await ctx.http.patch(`/api/v1/suppliers/${ctx.supplier.id}`, {
        expectedVersion: ctx.supplier.version,
        status: 'BLOCKED',
        statusReason: 'Auditoria pendente',
      }),
      200
    )
    assert.equal(blocked.status, 'BLOCKED')
    const stale = await ctx.http.patch(`/api/v1/suppliers/${ctx.supplier.id}`, {
      expectedVersion: ctx.supplier.version,
      paymentTermDays: 5,
    })
    stale.assertStatus(409)
    const found = await must<any[]>(await ctx.http.get('/api/v1/suppliers?q=5000099999'), 200)
    assert.lengthOf(found, 1)
  })

  test('um fornecedor bloqueado não recebe novas encomendas, mas as já confirmadas continuam a receber-se', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const order = await confirmedOrder(ctx, [
      { variantId: ctx.shirt.id, quantity: '10', unitCost: '5' },
    ])
    await must(
      await ctx.http.patch(`/api/v1/suppliers/${ctx.supplier.id}`, {
        expectedVersion: ctx.supplier.version,
        status: 'BLOCKED',
        statusReason: 'Auditoria pendente',
      }),
      200
    )
    const refused = await ctx.http.post('/api/v1/purchase-orders', { supplierId: ctx.supplier.id })
    refused.assertStatus(409)
    assert.equal(refused.body().error.code, 'SUPPLIER_BLOCKED')
    const receipt = await draftReceipt(ctx, order.id, [
      { purchaseLineId: order.lineIds[0]!, quantity: '4' },
    ])
    ;(await ctx.http.post(`/api/v1/goods-receipts/${receipt.id}/post`, {})).assertStatus(200)
  })
})

test.group('encomendas a fornecedor', (g) => {
  common(g)

  test('calcula os totais exactos, confirma com número e evento e é idempotente', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const draft = await must<any>(
      await ctx.http.post('/api/v1/purchase-orders', {
        supplierId: ctx.supplier.id,
        lines: [{ variantId: ctx.shirt.id, quantity: '2', unitCost: '50', taxRate: '14' }],
      }),
      201
    )
    assert.deepInclude(draft, { status: 'DRAFT', number: null, currency: 'AOA' })
    assert.deepEqual(draft.totals, { net: '100.0000', tax: '14.0000', total: '114.0000' })
    assert.include(draft.lines[0].description, 'Camisola — CAM-001')
    const more = await must<any>(
      await ctx.http.post(`/api/v1/purchase-orders/${draft.id}/lines`, {
        variantId: ctx.service.id,
        quantity: '1',
        unitCost: '10.5',
      }),
      201
    )
    assert.deepEqual(more.totals, { net: '110.5000', tax: '14.0000', total: '124.5000' })
    const trimmed = await must<any>(
      await ctx.http.delete(`/api/v1/purchase-orders/${draft.id}/lines/${more.lines[1].id}`),
      200
    )
    assert.equal(trimmed.totals.total, '114.0000')
    const bad = await ctx.http.post(`/api/v1/purchase-orders/${draft.id}/lines`, {
      variantId: ctx.service.id,
      quantity: '0',
      unitCost: '-1',
      taxRate: '101',
    })
    bad.assertStatus(422)
    assert.sameMembers(
      bad.body().error.details.map((d: any) => d.code),
      ['INVALID_QUANTITY', 'INVALID_COST', 'INVALID_TAX_RATE']
    )

    const confirmed = await must<any>(
      await ctx.http.post(`/api/v1/purchase-orders/${draft.id}/confirm`, {}),
      200
    )
    assert.isFalse(confirmed.idempotent)
    assert.match(confirmed.order.number, /^OC A\/\d{4}\/\d+$/)
    assert.equal(confirmed.order.status, 'ORDERED')
    const again = await must<any>(
      await ctx.http.post(`/api/v1/purchase-orders/${draft.id}/confirm`, {}),
      200
    )
    assert.isTrue(again.idempotent)
    assert.equal(again.order.number, confirmed.order.number)
    assert.lengthOf(
      await owner(
        `select 1 from outbox_events where event_type = 'procurement.purchase_order.confirmed'`,
        ctx.tenant
      ),
      1
    )
  })

  test('uma encomenda confirmada não se altera: nem pela API nem pela base de dados', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const order = await confirmedOrder(ctx, [
      { variantId: ctx.shirt.id, quantity: '2', unitCost: '50' },
    ])
    const current = await orderDetail(ctx, order.id)
    for (const request of [
      ctx.http.patch(`/api/v1/purchase-orders/${order.id}`, {
        expectedVersion: current.version,
        notes: 'x',
      }),
      ctx.http.delete(`/api/v1/purchase-orders/${order.id}`),
      ctx.http.post(`/api/v1/purchase-orders/${order.id}/lines`, {
        variantId: ctx.service.id,
        quantity: '1',
        unitCost: '1',
      }),
      ctx.http.delete(`/api/v1/purchase-orders/${order.id}/lines/${order.lineIds[0]}`),
    ]) {
      const response = await request
      response.assertStatus(409)
      assert.equal(response.body().error.code, 'PURCHASE_ORDER_NOT_DRAFT')
    }
    for (const sql of [
      `update purchase_orders set total = 1 where id = '${order.id}'`,
      `update purchase_orders set notes = 'x' where id = '${order.id}'`,
      `update purchase_lines set quantity = 9 where order_id = '${order.id}'`,
      `delete from purchase_lines where order_id = '${order.id}'`,
      `delete from purchase_orders where id = '${order.id}'`,
    ]) {
      let failed = false
      try {
        await owner(sql, ctx.tenant)
      } catch {
        failed = true
      }
      assert.isTrue(failed, sql)
    }
    const empty = await must<any>(
      await ctx.http.post('/api/v1/purchase-orders', { supplierId: ctx.supplier.id }),
      201
    )
    const noLines = await ctx.http.post(`/api/v1/purchase-orders/${empty.id}/confirm`, {})
    noLines.assertStatus(409)
    assert.equal(noLines.body().error.code, 'PURCHASE_ORDER_EMPTY')
  })

  test('cancelar exige motivo; numa encomenda parcial cancela-se o restante e a recepção fica', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const v = ctx.shirt.id
    const order = await confirmedOrder(ctx, [{ variantId: v, quantity: '10', unitCost: '5' }])
    const noReason = await ctx.http.post(`/api/v1/purchase-orders/${order.id}/cancel`, {})
    noReason.assertStatus(422)
    const receipt = await draftReceipt(ctx, order.id, [
      { purchaseLineId: order.lineIds[0]!, quantity: '4' },
    ])
    await must(await ctx.http.post(`/api/v1/goods-receipts/${receipt.id}/post`, {}), 200)
    const cancelled = await must<any>(
      await ctx.http.post(`/api/v1/purchase-orders/${order.id}/cancel`, { reason: 'Desistência' }),
      200
    )
    assert.isFalse(cancelled.idempotent)
    assert.equal(cancelled.order.status, 'CANCELLED')
    // A recepção lançada e o stock preservam-se; a encomenda cancelada já não recebe mais.
    assert.equal(cancelled.order.lines[0].receivedQty, '4.000000')
    assert.deepEqual(await balances(ctx, v), [{ onHand: '4.000000', lot: null }])
    assert.equal(
      (await must<any>(await ctx.http.get(`/api/v1/goods-receipts/${receipt.id}`), 200)).status,
      'POSTED'
    )
    const events = await owner<any>(
      `select payload from outbox_events where event_type = 'procurement.purchase_order.cancelled'`,
      ctx.tenant
    )
    assert.isTrue(events[0].payload.remainderOnly)
    const again = await must<any>(
      await ctx.http.post(`/api/v1/purchase-orders/${order.id}/cancel`, { reason: 'Desistência' }),
      200
    )
    assert.isTrue(again.idempotent)
    const receive = await ctx.http.post('/api/v1/goods-receipts', { purchaseOrderId: order.id })
    receive.assertStatus(409)
    assert.equal(receive.body().error.code, 'PURCHASE_ORDER_NOT_RECEIVABLE')
    assert.equal(
      (await ctx.http.post(`/api/v1/purchase-orders/${order.id}/confirm`, {})).status(),
      409
    )
    // Reverter a recepção devolve o stock, mas não reabre a encomenda cancelada.
    await must(
      await ctx.http.post(`/api/v1/goods-receipts/${receipt.id}/reverse`, { reason: 'Engano' }),
      200
    )
    assert.deepEqual(await balances(ctx, v), [{ onHand: '0.000000', lot: null }])
    assert.equal((await orderDetail(ctx, order.id)).status, 'CANCELLED')
  })

  test('uma encomenda toda recebida não tem restante a cancelar; uma sem recepções cancela-se inteira', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const v = ctx.shirt.id
    const done = await confirmedOrder(ctx, [{ variantId: v, quantity: '2', unitCost: '5' }])
    const receipt = await draftReceipt(ctx, done.id, [
      { purchaseLineId: done.lineIds[0]!, quantity: '2' },
    ])
    await must(await ctx.http.post(`/api/v1/goods-receipts/${receipt.id}/post`, {}), 200)
    const refused = await ctx.http.post(`/api/v1/purchase-orders/${done.id}/cancel`, {
      reason: 'x',
    })
    refused.assertStatus(409)
    assert.equal(refused.body().error.code, 'PURCHASE_ORDER_RECEIVED')
    const untouched = await confirmedOrder(ctx, [{ variantId: v, quantity: '2', unitCost: '5' }])
    const whole = await must<any>(
      await ctx.http.post(`/api/v1/purchase-orders/${untouched.id}/cancel`, { reason: 'Erro' }),
      200
    )
    assert.equal(whole.order.status, 'CANCELLED')
    const events = await owner<any>(
      `select payload from outbox_events where event_type = 'procurement.purchase_order.cancelled'`,
      ctx.tenant
    )
    assert.isFalse(events[0].payload.remainderOnly)
  })
})

test.group('recepções | entrada de stock', (g) => {
  common(g)

  test('a recepção parcial dá entrada ao custo da linha e a encomenda segue PARTIAL → RECEIVED', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const v = ctx.shirt.id
    const order = await confirmedOrder(ctx, [{ variantId: v, quantity: '10', unitCost: '5' }])
    assert.deepEqual(await balances(ctx, v), [])

    const first = await draftReceipt(ctx, order.id, [
      { purchaseLineId: order.lineIds[0]!, quantity: '4' },
    ])
    assert.deepInclude(first, { status: 'DRAFT', number: null })
    const posted = await must<any>(
      await ctx.http.post(`/api/v1/goods-receipts/${first.id}/post`, {}),
      200
    )
    assert.isFalse(posted.idempotent)
    assert.match(posted.receipt.number, /^REC A\/\d{4}\/\d+$/)
    assert.deepEqual(await balances(ctx, v), [{ onHand: '4.000000', lot: null }])
    let detail = await orderDetail(ctx, order.id)
    assert.equal(detail.status, 'PARTIAL')
    assert.equal(detail.lines[0].receivedQty, '4.000000')
    const moves = await must<any[]>(
      await ctx.http.get(`/api/v1/stock-movements?sourceType=GOODS_RECEIPT&sourceId=${first.id}`),
      200
    )
    assert.lengthOf(moves, 1)
    assert.deepInclude(moves[0], { kind: 'RECEIPT', quantityDelta: '4.000000', unitCost: '5.0000' })

    const second = await draftReceipt(ctx, order.id, [
      { purchaseLineId: order.lineIds[0]!, quantity: '6' },
    ])
    await must(await ctx.http.post(`/api/v1/goods-receipts/${second.id}/post`, {}), 200)
    detail = await orderDetail(ctx, order.id)
    assert.equal(detail.status, 'RECEIVED')
    assert.deepEqual(await balances(ctx, v), [{ onHand: '10.000000', lot: null }])
    const more = await ctx.http.post('/api/v1/goods-receipts', { purchaseOrderId: order.id })
    more.assertStatus(409)
    assert.equal(more.body().error.code, 'PURCHASE_ORDER_NOT_RECEIVABLE')
  })

  test('lançar duas vezes não dá entrada duas vezes nem gasta outro número; lançada é imutável', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const v = ctx.shirt.id
    const order = await confirmedOrder(ctx, [{ variantId: v, quantity: '5', unitCost: '5' }])
    const receipt = await draftReceipt(ctx, order.id, [
      { purchaseLineId: order.lineIds[0]!, quantity: '2' },
    ])
    const a = await must<any>(
      await ctx.http.post(`/api/v1/goods-receipts/${receipt.id}/post`, {}),
      200
    )
    const b = await must<any>(
      await ctx.http.post(`/api/v1/goods-receipts/${receipt.id}/post`, {}),
      200
    )
    assert.isTrue(b.idempotent)
    assert.equal(a.receipt.number, b.receipt.number)
    assert.deepEqual(await balances(ctx, v), [{ onHand: '2.000000', lot: null }])
    for (const request of [
      ctx.http.delete(`/api/v1/goods-receipts/${receipt.id}`),
      ctx.http.post(`/api/v1/goods-receipts/${receipt.id}/lines`, {
        purchaseLineId: order.lineIds[0],
        quantity: '1',
      }),
    ]) {
      const response = await request
      response.assertStatus(409)
      assert.equal(response.body().error.code, 'GOODS_RECEIPT_NOT_DRAFT')
    }
    for (const sql of [
      `update goods_receipts set notes = 'x' where id = '${receipt.id}'`,
      `update goods_receipt_lines set quantity = 9 where receipt_id = '${receipt.id}'`,
      `delete from goods_receipts where id = '${receipt.id}'`,
    ]) {
      let failed = false
      try {
        await owner(sql, ctx.tenant)
      } catch {
        failed = true
      }
      assert.isTrue(failed, sql)
    }
  })

  test('valida a linha, a quantidade, o armazém e a linha repetida', async ({ client, assert }) => {
    const ctx = await setup(client)
    const order = await confirmedOrder(ctx, [
      { variantId: ctx.shirt.id, quantity: '10', unitCost: '5' },
    ])
    const other = await confirmedOrder(ctx, [
      { variantId: ctx.shirt.id, quantity: '1', unitCost: '5' },
    ])
    const receipt = await draftReceipt(ctx, order.id, [
      { purchaseLineId: order.lineIds[0]!, quantity: '4' },
    ])
    const dup = await ctx.http.post(`/api/v1/goods-receipts/${receipt.id}/lines`, {
      purchaseLineId: order.lineIds[0],
      quantity: '1',
    })
    dup.assertStatus(409)
    assert.equal(dup.body().error.code, 'GOODS_RECEIPT_LINE_DUPLICATE')
    const foreign = await ctx.http.post(`/api/v1/goods-receipts/${receipt.id}/lines`, {
      purchaseLineId: other.lineIds[0],
      quantity: '1',
    })
    foreign.assertStatus(422)
    assert.equal(code(foreign), 'UNKNOWN_PURCHASE_LINE')
    const over = await ctx.http.post('/api/v1/goods-receipts', {
      purchaseOrderId: order.id,
      lines: [{ purchaseLineId: order.lineIds[0], quantity: '11' }],
    })
    over.assertStatus(422)
    assert.equal(code(over), 'EXCEEDS_BALANCE')
    assert.equal(over.body().error.details[0].path, 'lines[0].quantity')
    const badWarehouse = await ctx.http.post('/api/v1/goods-receipts', {
      purchaseOrderId: order.id,
      warehouseId: '00000000-0000-4000-8000-000000000000',
    })
    badWarehouse.assertStatus(422)
    assert.equal(code(badWarehouse), 'UNKNOWN_WAREHOUSE')
    const noWarehouse = await must<any>(
      await ctx.http.post('/api/v1/goods-receipts', {
        purchaseOrderId: order.id,
        lines: [{ purchaseLineId: order.lineIds[0], quantity: '1' }],
      }),
      201
    )
    const refused = await ctx.http.post(`/api/v1/goods-receipts/${noWarehouse.id}/post`, {})
    refused.assertStatus(409)
    assert.equal(refused.body().error.code, 'GOODS_RECEIPT_NOT_POSTABLE')
    assert.equal(code(refused), 'WAREHOUSE_REQUIRED')
    const empty = await must<any>(
      await ctx.http.post('/api/v1/goods-receipts', { purchaseOrderId: order.id }),
      201
    )
    const noLines = await ctx.http.post(`/api/v1/goods-receipts/${empty.id}/post`, {})
    noLines.assertStatus(409)
    assert.equal(noLines.body().error.code, 'GOODS_RECEIPT_EMPTY')
  })

  test('duas recepções lançadas ao mesmo tempo nunca recebem mais do que foi encomendado', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const v = ctx.shirt.id
    const order = await confirmedOrder(ctx, [{ variantId: v, quantity: '10', unitCost: '5' }])
    const a = await draftReceipt(ctx, order.id, [
      { purchaseLineId: order.lineIds[0]!, quantity: '6' },
    ])
    const b = await draftReceipt(ctx, order.id, [
      { purchaseLineId: order.lineIds[0]!, quantity: '6' },
    ])
    const results = await Promise.all([
      ctx.http.post(`/api/v1/goods-receipts/${a.id}/post`, {}),
      ctx.http.post(`/api/v1/goods-receipts/${b.id}/post`, {}),
    ])
    assert.sameMembers(results.map((r) => r.status()).sort(), [200, 409])
    const loser = results.find((r) => r.status() === 409)
    assert.equal(loser?.body().error.code, 'GOODS_RECEIPT_NOT_POSTABLE')
    assert.deepEqual(await balances(ctx, v), [{ onHand: '6.000000', lot: null }])
    assert.equal((await orderDetail(ctx, order.id)).lines[0].receivedQty, '6.000000')
  })

  test('produtos por lote exigem o lote (criado ao receber); serviços não movem stock', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const order = await confirmedOrder(ctx, [
      { variantId: ctx.yogurt.id, quantity: '10', unitCost: '2' },
      { variantId: ctx.service.id, quantity: '1', unitCost: '100' },
    ])
    const receipt = await draftReceipt(ctx, order.id, [
      { purchaseLineId: order.lineIds[0]!, quantity: '10' },
      { purchaseLineId: order.lineIds[1]!, quantity: '1' },
    ])
    const noLot = await ctx.http.post(`/api/v1/goods-receipts/${receipt.id}/post`, {})
    noLot.assertStatus(409)
    assert.equal(code(noLot), 'LOT_REQUIRED')
    assert.deepEqual(await balances(ctx, ctx.yogurt.id), [])
    await must(
      await ctx.http.delete(`/api/v1/goods-receipts/${receipt.id}`).then((r) => r),
      204
    ).catch(() => null)
    const withLot = await draftReceipt(ctx, order.id, [
      {
        purchaseLineId: order.lineIds[0]!,
        quantity: '10',
        lotCode: 'L-2099',
        expiresOn: '2099-01-01',
      },
      { purchaseLineId: order.lineIds[1]!, quantity: '1' },
    ])
    await must(await ctx.http.post(`/api/v1/goods-receipts/${withLot.id}/post`, {}), 200)
    assert.deepEqual(await balances(ctx, ctx.yogurt.id), [{ onHand: '10.000000', lot: 'L-2099' }])
    assert.deepEqual(await balances(ctx, ctx.service.id), [])
    assert.equal((await orderDetail(ctx, order.id)).status, 'RECEIVED')
    const lots = await must<any[]>(
      await ctx.http.get(`/api/v1/lots?variantId=${ctx.yogurt.id}`),
      200
    )
    assert.equal(lots[0].expiresOn, '2099-01-01')
  })

  test('reverter tira o stock e reabre o saldo; falha se o stock já foi consumido', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const v = ctx.shirt.id
    const order = await confirmedOrder(ctx, [{ variantId: v, quantity: '10', unitCost: '5' }])
    const receipt = await draftReceipt(ctx, order.id, [
      { purchaseLineId: order.lineIds[0]!, quantity: '10' },
    ])
    await must(await ctx.http.post(`/api/v1/goods-receipts/${receipt.id}/post`, {}), 200)
    assert.equal((await orderDetail(ctx, order.id)).status, 'RECEIVED')

    // Consumir parte do stock impede a reversão: nada muda.
    const location = ctx.warehouse.locations[0].id
    await must(
      await ctx.http.post('/api/v1/stock-adjustments', {
        variantId: v,
        locationId: location,
        quantityDelta: '-3',
        reason: 'Consumo',
      }),
      201
    )
    const blocked = await ctx.http.post(`/api/v1/goods-receipts/${receipt.id}/reverse`, {
      reason: 'Engano',
    })
    assert.isAbove(blocked.status(), 399)
    assert.equal(
      (await must<any>(await ctx.http.get(`/api/v1/goods-receipts/${receipt.id}`), 200)).status,
      'POSTED'
    )
    assert.equal((await orderDetail(ctx, order.id)).status, 'RECEIVED')
    await must(
      await ctx.http.post('/api/v1/stock-adjustments', {
        variantId: v,
        locationId: location,
        quantityDelta: '3',
        unitCost: '5',
        reason: 'Reposição',
      }),
      201
    )
    const noReason = await ctx.http.post(`/api/v1/goods-receipts/${receipt.id}/reverse`, {})
    noReason.assertStatus(422)
    const reversed = await must<any>(
      await ctx.http.post(`/api/v1/goods-receipts/${receipt.id}/reverse`, { reason: 'Engano' }),
      200
    )
    assert.equal(reversed.receipt.status, 'REVERSED')
    assert.deepEqual(await balances(ctx, v), [{ onHand: '0.000000', lot: null }])
    assert.equal((await orderDetail(ctx, order.id)).status, 'ORDERED')
    const again = await must<any>(
      await ctx.http.post(`/api/v1/goods-receipts/${receipt.id}/reverse`, { reason: 'Engano' }),
      200
    )
    assert.isTrue(again.idempotent)
    const repost = await ctx.http.post(`/api/v1/goods-receipts/${receipt.id}/post`, {})
    repost.assertStatus(409)
    assert.equal(repost.body().error.code, 'GOODS_RECEIPT_REVERSED')
    // O saldo reaberto recebe-se outra vez.
    const again2 = await draftReceipt(ctx, order.id, [
      { purchaseLineId: order.lineIds[0]!, quantity: '10' },
    ])
    await must(await ctx.http.post(`/api/v1/goods-receipts/${again2.id}/post`, {}), 200)
    assert.equal((await orderDetail(ctx, order.id)).status, 'RECEIVED')
  })
})

test.group('requisições', (g) => {
  common(g)

  const requisition = async (ctx: Ctx, http: Http = ctx.http) =>
    must<any>(
      await http.post('/api/v1/purchase-requisitions', {
        organizationId: ctx.org.id,
        lines: [
          { variantId: ctx.shirt.id, quantity: '5' },
          { variantId: ctx.service.id, quantity: '2' },
        ],
      }),
      201
    )

  test('rascunho → submetida → aprovada por outra pessoa → convertida numa encomenda, de forma idempotente', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const requester = await memberWith(ctx, [
      'requisition.read',
      'requisition.manage',
      'purchase.read',
      'purchase.manage',
    ])
    const approver = await memberWith(ctx, ['requisition.read', 'requisition.approve'])
    const req = await requisition(ctx, requester)
    assert.deepInclude(req, { status: 'DRAFT', number: null })
    const dup = await requester.post(`/api/v1/purchase-requisitions/${req.id}/lines`, {
      variantId: ctx.shirt.id,
      quantity: '1',
    })
    dup.assertStatus(409)
    assert.equal(dup.body().error.code, 'REQUISITION_LINE_DUPLICATE')
    const early = await approver.post(`/api/v1/purchase-requisitions/${req.id}/approve`, {})
    early.assertStatus(409)
    assert.equal(early.body().error.code, 'REQUISITION_NOT_SUBMITTED')
    const submitted = await must<any>(
      await requester.post(`/api/v1/purchase-requisitions/${req.id}/submit`, {}),
      200
    )
    assert.match(submitted.requisition.number, /^REQ A\/\d{4}\/\d+$/)
    assert.equal(submitted.requisition.status, 'SUBMITTED')
    const frozen = await requester.post(`/api/v1/purchase-requisitions/${req.id}/lines`, {
      variantId: ctx.yogurt.id,
      quantity: '1',
    })
    frozen.assertStatus(409)
    assert.equal(frozen.body().error.code, 'REQUISITION_NOT_DRAFT')
    let failed = false
    try {
      await owner(
        `update requisition_lines set quantity = 9 where requisition_id = '${req.id}'`,
        ctx.tenant
      )
    } catch {
      failed = true
    }
    assert.isTrue(failed)

    // Quem pediu não aprova (nem que tenha a permissão).
    const both = await memberWith(ctx, ['requisition.manage', 'requisition.approve'])
    const own = await requisition(ctx, both)
    await must(await both.post(`/api/v1/purchase-requisitions/${own.id}/submit`, {}), 200)
    const self = await both.post(`/api/v1/purchase-requisitions/${own.id}/approve`, {})
    self.assertStatus(409)
    assert.equal(self.body().error.code, 'SEGREGATION_OF_DUTIES')

    const noConvert = await requester.post(`/api/v1/purchase-requisitions/${req.id}/convert`, {
      supplierId: ctx.supplier.id,
      lines: [],
    })
    noConvert.assertStatus(409)
    assert.equal(noConvert.body().error.code, 'REQUISITION_NOT_APPROVED')
    const approved = await must<any>(
      await approver.post(`/api/v1/purchase-requisitions/${req.id}/approve`, {}),
      200
    )
    assert.equal(approved.requisition.status, 'APPROVED')
    const again = await must<any>(
      await approver.post(`/api/v1/purchase-requisitions/${req.id}/approve`, {}),
      200
    )
    assert.isTrue(again.idempotent)

    const missingCost = await requester.post(`/api/v1/purchase-requisitions/${req.id}/convert`, {
      supplierId: ctx.supplier.id,
      lines: [{ variantId: ctx.shirt.id, unitCost: '5' }],
    })
    missingCost.assertStatus(422)
    assert.equal(code(missingCost), 'COST_REQUIRED')
    const costs = [
      { variantId: ctx.shirt.id, unitCost: '5', taxRate: '14' },
      { variantId: ctx.service.id, unitCost: '100' },
    ]
    const converted = await requester.post(`/api/v1/purchase-requisitions/${req.id}/convert`, {
      supplierId: ctx.supplier.id,
      lines: costs,
    })
    converted.assertStatus(201)
    const order = converted.body().data.order
    assert.equal(order.status, 'DRAFT')
    assert.equal(order.requisitionId, req.id)
    assert.deepEqual(order.totals, { net: '225.0000', tax: '3.5000', total: '228.5000' })
    assert.deepEqual(
      order.lines.map((l: any) => l.quantity),
      ['5.000000', '2.000000']
    )
    const twice = await requester.post(`/api/v1/purchase-requisitions/${req.id}/convert`, {
      supplierId: ctx.supplier.id,
      lines: costs,
    })
    twice.assertStatus(200)
    assert.isTrue(twice.body().data.idempotent)
    assert.equal(twice.body().data.order.id, order.id)
    assert.lengthOf(
      await owner(`select 1 from purchase_orders where requisition_id = '${req.id}'`, ctx.tenant),
      1
    )
    const status = await must<any>(
      await requester.get(`/api/v1/purchase-requisitions/${req.id}`),
      200
    )
    assert.equal(status.status, 'CONVERTED')
    const del = await requester.delete(`/api/v1/purchase-orders/${order.id}`)
    del.assertStatus(409)
    assert.equal(del.body().error.code, 'PURCHASE_ORDER_FROM_REQUISITION')
  })

  test('rejeitar exige motivo e é definitivo; apagar só em rascunho', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const approver = await memberWith(ctx, ['requisition.read', 'requisition.approve'])
    const req = await requisition(ctx)
    await must(await ctx.http.post(`/api/v1/purchase-requisitions/${req.id}/submit`, {}), 200)
    const noReason = await approver.post(`/api/v1/purchase-requisitions/${req.id}/reject`, {})
    noReason.assertStatus(422)
    const rejected = await must<any>(
      await approver.post(`/api/v1/purchase-requisitions/${req.id}/reject`, {
        reason: 'Sem orçamento',
      }),
      200
    )
    assert.equal(rejected.requisition.status, 'REJECTED')
    assert.equal(rejected.requisition.decisionReason, 'Sem orçamento')
    const approve = await approver.post(`/api/v1/purchase-requisitions/${req.id}/approve`, {})
    approve.assertStatus(409)
    const del = await ctx.http.delete(`/api/v1/purchase-requisitions/${req.id}`)
    del.assertStatus(409)
    assert.equal(del.body().error.code, 'REQUISITION_NOT_DRAFT')
    const draft = await requisition(ctx)
    ;(await ctx.http.delete(`/api/v1/purchase-requisitions/${draft.id}`)).assertStatus(204)
    const empty = await must<any>(
      await ctx.http.post('/api/v1/purchase-requisitions', { organizationId: ctx.org.id }),
      201
    )
    const noLines = await ctx.http.post(`/api/v1/purchase-requisitions/${empty.id}/submit`, {})
    noLines.assertStatus(409)
    assert.equal(noLines.body().error.code, 'REQUISITION_EMPTY')
  })
})

test.group('compras | autorização, funcionalidades, auditoria e isolamento', (g) => {
  common(g)

  test('cada permissão abre só o seu conjunto de operações', async ({ client }) => {
    const ctx = await setup(client)
    const order = await confirmedOrder(ctx, [
      { variantId: ctx.shirt.id, quantity: '5', unitCost: '5' },
    ])
    const draft = await must<any>(
      await ctx.http.post('/api/v1/purchase-orders', { supplierId: ctx.supplier.id }),
      201
    )
    const receipt = await draftReceipt(ctx, order.id, [
      { purchaseLineId: order.lineIds[0]!, quantity: '1' },
    ])
    const reader = await memberWith(ctx, ['supplier.read', 'purchase.read', 'receipt.read'])
    ;(await reader.get('/api/v1/suppliers')).assertStatus(200)
    ;(await reader.get(`/api/v1/purchase-orders/${order.id}`)).assertStatus(200)
    ;(await reader.get(`/api/v1/goods-receipts/${receipt.id}`)).assertStatus(200)
    ;(await reader.get('/api/v1/purchase-requisitions')).assertStatus(403)
    ;(await reader.post('/api/v1/purchase-orders', { supplierId: ctx.supplier.id })).assertStatus(
      403
    )
    ;(await reader.post(`/api/v1/purchase-orders/${draft.id}/confirm`, {})).assertStatus(403)
    ;(await reader.post(`/api/v1/goods-receipts/${receipt.id}/post`, {})).assertStatus(403)
    const manager = await memberWith(ctx, ['purchase.read', 'purchase.manage', 'receipt.manage'])
    ;(
      await manager.post(`/api/v1/purchase-orders/${draft.id}/lines`, {
        variantId: ctx.shirt.id,
        quantity: '1',
        unitCost: '1',
      })
    ).assertStatus(201)
    ;(await manager.post(`/api/v1/purchase-orders/${draft.id}/confirm`, {})).assertStatus(403)
    ;(await manager.post(`/api/v1/goods-receipts/${receipt.id}/post`, {})).assertStatus(403)
    ;(
      await manager.post(`/api/v1/goods-receipts/${receipt.id}/reverse`, { reason: 'x' })
    ).assertStatus(403)
    ;(
      await (
        await memberWith(ctx, ['purchase.confirm'])
      ).post(`/api/v1/purchase-orders/${draft.id}/confirm`, {})
    ).assertStatus(200)
    ;(
      await (
        await memberWith(ctx, ['receipt.post'])
      ).post(`/api/v1/goods-receipts/${receipt.id}/post`, {})
    ).assertStatus(200)
    ;(
      await (
        await memberWith(ctx, ['supplier.read'])
      ).post('/api/v1/suppliers', {
        partyId: ctx.party.id,
        organizationId: ctx.org.id,
        code: 'X',
      })
    ).assertStatus(403)
    ;(await (await memberWith(ctx, ['party.read'])).get('/api/v1/goods-receipts')).assertStatus(403)
  })

  test('sem a funcionalidade, nem os administradores acedem', async ({ client, assert }) => {
    const ctx = await setup(client)
    for (const [feature, path] of [
      ['procurement.suppliers', '/api/v1/suppliers'],
      ['procurement.requisitions', '/api/v1/purchase-requisitions'],
      ['procurement.orders', '/api/v1/purchase-orders'],
      ['procurement.receipts', '/api/v1/goods-receipts'],
    ] as const) {
      ;(await ctx.http.get(path)).assertStatus(200)
      await must(
        await ctx.http.put(`/api/v1/tenant/features/${feature}`, {
          override: false,
          reason: 'Teste',
        }),
        200
      )
      const off = await ctx.http.get(path)
      off.assertStatus(403)
      assert.equal(off.body().error.code, 'FEATURE_NOT_AVAILABLE')
    }
  })

  test('as alterações ficam na auditoria e os dados de outro tenant não se vêem nem se tocam', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const order = await confirmedOrder(ctx, [
      { variantId: ctx.shirt.id, quantity: '2', unitCost: '5' },
    ])
    const receipt = await draftReceipt(ctx, order.id, [
      { purchaseLineId: order.lineIds[0]!, quantity: '2' },
    ])
    await must(await ctx.http.post(`/api/v1/goods-receipts/${receipt.id}/post`, {}), 200)
    const logs = await must<any[]>(
      await ctx.http.get(`/api/v1/audit-logs?resourceId=${receipt.id}`),
      200
    )
    assert.isAbove(logs.length, 1)
    const other = await setup(client)
    for (const request of [
      other.http.get(`/api/v1/purchase-orders/${order.id}`),
      other.http.post(`/api/v1/purchase-orders/${order.id}/cancel`, { reason: 'x' }),
      other.http.get(`/api/v1/goods-receipts/${receipt.id}`),
      other.http.post(`/api/v1/goods-receipts/${receipt.id}/reverse`, { reason: 'x' }),
      other.http.post('/api/v1/goods-receipts', { purchaseOrderId: order.id }),
      other.http.get(`/api/v1/suppliers/${ctx.supplier.id}`),
    ]) {
      ;(await request).assertStatus(404)
    }
    assert.lengthOf(await must<any[]>(await other.http.get('/api/v1/goods-receipts'), 200), 0)
    assert.lengthOf(await owner('select 1 from goods_receipts', other.tenant), 0)
    assert.lengthOf(await owner('select 1 from goods_receipts', ctx.tenant), 1)
  })
})

test.group('fornecedores | referências', (g) => {
  common(g)

  test('uma organização inexistente é um erro de validação, nunca uma falha interna', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const other = await must<any>(
      await ctx.http.post('/api/v1/organization-parties', {
        legalName: 'Outra Fornecedora, SA',
        taxCountry: 'AO',
        taxId: '5000011111',
      }),
      201
    )
    const response = await ctx.http.post('/api/v1/suppliers', {
      partyId: other.id,
      organizationId: '00000000-0000-4000-8000-000000000000',
      code: 'FOR-ORG',
    })
    assert.equal(response.status(), 422)
    assert.equal(response.body().error.details[0].code, 'UNKNOWN_ORGANIZATION')
  })
})

test.group('fornecedores | categorias, classificação e homologação (9.1)', (g) => {
  common(g)

  test('categorias com código imutável; classificação e filtros no fornecedor', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const category = await must<any>(
      await ctx.http.post('/api/v1/supplier-categories', {
        code: 'MAT',
        name: ' Materiais de construção ',
      }),
      201
    )
    assert.equal(category.name, 'Materiais de construção')
    const dup = await ctx.http.post('/api/v1/supplier-categories', { code: 'MAT', name: 'x' })
    dup.assertStatus(409)
    assert.equal(dup.body().error.code, 'SUPPLIER_CATEGORY_CODE_EXISTS')
    const immutable = await ctx.http.patch(`/api/v1/supplier-categories/${category.id}`, {
      expectedVersion: category.version,
      code: 'OUTRO',
    })
    immutable.assertStatus(422)

    const classified = await must<any>(
      await ctx.http.patch(`/api/v1/suppliers/${ctx.supplier.id}`, {
        expectedVersion: ctx.supplier.version,
        categoryId: category.id,
        supplyType: 'BOTH',
        critical: true,
        rating: 'A',
        leadTimeDays: 10,
        notes: 'Entrega em obra.',
      }),
      200
    )
    assert.deepInclude(classified, {
      categoryId: category.id,
      categoryName: 'Materiais de construção',
      supplyType: 'BOTH',
      critical: true,
      rating: 'A',
      leadTimeDays: 10,
      approvalStatus: 'PENDING',
    })
    const invalid = await ctx.http.patch(`/api/v1/suppliers/${ctx.supplier.id}`, {
      expectedVersion: classified.version,
      supplyType: 'X',
      rating: 'Z',
    })
    invalid.assertStatus(422)
    assert.sameMembers(
      invalid.body().error.details.map((d: any) => d.code),
      ['INVALID_SUPPLY_TYPE', 'INVALID_RATING']
    )

    // Uma categoria inactiva não se atribui de novo (o fornecedor que já a tem mantém-na).
    const inactive = await must<any>(
      await ctx.http.patch(`/api/v1/supplier-categories/${category.id}`, {
        expectedVersion: category.version,
        active: false,
      }),
      200
    )
    assert.isFalse(inactive.active)
    const party = await must<any>(
      await ctx.http.post('/api/v1/organization-parties', {
        legalName: 'Outra, Lda.',
        taxCountry: 'AO',
        taxId: '5000011111',
      }),
      201
    )
    const rejected = await ctx.http.post('/api/v1/suppliers', {
      partyId: party.id,
      organizationId: ctx.org.id,
      code: 'FOR-002',
      categoryId: category.id,
    })
    rejected.assertStatus(422)
    assert.equal(code(rejected), 'UNKNOWN_CATEGORY')
    await must(
      await ctx.http.patch(`/api/v1/suppliers/${ctx.supplier.id}`, {
        expectedVersion: classified.version,
        paymentTermDays: 45,
      }),
      200
    )

    const byCategory = await ctx.http.get(
      `/api/v1/suppliers?categoryId=${category.id}&critical=true&approvalStatus=PENDING`
    )
    assert.deepEqual(
      byCategory.body().data.map((s: any) => s.code),
      ['FOR-001']
    )
    assert.lengthOf(
      (await ctx.http.get('/api/v1/suppliers?approvalStatus=APPROVED')).body().data,
      0
    )
    assert.deepEqual(
      (await ctx.http.get('/api/v1/supplier-categories?active=false'))
        .body()
        .data.map((c: any) => c.code),
      ['MAT']
    )
  })

  test('homologação: análise, segregação de funções, condições, suspensão e histórico só-de-acrescentar', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const approver = await memberWith(ctx, ['supplier.read', 'supplier.approve'])
    const manager = await memberWith(ctx, ['supplier.read', 'supplier.manage'])

    // Sem análise pedida não há decisão.
    const early = await approver.post(`/api/v1/suppliers/${ctx.supplier.id}/approval/decide`, {
      expectedVersion: ctx.supplier.version,
      action: 'APPROVE',
    })
    early.assertStatus(409)
    assert.equal(early.body().error.code, 'SUPPLIER_APPROVAL_STATE')

    // Quem gere fornecedores pede a análise mas não decide.
    const submitted = await must<any>(
      await manager.post(`/api/v1/suppliers/${ctx.supplier.id}/approval/submit`, {
        expectedVersion: ctx.supplier.version,
        reason: 'Documentação entregue.',
      }),
      200
    )
    assert.equal(submitted.approvalStatus, 'UNDER_REVIEW')
    ;(
      await manager.post(`/api/v1/suppliers/${ctx.supplier.id}/approval/decide`, {
        expectedVersion: submitted.version,
        action: 'APPROVE',
      })
    ).assertStatus(403)
    const twice = await manager.post(`/api/v1/suppliers/${ctx.supplier.id}/approval/submit`, {
      expectedVersion: submitted.version,
    })
    twice.assertStatus(409)
    assert.equal(twice.body().error.code, 'SUPPLIER_ALREADY_UNDER_REVIEW')

    // O administrador tem todas as permissões, mas a segregação vale para quem pediu: aqui pediu o gestor.
    const noConditions = await approver.post(
      `/api/v1/suppliers/${ctx.supplier.id}/approval/decide`,
      { expectedVersion: submitted.version, action: 'APPROVE_CONDITIONALLY' }
    )
    noConditions.assertStatus(422)
    assert.equal(code(noConditions), 'CONDITIONS_REQUIRED')
    const stale = await approver.post(`/api/v1/suppliers/${ctx.supplier.id}/approval/decide`, {
      expectedVersion: ctx.supplier.version,
      action: 'APPROVE',
    })
    stale.assertStatus(409)
    const conditional = await must<any>(
      await approver.post(`/api/v1/suppliers/${ctx.supplier.id}/approval/decide`, {
        expectedVersion: submitted.version,
        action: 'APPROVE_CONDITIONALLY',
        conditions: 'Apresentar alvará actualizado em 90 dias.',
        validUntil: '2099-12-31',
      }),
      200
    )
    assert.deepInclude(conditional, {
      approvalStatus: 'CONDITIONALLY_APPROVED',
      approvalValidUntil: '2099-12-31',
      approvalConditions: 'Apresentar alvará actualizado em 90 dias.',
    })

    const noReason = await approver.post(`/api/v1/suppliers/${ctx.supplier.id}/approval/decide`, {
      expectedVersion: conditional.version,
      action: 'SUSPEND',
    })
    noReason.assertStatus(422)
    const suspended = await must<any>(
      await approver.post(`/api/v1/suppliers/${ctx.supplier.id}/approval/decide`, {
        expectedVersion: conditional.version,
        action: 'SUSPEND',
        reason: 'Alvará não apresentado.',
      }),
      200
    )
    assert.equal(suspended.approvalStatus, 'SUSPENDED')
    assert.isNull(suspended.approvalConditions)

    // Quem pede a renovação (o administrador) não a pode aprovar; outro pode.
    const renewal = await must<any>(
      await ctx.http.post(`/api/v1/suppliers/${ctx.supplier.id}/approval/submit`, {
        expectedVersion: suspended.version,
      }),
      200
    )
    const self = await ctx.http.post(`/api/v1/suppliers/${ctx.supplier.id}/approval/decide`, {
      expectedVersion: renewal.version,
      action: 'APPROVE',
    })
    self.assertStatus(409)
    assert.equal(self.body().error.code, 'SEGREGATION_OF_DUTIES')
    const approved = await must<any>(
      await approver.post(`/api/v1/suppliers/${ctx.supplier.id}/approval/decide`, {
        expectedVersion: renewal.version,
        action: 'APPROVE',
      }),
      200
    )
    assert.deepInclude(approved, { approvalStatus: 'APPROVED', approvalValidUntil: null })

    const history = await must<any[]>(
      await approver.get(`/api/v1/suppliers/${ctx.supplier.id}/approval-events`),
      200
    )
    assert.deepEqual(
      history.map((e) => `${e.action}:${e.fromStatus}>${e.toStatus}`),
      [
        'APPROVE:UNDER_REVIEW>APPROVED',
        'SUBMIT:SUSPENDED>UNDER_REVIEW',
        'SUSPEND:CONDITIONALLY_APPROVED>SUSPENDED',
        'APPROVE_CONDITIONALLY:UNDER_REVIEW>CONDITIONALLY_APPROVED',
        'SUBMIT:PENDING>UNDER_REVIEW',
      ]
    )
    assert.equal(history[4].reason, 'Documentação entregue.')
    assert.isString(history[0].actorMembershipId)

    // O histórico não se altera nem se apaga, nem por SQL directo.
    let blocked = ''
    try {
      await owner(`update supplier_approval_events set reason = 'x'`, ctx.tenant)
    } catch (error) {
      blocked = String((error as Error).message)
    }
    assert.include(blocked, 'SUPPLIER_APPROVAL_HISTORY_APPEND_ONLY')
    const events = await owner<{ event_type: string; to: string }>(
      `select event_type, payload->>'toStatus' as to from outbox_events
        where aggregate_type = 'supplier' order by created_at, aggregate_version`,
      ctx.tenant
    )
    assert.lengthOf(events, 5)
    assert.isTrue(events.every((e) => e.event_type === 'procurement.supplier.approval_changed'))
  })

  test('encomendas: crítico sem homologação, suspenso, rejeitado ou caducado não recebe novas', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const approver = await memberWith(ctx, ['supplier.read', 'supplier.approve'])
    const order = () =>
      ctx.http.post('/api/v1/purchase-orders', {
        supplierId: ctx.supplier.id,
        lines: [{ variantId: ctx.shirt.id, quantity: '1', unitCost: '10' }],
      })
    // Não crítico e por homologar: continua a poder encomendar (compatível com os fornecedores existentes).
    ;(await order()).assertStatus(201)
    const critical = await must<any>(
      await ctx.http.patch(`/api/v1/suppliers/${ctx.supplier.id}`, {
        expectedVersion: ctx.supplier.version,
        critical: true,
      }),
      200
    )
    const notApproved = await order()
    notApproved.assertStatus(409)
    assert.equal(notApproved.body().error.code, 'SUPPLIER_NOT_APPROVED')

    const submitted = await must<any>(
      await ctx.http.post(`/api/v1/suppliers/${ctx.supplier.id}/approval/submit`, {
        expectedVersion: critical.version,
      }),
      200
    )
    const approved = await must<any>(
      await approver.post(`/api/v1/suppliers/${ctx.supplier.id}/approval/decide`, {
        expectedVersion: submitted.version,
        action: 'APPROVE',
        validUntil: '2099-01-01',
      }),
      200
    )
    ;(await order()).assertStatus(201)

    // A validade passada lê-se como EXPIRED (nunca gravado) e bloqueia novas encomendas.
    await owner(
      `update suppliers set approval_valid_until = date '2020-01-01' where id = '${ctx.supplier.id}'`,
      ctx.tenant
    )
    const expired = await must<any>(await ctx.http.get(`/api/v1/suppliers/${ctx.supplier.id}`), 200)
    assert.equal(expired.approvalStatus, 'EXPIRED')
    const expiredOrder = await order()
    expiredOrder.assertStatus(409)
    assert.equal(expiredOrder.body().error.code, 'SUPPLIER_APPROVAL_EXPIRED')
    assert.deepEqual(
      (await ctx.http.get('/api/v1/suppliers?approvalStatus=EXPIRED'))
        .body()
        .data.map((s: any) => s.code),
      ['FOR-001']
    )

    // Suspenso: nem se suspende uma homologação caducada; renova-se e rejeita-se.
    const cannotSuspend = await approver.post(
      `/api/v1/suppliers/${ctx.supplier.id}/approval/decide`,
      { expectedVersion: approved.version, action: 'SUSPEND', reason: 'x' }
    )
    cannotSuspend.assertStatus(409)
    const renewal = await must<any>(
      await ctx.http.post(`/api/v1/suppliers/${ctx.supplier.id}/approval/submit`, {
        expectedVersion: approved.version,
      }),
      200
    )
    await must(
      await approver.post(`/api/v1/suppliers/${ctx.supplier.id}/approval/decide`, {
        expectedVersion: renewal.version,
        action: 'REJECT',
        reason: 'Sem certificação de qualidade.',
      }),
      200
    )
    const rejectedOrder = await order()
    rejectedOrder.assertStatus(409)
    assert.equal(rejectedOrder.body().error.code, 'SUPPLIER_REJECTED')
  })

  test('categorias exigem supplier_category.manage; outro tenant dá 404', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const manager = await memberWith(ctx, ['supplier.read', 'supplier.manage'])
    ;(await manager.post('/api/v1/supplier-categories', { code: 'X', name: 'X' })).assertStatus(403)
    const category = await must<any>(
      await ctx.http.post('/api/v1/supplier-categories', { code: 'SERV', name: 'Serviços' }),
      201
    )
    assert.lengthOf(await must<any[]>(await manager.get('/api/v1/supplier-categories'), 200), 1)

    const other = await setup(client)
    ;(await other.http.get(`/api/v1/supplier-categories/${category.id}`)).assertStatus(404)
    ;(await other.http.get(`/api/v1/suppliers/${ctx.supplier.id}/approval-events`)).assertStatus(
      404
    )
    const foreign = await other.http.patch(`/api/v1/suppliers/${other.supplier.id}`, {
      expectedVersion: other.supplier.version,
      categoryId: category.id,
    })
    foreign.assertStatus(422)
    assert.equal(code(foreign), 'UNKNOWN_CATEGORY')
  })
})
