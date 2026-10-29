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

const MODULES = ['catalog', 'customers', 'orders', 'inventory', 'procurement']
const code = (r: any) => r.body().error.details?.[0]?.code ?? r.body().error.code

/**
 * Tenant com vendas, compras e inventário: uma organização, dois armazéns (ARM-1 de vendas, com 100 camisolas a 5, e ARM-2),
 * o produto «Camisola», um cliente, um fornecedor e as sequências dos documentos.
 */
async function setup(client: any) {
  const tenant = await createActiveTenant()
  const admin = await newActor(client, tenant, true)
  const http = api(client, tenant, admin)
  await syncTestRegistry()
  await license(tenant, MODULES)
  for (const module of MODULES) {
    await must(await http.post(`/api/v1/tenant/modules/${module}/enable`, {}), 200)
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
    ['SALES_ORDER', 'ENC {SERIES}/{YYYY}/'],
    ['SHIPMENT', 'EXP {SERIES}/{YYYY}/'],
    ['PURCHASE_ORDER', 'OC {SERIES}/{YYYY}/'],
    ['GOODS_RECEIPT', 'REC {SERIES}/{YYYY}/'],
    ['STOCK_TRANSFER', 'TRF {SERIES}/{YYYY}/'],
    ['STOCK_COUNT', 'INV {SERIES}/{YYYY}/'],
    ['GOODS_RETURN', 'DEV {SERIES}/{YYYY}/'],
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
  const product = await must<any>(
    await http.post('/api/v1/products', {
      code: 'CAM-001',
      name: 'Camisola',
      type: 'GOODS',
      baseUnitId: unit.id,
    }),
    201
  )
  const variant = product.variants[0] as { id: string }
  await must(
    await http.post(`/api/v1/price-lists/${list.id}/items`, {
      variantId: variant.id,
      unitPrice: '100',
      maxDiscount: '0.1',
    }),
    201
  )
  const main = await must<any>(
    await http.post('/api/v1/warehouses', {
      organizationId: org.id,
      code: 'ARM-1',
      name: 'Central',
    }),
    201
  )
  await must(
    await http.patch(`/api/v1/warehouses/${main.id}`, {
      expectedVersion: main.version,
      salesDefault: true,
    }),
    200
  )
  const second = await must<any>(
    await http.post('/api/v1/warehouses', {
      organizationId: org.id,
      code: 'ARM-2',
      name: 'Secundário',
    }),
    201
  )
  await must(
    await http.post('/api/v1/stock-adjustments', {
      variantId: variant.id,
      locationId: main.locations[0].id,
      quantityDelta: '100',
      unitCost: '5',
      reason: 'Contagem inicial',
    }),
    201
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
    }),
    201
  )
  return { client, tenant, admin, http, org, variant, main, second, customer, supplier }
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

/** Soma do `onHand` da variante num armazém (qualquer local). */
async function onHand(ctx: Ctx, warehouseId: string, variantId = ctx.variant.id) {
  const rows = await must<any[]>(
    await ctx.http.get(
      `/api/v1/stock-balances?variantId=${variantId}&warehouseId=${warehouseId}&limit=200`
    ),
    200
  )
  return rows.reduce((sum, r) => sum + Number(r.onHand), 0)
}

const technical = async (ctx: Ctx, codeName: string) => {
  const warehouses = await must<any[]>(await ctx.http.get('/api/v1/warehouses'), 200)
  return warehouses.find((w) => w.code === codeName)
}

const draftTransfer = (ctx: Ctx, quantity = '10', extra: Record<string, unknown> = {}) =>
  ctx.http.post('/api/v1/stock-transfers', {
    sourceWarehouseId: ctx.main.id,
    destinationWarehouseId: ctx.second.id,
    lines: [{ variantId: ctx.variant.id, quantity }],
    ...extra,
  })

