import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { iamServices } from '#core/permissions/index'
import { serviceTenantContext } from '#core/tenancy/index'
import { registerMovementGuard } from '#modules/catalog/index'
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

/** Tenant com o módulo `catalog` licenciado e activo, uma organização e duas unidades. */
async function setup(client: any, enable = true) {
  const tenant = await createActiveTenant()
  const admin = await newActor(client, tenant, true)
  const http = api(client, tenant, admin)
  await syncTestRegistry()
  await license(tenant, ['catalog'])
  if (enable) await must(await http.post('/api/v1/tenant/modules/catalog/enable', {}), 200)
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
      name: 'Quilograma',
      dimension: 'MASS',
      precision: 3,
    }),
    201
  )
  return { tenant, admin, http, org, unit, kg, client }
}

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

const product = (unitId: string, extra: Record<string, unknown> = {}) => ({
  code: 'CAM-001',
  name: 'Camisola',
  type: 'GOODS',
  baseUnitId: unitId,
  ...extra,
})

const rowsOf = (tenant: Tenant, sql: string) =>
  db.connection('owner').transaction(async (trx) => {
    await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [tenant.id])
    return (await trx.rawQuery(sql)).rows as any[]
  })

test.group('catálogo | produtos e variantes', (group) => {
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

  test('um produto simples recebe a variante por omissão; o SKU e o código de barras são únicos', async ({
    client,
    assert,
  }) => {
    const { http, unit } = await setup(client)
    const created = await must<any>(
      await http.post('/api/v1/products', product(unit.id, { barcode: '5601234567890' })),
      201
    )
    assert.deepInclude(created, {
      code: 'CAM-001',
      trackStock: true,
      trackingMode: 'NONE',
      active: true,
    })
    assert.lengthOf(created.variants, 1)
    assert.deepInclude(created.variants[0], {
      sku: 'CAM-001',
      isDefault: true,
      barcode: '5601234567890',
    })

    // SKU duplicado falha, tal como o código do produto e o código de barras.
    const dupSku = await http.post(
      '/api/v1/products',
      product(unit.id, { code: 'OUTRO', sku: 'CAM-001' })
    )
    dupSku.assertStatus(409)
    assert.equal(dupSku.body().error.code, 'SKU_TAKEN')
    const dupCode = await http.post('/api/v1/products', product(unit.id, { sku: 'X-1' }))
    dupCode.assertStatus(409)
    assert.equal(dupCode.body().error.code, 'PRODUCT_CODE_TAKEN')
    const dupBarcode = await http.post(
      '/api/v1/products',
      product(unit.id, { code: 'OUTRO', barcode: '5601234567890' })
    )
    dupBarcode.assertStatus(409)
    assert.equal(dupBarcode.body().error.code, 'BARCODE_TAKEN')
    // A falha desfez tudo: não ficou nenhum produto «OUTRO».
    const all = await must<any[]>(await http.get('/api/v1/products'), 200)
    assert.deepEqual(
      all.map((p) => p.code),
      ['CAM-001']
    )

    // Mais variantes, com atributos; o SKU nunca se repete nem muda.
    const medium = await must<any>(
      await http.post(`/api/v1/products/${created.id}/variants`, {
        sku: 'CAM-001/M',
        attributes: { tamanho: 'M', cor: 'azul' },
      }),
      201
    )
    assert.isFalse(medium.isDefault)
    ;(
      await http.post(`/api/v1/products/${created.id}/variants`, { sku: 'CAM-001/M' })
    ).assertStatus(409)
    const renamed = await http.patch(`/api/v1/variants/${medium.id}`, {
      expectedVersion: medium.version,
      sku: 'OUTRO-SKU',
    })
    renamed.assertStatus(422)
    assert.equal(renamed.body().error.details[0].code, 'SKU_IMMUTABLE')
    const updated = await must<any>(
      await http.patch(`/api/v1/variants/${medium.id}`, {
        expectedVersion: medium.version,
        barcode: '5601234567891',
        active: false,
      }),
      200
    )
    assert.deepInclude(updated, { barcode: '5601234567891', active: false })
    ;(
      await http.patch(`/api/v1/variants/${medium.id}`, {
        expectedVersion: medium.version,
        active: true,
      })
    ).assertStatus(409)
    // A variante por omissão não se desactiva.
    const off = await http.patch(`/api/v1/variants/${created.variants[0].id}`, {
      expectedVersion: created.variants[0].version,
      active: false,
    })
    off.assertStatus(409)
    assert.equal(off.body().error.code, 'DEFAULT_VARIANT_ACTIVE')

    const detail = await must<any>(await http.get(`/api/v1/products/${created.id}`), 200)
    assert.deepEqual(
      detail.variants.map((v: any) => v.sku),
      ['CAM-001', 'CAM-001/M']
    )
    const byBarcode = await must<any[]>(await http.get('/api/v1/products?q=5601234567891'), 200)
    assert.deepEqual(
      byBarcode.map((p) => p.code),
      ['CAM-001'],
      'pesquisa também por SKU e código de barras'
    )
  })

  test('um serviço não controla stock; lotes e séries exigem controlar stock; a unidade tem de existir', async ({
    client,
    assert,
  }) => {
    const { http, unit, tenant } = await setup(client)
    const service = await must<any>(
      await http.post('/api/v1/products', product(unit.id, { code: 'SRV-1', type: 'SERVICE' })),
      201
    )
    assert.deepInclude(service, { type: 'SERVICE', trackStock: false, trackingMode: 'NONE' })
    const noStock = await http.post(
      '/api/v1/products',
      product(unit.id, { code: 'SRV-2', type: 'SERVICE', trackStock: true })
    )
    noStock.assertStatus(422)
    assert.equal(noStock.body().error.details[0].code, 'SERVICE_NO_STOCK')
    const lots = await http.post(
      '/api/v1/products',
      product(unit.id, { code: 'G-1', trackStock: false, trackingMode: 'LOT' })
    )
    lots.assertStatus(422)
    // Nem por SQL directo se contorna a regra do serviço.
    const direct = await db
      .connection('owner')
      .transaction(async (trx) => {
        await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [tenant.id])
        await trx.rawQuery("update products set track_stock = true where code = 'SRV-1'")
      })
      .catch((error: Error) => error)
    assert.instanceOf(direct, Error)

    const unknownUnit = await http.post(
      '/api/v1/products',
      product('99999999-9999-4999-8999-999999999999', { code: 'U-1' })
    )
    unknownUnit.assertStatus(422)
    assert.equal(unknownUnit.body().error.details[0].code, 'UNKNOWN_UNIT')
    const unknownCategory = await http.post(
      '/api/v1/products',
      product(unit.id, { code: 'C-1', categoryId: '99999999-9999-4999-8999-999999999999' })
    )
    unknownCategory.assertStatus(422)
    assert.equal(unknownCategory.body().error.details[0].code, 'UNKNOWN_CATEGORY')
  })

  test('mudar a unidade base ou o rastreio com movimentos exige migração; o código não muda', async ({
    client,
    assert,
  }) => {
    const { http, unit, kg } = await setup(client)
    const created = await must<any>(await http.post('/api/v1/products', product(unit.id)), 201)
    // Sem movimentos (o inventário ainda não existe) a unidade e o rastreio podem mudar.
    const lots = await must<any>(
      await http.patch(`/api/v1/products/${created.id}`, {
        expectedVersion: created.version,
        trackingMode: 'LOT',
      }),
      200
    )
    assert.equal(lots.trackingMode, 'LOT')

    // O inventário regista como saber se há movimentos; com movimentos, a edição simples é recusada.
    registerMovementGuard(async () => true)
    const blocked = await http.patch(`/api/v1/products/${created.id}`, {
      expectedVersion: lots.version,
      baseUnitId: kg.id,
    })
    blocked.assertStatus(409)
    assert.equal(blocked.body().error.code, 'STOCK_MIGRATION_REQUIRED')
    const track = await http.patch(`/api/v1/products/${created.id}`, {
      expectedVersion: lots.version,
      trackingMode: 'SERIAL',
    })
    track.assertStatus(409)
    // Uma edição que não toca na identidade de stock continua a ser possível.
    const renamed = await must<any>(
      await http.patch(`/api/v1/products/${created.id}`, {
        expectedVersion: lots.version,
        name: 'Camisola de algodão',
      }),
      200
    )
    assert.equal(renamed.name, 'Camisola de algodão')
    const code = await http.patch(`/api/v1/products/${created.id}`, {
      expectedVersion: renamed.version,
      code: 'NOVO',
    })
    code.assertStatus(422)
    assert.equal(code.body().error.details[0].code, 'CODE_IMMUTABLE')
    ;(
      await http.patch(`/api/v1/products/${created.id}`, { expectedVersion: 1, name: 'x' })
    ).assertStatus(409)
  })

  test('categorias em árvore, sem ciclos; filtros de produtos', async ({ client, assert }) => {
    const { http, unit } = await setup(client)
    const roupa = await must<any>(
      await http.post('/api/v1/product-categories', { code: 'ROUPA', name: 'Roupa' }),
      201
    )
    const camisolas = await must<any>(
      await http.post('/api/v1/product-categories', {
        code: 'CAMISOLAS',
        name: 'Camisolas',
        parentId: roupa.id,
      }),
      201
    )
    ;(await http.post('/api/v1/product-categories', { code: 'ROUPA', name: 'Outra' })).assertStatus(
      409
    )
    const cycle = await http.patch(`/api/v1/product-categories/${roupa.id}`, {
      expectedVersion: roupa.version,
      parentId: camisolas.id,
    })
    cycle.assertStatus(409)
    assert.equal(cycle.body().error.code, 'CATEGORY_CYCLE')

    await must(
      await http.post('/api/v1/products', product(unit.id, { categoryId: camisolas.id })),
      201
    )
    await must(
      await http.post(
        '/api/v1/products',
        product(unit.id, { code: 'SRV-1', name: 'Entrega', type: 'SERVICE' })
      ),
      201
    )
    const goods = await http.get('/api/v1/products?type=GOODS')
    assert.deepEqual(
      goods.body().data.map((p: any) => p.code),
      ['CAM-001']
    )
    assert.equal(goods.body().meta.total, 1)
    const inCategory = await must<any[]>(
      await http.get(`/api/v1/products?categoryId=${camisolas.id}`),
      200
    )
    assert.lengthOf(inCategory, 1)
    const page = await http.get('/api/v1/products?limit=1&offset=1')
    assert.lengthOf(page.body().data, 1)
    assert.equal(page.body().meta.total, 2)
    const first = await must<any>(await http.get('/api/v1/products?q=entrega'), 200)
    assert.deepEqual(
      first.map((p: any) => p.code),
      ['SRV-1']
    )
  })
})

