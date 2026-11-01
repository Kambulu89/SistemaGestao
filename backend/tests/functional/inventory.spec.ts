import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { iamServices } from '#core/permissions/index'
import { LucidTenantDatabase, serviceTenantContext } from '#core/tenancy/index'
import { deleteTestUsers, resetAuthState } from '#tests/support/auth_fixture'
import { createActiveTenant, deleteTestTenants } from '#tests/support/membership_fixture'
import { api, newActor } from '#tests/support/api_fixture'
import { license, syncTestRegistry } from '#tests/support/modules_fixture'
import { inventoryServices } from '#modules/inventory/index'
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

const uuid = () => crypto.randomUUID()

/**
 * Tenant com `catalog`, `customers`, `orders` e `inventory`: uma organização, as unidades UN (0 casas) e KG (3 casas), um
 * produto «Camisola» (por unidade, sem rastreio), um «Arroz» (KG), um «Iogurte» com rastreio por lote e um serviço, um
 * armazém com o local PRINCIPAL e as sequências de encomendas.
 */
async function setup(client: any) {
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
  const kg = await must<any>(
    await http.post('/api/v1/units', {
      code: 'KG',
      name: 'Quilo',
      dimension: 'MASS',
      precision: 3,
    }),
    201
  )
  await must(
    await http.post('/api/v1/tax-rates', {
      organizationId: org.id,
      code: 'IVA',
      name: 'IVA',
      rate: '14',
      validFrom: '2020-01-01',
      category: 'VAT',
    }),
    201
  )
  for (const [documentType, prefix] of [
    ['QUOTE', 'PRO {SERIES}/{YYYY}/'],
    ['SALES_ORDER', 'ENC {SERIES}/{YYYY}/'],
  ] as const) {
    await must(
      await http.post('/api/v1/sequences', {
        organizationId: org.id,
        documentType,
        series: 'A',
        prefixTemplate: prefix,
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
      await http.post('/api/v1/products', { type: 'GOODS', taxCategory: 'VAT', ...body }),
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
  const shirt = await makeProduct({ code: 'CAM-001', name: 'Camisola', baseUnitId: unit.id })
  const rice = await makeProduct({ code: 'ARR-001', name: 'Arroz', baseUnitId: kg.id })
  const yogurt = await makeProduct({
    code: 'IOG-001',
    name: 'Iogurte',
    baseUnitId: unit.id,
    trackingMode: 'LOT',
  })
  const service = await makeProduct({
    code: 'SRV-001',
    name: 'Instalação',
    type: 'SERVICE',
    baseUnitId: unit.id,
  })
  const warehouse = await must<any>(
    await http.post('/api/v1/warehouses', {
      organizationId: org.id,
      code: 'ARM-1',
      name: 'Central',
    }),
    201
  )
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
    kg,
    shirt,
    rice,
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

/** Ajuste com motivo; devolve o movimento. */
const adjust = async (
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
      reason: 'Contagem inicial',
      ...extra,
    }),
    201
  )

const balanceOf = async (ctx: Ctx, variantId: string) => {
  const rows = await must<any[]>(
    await ctx.http.get(`/api/v1/stock-balances?variantId=${variantId}`),
    200
  )
  return rows
}

const asService = <T>(
  ctx: Ctx,
  fn: Parameters<LucidTenantDatabase['run']>[0] & ((scope: any) => Promise<T>)
) =>
  new LucidTenantDatabase().run(
    fn as never,
    serviceTenantContext(ctx.tenant.id, 'teste')
  ) as Promise<T>

const newOrder = async (ctx: Ctx, lines: { variantId: string; quantity: string }[]) => {
  const order = await must<any>(
    await ctx.http.post('/api/v1/sales-orders', {
      organizationId: ctx.org.id,
      customerId: ctx.customer.id,
    }),
    201
  )
  for (const l of lines) {
    await must(await ctx.http.post(`/api/v1/sales-orders/${order.id}/lines`, l), 201)
  }
  return order.id as string
}

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

test.group('inventário | armazéns, locais e lotes', (g) => {
  common(g)

  test('o armazém nasce com o local PRINCIPAL; códigos únicos; versão e armazém de vendas', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    assert.equal(ctx.warehouse.locations[0].code, 'PRINCIPAL')
    const dup = await ctx.http.post('/api/v1/warehouses', {
      organizationId: ctx.org.id,
      code: 'ARM-1',
      name: 'Outro',
    })
    dup.assertStatus(409)
    assert.equal(dup.body().error.code, 'WAREHOUSE_CODE_TAKEN')
    const second = await must<any>(
      await ctx.http.post('/api/v1/warehouses', {
        organizationId: ctx.org.id,
        code: 'ARM-2',
        name: 'Loja',
      }),
      201
    )
    // Um só armazém de vendas por organização.
    const first = await must<any>(
      await ctx.http.patch(`/api/v1/warehouses/${ctx.warehouse.id}`, {
        expectedVersion: ctx.warehouse.version,
        salesDefault: true,
      }),
      200
    )
    assert.isTrue(first.salesDefault)
    const taken = await ctx.http.patch(`/api/v1/warehouses/${second.id}`, {
      expectedVersion: second.version,
      salesDefault: true,
    })
    taken.assertStatus(409)
    assert.equal(taken.body().error.code, 'SALES_WAREHOUSE_TAKEN')
    // Versão desactualizada → 409.
    const stale = await ctx.http.patch(`/api/v1/warehouses/${ctx.warehouse.id}`, {
      expectedVersion: ctx.warehouse.version,
      name: 'Central 2',
    })
    stale.assertStatus(409)
    assert.equal(stale.body().error.code, 'VERSION_CONFLICT')
    // Não se desactiva o armazém de vendas sem o retirar primeiro.
    const blocked = await ctx.http.patch(`/api/v1/warehouses/${ctx.warehouse.id}`, {
      expectedVersion: first.version,
      active: false,
    })
    blocked.assertStatus(409)
    assert.equal(blocked.body().error.code, 'WAREHOUSE_SALES_DEFAULT')
    const loc = await must<any>(
      await ctx.http.post(`/api/v1/warehouses/${second.id}/locations`, {
        code: 'A1',
        name: 'Corredor A1',
      }),
      201
    )
    ;(
      await ctx.http.post(`/api/v1/warehouses/${second.id}/locations`, {
        code: 'A1',
        name: 'Outra vez',
      })
    ).assertStatus(409)
    const off = await must<any>(
      await ctx.http.patch(`/api/v1/stock-locations/${loc.id}`, {
        expectedVersion: loc.version,
        active: false,
      }),
      200
    )
    assert.isFalse(off.active)
    ;(await ctx.http.get('/api/v1/warehouses/not-a-uuid')).assertStatus(404)
  })

  test('lotes: só para produtos com rastreio por lote; código único; datas coerentes', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const notLot = await ctx.http.post('/api/v1/lots', {
      variantId: ctx.shirt.variant.id,
      code: 'L1',
    })
    notLot.assertStatus(409)
    assert.equal(notLot.body().error.code, 'NOT_LOT_TRACKED')
    const lot = await must<any>(
      await ctx.http.post('/api/v1/lots', {
        variantId: ctx.yogurt.variant.id,
        code: 'L1',
        manufacturedOn: '2026-01-01',
        expiresOn: '2026-06-30',
      }),
      201
    )
    assert.equal(lot.expiresOn, '2026-06-30')
    ;(
      await ctx.http.post('/api/v1/lots', { variantId: ctx.yogurt.variant.id, code: 'L1' })
    ).assertStatus(409)
    const bad = await ctx.http.post('/api/v1/lots', {
      variantId: ctx.yogurt.variant.id,
      code: 'L2',
      manufacturedOn: '2026-05-01',
      expiresOn: '2026-01-01',
    })
    bad.assertStatus(422)
    assert.equal(bad.body().error.details[0].code, 'EXPIRY_BEFORE_MANUFACTURE')
    const lots = await must<any[]>(
      await ctx.http.get(`/api/v1/lots?variantId=${ctx.yogurt.variant.id}`),
      200
    )
    assert.lengthOf(lots, 1)
  })
})

test.group('inventário | livro de movimentos e saldos', (g) => {
  common(g)

  test('o ajuste lança livro e saldo juntos e a soma do livro reconcilia com o saldo', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const v = ctx.shirt.variant.id
    await adjust(ctx, v, '10')
    await adjust(ctx, v, '-3')
    await adjust(ctx, v, '5')
    const [balance] = await balanceOf(ctx, v)
    assert.deepInclude(balance, {
      onHand: '12.000000',
      reserved: '0.000000',
      available: '12.000000',
    })
    const movements = await must<any[]>(
      await ctx.http.get(`/api/v1/stock-movements?variantId=${v}`),
      200
    )
    assert.lengthOf(movements, 3)
    const sum = movements.reduce((acc, m) => acc + Number(m.quantityDelta), 0)
    assert.equal(sum, 12)
    const reconciled = await asService(ctx, async (scope) => {
      void scope
      return inventoryServices().stock.reconcile(serviceTenantContext(ctx.tenant.id, 'teste'), {
        variantId: v,
        locationId: ctx.location.id,
        lotId: null,
      })
    })
    assert.deepEqual(reconciled, { onHand: '12.000000', ledger: '12.000000', reserved: '0.000000' })
    // O livro é só de acrescentar: nem a conta dona o altera (sem o interruptor de retenção).
    let blocked = false
    try {
      await owner(`update stock_movements set reason = 'x'`, ctx.tenant)
    } catch {
      blocked = true
    }
    assert.isTrue(blocked)
    let deleted = false
    try {
      await owner(`delete from stock_movements`, ctx.tenant)
    } catch {
      deleted = true
    }
    assert.isTrue(deleted)
  })

  test('o saldo não fica negativo quando proibido; com allowNegative fica', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const v = ctx.shirt.variant.id
    await adjust(ctx, v, '2')
    const refused = await ctx.http.post('/api/v1/stock-adjustments', {
      variantId: v,
      locationId: ctx.location.id,
      quantityDelta: '-3',
      reason: 'Quebra',
    })
    refused.assertStatus(409)
    assert.equal(refused.body().error.code, 'INSUFFICIENT_STOCK')
    assert.include(refused.body().error.details[0].message, '2.000000')
    await must(
      await ctx.http.patch(`/api/v1/warehouses/${ctx.warehouse.id}`, {
        expectedVersion: ctx.warehouse.version,
        allowNegative: true,
      }),
      200
    )
    await adjust(ctx, v, '-3')
    const [balance] = await balanceOf(ctx, v)
    assert.equal(balance.onHand, '-1.000000')
  })

  test('duas saídas concorrentes não tornam o saldo negativo', async ({ client, assert }) => {
    const ctx = await setup(client)
    const v = ctx.shirt.variant.id
    await adjust(ctx, v, '10')
    const attempts = await Promise.all(
      [1, 2, 3, 4].map(() =>
        ctx.http.post('/api/v1/stock-adjustments', {
          variantId: v,
          locationId: ctx.location.id,
          quantityDelta: '-4',
          reason: 'Saída concorrente',
        })
      )
    )
    const statuses = attempts.map((r) => r.status()).sort()
    assert.deepEqual(statuses, [201, 201, 409, 409])
    const [balance] = await balanceOf(ctx, v)
    assert.equal(balance.onHand, '2.000000')
    const moves = await owner<{ n: number }>(
      `select count(*)::int as n from stock_movements`,
      ctx.tenant
    )
    assert.equal(moves[0]!.n, 3)
  })

  test('repetir a mesma origem não duplica o efeito; origem com outro conteúdo é conflito', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const v = ctx.shirt.variant.id
    const reference = uuid()
    const first = await adjust(ctx, v, '7', { reference })
    const again = await ctx.http.post('/api/v1/stock-adjustments', {
      variantId: v,
      locationId: ctx.location.id,
      quantityDelta: '7',
      reason: 'Contagem inicial',
      reference,
    })
    again.assertStatus(200)
    assert.equal(again.body().data.id, first.id)
    assert.isTrue(again.body().data.idempotent)
    const [balance] = await balanceOf(ctx, v)
    assert.equal(balance.onHand, '7.000000')
    const conflict = await ctx.http.post('/api/v1/stock-adjustments', {
      variantId: v,
      locationId: ctx.location.id,
      quantityDelta: '8',
      reason: 'Contagem inicial',
      reference,
    })
    conflict.assertStatus(409)
    assert.equal(conflict.body().error.code, 'SOURCE_CONFLICT')
  })

  test('validações: motivo, precisão da unidade, zero, controlo de stock e lote', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const post = (body: Record<string, unknown>) =>
      ctx.http.post('/api/v1/stock-adjustments', {
        locationId: ctx.location.id,
        reason: 'Teste',
        ...body,
      })
    const code = (r: any) => r.body().error.details?.[0]?.code ?? r.body().error.code
    assert.equal(
      code(await post({ variantId: ctx.shirt.variant.id, quantityDelta: '1', reason: ' ' })),
      'REASON_REQUIRED'
    )
    assert.equal(
      code(await post({ variantId: ctx.shirt.variant.id, quantityDelta: '0' })),
      'INVALID_QUANTITY'
    )
    assert.equal(
      code(await post({ variantId: ctx.shirt.variant.id, quantityDelta: '1e3' })),
      'INVALID_QUANTITY'
    )
    assert.equal(
      code(await post({ variantId: ctx.shirt.variant.id, quantityDelta: '1.5' })),
      'QUANTITY_PRECISION'
    )
    // Arroz em KG admite 3 casas.
    await must(await post({ variantId: ctx.rice.variant.id, quantityDelta: '2.125' }), 201)
    assert.equal(
      code(await post({ variantId: ctx.rice.variant.id, quantityDelta: '1.0005' })),
      'QUANTITY_PRECISION'
    )
    const service = await post({ variantId: ctx.service.variant.id, quantityDelta: '1' })
    service.assertStatus(409)
    assert.equal(service.body().error.code, 'NOT_STOCK_TRACKED')
    assert.equal(
      code(await post({ variantId: ctx.yogurt.variant.id, quantityDelta: '1' })),
      'LOT_REQUIRED'
    )
    assert.equal(
      code(await post({ variantId: ctx.shirt.variant.id, quantityDelta: '1', lotId: uuid() })),
      'LOT_NOT_ALLOWED'
    )
    assert.equal(
      code(await post({ variantId: ctx.yogurt.variant.id, quantityDelta: '1', lotId: uuid() })),
      'UNKNOWN_LOT'
    )
    assert.equal(code(await post({ variantId: uuid(), quantityDelta: '1' })), 'UNKNOWN_VARIANT')
    const unknownLocation = await ctx.http.post('/api/v1/stock-adjustments', {
      variantId: ctx.shirt.variant.id,
      locationId: uuid(),
      quantityDelta: '1',
      reason: 'x',
    })
    assert.equal(code(unknownLocation), 'UNKNOWN_LOCATION')
    // Local desactivado não recebe movimentos.
    const loc = ctx.location
    await must(
      await ctx.http.patch(`/api/v1/stock-locations/${loc.id}`, {
        expectedVersion: loc.version,
        active: false,
      }),
      200
    )
    const inactive = await post({ variantId: ctx.shirt.variant.id, quantityDelta: '1' })
    inactive.assertStatus(409)
    assert.equal(inactive.body().error.code, 'LOCATION_INACTIVE')
  })

  test('a reversão repõe o saldo ao custo original, só uma vez, e uma reversão não se reverte', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const v = ctx.shirt.variant.id
    const five = await adjust(ctx, v, '10', { unitCost: '5' })
    const seven = await adjust(ctx, v, '10', { unitCost: '7' })
    const cost = async () =>
      (
        await owner<{ avg_cost: string; quantity: string }>(
          `select avg_cost, quantity from stock_costs`,
          ctx.tenant
        )
      )[0]!
    assert.deepInclude(await cost(), { avg_cost: '6.0000', quantity: '20.000000' })
    const reverted = await ctx.http.post(`/api/v1/stock-movements/${seven.id}/reverse`, {
      reason: 'Entrada em duplicado',
    })
    reverted.assertStatus(201)
    assert.equal(reverted.body().data.kind, 'REVERSAL')
    assert.equal(reverted.body().data.quantityDelta, '-10.000000')
    assert.equal(reverted.body().data.unitCost, '7.0000')
    assert.equal(reverted.body().data.reversedMovementId, seven.id)
    assert.deepInclude(await cost(), { avg_cost: '5.0000', quantity: '10.000000' })
    const [balance] = await balanceOf(ctx, v)
    assert.equal(balance.onHand, '10.000000')
    const again = await ctx.http.post(`/api/v1/stock-movements/${seven.id}/reverse`, {
      reason: 'Outra vez',
    })
    again.assertStatus(200)
    assert.isTrue(again.body().data.idempotent)
    assert.equal((await balanceOf(ctx, v))[0].onHand, '10.000000')
    const ofReversal = await ctx.http.post(
      `/api/v1/stock-movements/${reverted.body().data.id}/reverse`,
      { reason: 'x' }
    )
    ofReversal.assertStatus(409)
    assert.equal(ofReversal.body().error.code, 'REVERSAL_OF_REVERSAL')
    ;(
      await ctx.http.post(`/api/v1/stock-movements/${five.id}/reverse`, { reason: ' ' })
    ).assertStatus(422)
    ;(
      await ctx.http.post(`/api/v1/stock-movements/${uuid()}/reverse`, { reason: 'x' })
    ).assertStatus(404)
  })

  test('a saída corre ao custo médio e as entradas misturam-se', async ({ client, assert }) => {
    const ctx = await setup(client)
    const v = ctx.shirt.variant.id
    await adjust(ctx, v, '10', { unitCost: '5' })
    await adjust(ctx, v, '10', { unitCost: '7' })
    const out = await adjust(ctx, v, '-5')
    assert.equal(out.unitCost, '6.0000')
    const cost = (
      await owner<{ avg_cost: string }>(`select avg_cost from stock_costs`, ctx.tenant)
    )[0]!
    assert.equal(cost.avg_cost, '6.0000')
  })

  test('lote expirado bloqueia a reserva e o rastreio por lote guarda saldos por lote', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const v = ctx.yogurt.variant.id
    const expired = await must<any>(
      await ctx.http.post('/api/v1/lots', { variantId: v, code: 'VELHO', expiresOn: '2020-01-01' }),
      201
    )
    const fresh = await must<any>(
      await ctx.http.post('/api/v1/lots', { variantId: v, code: 'NOVO', expiresOn: '2099-01-01' }),
      201
    )
    await adjust(ctx, v, '5', { lotId: expired.id })
    await adjust(ctx, v, '8', { lotId: fresh.id })
    const balances = await balanceOf(ctx, v)
    assert.lengthOf(balances, 2)
    assert.deepEqual(balances.map((b) => b.lotCode).sort(), ['NOVO', 'VELHO'])
    const reserve = await ctx.http.post('/api/v1/stock-reservations', {
      variantId: v,
      locationId: ctx.location.id,
      lotId: expired.id,
      quantity: '1',
      sourceType: 'MANUAL',
      sourceId: uuid(),
    })
    reserve.assertStatus(409)
    assert.equal(reserve.body().error.code, 'LOT_EXPIRED')
  })
})

