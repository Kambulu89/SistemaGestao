import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { iamServices } from '#core/permissions/index'
import { deleteTestUsers, resetAuthState } from '#tests/support/auth_fixture'
import { createActiveTenant, deleteTestTenants } from '#tests/support/membership_fixture'
import { api, newActor } from '#tests/support/api_fixture'
import { license, syncTestRegistry } from '#tests/support/modules_fixture'
import { registerConfirmationCheck } from '#modules/orders/index'
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
const daysFromNow = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)

/**
 * Tenant com `catalog`, `customers` e `orders` activos: uma organização (AOA, IVA 14 % «VAT»), um produto «Camisola»
 * com a variante por omissão, uma tabela de preços com dois escalões (1 500 e, a partir de 10, 1 350; desconto máximo 10 %),
 * um cliente e as sequências `QUOTE` e `SALES_ORDER`.
 */
async function setup(client: any, options: { sequences?: boolean } = {}) {
  const tenant = await createActiveTenant()
  const admin = await newActor(client, tenant, true)
  const http = api(client, tenant, admin)
  await syncTestRegistry()
  await license(tenant, ['catalog', 'customers', 'orders'])
  for (const code of ['catalog', 'customers', 'orders']) {
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
  if (options.sequences !== false) {
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
  }
  const product = await must<any>(
    await http.post('/api/v1/products', {
      code: 'CAM-001',
      name: 'Camisola',
      type: 'GOODS',
      baseUnitId: unit.id,
      taxCategory: 'VAT',
    }),
    201
  )
  const variant = product.variants[0]
  const list = await must<any>(
    await http.post('/api/v1/price-lists', {
      organizationId: org.id,
      name: 'Retalho',
      currency: 'AOA',
      validFrom: '2020-01-01',
    }),
    201
  )
  await must(
    await http.post(`/api/v1/price-lists/${list.id}/items`, {
      variantId: variant.id,
      unitPrice: '1500',
      maxDiscount: '0.1',
    }),
    201
  )
  const tier = await must<any>(
    await http.post(`/api/v1/price-lists/${list.id}/items`, {
      variantId: variant.id,
      minQuantity: '10',
      unitPrice: '1350',
      maxDiscount: '0.1',
    }),
    201
  )
  const party = await must<any>(
    await http.post('/api/v1/organization-parties', {
      legalName: `Acme ${uid()}, Lda.`,
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
    tenant,
    admin,
    http,
    org,
    unit,
    kg,
    product,
    variant,
    list,
    tier,
    party,
    customer,
    client,
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

const newQuote = (ctx: Ctx, extra: Record<string, unknown> = {}) => ({
  organizationId: ctx.org.id,
  customerId: ctx.customer.id,
  validUntil: daysFromNow(30),
  ...extra,
})

const newOrder = (ctx: Ctx, extra: Record<string, unknown> = {}) => ({
  organizationId: ctx.org.id,
  customerId: ctx.customer.id,
  ...extra,
})

const line = (ctx: Ctx, quantity: string, extra: Record<string, unknown> = {}) => ({
  variantId: ctx.variant.id,
  quantity,
  ...extra,
})

const owner = <T>(sql: string, tenant?: Tenant) =>
  db.connection('owner').transaction(async (trx) => {
    if (tenant) await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [tenant.id])
    return (await trx.rawQuery(sql)).rows as T[]
  })

const eventCount = async (tenant: Tenant, type: string) =>
  (
    (
      await owner<{ n: number }>(
        `select count(*)::int as n from outbox_events where event_type = '${type}'`,
        tenant
      )
    )[0] as any
  ).n

test.group('propostas | linhas e instantâneo', (group) => {
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

  test('o preço, o escalão e o imposto vêm do servidor; o total é a soma exacta das linhas', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const quote = await must<any>(await ctx.http.post('/api/v1/quotes', newQuote(ctx)), 201)
    assert.deepInclude(quote, { status: 'DRAFT', currency: 'AOA', number: null })
    // O cliente não manda no preço: o que vier em `unitPrice` é ignorado.
    const one = await must<any>(
      await ctx.http.post(`/api/v1/quotes/${quote.id}/lines`, line(ctx, '2', { unitPrice: '1' })),
      201
    )
    assert.deepInclude(one.lines[0], {
      quantity: '2.000000',
      unitPrice: '1500.0000',
      taxRateSnapshot: '14.0000',
      netAmount: '3000.0000',
      taxAmount: '420.0000',
      total: '3420.0000',
    })
    assert.equal(one.lines[0].descriptionSnapshot, 'Camisola — CAM-001')
    assert.deepInclude(one.lines[0].priceOrigin, {
      priceListName: 'Retalho',
      minQuantity: '1.000000',
      maxDiscount: '0.1000',
    })
    // 12 unidades caem no escalão de 10 (1 350), com 5 % de desconto: 12 × 1350 × 0,95 = 15 390; IVA 2 154,60.
    const two = await must<any>(
      await ctx.http.post(
        `/api/v1/quotes/${quote.id}/lines`,
        line(ctx, '12', { discountRate: '0.05' })
      ),
      201
    )
    assert.deepInclude(two.lines[1], {
      position: 2,
      unitPrice: '1350.0000',
      discountRate: '0.0500',
      netAmount: '15390.0000',
      taxAmount: '2154.6000',
      total: '17544.6000',
    })
    assert.deepEqual(two.totals, { net: '18390.0000', tax: '2574.6000', total: '20964.6000' })
  })

  test('desconto acima do máximo, quantidade com demasiadas casas, sem preço e variante inactiva são recusados', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const quote = await must<any>(await ctx.http.post('/api/v1/quotes', newQuote(ctx)), 201)
    const codeOf = async (body: Record<string, unknown>, status = 422) => {
      const response = await ctx.http.post(`/api/v1/quotes/${quote.id}/lines`, body)
      response.assertStatus(status)
      return response.body().error.details?.[0]?.code ?? response.body().error.code
    }
    assert.equal(await codeOf(line(ctx, '1', { discountRate: '0.11' })), 'DISCOUNT_EXCEEDS')
    assert.equal(await codeOf(line(ctx, '1.5')), 'QUANTITY_PRECISION')
    assert.equal(await codeOf(line(ctx, '0')), 'INVALID_QUANTITY')
    assert.equal(await codeOf(line(ctx, '1', { discountRate: '2' })), 'INVALID_DISCOUNT')
    assert.equal(
      await codeOf({ variantId: '33333333-3333-4333-8333-333333333333', quantity: '1' }),
      'UNKNOWN_VARIANT'
    )
    // Uma variante sem preço nesta organização/moeda.
    const lonely = await must<any>(
      await ctx.http.post('/api/v1/products', {
        code: 'SEM-PRECO',
        name: 'Sem preço',
        type: 'GOODS',
        baseUnitId: ctx.unit.id,
      }),
      201
    )
    assert.equal(
      await codeOf({ variantId: lonely.variants[0].id, quantity: '1' }),
      'PRICE_NOT_FOUND'
    )
    // Uma categoria de imposto sem taxa válida.
    const odd = await must<any>(
      await ctx.http.post('/api/v1/products', {
        code: 'ODD',
        name: 'Categoria sem taxa',
        type: 'GOODS',
        baseUnitId: ctx.unit.id,
        taxCategory: 'XPTO',
      }),
      201
    )
    await must(
      await ctx.http.post(`/api/v1/price-lists/${ctx.list.id}/items`, {
        variantId: odd.variants[0].id,
        unitPrice: '10',
      }),
      201
    )
    assert.equal(await codeOf({ variantId: odd.variants[0].id, quantity: '1' }), 'NO_TAX_RATE')
    // Produto desactivado (a variante por omissão não se desactiva sozinha).
    await must(
      await ctx.http.patch(`/api/v1/products/${ctx.product.id}`, {
        expectedVersion: ctx.product.version,
        active: false,
      }),
      200
    )
    assert.equal(await codeOf(line(ctx, '1')), 'VARIANT_INACTIVE')
    // Nada ficou na proposta.
    const after = await must<any>(await ctx.http.get(`/api/v1/quotes/${quote.id}`), 200)
    assert.lengthOf(after.lines, 0)
    assert.deepEqual(after.totals, { net: '0.0000', tax: '0.0000', total: '0.0000' })
  })

  test('actualizar a quantidade reavalia o escalão e remover uma linha recalcula os totais', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const quote = await must<any>(await ctx.http.post('/api/v1/quotes', newQuote(ctx)), 201)
    const created = await must<any>(
      await ctx.http.post(`/api/v1/quotes/${quote.id}/lines`, line(ctx, '2')),
      201
    )
    const lineId = created.lines[0].id
    const moved = await must<any>(
      await ctx.http.patch(`/api/v1/quotes/${quote.id}/lines/${lineId}`, { quantity: '10' }),
      200
    )
    assert.equal(moved.lines[0].unitPrice, '1350.0000')
    assert.equal(moved.totals.net, '13500.0000')
    ;(
      await ctx.http.patch(`/api/v1/quotes/${quote.id}/lines/${lineId}`, {
        variantId: '33333333-3333-4333-8333-333333333333',
      })
    ).assertStatus(422)
    const removed = await must<any>(
      await ctx.http.delete(`/api/v1/quotes/${quote.id}/lines/${lineId}`),
      200
    )
    assert.lengthOf(removed.lines, 0)
    assert.equal(removed.totals.total, '0.0000')
    ;(await ctx.http.delete(`/api/v1/quotes/${quote.id}/lines/${lineId}`)).assertStatus(404)
  })

  test('o instantâneo não muda com o catálogo, e as linhas de um documento enviado são imutáveis (até por SQL)', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const quote = await must<any>(await ctx.http.post('/api/v1/quotes', newQuote(ctx)), 201)
    await must(await ctx.http.post(`/api/v1/quotes/${quote.id}/lines`, line(ctx, '2')), 201)
    const sent = await must<any>(await ctx.http.post(`/api/v1/quotes/${quote.id}/send`, {}), 200)
    assert.equal(sent.status, 'SENT')
    // Subir o preço depois não mexe na proposta.
    await must(await ctx.http.get(`/api/v1/price-lists/${ctx.list.id}`), 200)
    const items = (await ctx.http.get(`/api/v1/price-lists/${ctx.list.id}`)).body().data.items
    const base = items.find((i: any) => i.minQuantity === '1.000000')
    await must(
      await ctx.http.patch(`/api/v1/price-list-items/${base.id}`, {
        expectedVersion: base.version,
        unitPrice: '2000',
      }),
      200
    )
    const reread = await must<any>(await ctx.http.get(`/api/v1/quotes/${quote.id}`), 200)
    assert.equal(reread.lines[0].unitPrice, '1500.0000')
    assert.equal(reread.totals.total, '3420.0000')
    // Já não se altera pela API…
    const late = await ctx.http.post(`/api/v1/quotes/${quote.id}/lines`, line(ctx, '1'))
    late.assertStatus(409)
    assert.equal(late.body().error.code, 'QUOTE_NOT_DRAFT')
    ;(
      await ctx.http.patch(`/api/v1/quotes/${quote.id}/lines/${reread.lines[0].id}`, {
        quantity: '3',
      })
    ).assertStatus(409)
    ;(await ctx.http.delete(`/api/v1/quotes/${quote.id}/lines/${reread.lines[0].id}`)).assertStatus(
      409
    )
    ;(
      await ctx.http.patch(`/api/v1/quotes/${quote.id}`, { expectedVersion: reread.version })
    ).assertStatus(409)
    // … nem por SQL directo.
    const direct = await db
      .connection('owner')
      .transaction(async (trx) => {
        await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [ctx.tenant.id])
        await trx.rawQuery('update sales_lines set quantity = 99')
      })
      .catch((error: Error) => error)
    assert.instanceOf(direct, Error)
    assert.include((direct as Error).message, 'SALES_LINES_IMMUTABLE')
  })
})