test.group('catálogo | tabelas de preços', (group) => {
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

  const list = (org: string, extra: Record<string, unknown> = {}) => ({
    organizationId: org,
    name: 'Retalho',
    currency: 'AOA',
    validFrom: '2026-01-01',
    priority: 0,
    ...extra,
  })

  async function withVariant(client: any) {
    const ctx = await setup(client)
    const created = await must<any>(
      await ctx.http.post('/api/v1/products', product(ctx.unit.id)),
      201
    )
    return { ...ctx, variant: created.variants[0] }
  }
  const resolve = (http: Http, q: Record<string, string>) =>
    http.get(`/api/v1/prices/resolve?${new URLSearchParams(q).toString()}`)

  test('a resolução escolhe o escalão, a validade e a prioridade; decimais em texto', async ({
    client,
    assert,
  }) => {
    const { http, org, variant } = await withVariant(client)
    const retail = await must<any>(await http.post('/api/v1/price-lists', list(org.id)), 201)
    for (const [minQuantity, unitPrice] of [
      ['1', '100.00'],
      ['10', '90.5'],
      ['100', '80'],
    ]) {
      await must(
        await http.post(`/api/v1/price-lists/${retail.id}/items`, {
          variantId: variant.id,
          minQuantity,
          unitPrice,
          maxDiscount: '0.1',
        }),
        201
      )
    }
    const base = {
      variantId: variant.id,
      organizationId: org.id,
      currency: 'AOA',
      date: '2026-06-01',
    }
    const at = async (quantity: string) =>
      must<any>(await resolve(http, { ...base, quantity }), 200)
    assert.deepInclude(await at('1'), {
      unitPrice: '100.0000',
      minQuantity: '1.000000',
      priceListName: 'Retalho',
    })
    assert.equal((await at('9.999999')).unitPrice, '100.0000')
    assert.equal((await at('10')).unitPrice, '90.5000')
    assert.equal((await at('250')).unitPrice, '80.0000')
    const found = await at('10')
    assert.deepInclude(found, {
      maxDiscount: '0.1000',
      taxInclusive: false,
      currency: 'AOA',
      sku: 'CAM-001',
    })

    // Fora da validade ou noutra moeda não há preço.
    const before = await resolve(http, { ...base, quantity: '1', date: '2025-12-31' })
    before.assertStatus(404)
    assert.equal(before.body().error.code, 'PRICE_NOT_FOUND')
    ;(await resolve(http, { ...base, quantity: '1', currency: 'EUR' })).assertStatus(404)
    // Quantidades e datas inválidas.
    ;(await resolve(http, { ...base, quantity: '0' })).assertStatus(422)
    ;(await resolve(http, { ...base, quantity: '1,5' })).assertStatus(422)
    ;(await resolve(http, { ...base, quantity: '1', date: '2026-13-01' })).assertStatus(422)

    // Uma tabela de maior prioridade passa à frente; o fim da validade devolve a anterior.
    const promo = await must<any>(
      await http.post(
        '/api/v1/price-lists',
        list(org.id, {
          name: 'Promoção',
          priority: 10,
          validFrom: '2026-06-01',
          validTo: '2026-06-30',
        })
      ),
      201
    )
    await must(
      await http.post(`/api/v1/price-lists/${promo.id}/items`, {
        variantId: variant.id,
        unitPrice: '70.00',
      }),
      201
    )
    assert.deepInclude(await at('1'), { unitPrice: '70.0000', priceListName: 'Promoção' })
    const after = await must<any>(
      await resolve(http, { ...base, quantity: '1', date: '2026-07-01' }),
      200
    )
    assert.equal(after.priceListName, 'Retalho')
  })

  test('duas tabelas aplicáveis com a mesma prioridade são um empate ambíguo', async ({
    client,
    assert,
  }) => {
    const { http, org, variant } = await withVariant(client)
    for (const name of ['A', 'B']) {
      const l = await must<any>(
        await http.post('/api/v1/price-lists', list(org.id, { name, priority: 5 })),
        201
      )
      await must(
        await http.post(`/api/v1/price-lists/${l.id}/items`, {
          variantId: variant.id,
          unitPrice: '10.00',
        }),
        201
      )
    }
    const tie = await resolve(http, {
      variantId: variant.id,
      organizationId: org.id,
      currency: 'AOA',
      quantity: '1',
      date: '2026-06-01',
    })
    tie.assertStatus(409)
    assert.equal(tie.body().error.code, 'PRICE_AMBIGUOUS')
    assert.sameMembers(
      tie.body().error.details.map((d: any) => d.message),
      ['A', 'B']
    )
  })

  test('a linha conserva o preço anterior: a resolução devolve a origem e a tabela editada não a altera', async ({
    client,
    assert,
  }) => {
    const { http, org, variant } = await withVariant(client)
    const l = await must<any>(await http.post('/api/v1/price-lists', list(org.id)), 201)
    const item = await must<any>(
      await http.post(`/api/v1/price-lists/${l.id}/items`, {
        variantId: variant.id,
        unitPrice: '100.00',
      }),
      201
    )
    const q = {
      variantId: variant.id,
      organizationId: org.id,
      currency: 'AOA',
      quantity: '1',
      date: '2026-06-01',
    }
    const snapshot = await must<any>(await resolve(http, q), 200)
    // O documento que usar este preço guarda `snapshot` (valor + origem); editar a tabela depois…
    await must(
      await http.patch(`/api/v1/price-list-items/${item.id}`, {
        expectedVersion: item.version,
        unitPrice: '120.00',
      }),
      200
    )
    const now = await must<any>(await resolve(http, q), 200)
    assert.equal(snapshot.unitPrice, '100.0000')
    assert.equal(now.unitPrice, '120.0000', '…só afecta resoluções futuras')
    assert.equal(snapshot.priceListId, now.priceListId, 'a origem identifica a tabela')
    // Escalão repetido e preços inválidos.
    const tier = await http.post(`/api/v1/price-lists/${l.id}/items`, {
      variantId: variant.id,
      unitPrice: '1.00',
    })
    tier.assertStatus(409)
    assert.equal(tier.body().error.code, 'PRICE_TIER_EXISTS')
    for (const bad of [
      { unitPrice: '-1' },
      { unitPrice: '1e3' },
      { maxDiscount: '1.5' },
      { minQuantity: '0' },
    ]) {
      ;(
        await http.post(`/api/v1/price-lists/${l.id}/items`, {
          variantId: variant.id,
          minQuantity: '5',
          unitPrice: '1.00',
          ...bad,
        })
      ).assertStatus(422)
    }
    ;(await http.delete(`/api/v1/price-list-items/${item.id}`)).assertStatus(204)
    ;(await http.delete(`/api/v1/price-list-items/${item.id}`)).assertStatus(404)
    ;(await resolve(http, q)).assertStatus(404)
  })

  test('uma variante ou produto desactivado não tem preço; validações da tabela', async ({
    client,
    assert,
  }) => {
    const { http, org, variant } = await withVariant(client)
    const l = await must<any>(await http.post('/api/v1/price-lists', list(org.id)), 201)
    await must(
      await http.post(`/api/v1/price-lists/${l.id}/items`, {
        variantId: variant.id,
        unitPrice: '5.00',
      }),
      201
    )
    const q = {
      variantId: variant.id,
      organizationId: org.id,
      currency: 'AOA',
      quantity: '1',
      date: '2026-06-01',
    }
    await must(await resolve(http, q), 200)
    const detail = await must<any>(await http.get(`/api/v1/variants/${variant.id}`), 200)
    await must(
      await http.patch(`/api/v1/products/${detail.product.id}`, {
        expectedVersion: detail.product.version,
        active: false,
      }),
      200
    )
    const off = await resolve(http, q)
    off.assertStatus(409)
    assert.equal(off.body().error.code, 'VARIANT_INACTIVE')

    ;(await http.post('/api/v1/price-lists', list(org.id))).assertStatus(409)
    ;(
      await http.post(
        '/api/v1/price-lists',
        list('99999999-9999-4999-8999-999999999999', { name: 'X' })
      )
    ).assertStatus(422)
    ;(
      await http.post('/api/v1/price-lists', list(org.id, { name: 'Y', validTo: '2025-01-01' }))
    ).assertStatus(422)
    const currency = await http.patch(`/api/v1/price-lists/${l.id}`, {
      expectedVersion: l.version,
      currency: 'EUR',
    })
    currency.assertStatus(422)
    assert.equal(currency.body().error.details[0].code, 'CURRENCY_IMMUTABLE')
    const edited = await must<any>(
      await http.patch(`/api/v1/price-lists/${l.id}`, {
        expectedVersion: l.version,
        taxInclusive: true,
        priority: 3,
      }),
      200
    )
    assert.deepInclude(edited, { taxInclusive: true, priority: 3 })
    const full = await must<any>(await http.get(`/api/v1/price-lists/${l.id}`), 200)
    assert.lengthOf(full.items, 1)
    assert.equal(full.items[0].sku, 'CAM-001')
  })
})