test.group('inventário | reservas', (g) => {
  common(g)

  test('reservar reduz o disponível; repetir a origem não duplica; libertar repõe', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const v = ctx.shirt.variant.id
    await adjust(ctx, v, '10')
    const body = {
      variantId: v,
      locationId: ctx.location.id,
      quantity: '6',
      sourceType: 'MANUAL',
      sourceId: uuid(),
      sourceLineId: uuid(),
    }
    const reservation = await must<any>(
      await ctx.http.post('/api/v1/stock-reservations', body),
      201
    )
    assert.equal(reservation.status, 'ACTIVE')
    const again = await ctx.http.post('/api/v1/stock-reservations', body)
    again.assertStatus(200)
    assert.equal(again.body().data.id, reservation.id)
    assert.deepInclude((await balanceOf(ctx, v))[0], {
      onHand: '10.000000',
      reserved: '6.000000',
      available: '4.000000',
    })
    const tooMuch = await ctx.http.post('/api/v1/stock-reservations', {
      ...body,
      sourceId: uuid(),
      quantity: '5',
    })
    tooMuch.assertStatus(409)
    assert.equal(tooMuch.body().error.code, 'INSUFFICIENT_STOCK')
    // O que está reservado não se pode tirar com uma saída normal.
    const blocked = await ctx.http.post('/api/v1/stock-adjustments', {
      variantId: v,
      locationId: ctx.location.id,
      quantityDelta: '-5',
      reason: 'Quebra',
    })
    blocked.assertStatus(409)
    const partial = await must<any>(
      await ctx.http.post(`/api/v1/stock-reservations/${reservation.id}/release`, {
        quantity: '2',
      }),
      200
    )
    assert.equal(partial.status, 'ACTIVE')
    assert.equal(partial.releasedQty, '2.000000')
    assert.equal((await balanceOf(ctx, v))[0].reserved, '4.000000')
    const done = await must<any>(
      await ctx.http.post(`/api/v1/stock-reservations/${reservation.id}/release`, {}),
      200
    )
    assert.equal(done.status, 'RELEASED')
    assert.equal((await balanceOf(ctx, v))[0].reserved, '0.000000')
    const twice = await must<any>(
      await ctx.http.post(`/api/v1/stock-reservations/${reservation.id}/release`, {}),
      200
    )
    assert.isTrue(twice.idempotent)
    assert.equal((await balanceOf(ctx, v))[0].reserved, '0.000000')
    const listed = await must<any[]>(
      await ctx.http.get(`/api/v1/stock-reservations?status=RELEASED`),
      200
    )
    assert.lengthOf(listed, 1)
    ;(
      await ctx.http.post(`/api/v1/stock-reservations/${reservation.id}/release`, {
        quantity: '99',
      })
    ).assertStatus(200)
  })

  test('reservas vencidas libertam-se (EXPIRED) e repõem o disponível', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const v = ctx.shirt.variant.id
    await adjust(ctx, v, '10')
    const soon = new Date(Date.now() + 60_000).toISOString()
    const reservation = await must<any>(
      await ctx.http.post('/api/v1/stock-reservations', {
        variantId: v,
        locationId: ctx.location.id,
        quantity: '4',
        sourceType: 'MANUAL',
        sourceId: uuid(),
        expiresAt: soon,
      }),
      201
    )
    ;(await ctx.http.post('/api/v1/stock-reservations/expire', {})).assertStatus(200)
    assert.equal((await balanceOf(ctx, v))[0].reserved, '4.000000')
    await owner(
      `update stock_reservations set expires_at = now() - interval '1 minute' where id = '${reservation.id}'`,
      ctx.tenant
    )
    const result = await must<any>(
      await ctx.http.post('/api/v1/stock-reservations/expire', {}),
      200
    )
    assert.equal(result.expired, 1)
    const [row] = await must<any[]>(
      await ctx.http.get('/api/v1/stock-reservations?status=EXPIRED'),
      200
    )
    assert.equal(row.id, reservation.id)
    assert.equal((await balanceOf(ctx, v))[0].reserved, '0.000000')
    const past = await ctx.http.post('/api/v1/stock-reservations', {
      variantId: v,
      locationId: ctx.location.id,
      quantity: '1',
      sourceType: 'MANUAL',
      sourceId: uuid(),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })
    past.assertStatus(422)
  })

  test('a saída que consome a reserva baixa o físico e o reservado uma só vez', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const v = ctx.shirt.variant.id
    await adjust(ctx, v, '10')
    const reservation = await must<any>(
      await ctx.http.post('/api/v1/stock-reservations', {
        variantId: v,
        locationId: ctx.location.id,
        quantity: '6',
        sourceType: 'SALES_ORDER',
        sourceId: uuid(),
      }),
      201
    )
    const shipment = uuid()
    const issue = (quantity: string, effect = 'MAIN', source = shipment) =>
      asService(ctx, (scope) =>
        inventoryServices().stock.postInScope(scope, {
          kind: 'ISSUE',
          variantId: v,
          locationId: ctx.location.id,
          lotId: null,
          quantityDelta: `-${quantity}`,
          source: { type: 'SHIPMENT', id: source, lineId: null, effect },
          reservationId: reservation.id,
        })
      )
    const first = await issue('4')
    assert.isFalse(first.idempotent)
    assert.equal(first.movement.kind, 'ISSUE')
    // O mesmo documento outra vez não baixa de novo.
    const replay = await issue('4')
    assert.isTrue(replay.idempotent)
    assert.equal(replay.movement.id, first.movement.id)
    assert.deepInclude((await balanceOf(ctx, v))[0], { onHand: '6.000000', reserved: '2.000000' })
    // Só restam 2 por consumir.
    let code = ''
    try {
      await issue('3', 'MAIN', uuid())
    } catch (error: any) {
      code = error.code
    }
    assert.equal(code, 'RESERVATION_INSUFFICIENT')
    await issue('2', 'MAIN', uuid())
    const [done] = await must<any[]>(
      await ctx.http.get('/api/v1/stock-reservations?status=CONSUMED'),
      200
    )
    assert.deepInclude(done, { consumedQty: '6.000000', status: 'CONSUMED' })
    assert.deepInclude((await balanceOf(ctx, v))[0], { onHand: '4.000000', reserved: '0.000000' })
  })
})

