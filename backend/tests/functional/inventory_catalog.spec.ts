import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import {
  as,
  cleanDatabase,
  createRole,
  memberWithRoles,
  signIn,
  tenantWithAdmin,
  type Session,
} from '#tests/support/fixtures'

const I = '/api/v1/inventory'
const S = `${I}/settings`
const owner = () => db.connection('owner')
const ok = (r: any, status = 201) => {
  if (r.status() !== status) throw new Error(`${r.status()} ${JSON.stringify(r.body())}`)
  return r.body().data
}
const code = (r: any) => r.body().error?.code
const details = (r: any) => (r.body().error?.details ?? []).map((d: any) => d.code)

async function roleMember(client: any, admin: Session, roleCode: string, permissions: string[]) {
  const m = await memberWithRoles(client, admin, [])
  const role = await createRole(client, admin, roleCode, permissions)
  ok(
    await as(client, admin).post(`/api/v1/members/${m.memberId}/roles`, {
      roleId: role.id,
      scopeType: 'TENANT',
    }),
    200
  )
  return as(client, m.session)
}

async function setup(client: any) {
  const { tenant, admin } = await tenantWithAdmin()
  const s = await signIn(client, admin.email, tenant.id)
  const api = as(client, s)
  const uom = async (c: string, category: string, decimals: number) =>
    ok(await api.post(`${S}/uoms`, { code: c, name: `Unidade ${c}`, category, decimals }))
  const un = await uom('UN', 'UNIT', 0)
  const cx = await uom('CX', 'UNIT', 0)
  const kg = await uom('KG', 'WEIGHT', 3)
  const hr = await uom('H', 'TIME', 2)
  const root = ok(
    await api.post(`${S}/categories`, {
      code: 'MERC',
      name: 'Mercadorias',
      accountingClass: 'mercadorias',
    })
  )
  const bev = ok(
    await api.post(`${S}/categories`, { code: 'BEB', name: 'Bebidas', parentId: root.id })
  )
  const brand = ok(await api.post(`${S}/brands`, { code: 'ACME', name: 'Acme' }))
  return { tenant, admin, s, api, un, cx, kg, hr, root, bev, brand }
}