test.group('propostas | ciclo de vida e conversão', (group) => {
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

  test('enviar exige linhas e sequência, atribui o número e congela a proposta', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const quote = await must<any>(await ctx.http.post('/api/v1/quotes', newQuote(ctx)), 201)
    const empty = await ctx.http.post(`/api/v1/quotes/${quote.id}/send`, {})
    empty.assertStatus(409)
    assert.equal(empty.body().error.code, 'QUOTE_EMPTY')
    await must(await ctx.http.post(`/api/v1/quotes/${quote.id}/lines`, line(ctx, '1')), 201)
    const sent = await must<any>(await ctx.http.post(`/api/v1/quotes/${quote.id}/send`, {}), 200)
    assert.match(sent.number, /^PRO A\/\d{4}\/\d+$/)
    const again = await ctx.http.post(`/api/v1/quotes/${quote.id}/send`, {})
    again.assertStatus(409)
    assert.equal(again.body().error.code, 'QUOTE_NOT_DRAFT')

    // Sem sequência configurada o envio falha por inteiro: a proposta continua rascunho.
    const bare = await setup(client, { sequences: false })
    const q2 = await must<any>(await bare.http.post('/api/v1/quotes', newQuote(bare)), 201)
    await must(await bare.http.post(`/api/v1/quotes/${q2.id}/lines`, line(bare, '1')), 201)
    const noSeq = await bare.http.post(`/api/v1/quotes/${q2.id}/send`, {})
    noSeq.assertStatus(409)
    assert.equal(noSeq.body().error.code, 'SEQUENCE_NOT_CONFIGURED')
    assert.equal(
      (await must<any>(await bare.http.get(`/api/v1/quotes/${q2.id}`), 200)).status,
      'DRAFT'
    )
  })

  test('aceitar converte numa encomenda com as linhas tal como propostas — e é idempotente', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const quote = await must<any>(await ctx.http.post('/api/v1/quotes', newQuote(ctx)), 201)
    await must(await ctx.http.post(`/api/v1/quotes/${quote.id}/lines`, line(ctx, '12')), 201)
    ;(await ctx.http.post(`/api/v1/quotes/${quote.id}/accept`, {})).assertStatus(409) // rascunho: ainda não foi enviada
    await must(await ctx.http.post(`/api/v1/quotes/${quote.id}/send`, {}), 200)
    // O preço sobe depois do envio: a encomenda honra o que foi proposto.
    const items = (await ctx.http.get(`/api/v1/price-lists/${ctx.list.id}`)).body().data.items
    const tier = items.find((i: any) => i.minQuantity === '10.000000')
    await must(
      await ctx.http.patch(`/api/v1/price-list-items/${tier.id}`, {
        expectedVersion: tier.version,
        unitPrice: '5000',
      }),
      200
    )
    const accepted = await must<any>(
      await ctx.http.post(`/api/v1/quotes/${quote.id}/accept`, {}),
      200
    )
    assert.isFalse(accepted.idempotent)
    assert.equal(accepted.quote.status, 'ACCEPTED')
    assert.deepInclude(accepted.order, { status: 'DRAFT', quoteId: quote.id, currency: 'AOA' })
    assert.equal(accepted.order.lines[0].unitPrice, '1350.0000')
    assert.deepEqual(accepted.order.totals, accepted.quote.totals)

    const again = await must<any>(await ctx.http.post(`/api/v1/quotes/${quote.id}/accept`, {}), 200)
    assert.isTrue(again.idempotent)
    assert.equal(again.order.id, accepted.order.id)
    const orders = await must<any[]>(await ctx.http.get('/api/v1/sales-orders'), 200)
    assert.lengthOf(orders, 1)
    assert.equal(await eventCount(ctx.tenant, 'sales.quote.accepted'), 1)
    // Uma proposta aceite já não se rejeita.
    ;(await ctx.http.post(`/api/v1/quotes/${quote.id}/reject`, {})).assertStatus(409)
  })

  test('uma proposta enviada que passou da validade é expirada e não se aceita; rejeitar fecha a proposta', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const make = async () => {
      const q = await must<any>(await ctx.http.post('/api/v1/quotes', newQuote(ctx)), 201)
      await must(await ctx.http.post(`/api/v1/quotes/${q.id}/lines`, line(ctx, '1')), 201)
      await must(await ctx.http.post(`/api/v1/quotes/${q.id}/send`, {}), 200)
      return q.id as string
    }
    const old = await make()
    await owner(
      `update sales_quotes set valid_until = current_date - 1 where id = '${old}'`,
      ctx.tenant
    )
    const reread = await must<any>(await ctx.http.get(`/api/v1/quotes/${old}`), 200)
    assert.equal(reread.status, 'EXPIRED')
    const refused = await ctx.http.post(`/api/v1/quotes/${old}/accept`, {})
    refused.assertStatus(409)
    assert.equal(refused.body().error.code, 'QUOTE_EXPIRED')
    ;(await ctx.http.post(`/api/v1/quotes/${old}/reject`, {})).assertStatus(409)
    const expired = await must<any[]>(await ctx.http.get('/api/v1/quotes?status=EXPIRED'), 200)
    assert.deepEqual(
      expired.map((q) => q.id),
      [old]
    )
    const live = await make()
    const sentList = await must<any[]>(await ctx.http.get('/api/v1/quotes?status=SENT'), 200)
    assert.deepEqual(
      sentList.map((q) => q.id),
      [live]
    )
    const rejected = await must<any>(await ctx.http.post(`/api/v1/quotes/${live}/reject`, {}), 200)
    assert.equal(rejected.status, 'REJECTED')
    ;(await ctx.http.post(`/api/v1/quotes/${live}/accept`, {})).assertStatus(409)
  })

  test('a validade passada, o cliente de outra organização e a moeda bloqueada são recusados', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const past = await ctx.http.post('/api/v1/quotes', newQuote(ctx, { validUntil: '2020-01-01' }))
    past.assertStatus(422)
    assert.equal(past.body().error.details[0].code, 'IN_THE_PAST')
    const org2 = await must<any>(
      await ctx.http.post('/api/v1/organizations', {
        code: 'EMP2',
        legalName: 'Outra, Lda.',
        countryCode: 'PT',
        baseCurrency: 'EUR',
      }),
      201
    )
    const wrongOrg = await ctx.http.post(
      '/api/v1/quotes',
      newQuote(ctx, { organizationId: org2.id })
    )
    wrongOrg.assertStatus(422)
    assert.equal(wrongOrg.body().error.details[0].code, 'CUSTOMER_ORGANIZATION')
    const stranger = await setup(client)
    const foreign = await ctx.http.post(
      '/api/v1/quotes',
      newQuote(ctx, { customerId: stranger.customer.id })
    )
    foreign.assertStatus(422)
    assert.equal(foreign.body().error.details[0].code, 'UNKNOWN_CUSTOMER')
    // Com linhas, a moeda não muda.
    const quote = await must<any>(await ctx.http.post('/api/v1/quotes', newQuote(ctx)), 201)
    await must(await ctx.http.post(`/api/v1/quotes/${quote.id}/lines`, line(ctx, '1')), 201)
    const current = await must<any>(await ctx.http.get(`/api/v1/quotes/${quote.id}`), 200)
    const locked = await ctx.http.patch(`/api/v1/quotes/${quote.id}`, {
      expectedVersion: current.version,
      currency: 'EUR',
    })
    locked.assertStatus(409)
    assert.equal(locked.body().error.code, 'CURRENCY_LOCKED')
    const moved = await ctx.http.patch(`/api/v1/quotes/${quote.id}`, {
      expectedVersion: current.version,
      customerId: ctx.customer.id,
    })
    moved.assertStatus(422)
  })
})