test.group('inventário | encomendas', (g) => {
  common(g)

  test('confirmar reserva o stock do armazém de vendas; confirmar outra vez não duplica; cancelar liberta', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const v = ctx.shirt.variant.id
    await must(
      await ctx.http.patch(`/api/v1/warehouses/${ctx.warehouse.id}`, {
        expectedVersion: ctx.warehouse.version,
        salesDefault: true,
      }),
      200
    )
    await adjust(ctx, v, '5')
    const id = await newOrder(ctx, [{ variantId: v, quantity: '3' }])
    const confirmed = await must<any>(
      await ctx.http.post(`/api/v1/sales-orders/${id}/confirm`, {}),
      200
    )
    assert.equal(confirmed.order.status, 'CONFIRMED')
    const reservations = await must<any[]>(
      await ctx.http.get(`/api/v1/stock-reservations?sourceType=SALES_ORDER&sourceId=${id}`),
      200
    )
    assert.lengthOf(reservations, 1)
    assert.deepInclude(reservations[0], { status: 'ACTIVE', quantity: '3.000000' })
    assert.deepInclude((await balanceOf(ctx, v))[0], {
      onHand: '5.000000',
      reserved: '3.000000',
      available: '2.000000',
    })
    // Confirmar duas vezes não duplica a reserva.
    await must(await ctx.http.post(`/api/v1/sales-orders/${id}/confirm`, {}), 200)
    assert.equal((await balanceOf(ctx, v))[0].reserved, '3.000000')
    assert.lengthOf(await owner('select 1 from stock_reservations', ctx.tenant), 1)
    // Confirmar não baixa o físico: só reserva.
    assert.equal((await balanceOf(ctx, v))[0].onHand, '5.000000')
    const cancelled = await must<any>(
      await ctx.http.post(`/api/v1/sales-orders/${id}/cancel`, { reason: 'Cliente desistiu' }),
      200
    )
    assert.equal(cancelled.order.status, 'CANCELLED')
    assert.deepInclude((await balanceOf(ctx, v))[0], { onHand: '5.000000', reserved: '0.000000' })
    const [released] = await must<any[]>(
      await ctx.http.get(`/api/v1/stock-reservations?sourceId=${id}`),
      200
    )
    assert.equal(released.status, 'RELEASED')
    // Cancelar outra vez é inofensivo.
    await must(
      await ctx.http.post(`/api/v1/sales-orders/${id}/cancel`, { reason: 'Cliente desistiu' }),
      200
    )
    assert.equal((await balanceOf(ctx, v))[0].reserved, '0.000000')
  })

  test('stock insuficiente não deixa a encomenda confirmada nem gasta o número', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const v = ctx.shirt.variant.id
    await must(
      await ctx.http.patch(`/api/v1/warehouses/${ctx.warehouse.id}`, {
        expectedVersion: ctx.warehouse.version,
        salesDefault: true,
      }),
      200
    )
    await adjust(ctx, v, '5')
    const first = await newOrder(ctx, [{ variantId: v, quantity: '3' }])
    const second = await newOrder(ctx, [{ variantId: v, quantity: '3' }])
    const a = await must<any>(await ctx.http.post(`/api/v1/sales-orders/${first}/confirm`, {}), 200)
    const refused = await ctx.http.post(`/api/v1/sales-orders/${second}/confirm`, {})
    refused.assertStatus(409)
    assert.equal(refused.body().error.code, 'ORDER_NOT_CONFIRMABLE')
    assert.equal(refused.body().error.details[0].code, 'INSUFFICIENT_STOCK')
    assert.equal(refused.body().error.details[0].path, 'lines[0].quantity')
    const draft = await must<any>(await ctx.http.get(`/api/v1/sales-orders/${second}`), 200)
    assert.deepInclude(draft, { status: 'DRAFT', number: null })
    assert.equal((await balanceOf(ctx, v))[0].reserved, '3.000000')
    // Repõe-se stock e o número seguinte não tem lacuna.
    await adjust(ctx, v, '10')
    const b = await must<any>(
      await ctx.http.post(`/api/v1/sales-orders/${second}/confirm`, {}),
      200
    )
    const num = (n: string) => Number(n.split('/').pop())
    assert.equal(num(b.order.number), num(a.order.number) + 1)
  })

  test('duas confirmações concorrentes só reservam o que existe', async ({ client, assert }) => {
    const ctx = await setup(client)
    const v = ctx.shirt.variant.id
    await must(
      await ctx.http.patch(`/api/v1/warehouses/${ctx.warehouse.id}`, {
        expectedVersion: ctx.warehouse.version,
        salesDefault: true,
      }),
      200
    )
    await adjust(ctx, v, '5')
    const ids = await Promise.all(
      [1, 2, 3].map(() => newOrder(ctx, [{ variantId: v, quantity: '3' }]))
    )
    const results = await Promise.all(
      ids.map((id) => ctx.http.post(`/api/v1/sales-orders/${id}/confirm`, {}))
    )
    assert.deepEqual(results.map((r) => r.status()).sort(), [200, 409, 409])
    assert.equal((await balanceOf(ctx, v))[0].reserved, '3.000000')
  })

  test('com armazém que aceita encomendas em falta reserva o que há e regista o que falta', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const v = ctx.shirt.variant.id
    await must(
      await ctx.http.patch(`/api/v1/warehouses/${ctx.warehouse.id}`, {
        expectedVersion: ctx.warehouse.version,
        salesDefault: true,
        allowBackorder: true,
      }),
      200
    )
    await adjust(ctx, v, '2')
    const id = await newOrder(ctx, [{ variantId: v, quantity: '5' }])
    const confirmed = await must<any>(
      await ctx.http.post(`/api/v1/sales-orders/${id}/confirm`, {}),
      200
    )
    assert.equal(confirmed.order.status, 'CONFIRMED')
    assert.deepInclude((await balanceOf(ctx, v))[0], {
      reserved: '2.000000',
      available: '0.000000',
    })
    const events = await owner<{ payload: any }>(
      `select payload from outbox_events where event_type = 'inventory.order_stock.reserved'`,
      ctx.tenant
    )
    assert.lengthOf(events, 1)
    assert.equal(events[0]!.payload.backorder[0].missing, '3.000000')
  })

  test('sem armazém de vendas, serviços e produtos sem controlo, a confirmação não mexe no stock', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const id = await newOrder(ctx, [{ variantId: ctx.shirt.variant.id, quantity: '3' }])
    await must(await ctx.http.post(`/api/v1/sales-orders/${id}/confirm`, {}), 200)
    assert.lengthOf(await owner('select 1 from stock_reservations', ctx.tenant), 0)
    // Com armazém de vendas, um serviço também não reserva.
    await must(
      await ctx.http.patch(`/api/v1/warehouses/${ctx.warehouse.id}`, {
        expectedVersion: ctx.warehouse.version,
        salesDefault: true,
      }),
      200
    )
    const service = await newOrder(ctx, [{ variantId: ctx.service.variant.id, quantity: '1' }])
    await must(await ctx.http.post(`/api/v1/sales-orders/${service}/confirm`, {}), 200)
    assert.lengthOf(await owner('select 1 from stock_reservations', ctx.tenant), 0)
  })

  test('a reserva percorre os lotes por validade e ignora o lote expirado', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const v = ctx.yogurt.variant.id
    await must(
      await ctx.http.patch(`/api/v1/warehouses/${ctx.warehouse.id}`, {
        expectedVersion: ctx.warehouse.version,
        salesDefault: true,
      }),
      200
    )
    const lot = async (code: string, expiresOn: string) =>
      must<any>(await ctx.http.post('/api/v1/lots', { variantId: v, code, expiresOn }), 201)
    const old = await lot('VELHO', '2020-01-01')
    const soon = await lot('PROXIMO', '2098-01-01')
    const late = await lot('TARDIO', '2099-01-01')
    await adjust(ctx, v, '5', { lotId: old.id })
    await adjust(ctx, v, '2', { lotId: late.id })
    await adjust(ctx, v, '2', { lotId: soon.id })
    const id = await newOrder(ctx, [{ variantId: v, quantity: '3' }])
    await must(await ctx.http.post(`/api/v1/sales-orders/${id}/confirm`, {}), 200)
    const reservations = await must<any[]>(
      await ctx.http.get(`/api/v1/stock-reservations?sourceId=${id}`),
      200
    )
    const byLot = new Map(reservations.map((r) => [r.lotId, r.quantity]))
    assert.equal(byLot.get(soon.id), '2.000000')
    assert.equal(byLot.get(late.id), '1.000000')
    assert.isFalse(byLot.has(old.id))
  })

  test('o produto com movimentos de stock não muda de unidade base', async ({ client, assert }) => {
    const ctx = await setup(client)
    const product = ctx.shirt.product
    const change = () =>
      ctx.http.patch(`/api/v1/products/${product.id}`, {
        expectedVersion: product.version,
        baseUnitId: ctx.kg.id,
      })
    assert.equal((await change()).status(), 200)
    const other = ctx.rice.product
    await adjust(ctx, ctx.rice.variant.id, '1')
    const blocked = await ctx.http.patch(`/api/v1/products/${other.id}`, {
      expectedVersion: other.version,
      baseUnitId: ctx.unit.id,
    })
    blocked.assertStatus(409)
    assert.equal(blocked.body().error.code, 'STOCK_MIGRATION_REQUIRED')
  })
})