test.group('Inventário | catálogo de produtos e serviços (8.1)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('configuração: unidades, categorias em hierarquia com classe contabilística, marcas', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    assert.equal(o.root.accountingClass, 'MERCADORIAS')
    assert.equal(
      code(await o.api.post(`${S}/uoms`, { code: 'un', name: 'x', category: 'UNIT' })),
      'CODE_TAKEN'
    )
    assert.includeMembers(
      details(
        await o.api.post(`${S}/uoms`, { code: 'L', name: 'Litro', category: 'LIQ', decimals: 9 })
      ),
      ['INVALID']
    )
    assert.include(
      details(
        await o.api.patch(`${S}/categories/${o.root.id}`, {
          parentId: o.bev.id,
          expectedVersion: o.root.version,
        })
      ),
      'CYCLE'
    )
    assert.include(
      details(
        await o.api.post(`${S}/categories`, { code: 'X', name: 'X', accountingClass: '1-bad' })
      ),
      'INVALID'
    )
    const list = ok(await o.api.get(`${S}/categories`), 200)
    assert.lengthOf(list, 2)
    assert.equal((await o.api.get(`${S}/coisas`)).status(), 404)
  })

  test('produto armazenável: SKU e EAN únicos, conversões, unidades de compra/venda, preço e classe herdada', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const P = (b: Record<string, unknown>) => o.api.post(`${I}/products`, b)
    const good = {
      sku: 'agua-05',
      barcode: '4006381333931',
      name: 'Água 0,5 L',
      productType: 'STOCKABLE',
      categoryId: o.bev.id,
      brandId: o.brand.id,
      baseUomId: o.un.id,
      purchaseUomId: o.cx.id,
      saleUomId: o.un.id,
      conversions: [{ uomId: o.cx.id, factor: '24' }],
      trackLots: true,
      trackExpiry: true,
      shelfLifeDays: 365,
      minStock: '48',
      maxStock: '480',
      salePrice: '150.5',
      currency: 'aoa',
    }
    assert.includeMembers(
      details(
        await P({ ...good, barcode: '4006381333932', sku: '-x', minStock: '1.5', productType: 'X' })
      ),
      ['INVALID_BARCODE', 'INVALID']
    )
    assert.include(details(await P({ ...good, conversions: [] })), 'NO_CONVERSION')
    assert.include(details(await P({ ...good, minStock: '500' })), 'MIN_MAX')
    assert.include(details(await P({ ...good, minStock: '1.5' })), 'DECIMALS')
    assert.include(details(await P({ ...good, trackExpiry: false })), 'EXPIRY_REQUIRED')
    assert.include(details(await P({ ...good, salePrice: '10', currency: null })), 'REQUIRED')
    let p = ok(await P(good))
    assert.equal(p.sku, 'AGUA-05')
    assert.equal(p.currency, 'AOA')
    assert.equal(p.salePrice, '150.5000')
    assert.equal(p.minStock, '48')
    assert.equal(p.effectiveAccountingClass, 'MERCADORIAS') // herdada da categoria-mãe
    assert.equal(p.accountingClassSource, 'CATEGORY')
    assert.deepEqual(
      p.conversions.map((c: any) => [c.uomCode, c.factor]),
      [['CX', '24']]
    )
    // SKU e código de barras únicos (também entre produtos e variantes).
    assert.equal(code(await P({ ...good, barcode: null })), 'SKU_TAKEN')
    assert.equal(code(await P({ ...good, sku: 'OUTRO' })), 'BARCODE_TAKEN')

    // Alteração parcial com versão; a classe do produto sobrepõe-se.
    assert.equal(
      (await o.api.patch(`${I}/products/${p.id}`, { name: 'Água', expectedVersion: 99 })).status(),
      409
    )
    p = ok(
      await o.api.patch(`${I}/products/${p.id}`, {
        accountingClass: 'BEBIDAS',
        expectedVersion: p.version,
      }),
      200
    )
    assert.equal(p.effectiveAccountingClass, 'BEBIDAS')
    assert.equal(p.accountingClassSource, 'PRODUCT')
    // Retirar a conversão usada pela compra é recusado.
    assert.include(
      details(
        await o.api.patch(`${I}/products/${p.id}`, { conversions: [], expectedVersion: p.version })
      ),
      'NO_CONVERSION'
    )
    // Pesquisa, filtro por categoria (inclui subcategorias) e procura exacta por código.
    const found = await o.api.get(`${I}/products?q=agua&categoryId=${o.root.id}`)
    assert.equal(found.body().meta.total, 1)
    const hit = ok(await o.api.get(`${I}/products/lookup?code=4006381333931`), 200)
    assert.equal(hit.product.id, p.id)
    assert.isNull(hit.variant)
    assert.equal((await o.api.get(`${I}/products/lookup?code=NADA`)).status(), 404)
    // A unidade usada não muda de casas decimais.
    const un = ok(await o.api.get(`${S}/uoms`), 200).find((u: any) => u.code === 'UN')
    assert.equal(
      code(await o.api.patch(`${S}/uoms/${un.id}`, { decimals: 2, expectedVersion: un.version })),
      'UOM_IN_USE'
    )
    const a = await owner().rawQuery(
      `select action from audit_events where entity_type = 'product' and entity_id = ? order by created_at`,
      [p.id]
    )
    assert.deepEqual(
      a.rows.map((x: any) => x.action),
      ['inventory.product.created', 'inventory.product.updated']
    )
  })

  test('serviços e kits não movimentam stock; série exige unidade inteira; variantes únicas', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const P = (b: Record<string, unknown>) => o.api.post(`${I}/products`, b)
    const svc = { sku: 'MANUT', name: 'Manutenção', productType: 'SERVICE', baseUomId: o.hr.id }
    assert.include(details(await P({ ...svc, trackLots: true })), 'NOT_STOCKABLE')
    assert.include(details(await P({ ...svc, minStock: '1' })), 'NOT_STOCKABLE')
    const service = ok(await P(svc))
    // A base também recusa (defesa em profundidade).
    await assert.rejects(() =>
      owner().rawQuery(`update products set track_lots = true where id = ?`, [service.id])
    )
    assert.include(
      details(
        await P({
          sku: 'BAL',
          name: 'Balança',
          productType: 'STOCKABLE',
          baseUomId: o.kg.id,
          trackSerials: true,
        })
      ),
      'SERIAL_DECIMALS'
    )
    const shirt = ok(
      await P({
        sku: 'CAM',
        name: 'Camisola',
        productType: 'STOCKABLE',
        baseUomId: o.un.id,
        salePrice: '5000',
        currency: 'AOA',
      })
    )
    const sugar = ok(
      await P({ sku: 'ACU', name: 'Açúcar', productType: 'STOCKABLE', baseUomId: o.kg.id })
    )
    // Kit: precisa de componentes armazenáveis activos, com as casas da unidade do componente.
    const kit = { sku: 'CABAZ', name: 'Cabaz', productType: 'KIT', baseUomId: o.un.id }
    assert.include(details(await P(kit)), 'REQUIRED')
    assert.include(
      details(await P({ ...kit, components: [{ componentId: service.id, quantity: '1' }] })),
      'NOT_STOCKABLE'
    )
    assert.include(
      details(await P({ ...kit, components: [{ componentId: shirt.id, quantity: '1.5' }] })),
      'DECIMALS'
    )
    assert.include(
      details(
        await P({ ...kit, trackLots: true, components: [{ componentId: shirt.id, quantity: '1' }] })
      ),
      'NOT_STOCKABLE'
    )
    let cabaz = ok(
      await P({
        ...kit,
        components: [
          { componentId: shirt.id, quantity: '2' },
          { componentId: sugar.id, quantity: '1.25' },
        ],
      })
    )
    assert.deepEqual(
      cabaz.components.map((c: any) => [c.sku, c.quantity, c.uomCode]),
      [
        ['ACU', '1.25', 'KG'],
        ['CAM', '2', 'UN'],
      ]
    )
    assert.equal(
      code(
        await o.api.post(`${I}/products/${cabaz.id}/variants`, {
          sku: 'CAB-1',
          attributes: { T: 'G' },
        })
      ),
      'KIT_VARIANTS'
    )
    // Um kit que passa a armazenável perde os componentes.
    cabaz = ok(
      await o.api.patch(`${I}/products/${cabaz.id}`, {
        productType: 'STOCKABLE',
        components: [],
        expectedVersion: cabaz.version,
      }),
      200
    )
    assert.lengthOf(cabaz.components, 0)

    // Variantes: atributos, SKU/EAN únicos entre produtos e variantes, combinação única.
    const V = (b: Record<string, unknown>) => o.api.post(`${I}/products/${shirt.id}/variants`, b)
    assert.include(details(await V({ sku: 'CAM-AZ-M', attributes: {} })), 'INVALID')
    let full = ok(
      await V({ sku: 'cam-az-m', barcode: '96385074', attributes: { Cor: 'Azul', Tamanho: 'M' } })
    )
    assert.isTrue(full.hasVariants)
    assert.equal(full.variants[0].sku, 'CAM-AZ-M')
    assert.equal(code(await V({ sku: 'CAM', attributes: { Cor: 'Verde' } })), 'SKU_TAKEN')
    assert.equal(
      code(await V({ sku: 'CAM-X', barcode: '96385074', attributes: { Cor: 'Verde' } })),
      'BARCODE_TAKEN'
    )
    assert.equal(
      code(await V({ sku: 'CAM-AZ-M2', attributes: { tamanho: 'm', cor: 'azul' } })),
      'VARIANT_EXISTS'
    )
    full = ok(
      await V({ sku: 'CAM-VD-M', attributes: { Cor: 'Verde', Tamanho: 'M' }, salePrice: '5500' })
    )
    const v = full.variants.find((x: any) => x.sku === 'CAM-VD-M')
    assert.equal(v.salePrice, '5500.0000')
    full = ok(
      await o.api.patch(`${I}/product-variants/${v.id}`, {
        status: 'DISCONTINUED',
        expectedVersion: v.version,
      }),
      200
    )
    assert.equal(full.variants.find((x: any) => x.id === v.id).status, 'DISCONTINUED')
    const hit = ok(await o.api.get(`${I}/products/lookup?code=96385074`), 200)
    assert.equal(hit.variant.sku, 'CAM-AZ-M')
    assert.equal(
      code(
        await P({ sku: 'CAM-AZ-M', name: 'Outro', productType: 'STOCKABLE', baseUomId: o.un.id })
      ),
      'SKU_TAKEN'
    )
  })

  test('permissões: ler, gerir produtos e configurar são separadas; funcionalidade do plano', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const reader = await roleMember(client, o.s, 'inv_ler', ['inventory.read'])
    const manager = await roleMember(client, o.s, 'inv_prod', [
      'inventory.read',
      'inventory.products.manage',
    ])
    const nobody = await roleMember(client, o.s, 'nada', ['hr.read'])
    assert.equal((await nobody.get(`${I}/products`)).status(), 403)
    assert.equal((await reader.get(`${I}/products`)).status(), 200)
    const body = { sku: 'P1', name: 'Produto 1', productType: 'STOCKABLE', baseUomId: o.un.id }
    assert.equal((await reader.post(`${I}/products`, body)).status(), 403)
    ok(await manager.post(`${I}/products`, body))
    assert.equal((await manager.post(`${S}/brands`, { code: 'B2', name: 'B2' })).status(), 403)
    // Unidade inactiva não serve para produtos novos.
    const un = ok(await o.api.get(`${S}/uoms`), 200).find((u: any) => u.code === 'CX')
    ok(
      await o.api.patch(`${S}/uoms/${un.id}`, { status: 'INACTIVE', expectedVersion: un.version }),
      200
    )
    assert.include(
      details(await manager.post(`${I}/products`, { ...body, sku: 'P2', baseUomId: un.id })),
      'INACTIVE'
    )
  })
})
