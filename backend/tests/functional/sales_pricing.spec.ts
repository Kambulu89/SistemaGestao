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

const S = '/api/v1/sales'
const owner = () => db.connection('owner')
const ok = (r: any, status = 201) => {
  if (r.status() !== status) throw new Error(`${r.status()} ${JSON.stringify(r.body())}`)
  return r.body().data
}
const code = (r: any) => r.body().error?.code
const details = (r: any) => (r.body().error?.details ?? []).map((d: any) => d.path)

async function member(client: any, admin: Session, roleCode: string, permissions: string[]) {
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
  const manager = await member(client, s, 'precos', ['sales.prices.manage'])
  const approver = await member(client, s, 'aprova_precos', ['sales.prices.approve'])
  const viewer = await member(client, s, 'ver_precos', ['sales.prices.read'])
  const nobody = await member(client, s, 'nada', ['sales.customers.read'])
  const uom = ok(
    await api.post('/api/v1/inventory/settings/uoms', {
      code: 'UN',
      name: 'Unidade',
      category: 'UNIT',
    })
  )
  const parent = ok(
    await api.post('/api/v1/inventory/settings/categories', { code: 'BEB', name: 'Bebidas' })
  )
  const child = ok(
    await api.post('/api/v1/inventory/settings/categories', {
      code: 'SUM',
      name: 'Sumos',
      parentId: parent.id,
    })
  )
  const p1 = ok(
    await api.post('/api/v1/inventory/products', {
      sku: 'SUMO-1',
      name: 'Sumo de laranja',
      productType: 'STOCKABLE',
      baseUomId: uom.id,
      categoryId: child.id,
      currency: 'AOA',
      salePrice: '50',
    })
  )
  const p2 = ok(
    await api.post('/api/v1/inventory/products', {
      sku: 'SERV-1',
      name: 'Instalação',
      productType: 'SERVICE',
      baseUomId: uom.id,
    })
  )
  const segment = ok(await api.post(`${S}/segments`, { code: 'RET', name: 'Retalho' }))
  const customer = (n: number, extra: Record<string, unknown> = {}) =>
    api.post(`${S}/customers`, {
      currency: 'AOA',
      partner: {
        code: `CLI-${n}`,
        name: `Cliente ${n}`,
        partnerType: 'ORGANIZATION',
        taxId: `541700007${n}`,
        countryCode: 'AO',
      },
      ...extra,
    })
  const c1 = ok(await customer(1, { segmentId: segment.id }))
  const c2 = ok(await customer(2))
  return { api, manager, approver, viewer, nobody, parent, child, p1, p2, segment, c1, c2 }
}

const header = (extra: Record<string, unknown> = {}) => ({
  code: 'GERAL',
  name: 'Tabela geral',
  currency: 'AOA',
  targetType: 'GENERAL',
  validFrom: '2026-01-01',
  ...extra,
})

/** Cria, preenche, submete (quem gere) e aprova (outra pessoa) uma tabela. */
async function activeList(o: any, h: Record<string, unknown>, lines: Record<string, unknown>[]) {
  let l = ok(await o.manager.post(`${S}/price-lists`, header(h)))
  for (const ln of lines) l = ok(await o.manager.post(`${S}/price-lists/${l.id}/lines`, ln), 200)
  l = ok(
    await o.manager.post(`${S}/price-lists/${l.id}/submit`, { expectedVersion: l.version }),
    200
  )
  return ok(
    await o.approver.post(`${S}/price-lists/${l.id}/approve`, { expectedVersion: l.version }),
    200
  )
}
const resolve = (api: any, customerId: string, lines: Record<string, unknown>[], extra = {}) =>
  api.post(`${S}/pricing/resolve`, {
    customerId,
    currency: 'AOA',
    date: '2026-06-01',
    lines,
    ...extra,
  })