test.group('logística | transferências', (group) => {
  hooks(group)

  test('valida o rascunho: armazéns diferentes, da mesma organização e utilizáveis', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const same = await ctx.http.post('/api/v1/stock-transfers', {
      sourceWarehouseId: ctx.main.id,
      destinationWarehouseId: ctx.main.id,
    })
    assert.equal(code(same), 'SAME_WAREHOUSE')
    const org2 = await must<any>(
      await ctx.http.post('/api/v1/organizations', {
        code: 'EMP2',
        legalName: 'Outra Empresa, Lda.',
        countryCode: 'AO',
        baseCurrency: 'AOA',
      }),
      201
    )
    const foreign = await must<any>(
      await ctx.http.post('/api/v1/warehouses', {
        organizationId: org2.id,
        code: 'X-1',
        name: 'Alheio',
      }),
      201
    )
    const cross = await ctx.http.post('/api/v1/stock-transfers', {
      sourceWarehouseId: ctx.main.id,
      destinationWarehouseId: foreign.id,
    })
    assert.equal(code(cross), 'DIFFERENT_ORGANIZATION')
    assert.equal(code(await draftTransfer(ctx, '0')), 'INVALID_QUANTITY')
    assert.equal(code(await draftTransfer(ctx, '1.0000001')), 'INVALID_QUANTITY')
    const unknown = await ctx.http.post('/api/v1/stock-transfers', {
      sourceWarehouseId: ctx.main.id,
      destinationWarehouseId: '00000000-0000-4000-8000-000000000000',
    })
    assert.equal(code(unknown), 'UNKNOWN_WAREHOUSE')

    const draft = await must<any>(await draftTransfer(ctx, '10'), 201)
    assert.equal(draft.status, 'DRAFT')
    assert.isNull(draft.number)
    assert.equal(draft.lines[0].inTransit, '0.000000')
    const extra = await must<any>(
      await ctx.http.post(`/api/v1/stock-transfers/${draft.id}/lines`, {
        variantId: ctx.variant.id,
        quantity: '2',
      }),
      201
    )
    assert.lengthOf(extra.lines, 2)
    const trimmed = await must<any>(
      await ctx.http.delete(`/api/v1/stock-transfers/${draft.id}/lines/${extra.lines[1].id}`),
      200
    )
    assert.lengthOf(trimmed.lines, 1)
    assert.equal((await ctx.http.delete(`/api/v1/stock-transfers/${draft.id}`)).status(), 204)
    assert.equal((await ctx.http.get(`/api/v1/stock-transfers/${draft.id}`)).status(), 404)
  })

  test('expedir move o stock para trânsito sem o duplicar; receber parcialmente deixa o resto em trânsito', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const draft = await must<any>(await draftTransfer(ctx, '30'), 201)
    const dispatched = await must<any>(
      await ctx.http.post(`/api/v1/stock-transfers/${draft.id}/dispatch`, {}),
      200
    )
    assert.equal(dispatched.status, 'DISPATCHED')
    assert.match(dispatched.number, /^TRF A\/\d{4}\/0*1$/)
    assert.equal(dispatched.lines[0].dispatchedQty, '30.000000')
    assert.equal(dispatched.lines[0].inTransit, '30.000000')
    const transit = await technical(ctx, 'TRANSITO')
    assert.isTrue(transit.technical)
    assert.equal(await onHand(ctx, ctx.main.id), 70)
    assert.equal(await onHand(ctx, transit.id), 30)
    assert.equal(await onHand(ctx, ctx.second.id), 0)
    // O mesmo comando outra vez não move nada.
    await must(await ctx.http.post(`/api/v1/stock-transfers/${draft.id}/dispatch`, {}), 200)
    assert.equal(await onHand(ctx, ctx.main.id), 70)

    const lineId = dispatched.lines[0].id as string
    const half = await must<any>(
      await ctx.http.post(`/api/v1/stock-transfers/${draft.id}/receive`, {
        lines: [{ lineId, quantity: '12' }],
      }),
      200
    )
    assert.equal(half.status, 'PARTIAL_RECEIVED')
    assert.equal(half.lines[0].receivedQty, '12.000000')
    assert.equal(half.lines[0].inTransit, '18.000000')
    assert.equal(await onHand(ctx, transit.id), 18)
    assert.equal(await onHand(ctx, ctx.second.id), 12)
    assert.equal((await onHand(ctx, ctx.main.id)) + 18 + 12, 100)

    const tooMuch = await ctx.http.post(`/api/v1/stock-transfers/${draft.id}/receive`, {
      lines: [{ lineId, quantity: '19' }],
    })
    assert.equal(tooMuch.status(), 422)
    assert.equal(tooMuch.body().error.details[0].code, 'EXCEEDS_IN_TRANSIT')

    const done = await must<any>(
      await ctx.http.post(`/api/v1/stock-transfers/${draft.id}/receive`, {
        lines: [{ lineId, quantity: '18' }],
      }),
      200
    )
    assert.equal(done.status, 'RECEIVED')
    assert.lengthOf(done.receipts, 2)
    assert.equal(await onHand(ctx, transit.id), 0)
    assert.equal(await onHand(ctx, ctx.second.id), 30)
    assert.equal(
      (
        await ctx.http.post(`/api/v1/stock-transfers/${draft.id}/receive`, {
          lines: [{ lineId, quantity: '1' }],
        })
      ).status(),
      409
    )
  })

  test('o custo acompanha o stock e uma recepção repetida com a mesma chave não recebe outra vez', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const draft = await must<any>(await draftTransfer(ctx, '10'), 201)
    const dispatched = await must<any>(
      await ctx.http.post(`/api/v1/stock-transfers/${draft.id}/dispatch`, {}),
      200
    )
    const lineId = dispatched.lines[0].id as string
    const send = (key: string) =>
      client
        .post(`/api/v1/stock-transfers/${draft.id}/receive`)
        .header('cookie', ctx.admin.cookie)
        .header('x-tenant-id', ctx.tenant.id)
        .header('x-csrf-token', ctx.admin.csrf)
        .header('idempotency-key', key)
        .json({ lines: [{ lineId, quantity: '4' }] })
    assert.equal((await send('rec-1')).status(), 200)
    assert.equal((await send('rec-1')).status(), 200)
    assert.equal(await onHand(ctx, ctx.second.id), 4)
    assert.equal((await send('chave com espaços')).status(), 422)
    const movements = await must<any[]>(
      await ctx.http.get(`/api/v1/stock-movements?sourceType=TRANSFER_RECEIPT&limit=200`),
      200
    )
    assert.lengthOf(movements, 2)
    for (const m of movements) assert.equal(m.unitCost, '5.0000')
    const kinds = movements.map((m) => m.kind).sort()
    assert.deepEqual(kinds, ['TRANSFER_IN', 'TRANSFER_OUT'])
  })

  test('sem stock disponível não se expede e nada se move; depois de expedida não se cancela', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const big = await must<any>(await draftTransfer(ctx, '101'), 201)
    const refused = await ctx.http.post(`/api/v1/stock-transfers/${big.id}/dispatch`, {})
    assert.equal(refused.status(), 409)
    assert.equal(code(refused), 'INSUFFICIENT_STOCK')
    assert.equal(await onHand(ctx, ctx.main.id), 100)
    assert.equal(
      (await must<any>(await ctx.http.get(`/api/v1/stock-transfers/${big.id}`), 200)).status,
      'DRAFT'
    )
    assert.isUndefined(await technical(ctx, 'TRANSITO'))

    const ok = await must<any>(await draftTransfer(ctx, '5'), 201)
    await must(await ctx.http.post(`/api/v1/stock-transfers/${ok.id}/dispatch`, {}), 200)
    assert.equal(
      code(await ctx.http.post(`/api/v1/stock-transfers/${ok.id}/cancel`, { reason: 'x' })),
      'TRANSFER_NOT_CANCELLABLE'
    )
    assert.equal(
      code(await ctx.http.post(`/api/v1/stock-transfers/${big.id}/cancel`, { reason: '' })),
      'REQUIRED'
    )
    const cancelled = await must<any>(
      await ctx.http.post(`/api/v1/stock-transfers/${big.id}/cancel`, { reason: 'Engano' }),
      200
    )
    assert.equal(cancelled.status, 'CANCELLED')
    assert.equal(
      (await ctx.http.post(`/api/v1/stock-transfers/${big.id}/dispatch`, {})).status(),
      409
    )
    const empty = await must<any>(
      await ctx.http.post('/api/v1/stock-transfers', {
        sourceWarehouseId: ctx.main.id,
        destinationWarehouseId: ctx.second.id,
      }),
      201
    )
    assert.equal(
      code(await ctx.http.post(`/api/v1/stock-transfers/${empty.id}/dispatch`, {})),
      'TRANSFER_EMPTY'
    )
  })

  test('expedir, receber e gerir são permissões distintas; expedida é imutável (também por SQL)', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const manager = await memberWith(ctx, ['transfer.read', 'transfer.manage'])
    const draft = await must<any>(
      await manager.post('/api/v1/stock-transfers', {
        sourceWarehouseId: ctx.main.id,
        destinationWarehouseId: ctx.second.id,
        lines: [{ variantId: ctx.variant.id, quantity: '3' }],
      }),
      201
    )
    assert.equal(
      (await manager.post(`/api/v1/stock-transfers/${draft.id}/dispatch`, {})).status(),
      403
    )
    const dispatcher = await memberWith(ctx, ['transfer.read', 'transfer.dispatch'])
    const dispatched = await must<any>(
      await dispatcher.post(`/api/v1/stock-transfers/${draft.id}/dispatch`, {}),
      200
    )
    const body = { lines: [{ lineId: dispatched.lines[0].id, quantity: '3' }] }
    assert.equal(
      (await dispatcher.post(`/api/v1/stock-transfers/${draft.id}/receive`, body)).status(),
      403
    )
    const receiver = await memberWith(ctx, ['transfer.read', 'transfer.receive'])
    assert.equal(
      (await receiver.post(`/api/v1/stock-transfers/${draft.id}/receive`, body)).status(),
      200
    )
    assert.equal(
      (
        await receiver.post('/api/v1/stock-transfers', {
          sourceWarehouseId: ctx.main.id,
          destinationWarehouseId: ctx.second.id,
        })
      ).status(),
      403
    )

    await assert.rejects(
      () =>
        owner(
          `update transfer_lines set quantity = 99 where transfer_id = '${draft.id}'`,
          ctx.tenant
        ),
      /TRANSFER_LINES_IMMUTABLE/
    )
    await assert.rejects(
      () =>
        owner(
          `update stock_transfers set source_warehouse_id = destination_warehouse_id where id = '${draft.id}'`,
          ctx.tenant
        ),
      /STOCK_TRANSFER_IMMUTABLE|stock_transfers_warehouses_check/
    )
    await assert.rejects(
      () => owner(`delete from transfer_receipts where transfer_id = '${draft.id}'`, ctx.tenant),
      /imutável/
    )
    await assert.rejects(
      () => owner(`delete from stock_transfers where id = '${draft.id}'`, ctx.tenant),
      /STOCK_TRANSFER_IMMUTABLE/
    )
  })
})