test.group('catálogo | módulo, permissões e auditoria', (group) => {
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

  test('sem o módulo activo, a API recusa mesmo a quem tem as permissões', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client, false)
    const response = await http.get('/api/v1/products')
    response.assertStatus(403)
    assert.equal(response.body().error.code, 'FEATURE_NOT_AVAILABLE')
    ;(await http.get('/api/v1/price-lists')).assertStatus(403)
    ;(await http.get('/api/v1/prices/resolve')).assertStatus(403)
  })

  test('ler e gerir catálogo e preços são permissões distintas', async ({ client, assert }) => {
    const ctx = await setup(client)
    const created = await must<any>(
      await ctx.http.post('/api/v1/products', product(ctx.unit.id)),
      201
    )
    const reader = await memberWith(ctx, ['catalog.read'])
    await must(await reader.get('/api/v1/products'), 200)
    ;(await reader.post('/api/v1/products', product(ctx.unit.id, { code: 'X-1' }))).assertStatus(
      403
    )
    ;(
      await reader.patch(`/api/v1/products/${created.id}`, { expectedVersion: 1, name: 'x' })
    ).assertStatus(403)
    ;(await reader.get('/api/v1/price-lists')).assertStatus(403)

    const pricer = await memberWith(ctx, ['price.read'])
    await must(await pricer.get('/api/v1/price-lists'), 200)
    ;(await pricer.post('/api/v1/price-lists', { organizationId: ctx.org.id })).assertStatus(403)
    ;(await pricer.get('/api/v1/products')).assertStatus(403)
    const nobody = await memberWith(ctx, ['party.read'])
    ;(await nobody.get('/api/v1/products')).assertStatus(403)
    ;(await nobody.get(`/api/v1/products/${created.id}`)).assertStatus(403)
    assert.isNotNull(created.id)
  })

  test('as alterações ficam na auditoria e as tabelas do catálogo cumprem o isolamento', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const created = await must<any>(
      await ctx.http.post('/api/v1/products', product(ctx.unit.id)),
      201
    )
    await must(
      await ctx.http.patch(`/api/v1/products/${created.id}`, {
        expectedVersion: created.version,
        name: 'Outro nome',
      }),
      200
    )
    const logs = await must<any[]>(
      await ctx.http.get(`/api/v1/audit-logs?resourceType=products&resourceId=${created.id}`),
      200
    )
    assert.isAbove(logs.length, 1)
    assert.include(JSON.stringify(logs), 'Outro nome')

    // Outro tenant não vê nada e nem referencia dados deste.
    const other = await setup(client)
    ;(await other.http.get(`/api/v1/products/${created.id}`)).assertStatus(404)
    const otherUnit = other.unit.id
    const cross = await rowsOf(ctx.tenant, 'select 1 from products')
    assert.lengthOf(cross, 1)
    const refused = await ctx.http.post('/api/v1/products', product(otherUnit, { code: 'CROSS' }))
    refused.assertStatus(422)
    assert.equal(refused.body().error.details[0].code, 'UNKNOWN_UNIT')
    void serviceTenantContext
  })
})