test.group('inventário | autorização e isolamento', (g) => {
  common(g)

  test('cada operação exige a sua permissão e a funcionalidade licenciada', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const reader = await memberWith(ctx, ['inventory.read'])
    ;(await reader.get('/api/v1/stock-balances')).assertStatus(200)
    ;(await reader.get('/api/v1/warehouses')).assertStatus(200)
    ;(
      await reader.post('/api/v1/stock-adjustments', {
        variantId: ctx.shirt.variant.id,
        locationId: ctx.location.id,
        quantityDelta: '1',
        reason: 'x',
      })
    ).assertStatus(403)
    ;(
      await reader.post('/api/v1/stock-reservations', {
        variantId: ctx.shirt.variant.id,
        locationId: ctx.location.id,
        quantity: '1',
        sourceType: 'MANUAL',
        sourceId: uuid(),
      })
    ).assertStatus(403)
    ;(
      await reader.post('/api/v1/warehouses', { organizationId: ctx.org.id, code: 'X', name: 'X' })
    ).assertStatus(403)
    const nobody = await memberWith(ctx, ['party.read'])
    ;(await nobody.get('/api/v1/stock-balances')).assertStatus(403)
    const adjuster = await memberWith(ctx, ['inventory.adjust', 'inventory.read'])
    await must(
      await adjuster.post('/api/v1/stock-adjustments', {
        variantId: ctx.shirt.variant.id,
        locationId: ctx.location.id,
        quantityDelta: '1',
        reason: 'Contagem',
      }),
      201
    )
    // Sem o módulo activo, a funcionalidade não está disponível.
    await must(await ctx.http.post('/api/v1/tenant/modules/inventory/disable', {}), 200)
    const off = await ctx.http.get('/api/v1/stock-balances')
    off.assertStatus(403)
    assert.equal(off.body().error.code, 'FEATURE_NOT_AVAILABLE')
  })

  test('as alterações ficam na auditoria e os dados de outro tenant não se vêem nem se tocam', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const move = await adjust(ctx, ctx.shirt.variant.id, '4')
    const logs = await must<any[]>(
      await ctx.http.get(`/api/v1/audit-logs?resourceId=${move.id}`),
      200
    )
    assert.isAbove(logs.length, 0)
    const other = await setup(client)
    ;(
      await other.http.post(`/api/v1/stock-movements/${move.id}/reverse`, { reason: 'x' })
    ).assertStatus(404)
    ;(await other.http.get(`/api/v1/warehouses/${ctx.warehouse.id}`)).assertStatus(404)
    ;(
      await other.http.post('/api/v1/stock-adjustments', {
        variantId: ctx.shirt.variant.id,
        locationId: ctx.location.id,
        quantityDelta: '1',
        reason: 'x',
      })
    ).assertStatus(422)
    ;(
      await other.http.post('/api/v1/stock-adjustments', {
        variantId: other.shirt.variant.id,
        locationId: ctx.location.id,
        quantityDelta: '1',
        reason: 'x',
      })
    ).assertStatus(422)
    assert.lengthOf(await owner('select 1 from stock_movements', other.tenant), 0)
    assert.lengthOf(await owner('select 1 from stock_balances', other.tenant), 0)
    assert.lengthOf(await owner('select 1 from stock_movements', ctx.tenant), 1)
  })
})