test.group('logística | contagens', (group) => {
  hooks(group)

  const open = async (ctx: Ctx, extra: Record<string, unknown> = {}) => {
    const count = await must<any>(
      await ctx.http.post('/api/v1/stock-counts', { warehouseId: ctx.main.id, ...extra }),
      201
    )
    return must<any>(await ctx.http.post(`/api/v1/stock-counts/${count.id}/open`, {}), 200)
  }
  const adjust = (ctx: Ctx, delta: string) =>
    ctx.http.post('/api/v1/stock-adjustments', {
      variantId: ctx.variant.id,
      locationId: ctx.main.locations[0].id,
      quantityDelta: delta,
      reason: 'Ajuste manual',
    })

  test('abrir congela os locais e fotografa o esperado; só o fim da contagem descongela', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const opened = await open(ctx)
    assert.equal(opened.status, 'OPEN')
    assert.match(opened.number, /^INV A\/\d{4}\/0*1$/)
    assert.lengthOf(opened.lines, 1)
    assert.equal(opened.lines[0].expectedQty, '100.000000')

    const frozen = await adjust(ctx, '-1')
    assert.equal(frozen.status(), 409)
    assert.equal(code(frozen), 'LOCATION_FROZEN')
    const dispatch = await must<any>(await draftTransfer(ctx, '5'), 201)
    assert.equal(
      code(await ctx.http.post(`/api/v1/stock-transfers/${dispatch.id}/dispatch`, {})),
      'LOCATION_FROZEN'
    )
    const overlapping = await must<any>(
      await ctx.http.post('/api/v1/stock-counts', { warehouseId: ctx.main.id }),
      201
    )
    assert.equal(
      code(await ctx.http.post(`/api/v1/stock-counts/${overlapping.id}/open`, {})),
      'LOCATION_FROZEN'
    )
    // Outro armazém não é afectado.
    assert.equal(await onHand(ctx, ctx.second.id), 0)

    // Abrir outra vez é idempotente.
    const again = await must<any>(
      await ctx.http.post(`/api/v1/stock-counts/${opened.id}/open`, {}),
      200
    )
    assert.equal(again.number, opened.number)
    const cancelled = await must<any>(
      await ctx.http.post(`/api/v1/stock-counts/${opened.id}/cancel`, { reason: 'Engano' }),
      200
    )
    assert.equal(cancelled.status, 'CANCELLED')
    assert.equal((await adjust(ctx, '-1')).status(), 201)
  })

  test('contagem cega esconde o esperado até à revisão; a revisão exige tudo contado', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const opened = await open(ctx, { blind: true })
    assert.isNull(opened.lines[0].expectedQty)
    assert.isNull(opened.lines[0].varianceQty)
    const unsettled = await ctx.http.post(`/api/v1/stock-counts/${opened.id}/review`, {})
    assert.equal(unsettled.status(), 422)
    assert.equal(unsettled.body().error.details[0].code, 'UNCOUNTED_LINE')
    const lineId = opened.lines[0].id as string
    assert.equal(
      code(
        await ctx.http.put(`/api/v1/stock-counts/${opened.id}/counts`, {
          lines: [{ lineId, countedQty: '-1' }],
        })
      ),
      'INVALID_QUANTITY'
    )
    await must(
      await ctx.http.put(`/api/v1/stock-counts/${opened.id}/counts`, {
        lines: [{ lineId, countedQty: '97' }],
      }),
      200
    )
    const review = await must<any>(
      await ctx.http.post(`/api/v1/stock-counts/${opened.id}/review`, {}),
      200
    )
    assert.equal(review.status, 'REVIEW')
    assert.equal(review.lines[0].expectedQty, '100.000000')
    assert.equal(review.lines[0].varianceQty, '-3.000000')
    // Reconferência: volta à contagem, corrige e volta a rever.
    await must(await ctx.http.post(`/api/v1/stock-counts/${opened.id}/reopen`, {}), 200)
    await must(
      await ctx.http.put(`/api/v1/stock-counts/${opened.id}/counts`, {
        lines: [{ lineId, countedQty: '98' }],
      }),
      200
    )
    const second = await must<any>(
      await ctx.http.post(`/api/v1/stock-counts/${opened.id}/review`, {}),
      200
    )
    assert.equal(second.lines[0].varianceQty, '-2.000000')
  })

  test('lançar duas vezes não repete o ajuste; lançada, descongela e não se altera', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const opened = await open(ctx)
    const lineId = opened.lines[0].id as string
    // Um artigo encontrado onde o sistema não esperava.
    const other = await must<any>(
      await ctx.http.post('/api/v1/products', {
        code: 'CAM-002',
        name: 'Calças',
        type: 'GOODS',
        baseUnitId: (await must<any[]>(await ctx.http.get('/api/v1/units'), 200))[0].id,
      }),
      201
    )
    const extra = await must<any>(
      await ctx.http.post(`/api/v1/stock-counts/${opened.id}/lines`, {
        variantId: other.variants[0].id,
        locationId: ctx.main.locations[0].id,
      }),
      201
    )
    assert.equal(extra.lines.length, 2)
    assert.equal(
      code(
        await ctx.http.post(`/api/v1/stock-counts/${opened.id}/lines`, {
          variantId: other.variants[0].id,
          locationId: ctx.main.locations[0].id,
        })
      ),
      'COUNT_LINE_EXISTS'
    )
    const newLine = extra.lines.find((l: any) => l.id !== lineId)
    await must(
      await ctx.http.put(`/api/v1/stock-counts/${opened.id}/counts`, {
        lines: [
          { lineId, countedQty: '96', reason: 'Quebra' },
          { lineId: newLine.id, countedQty: '2' },
        ],
      }),
      200
    )
    await must(await ctx.http.post(`/api/v1/stock-counts/${opened.id}/review`, {}), 200)
    assert.equal(
      (await ctx.http.post(`/api/v1/stock-counts/${opened.id}/cancel`, { reason: '' })).status(),
      422
    )

    const posted = await must<any>(
      await ctx.http.post(`/api/v1/stock-counts/${opened.id}/post`, {}),
      200
    )
    assert.equal(posted.status, 'POSTED')
    assert.equal(await onHand(ctx, ctx.main.id), 96)
    assert.equal(await onHand(ctx, ctx.main.id, other.variants[0].id), 2)
    const adjustments = await must<any[]>(
      await ctx.http.get(`/api/v1/stock-movements?sourceType=STOCK_COUNT&limit=200`),
      200
    )
    assert.lengthOf(adjustments, 2)

    // Lançar outra vez: nada se repete.
    await must(await ctx.http.post(`/api/v1/stock-counts/${opened.id}/post`, {}), 200)
    assert.equal(await onHand(ctx, ctx.main.id), 96)
    assert.lengthOf(
      await must<any[]>(
        await ctx.http.get(`/api/v1/stock-movements?sourceType=STOCK_COUNT&limit=200`),
        200
      ),
      2
    )
    // Descongelado: voltam os movimentos normais.
    assert.equal((await adjust(ctx, '-1')).status(), 201)
    assert.equal(
      code(await ctx.http.post(`/api/v1/stock-counts/${opened.id}/cancel`, { reason: 'x' })),
      'COUNT_POSTED'
    )
    assert.equal(
      (
        await ctx.http.put(`/api/v1/stock-counts/${opened.id}/counts`, {
          lines: [{ lineId, countedQty: '1' }],
        })
      ).status(),
      409
    )
    await assert.rejects(
      () =>
        owner(
          `update count_lines set expected_qty = 1 where count_id = '${opened.id}'`,
          ctx.tenant
        ),
      /COUNT_LINES_IMMUTABLE/
    )
    await assert.rejects(
      () => owner(`update stock_counts set status = 'OPEN' where id = '${opened.id}'`, ctx.tenant),
      /STOCK_COUNT_IMMUTABLE/
    )
    const frozen = await owner<{ n: number }>(
      `select count(*)::int as n from stock_locations where frozen_by_count_id is not null`,
      ctx.tenant
    )
    assert.equal(frozen[0]?.n, 0)
  })

  test('lançar duas vezes em simultâneo gera um só ajuste', async ({ client, assert }) => {
    const ctx = await setup(client)
    const opened = await open(ctx)
    const lineId = opened.lines[0].id as string
    await must(
      await ctx.http.put(`/api/v1/stock-counts/${opened.id}/counts`, {
        lines: [{ lineId, countedQty: '90' }],
      }),
      200
    )
    await must(await ctx.http.post(`/api/v1/stock-counts/${opened.id}/review`, {}), 200)
    const results = await Promise.all([
      ctx.http.post(`/api/v1/stock-counts/${opened.id}/post`, {}),
      ctx.http.post(`/api/v1/stock-counts/${opened.id}/post`, {}),
    ])
    assert.deepEqual(
      results.map((r) => r.status()),
      [200, 200]
    )
    assert.equal(await onHand(ctx, ctx.main.id), 90)
  })

  test('permissões: contar, lançar e ler são distintas', async ({ client, assert }) => {
    const ctx = await setup(client)
    const counter = await memberWith(ctx, ['count.read', 'count.manage'])
    const created = await must<any>(
      await counter.post('/api/v1/stock-counts', { warehouseId: ctx.main.id }),
      201
    )
    await must(await counter.post(`/api/v1/stock-counts/${created.id}/open`, {}), 200)
    assert.equal((await counter.post(`/api/v1/stock-counts/${created.id}/post`, {})).status(), 403)
    const reader = await memberWith(ctx, ['count.read'])
    assert.equal((await reader.get(`/api/v1/stock-counts/${created.id}`)).status(), 200)
    assert.equal(
      (await reader.post('/api/v1/stock-counts', { warehouseId: ctx.main.id })).status(),
      403
    )
    assert.equal((await ctx.http.get('/api/v1/stock-counts/não-é-uuid')).status(), 404)
  })
})