test.group('encomendas | confirmação e cancelamento', (group) => {
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

  const draft = async (ctx: Ctx, quantity = '3') => {
    const order = await must<any>(await ctx.http.post('/api/v1/sales-orders', newOrder(ctx)), 201)
    await must(
      await ctx.http.post(`/api/v1/sales-orders/${order.id}/lines`, line(ctx, quantity)),
      201
    )
    return order.id as string
  }

  test('uma encomenda directa leva morada de entrega em instantâneo, linhas e totais; só se altera em rascunho', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const created = await must<any>(
      await ctx.http.post(
        '/api/v1/sales-orders',
        newOrder(ctx, { deliveryAddress: { line1: 'Rua A, 1', city: 'Luanda', countryCode: 'AO' } })
      ),
      201
    )
    assert.deepInclude(created, { status: 'DRAFT', creditReservation: '0.0000', quoteId: null })
    assert.deepEqual(created.deliveryAddress, {
      line1: 'Rua A, 1',
      city: 'Luanda',
      countryCode: 'AO',
    })
    const withLine = await must<any>(
      await ctx.http.post(`/api/v1/sales-orders/${created.id}/lines`, line(ctx, '3')),
      201
    )
    assert.equal(withLine.totals.total, '5130.0000')
    const bad = await ctx.http.post(
      '/api/v1/sales-orders',
      newOrder(ctx, { deliveryAddress: { rua: 'x' } })
    )
    bad.assertStatus(422)
    const patched = await must<any>(
      await ctx.http.patch(`/api/v1/sales-orders/${created.id}`, {
        expectedVersion: withLine.version,
        deliveryAddress: { line1: 'Rua B, 2', city: 'Benguela' },
      }),
      200
    )
    assert.deepEqual(patched.deliveryAddress, { line1: 'Rua B, 2', city: 'Benguela' })
    ;(
      await ctx.http.patch(`/api/v1/sales-orders/${created.id}`, {
        expectedVersion: withLine.version,
        orderDate: '2026-01-01',
      })
    ).assertStatus(409) // versão desactualizada
  })

  test('confirmar emite o número e o evento uma só vez; confirmar duas vezes não duplica nada', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const id = await draft(ctx)
    const first = await must<any>(
      await ctx.http.post(`/api/v1/sales-orders/${id}/confirm`, {}),
      200
    )
    assert.isFalse(first.idempotent)
    assert.equal(first.order.status, 'CONFIRMED')
    assert.match(first.order.number, /^ENC A\/\d{4}\/\d+$/)
    assert.isNotNull(first.order.confirmedAt)
    assert.equal(first.order.creditReservation, '0.0000')
    const second = await must<any>(
      await ctx.http.post(`/api/v1/sales-orders/${id}/confirm`, {}),
      200
    )
    assert.isTrue(second.idempotent)
    assert.equal(second.order.number, first.order.number)
    assert.equal(await eventCount(ctx.tenant, 'sales.order.confirmed'), 1)
    // Confirmar não expede nem factura: o evento é só de compromisso.
    assert.equal(await eventCount(ctx.tenant, 'sales.shipment.posted'), 0)
    // Depois de confirmada, as linhas congelam.
    const late = await ctx.http.post(`/api/v1/sales-orders/${id}/lines`, line(ctx, '1'))
    late.assertStatus(409)
    assert.equal(late.body().error.code, 'ORDER_NOT_DRAFT')
    // Um segundo pedido consome o número seguinte (sem lacunas).
    const other = await draft(ctx, '1')
    const next = await must<any>(
      await ctx.http.post(`/api/v1/sales-orders/${other}/confirm`, {}),
      200
    )
    assert.notEqual(next.order.number, first.order.number)
  })

  test('confirmações concorrentes produzem um só efeito', async ({ client, assert }) => {
    const ctx = await setup(client)
    const id = await draft(ctx)
    const results = await Promise.all(
      Array.from({ length: 6 }, () => ctx.http.post(`/api/v1/sales-orders/${id}/confirm`, {}))
    )
    for (const response of results) response.assertStatus(200)
    const fresh = results.filter((r) => r.body().data.idempotent === false)
    assert.lengthOf(fresh, 1)
    assert.equal(await eventCount(ctx.tenant, 'sales.order.confirmed'), 1)
    const numbers = new Set(results.map((r) => r.body().data.order.number))
    assert.equal(numbers.size, 1)
  })

  test('sem linhas, com cliente bloqueado ou com uma verificação a recusar, a encomenda não se confirma e nada muda', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const empty = await must<any>(await ctx.http.post('/api/v1/sales-orders', newOrder(ctx)), 201)
    const none = await ctx.http.post(`/api/v1/sales-orders/${empty.id}/confirm`, {})
    none.assertStatus(409)
    assert.equal(none.body().error.code, 'ORDER_EMPTY')

    const id = await draft(ctx)
    // Cliente bloqueado: recusa a confirmação (mas o rascunho existe).
    const customer = await must<any>(
      await ctx.http.get(`/api/v1/customers/${ctx.customer.id}`),
      200
    )
    await must(
      await ctx.http.post(`/api/v1/customers/${ctx.customer.id}/block`, {
        expectedVersion: customer.version,
        reason: 'Dívida',
      }),
      200
    )
    const blocked = await ctx.http.post(`/api/v1/sales-orders/${id}/confirm`, {})
    blocked.assertStatus(409)
    assert.equal(blocked.body().error.code, 'CUSTOMER_BLOCKED')
    const unblock = await must<any>(await ctx.http.get(`/api/v1/customers/${ctx.customer.id}`), 200)
    await must(
      await ctx.http.post(`/api/v1/customers/${ctx.customer.id}/unblock`, {
        expectedVersion: unblock.version,
      }),
      200
    )

    // Uma verificação registada (o stock, mais tarde) pode recusar com o motivo; nada fica confirmado nem numerado.
    const unregister = registerConfirmationCheck(async () => [
      { path: 'lines[0]', code: 'INSUFFICIENT_STOCK', message: 'Stock insuficiente.' },
    ])
    try {
      const refused = await ctx.http.post(`/api/v1/sales-orders/${id}/confirm`, {})
      refused.assertStatus(409)
      assert.equal(refused.body().error.code, 'ORDER_NOT_CONFIRMABLE')
      assert.equal(refused.body().error.details[0].code, 'INSUFFICIENT_STOCK')
    } finally {
      unregister()
    }
    const still = await must<any>(await ctx.http.get(`/api/v1/sales-orders/${id}`), 200)
    assert.equal(still.status, 'DRAFT')
    assert.isNull(still.number)
    assert.equal(await eventCount(ctx.tenant, 'sales.order.confirmed'), 0)
    // Retirada a verificação, confirma.
    const ok = await must<any>(await ctx.http.post(`/api/v1/sales-orders/${id}/confirm`, {}), 200)
    assert.equal(ok.order.status, 'CONFIRMED')
  })

  test('cancelar exige motivo, é idempotente e emite o evento uma vez; uma encomenda cancelada não se confirma', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const a = await draft(ctx)
    ;(await ctx.http.post(`/api/v1/sales-orders/${a}/cancel`, { reason: '  ' })).assertStatus(422)
    const cancelled = await must<any>(
      await ctx.http.post(`/api/v1/sales-orders/${a}/cancel`, { reason: 'Desistência' }),
      200
    )
    assert.equal(cancelled.order.status, 'CANCELLED')
    assert.equal(cancelled.order.cancelReason, 'Desistência')
    const refused = await ctx.http.post(`/api/v1/sales-orders/${a}/confirm`, {})
    refused.assertStatus(409)
    assert.equal(refused.body().error.code, 'ORDER_CANCELLED')

    const b = await draft(ctx)
    await must(await ctx.http.post(`/api/v1/sales-orders/${b}/confirm`, {}), 200)
    const first = await must<any>(
      await ctx.http.post(`/api/v1/sales-orders/${b}/cancel`, { reason: 'Cliente desistiu' }),
      200
    )
    assert.isFalse(first.idempotent)
    const again = await must<any>(
      await ctx.http.post(`/api/v1/sales-orders/${b}/cancel`, { reason: 'Outra vez' }),
      200
    )
    assert.isTrue(again.idempotent)
    assert.equal(again.order.cancelReason, 'Cliente desistiu')
    assert.equal(await eventCount(ctx.tenant, 'sales.order.cancelled'), 2)
    const events = await owner<{ payload: any }>(
      "select payload from outbox_events where event_type = 'sales.order.cancelled' order by created_at",
      ctx.tenant
    )
    assert.deepEqual(
      events.map((e) => e.payload.wasConfirmed),
      [false, true]
    )

    // Uma encomenda já expedida (parcial) não se cancela.
    const c = await draft(ctx)
    await must(await ctx.http.post(`/api/v1/sales-orders/${c}/confirm`, {}), 200)
    await owner(`update sales_orders set status = 'PARTIAL' where id = '${c}'`, ctx.tenant)
    const shipped = await ctx.http.post(`/api/v1/sales-orders/${c}/cancel`, {
      reason: 'Tarde demais',
    })
    shipped.assertStatus(409)
    assert.equal(shipped.body().error.code, 'ORDER_NOT_CANCELLABLE')
  })
})