test.group('Vendas | preços e descontos (10.2)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('tabelas por cliente, segmento e geral com escalões; aprovação segregada; imutável depois de activa', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    // Validação, permissões e unicidade.
    assert.includeMembers(
      details(await o.manager.post(`${S}/price-lists`, { targetType: 'CUSTOMER' })),
      ['code', 'name', 'currency', 'customerId', 'validFrom']
    )
    assert.equal((await o.viewer.post(`${S}/price-lists`, header())).status(), 403)
    assert.equal((await o.nobody.get(`${S}/price-lists`)).status(), 403)
    let g = ok(await o.manager.post(`${S}/price-lists`, header()))
    assert.equal(code(await o.manager.post(`${S}/price-lists`, header())), 'CODE_TAKEN')
    assert.equal(
      code(await o.manager.post(`${S}/price-lists/${g.id}/submit`, { expectedVersion: g.version })),
      'NO_LINES'
    )
    g = ok(
      await o.manager.post(`${S}/price-lists/${g.id}/lines`, {
        productId: o.p1.id,
        unitPrice: '100',
      }),
      200
    )
    g = ok(
      await o.manager.post(`${S}/price-lists/${g.id}/lines`, {
        productId: o.p1.id,
        minQuantity: '10',
        unitPrice: '90',
      }),
      200
    )
    assert.equal(
      code(
        await o.manager.post(`${S}/price-lists/${g.id}/lines`, {
          productId: o.p1.id,
          minQuantity: '10.000',
          unitPrice: '1',
        })
      ),
      'TIER_EXISTS'
    )
    assert.lengthOf(g.lines, 2)
    // Devolver exige motivo e volta a rascunho.
    g = ok(
      await o.manager.post(`${S}/price-lists/${g.id}/submit`, { expectedVersion: g.version }),
      200
    )
    assert.equal(g.status, 'PENDING')
    assert.isFalse(g.can.edit)
    assert.equal(
      (
        await o.manager.post(`${S}/price-lists/${g.id}/approve`, { expectedVersion: g.version })
      ).status(),
      403
    )
    assert.equal(
      code(
        await o.approver.post(`${S}/price-lists/${g.id}/reject`, { expectedVersion: g.version })
      ),
      'VALIDATION_ERROR'
    )
    g = ok(
      await o.approver.post(`${S}/price-lists/${g.id}/reject`, {
        expectedVersion: g.version,
        reason: 'Falta o escalão',
      }),
      200
    )
    assert.equal(g.status, 'DRAFT')
    assert.equal(g.history.at(-1).reason, 'Falta o escalão')
    // Quem submete não aprova, mesmo tendo as duas permissões.
    g = ok(await o.api.post(`${S}/price-lists/${g.id}/submit`, { expectedVersion: g.version }), 200)
    assert.equal(
      code(await o.api.post(`${S}/price-lists/${g.id}/approve`, { expectedVersion: g.version })),
      'SELF_APPROVAL'
    )
    g = ok(
      await o.approver.post(`${S}/price-lists/${g.id}/approve`, { expectedVersion: g.version }),
      200
    )
    assert.equal(g.status, 'ACTIVE')
    // Activa: não muda pela API nem directamente na base.
    assert.equal(
      code(
        await o.manager.patch(`${S}/price-lists/${g.id}`, { expectedVersion: g.version, name: 'X' })
      ),
      'INVALID_STATE'
    )
    assert.equal(
      code(
        await o.manager.post(`${S}/price-lists/${g.id}/lines`, {
          productId: o.p1.id,
          minQuantity: '20',
          unitPrice: '1',
        })
      ),
      'INVALID_STATE'
    )
    await assert.rejects(() =>
      owner().rawQuery(`update price_list_lines set unit_price = 1 where price_list_id = ?`, [g.id])
    )
    await assert.rejects(() =>
      owner().rawQuery(`update price_lists set priority = 1 where id = ?`, [g.id])
    )
    await assert.rejects(() => owner().rawQuery(`delete from price_lists where id = ?`, [g.id]))

    await activeList(o, { code: 'RETALHO', targetType: 'SEGMENT', segmentId: o.segment.id }, [
      { productId: o.p1.id, unitPrice: '80' },
    ])
    await activeList(o, { code: 'CLI1', targetType: 'CUSTOMER', customerId: o.c1.id }, [
      { productId: o.p1.id, minQuantity: '5', unitPrice: '70' },
    ])
    const r = ok(
      await resolve(o.viewer, o.c1.id, [
        { productId: o.p1.id, quantity: '1' },
        { productId: o.p1.id, quantity: '5' },
      ]),
      200
    )
    // Cliente com tabela própria mas escalão não atingido → segmento; atingido → cliente.
    assert.deepEqual(
      r.lines.map((l: any) => [l.priceListCode, l.netUnitPrice]),
      [
        ['RETALHO', '80.0000'],
        ['CLI1', '70.0000'],
      ]
    )
    const r2 = ok(
      await resolve(o.viewer, o.c2.id, [
        { productId: o.p1.id, quantity: '9.5' },
        { productId: o.p1.id, quantity: '10' },
      ]),
      200
    )
    assert.deepEqual(
      r2.lines.map((l: any) => [l.priceListCode, l.netUnitPrice, l.netAmount]),
      [
        ['GERAL', '100.0000', '950.00'],
        ['GERAL', '90.0000', '900.00'],
      ]
    )
    // Fora do período, ou noutra moeda: o preço do catálogo (na mesma moeda) ou nenhum.
    const before = ok(
      await resolve(o.viewer, o.c2.id, [{ productId: o.p1.id, quantity: '1' }], {
        date: '2025-12-31',
      }),
      200
    )
    assert.equal(before.lines[0].source, 'CATALOG')
    assert.equal(before.lines[0].netUnitPrice, '50.0000')
    const usd = ok(
      await resolve(o.viewer, o.c2.id, [{ productId: o.p1.id, quantity: '1' }], {
        currency: 'USD',
      }),
      200
    )
    assert.equal(usd.lines[0].source, 'NONE')
    assert.isTrue(usd.missingPrices)

    // Mudar preços: copiar para um rascunho novo; a sobreposição com a mesma prioridade é recusada até inactivar a antiga.
    let c = ok(
      await o.manager.post(`${S}/price-lists/${g.id}/copy`, {
        code: 'GERAL-27',
        validFrom: '2027-01-01',
      })
    )
    assert.equal(c.status, 'DRAFT')
    assert.equal(c.copiedFrom.code, 'GERAL')
    assert.lengthOf(c.lines, 2)
    c = ok(
      await o.manager.patch(`${S}/price-lists/${c.id}/lines/${c.lines[0].id}`, {
        expectedVersion: c.lines[0].version,
        unitPrice: '110',
      }),
      200
    )
    c = ok(
      await o.manager.post(`${S}/price-lists/${c.id}/submit`, { expectedVersion: c.version }),
      200
    )
    assert.equal(
      code(
        await o.approver.post(`${S}/price-lists/${c.id}/approve`, { expectedVersion: c.version })
      ),
      'OVERLAP'
    )
    assert.equal(
      code(
        await o.manager.post(`${S}/price-lists/${g.id}/deactivate`, { expectedVersion: g.version })
      ),
      'VALIDATION_ERROR'
    )
    ok(
      await o.manager.post(`${S}/price-lists/${g.id}/deactivate`, {
        expectedVersion: g.version,
        reason: 'Substituída pela de 2027',
      }),
      200
    )
    c = ok(
      await o.approver.post(`${S}/price-lists/${c.id}/approve`, { expectedVersion: c.version }),
      200
    )
    const y27 = ok(
      await resolve(o.viewer, o.c2.id, [{ productId: o.p1.id, quantity: '1' }], {
        date: '2027-02-01',
      }),
      200
    )
    assert.equal(y27.lines[0].netUnitPrice, '110.0000')
    // A tabela antiga mantém os preços (os documentos que a usaram continuam explicáveis).
    const old = ok(await o.viewer.get(`${S}/price-lists/${g.id}`), 200)
    assert.equal(old.status, 'INACTIVE')
    assert.equal(old.lines.find((l: any) => l.minQuantity === '1.000000').unitPrice, '100.0000')

    const audits = await owner().rawQuery(
      `select action from audit_events where entity_type = 'price_list' and entity_id = ? order by created_at`,
      [g.id]
    )
    assert.includeMembers(
      audits.rows.map((x: any) => x.action),
      [
        'price_list.created',
        'price_list.line_added',
        'price_list.rejected',
        'price_list.approved',
        'price_list.deactivated',
      ]
    )
  })

  test('regras automáticas, limites do desconto manual, preço manual e snapshot', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    await activeList(o, {}, [{ productId: o.p1.id, unitPrice: '1000', maxDiscountPct: '8' }])
    const rule = async (body: Record<string, unknown>) => {
      let r = ok(
        await o.manager.post(`${S}/discount-rules`, {
          name: 'Regra',
          validFrom: '2026-01-01',
          ...body,
        })
      )
      r = ok(
        await o.manager.post(`${S}/discount-rules/${r.id}/submit`, { expectedVersion: r.version }),
        200
      )
      return ok(
        await o.approver.post(`${S}/discount-rules/${r.id}/approve`, {
          expectedVersion: r.version,
        }),
        200
      )
    }
    assert.includeMembers(
      details(
        await o.manager.post(`${S}/discount-rules`, {
          code: 'X',
          name: 'X',
          targetType: 'ALL',
          discountPct: '0',
          validFrom: 'x',
        })
      ),
      ['discountPct', 'validFrom']
    )
    // Categoria-mãe abrange a subcategoria; a de maior prioridade ganha (não acumulam).
    await rule({
      code: 'BEB10',
      targetType: 'ALL',
      categoryId: o.parent.id,
      discountPct: '10',
      priority: 200,
    })
    await rule({
      code: 'CLI5',
      targetType: 'CUSTOMER',
      customerId: o.c1.id,
      discountPct: '5',
      priority: 100,
    })
    await rule({
      code: 'QTD20',
      targetType: 'ALL',
      productId: o.p1.id,
      minQuantity: '100',
      discountPct: '20',
      priority: 300,
    })
    const dup = ok(
      await o.manager.post(`${S}/discount-rules`, {
        code: 'BEB10B',
        name: 'Igual',
        targetType: 'ALL',
        categoryId: o.parent.id,
        discountPct: '3',
        priority: 200,
        validFrom: '2026-03-01',
      })
    )
    const dupS = ok(
      await o.manager.post(`${S}/discount-rules/${dup.id}/submit`, {
        expectedVersion: dup.version,
      }),
      200
    )
    assert.equal(
      code(
        await o.approver.post(`${S}/discount-rules/${dup.id}/approve`, {
          expectedVersion: dupS.version,
        })
      ),
      'OVERLAP'
    )

    // Limites: só quem aprova preços os define.
    assert.equal(
      (
        await o.manager.put(`${S}/discount-limits`, { targetType: 'GENERAL', maxPct: '50' })
      ).status(),
      403
    )
    ok(await o.approver.put(`${S}/discount-limits`, { targetType: 'GENERAL', maxPct: '3' }), 200)
    ok(
      await o.approver.put(`${S}/discount-limits`, {
        targetType: 'SEGMENT',
        segmentId: o.segment.id,
        maxPct: '6',
      }),
      200
    )
    const lim = ok(
      await o.approver.put(`${S}/discount-limits`, { targetType: 'GENERAL', maxPct: '4' }),
      200
    )
    const limits = ok(await o.viewer.get(`${S}/discount-limits`), 200)
    assert.deepEqual(
      limits.items.map((l: any) => [l.targetType, l.maxPct]),
      [
        ['GENERAL', '4.00'],
        ['SEGMENT', '6.00'],
      ]
    )

    const lines = [
      { productId: o.p1.id, quantity: '2', manualDiscountPct: '5' },
      { productId: o.p1.id, quantity: '100' },
      { productId: o.p2.id, quantity: '1' },
      { productId: o.p2.id, quantity: '1', manualUnitPrice: '15000' },
    ]
    const r1 = ok(await resolve(o.viewer, o.c1.id, lines), 200)
    const [a, b, none, manual] = r1.lines
    // 1000 −10 % (BEB10) −5 % manual = 855; limite do segmento 6 %.
    assert.equal(a.ruleCode, 'BEB10')
    assert.equal(a.netUnitPrice, '855.0000')
    assert.equal(a.limitSource, 'SEGMENT')
    assert.isFalse(a.requiresApproval)
    assert.equal(b.ruleCode, 'QTD20')
    assert.equal(b.netAmount, '80000.00')
    assert.equal(none.source, 'NONE')
    assert.equal(manual.source, 'MANUAL')
    assert.isTrue(manual.requiresApproval)
    assert.isTrue(r1.requiresApproval)
    // O mesmo pedido dá o mesmo snapshot (mesma impressão digital).
    const r1b = ok(await resolve(o.viewer, o.c1.id, lines), 200)
    assert.equal(r1b.hash, r1.hash)
    // Cliente sem segmento: limite geral 4 % → 5 % precisa de aprovação.
    const r2 = ok(await resolve(o.viewer, o.c2.id, [lines[0]]), 200)
    assert.equal(r2.lines[0].limitPct, '4.00')
    assert.deepEqual(r2.lines[0].reasons, ['DISCOUNT_OVER_LIMIT'])
    assert.notEqual(r2.hash, r1.hash)
    // Limite do cliente acima do da linha da tabela (8 %): vale o da linha.
    ok(
      await o.approver.put(`${S}/discount-limits`, {
        targetType: 'CUSTOMER',
        customerId: o.c2.id,
        maxPct: '15',
      }),
      200
    )
    const r3 = ok(await resolve(o.viewer, o.c2.id, [{ ...lines[0], manualDiscountPct: '9' }]), 200)
    assert.equal(r3.lines[0].limitSource, 'LINE')
    assert.isTrue(r3.lines[0].requiresApproval)
    ok(await o.approver.delete(`${S}/discount-limits/${lim.id}`), 200)

    // Inactivar uma regra: deixa de se aplicar.
    const rules = ok(await o.viewer.get(`${S}/discount-rules?status=ACTIVE`), 200)
    const beb = rules.find((x: any) => x.code === 'BEB10')
    ok(
      await o.manager.post(`${S}/discount-rules/${beb.id}/deactivate`, {
        expectedVersion: beb.version,
        reason: 'Fim da campanha',
      }),
      200
    )
    const r4 = ok(await resolve(o.viewer, o.c1.id, [{ productId: o.p1.id, quantity: '1' }]), 200)
    assert.equal(r4.lines[0].ruleCode, 'CLI5')

    // Pesquisas dos formulários de preços (sem permissão de clientes nem de inventário).
    const found = ok(await o.viewer.get(`${S}/pricing/search/products?q=sumo`), 200)
    assert.deepEqual(
      found.map((x: any) => [x.sku, x.salePrice, x.currency]),
      [['SUMO-1', '50.0000', 'AOA']]
    )
    const cs = ok(await o.viewer.get(`${S}/pricing/search/customers?q=cli-2`), 200)
    assert.deepEqual(
      cs.map((x: any) => x.code),
      ['CLI-2']
    )
    assert.equal((await o.nobody.get(`${S}/pricing/search/products`)).status(), 403)
    // Erros de dados por linha; sem permissão.
    const bad = await resolve(o.viewer, o.c1.id, [
      { productId: o.p1.id, quantity: '0' },
      { productId: o.p1.id, quantity: '1', manualDiscountPct: '1', manualUnitPrice: '1' },
    ])
    assert.equal(bad.status(), 422)
    assert.includeMembers(details(bad), ['lines.0.quantity', 'lines.1.manualUnitPrice'])
    assert.equal((await resolve(o.nobody, o.c1.id, [lines[0]])).status(), 403)
  })

  test('aprovações simultâneas de tabelas sobrepostas: só uma fica activa', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const pending = []
    for (const n of [1, 2, 3]) {
      let l = ok(await o.manager.post(`${S}/price-lists`, header({ code: `G${n}` })))
      l = ok(
        await o.manager.post(`${S}/price-lists/${l.id}/lines`, {
          productId: o.p1.id,
          unitPrice: String(n),
        }),
        200
      )
      pending.push(
        ok(
          await o.manager.post(`${S}/price-lists/${l.id}/submit`, { expectedVersion: l.version }),
          200
        )
      )
    }
    const res = await Promise.all(
      pending.map((l) =>
        o.approver.post(`${S}/price-lists/${l.id}/approve`, { expectedVersion: l.version })
      )
    )
    assert.deepEqual(res.map((r) => r.status()).sort(), [200, 409, 409])
    const active = await owner().rawQuery(
      `select count(*)::int as n from price_lists where status = 'ACTIVE'`
    )
    assert.equal(active.rows[0].n, 1)
  })
})