test.group('logística | devoluções', (group) => {
  hooks(group)

  /** Encomenda de `quantity` camisolas, expedida: devolve o id da expedição e da sua linha. */
  async function shipped(ctx: Ctx, quantity = '10') {
    const order = await must<any>(
      await ctx.http.post('/api/v1/sales-orders', {
        organizationId: ctx.org.id,
        customerId: ctx.customer.id,
      }),
      201
    )
    const detail = await must<any>(
      await ctx.http.post(`/api/v1/sales-orders/${order.id}/lines`, {
        variantId: ctx.variant.id,
        quantity,
      }),
      201
    )
    await must(await ctx.http.post(`/api/v1/sales-orders/${order.id}/confirm`, {}), 200)
    const shipment = await must<any>(
      await ctx.http.post('/api/v1/shipments', {
        orderId: order.id,
        lines: [{ orderLineId: detail.lines[0].id, quantity }],
      }),
      201
    )
    await must(await ctx.http.post(`/api/v1/shipments/${shipment.id}/post`, {}), 200)
    return { id: shipment.id as string, lineId: shipment.lines[0].id as string }
  }

  const customerReturn = (
    ctx: Ctx,
    shipment: { id: string; lineId: string },
    quantity: string,
    condition = 'SELLABLE'
  ) =>
    ctx.http.post('/api/v1/goods-returns', {
      direction: 'CUSTOMER',
      sourceDocumentId: shipment.id,
      warehouseId: ctx.main.id,
      reason: 'Tamanho errado',
      lines: [{ sourceLineId: shipment.lineId, quantity, condition }],
    })

  test('mostra o devolvível por linha; uma devolução superior ao expedido falha', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const shipment = await shipped(ctx, '10')
    const sources = await must<any[]>(
      await ctx.http.get(
        `/api/v1/goods-returns/source-lines?direction=CUSTOMER&sourceDocumentId=${shipment.id}`
      ),
      200
    )
    assert.equal(sources[0].quantity, '10.000000')
    assert.equal(sources[0].returnable, '10.000000')
    assert.equal(sources[0].unitCost, '5.0000')

    const over = await customerReturn(ctx, shipment, '11')
    assert.equal(over.status(), 422)
    assert.equal(over.body().error.details[0].code, 'EXCEEDS_RETURNABLE')
    assert.equal(code(await customerReturn(ctx, shipment, '0')), 'INVALID_QUANTITY')
    assert.equal(code(await customerReturn(ctx, shipment, '1', 'BROKEN')), 'INVALID_CONDITION')
    const unknownLine = await ctx.http.post('/api/v1/goods-returns', {
      direction: 'CUSTOMER',
      sourceDocumentId: shipment.id,
      warehouseId: ctx.main.id,
      reason: 'x',
      lines: [{ sourceLineId: '00000000-0000-4000-8000-000000000000', quantity: '1' }],
    })
    assert.equal(code(unknownLine), 'UNKNOWN_SOURCE_LINE')
    const unknownSource = await ctx.http.post('/api/v1/goods-returns', {
      direction: 'CUSTOMER',
      sourceDocumentId: '00000000-0000-4000-8000-000000000000',
      warehouseId: ctx.main.id,
      reason: 'x',
    })
    assert.equal(code(unknownSource), 'UNKNOWN_SOURCE')
    assert.equal(
      code(
        await ctx.http.post('/api/v1/goods-returns', {
          direction: 'CUSTOMER',
          sourceDocumentId: shipment.id,
          warehouseId: ctx.main.id,
          reason: '',
        })
      ),
      'REQUIRED'
    )
  })

  test('devolução de cliente: aprovar e lançar dá entrada ao custo original; é idempotente', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const shipment = await shipped(ctx, '10')
    assert.equal(await onHand(ctx, ctx.main.id), 90)
    const created = await must<any>(await customerReturn(ctx, shipment, '4'), 201)
    assert.equal(created.status, 'DRAFT')
    assert.equal(
      code(await ctx.http.post(`/api/v1/goods-returns/${created.id}/post`, {})),
      'RETURN_NOT_APPROVED'
    )
    const approved = await must<any>(
      await ctx.http.post(`/api/v1/goods-returns/${created.id}/approve`, {}),
      200
    )
    assert.equal(approved.status, 'APPROVED')
    const posted = await must<any>(
      await ctx.http.post(`/api/v1/goods-returns/${created.id}/post`, {}),
      200
    )
    assert.equal(posted.status, 'POSTED')
    assert.match(posted.number, /^DEV A\/\d{4}\/0*1$/)
    assert.equal(await onHand(ctx, ctx.main.id), 94)
    await must(await ctx.http.post(`/api/v1/goods-returns/${created.id}/post`, {}), 200)
    assert.equal(await onHand(ctx, ctx.main.id), 94)
    const moves = await must<any[]>(
      await ctx.http.get('/api/v1/stock-movements?sourceType=GOODS_RETURN&limit=50'),
      200
    )
    assert.lengthOf(moves, 1)
    assert.equal(moves[0].unitCost, '5.0000')
    const after = await must<any[]>(
      await ctx.http.get(
        `/api/v1/goods-returns/source-lines?direction=CUSTOMER&sourceDocumentId=${shipment.id}`
      ),
      200
    )
    assert.equal(after[0].returned, '4.000000')
    assert.equal(after[0].returnable, '6.000000')
    // Lançada é imutável (também por SQL).
    assert.equal((await ctx.http.delete(`/api/v1/goods-returns/${created.id}`)).status(), 409)
    assert.equal(
      (
        await ctx.http.post(`/api/v1/goods-returns/${created.id}/lines`, {
          sourceLineId: shipment.lineId,
          quantity: '1',
        })
      ).status(),
      409
    )
    await assert.rejects(
      () =>
        owner(`update return_lines set quantity = 9 where return_id = '${created.id}'`, ctx.tenant),
      /RETURN_LINES_IMMUTABLE/
    )
    await assert.rejects(
      () => owner(`update goods_returns set reason = 'x' where id = '${created.id}'`, ctx.tenant),
      /GOODS_RETURN_IMMUTABLE/
    )
  })

  test('duas devoluções aprovadas nunca excedem o expedido, mesmo em simultâneo', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const shipment = await shipped(ctx, '10')
    const a = await must<any>(await customerReturn(ctx, shipment, '6'), 201)
    const b = await must<any>(await customerReturn(ctx, shipment, '6'), 201)
    const results = await Promise.all([
      ctx.http.post(`/api/v1/goods-returns/${a.id}/approve`, {}),
      ctx.http.post(`/api/v1/goods-returns/${b.id}/approve`, {}),
    ])
    assert.sameMembers(results.map((r) => r.status()).sort(), [200, 409])
    const refused = results.find((r) => r.status() === 409)!
    assert.equal(refused.body().error.code, 'RETURN_NOT_APPROVABLE')
    const sources = await must<any[]>(
      await ctx.http.get(
        `/api/v1/goods-returns/source-lines?direction=CUSTOMER&sourceDocumentId=${shipment.id}`
      ),
      200
    )
    assert.equal(sources[0].returned, '6.000000')
    assert.equal(sources[0].returnable, '4.000000')
  })

  test('danificado e em quarentena vão para armazéns técnicos e não se vendem', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const shipment = await shipped(ctx, '10')
    const created = await must<any>(
      await ctx.http.post('/api/v1/goods-returns', {
        direction: 'CUSTOMER',
        sourceDocumentId: shipment.id,
        warehouseId: ctx.main.id,
        reason: 'Defeito',
        lines: [
          { sourceLineId: shipment.lineId, quantity: '2', condition: 'DAMAGED' },
          { sourceLineId: shipment.lineId, quantity: '1', condition: 'QUARANTINE' },
          { sourceLineId: shipment.lineId, quantity: '3', condition: 'SELLABLE' },
        ],
      }),
      201
    )
    await must(await ctx.http.post(`/api/v1/goods-returns/${created.id}/approve`, {}), 200)
    await must(await ctx.http.post(`/api/v1/goods-returns/${created.id}/post`, {}), 200)
    const damaged = await technical(ctx, 'DANIFICADO')
    const quarantine = await technical(ctx, 'QUARENTENA')
    assert.equal(await onHand(ctx, damaged.id), 2)
    assert.equal(await onHand(ctx, quarantine.id), 1)
    assert.equal(await onHand(ctx, ctx.main.id), 93)
    assert.isTrue(damaged.technical)
    const flag = await ctx.http.patch(`/api/v1/warehouses/${damaged.id}`, {
      expectedVersion: damaged.version,
      salesDefault: true,
    })
    assert.equal(flag.status(), 409)
    assert.equal(code(flag), 'WAREHOUSE_TECHNICAL')
  })

  test('devolução a fornecedor tira o stock; só devolve o recebido e não o revertido', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const order = await must<any>(
      await ctx.http.post('/api/v1/purchase-orders', {
        supplierId: ctx.supplier.id,
        lines: [{ variantId: ctx.variant.id, quantity: '20', unitCost: '7' }],
      }),
      201
    )
    await must(await ctx.http.post(`/api/v1/purchase-orders/${order.id}/confirm`, {}), 200)
    const receipt = await must<any>(
      await ctx.http.post('/api/v1/goods-receipts', {
        purchaseOrderId: order.id,
        warehouseId: ctx.second.id,
        lines: [{ purchaseLineId: order.lines[0].id, quantity: '8' }],
      }),
      201
    )
    await must(await ctx.http.post(`/api/v1/goods-receipts/${receipt.id}/post`, {}), 200)
    assert.equal(await onHand(ctx, ctx.second.id), 8)
    const sources = await must<any[]>(
      await ctx.http.get(
        `/api/v1/goods-returns/source-lines?direction=SUPPLIER&sourceDocumentId=${receipt.id}`
      ),
      200
    )
    assert.equal(sources[0].quantity, '8.000000')
    assert.equal(sources[0].unitCost, '7.0000')
    const body = (quantity: string) => ({
      direction: 'SUPPLIER',
      sourceDocumentId: receipt.id,
      warehouseId: ctx.second.id,
      reason: 'Fora de especificação',
      lines: [{ sourceLineId: sources[0].sourceLineId, quantity }],
    })
    assert.equal(
      code(await ctx.http.post('/api/v1/goods-returns', body('9'))),
      'EXCEEDS_RETURNABLE'
    )
    const created = await must<any>(await ctx.http.post('/api/v1/goods-returns', body('3')), 201)
    await must(await ctx.http.post(`/api/v1/goods-returns/${created.id}/approve`, {}), 200)
    await must(await ctx.http.post(`/api/v1/goods-returns/${created.id}/post`, {}), 200)
    assert.equal(await onHand(ctx, ctx.second.id), 5)
    // Revertida uma recepção, a sua origem deixa de contar para devoluções.
    const other = await must<any>(
      await ctx.http.post('/api/v1/goods-receipts', {
        purchaseOrderId: order.id,
        warehouseId: ctx.second.id,
        lines: [{ purchaseLineId: order.lines[0].id, quantity: '2' }],
      }),
      201
    )
    await must(await ctx.http.post(`/api/v1/goods-receipts/${other.id}/post`, {}), 200)
    await must(
      await ctx.http.post(`/api/v1/goods-receipts/${other.id}/reverse`, { reason: 'Engano' }),
      200
    )
    const gone = await ctx.http.post('/api/v1/goods-returns', {
      direction: 'SUPPLIER',
      sourceDocumentId: other.id,
      warehouseId: ctx.second.id,
      reason: 'x',
    })
    assert.equal(code(gone), 'UNKNOWN_SOURCE')
  })

  test('permissões: gerir, aprovar/lançar e ler devoluções são distintas', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const shipment = await shipped(ctx, '5')
    const manager = await memberWith(ctx, ['return.read', 'return.manage'])
    const created = await must<any>(
      await manager.post('/api/v1/goods-returns', {
        direction: 'CUSTOMER',
        sourceDocumentId: shipment.id,
        warehouseId: ctx.main.id,
        reason: 'x',
        lines: [{ sourceLineId: shipment.lineId, quantity: '1' }],
      }),
      201
    )
    assert.equal(
      (await manager.post(`/api/v1/goods-returns/${created.id}/approve`, {})).status(),
      403
    )
    const poster = await memberWith(ctx, ['return.read', 'return.post'])
    assert.equal(
      (await poster.post(`/api/v1/goods-returns/${created.id}/approve`, {})).status(),
      200
    )
    assert.equal((await poster.delete(`/api/v1/goods-returns/${created.id}`)).status(), 403)
    const nobody = await memberWith(ctx, ['transfer.read'])
    assert.equal((await nobody.get('/api/v1/goods-returns')).status(), 403)
  })
})