test.group('propostas e encomendas | autorização e isolamento', (group) => {
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

  test('cada operação tem a sua permissão; aceitar exige também gerir encomendas; sem o módulo a API recusa', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const quote = await must<any>(await ctx.http.post('/api/v1/quotes', newQuote(ctx)), 201)
    await must(await ctx.http.post(`/api/v1/quotes/${quote.id}/lines`, line(ctx, '1')), 201)
    await must(await ctx.http.post(`/api/v1/quotes/${quote.id}/send`, {}), 200)
    const order = await must<any>(await ctx.http.post('/api/v1/sales-orders', newOrder(ctx)), 201)
    await must(await ctx.http.post(`/api/v1/sales-orders/${order.id}/lines`, line(ctx, '1')), 201)

    const reader = await memberWith(ctx, ['quote.read', 'order.read'])
    await must(await reader.get('/api/v1/quotes'), 200)
    await must(await reader.get('/api/v1/sales-orders'), 200)
    ;(await reader.post('/api/v1/quotes', newQuote(ctx))).assertStatus(403)
    ;(await reader.post('/api/v1/sales-orders', newOrder(ctx))).assertStatus(403)
    ;(await reader.post(`/api/v1/sales-orders/${order.id}/confirm`, {})).assertStatus(403)

    const manager = await memberWith(ctx, ['quote.manage', 'order.manage'])
    ;(await manager.get('/api/v1/quotes')).assertStatus(403)
    ;(await manager.post(`/api/v1/sales-orders/${order.id}/confirm`, {})).assertStatus(403)
    ;(await manager.post(`/api/v1/sales-orders/${order.id}/cancel`, { reason: 'x' })).assertStatus(
      403
    )

    const quoter = await memberWith(ctx, ['quote.manage'])
    const noOrders = await quoter.post(`/api/v1/quotes/${quote.id}/accept`, {})
    noOrders.assertStatus(403) // a conversão escreve em encomendas
    assert.equal(
      (await must<any>(await ctx.http.get(`/api/v1/quotes/${quote.id}`), 200)).status,
      'SENT'
    )

    const confirmer = await memberWith(ctx, ['sales.confirm'])
    await must(await confirmer.post(`/api/v1/sales-orders/${order.id}/confirm`, {}), 200)

    const off = await setup(client)
    await must(await off.http.post('/api/v1/tenant/modules/orders/disable', {}), 200)
    const response = await off.http.get('/api/v1/quotes')
    response.assertStatus(403)
    assert.equal(response.body().error.code, 'FEATURE_NOT_AVAILABLE')
    ;(await off.http.get('/api/v1/sales-orders')).assertStatus(403)
  })

  test('as alterações ficam na auditoria e as tabelas cumprem o isolamento entre tenants', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const id = await (async () => {
      const order = await must<any>(await ctx.http.post('/api/v1/sales-orders', newOrder(ctx)), 201)
      await must(await ctx.http.post(`/api/v1/sales-orders/${order.id}/lines`, line(ctx, '1')), 201)
      await must(await ctx.http.post(`/api/v1/sales-orders/${order.id}/confirm`, {}), 200)
      return order.id as string
    })()
    const logs = await must<any[]>(
      await ctx.http.get(`/api/v1/audit-logs?resourceType=sales_orders&resourceId=${id}`),
      200
    )
    assert.isAbove(logs.length, 1)
    const other = await setup(client)
    ;(await other.http.get(`/api/v1/sales-orders/${id}`)).assertStatus(404)
    ;(await other.http.post(`/api/v1/sales-orders/${id}/confirm`, {})).assertStatus(404)
    ;(await other.http.post(`/api/v1/sales-orders/${id}/cancel`, { reason: 'x' })).assertStatus(404)
    assert.lengthOf(await owner('select 1 from sales_orders', other.tenant), 0)
    assert.lengthOf(await owner('select 1 from sales_orders', ctx.tenant), 1)
    assert.lengthOf(await owner('select 1 from sales_lines', other.tenant), 0)
  })
})
