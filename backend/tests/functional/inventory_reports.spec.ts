import { test } from '@japa/runner'
import { runInTenant } from '#modules/tenancy/index'
import { postStock, reverseStockPosting } from '#modules/inventory/index'
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
const P = `${I}/reports`
const ORG = '/api/v1/organization'
const ok = (r: any, status = 201) => {
  if (r.status() !== status) throw new Error(`${r.status()} ${JSON.stringify(r.body())}`)
  return r.body().data
}
const code = (r: any) => r.body().error?.code
const details = (r: any) => (r.body().error?.details ?? []).map((d: any) => d.code)
let seq = 0
const key = () => `k-${Date.now()}-${++seq}`
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
const today = day(0)

async function roleMember(
  client: any,
  admin: Session,
  roleCode: string,
  grants: [string[], string, string?][]
) {
  const m = await memberWithRoles(client, admin, [])
  let n = 0
  for (const [permissions, scopeType, scopeId] of grants) {
    const role = await createRole(client, admin, `${roleCode}_${n++}`, permissions)
    ok(
      await as(client, admin).post(`/api/v1/members/${m.memberId}/roles`, {
        roleId: role.id,
        scopeType,
        ...(scopeId ? { scopeId } : {}),
      }),
      200
    )
  }
  return as(client, m.session)
}

async function setup(client: any) {
  const { tenant, admin } = await tenantWithAdmin()
  const s = await signIn(client, admin.email, tenant.id)
  const api = as(client, s)
  const le = async (c: string, taxId: string) =>
    ok(
      await api.post(`${ORG}/legal-entities`, {
        code: c,
        legalName: `Entidade ${c}, Lda.`,
        taxId,
        countryCode: 'AO',
        functionalCurrency: 'AOA',
      })
    )
  const leA = await le('LEA', '5000000871')
  const leB = await le('LEB', '5000000872')
  for (const [t, c] of [
    ['STOCK_REQUISITION', 'RQ'],
    ['STOCK_ISSUE', 'SI'],
  ])
    ok(
      await api.post('/api/v1/document-series', {
        legalEntityId: leA.id,
        documentType: t,
        code: c,
        prefix: `${c}-`,
      })
    )
  const dept = ok(
    await api.post(`${ORG}/departments`, {
      code: 'MANUT',
      name: 'Manutenção',
      legalEntityId: leA.id,
    })
  )
  const cc = ok(
    await api.post(`${ORG}/cost-centers`, { code: 'CC1', name: 'Oficina', legalEntityId: leA.id })
  )
  const un = ok(
    await api.post(`${I}/settings/uoms`, { code: 'UN', name: 'Unidade', category: 'UNIT' })
  )
  const cat = ok(
    await api.post(`${I}/settings/categories`, {
      code: 'MERC',
      name: 'Mercadorias',
      accountingClass: 'MERCADORIAS',
    })
  )
  const product = async (sku: string, extra: Record<string, unknown> = {}) =>
    ok(
      await api.post(`${I}/products`, {
        sku,
        name: `Produto ${sku}`,
        productType: 'STOCKABLE',
        baseUomId: un.id,
        categoryId: cat.id,
        ...extra,
      })
    )
  const oil = await product('OLEO', { minStock: '50', maxStock: '120' })
  const wax = await product('PARAF', { minStock: '10' }) // nunca teve stock → ruptura
  const bolt = await product('PERNO', { minStock: '5' }) // 3 livres e 10 previstos → a caminho
  const milk = await product('LEITE', { trackLots: true, trackExpiry: true })
  const mkWh = async (c: string, l: any) => {
    const w = ok(
      await api.post(`${I}/warehouses`, {
        code: c,
        name: `Armazém ${c}`,
        legalEntityId: l.id,
        warehouseType: 'MAIN',
      })
    )
    const z = ok(await api.post(`${I}/warehouses/${w.id}/locations`, { code: 'Z1' }))
    const b = ok(
      await api.post(`${I}/warehouses/${w.id}/locations`, {
        parentId: z.locations[0].id,
        code: 'P1',
        holdsStock: true,
      })
    )
    return { ...w, bin: b.locations.find((x: any) => x.pathCode === 'Z1-P1') }
  }
  const wa = await mkWh('WA', leA)
  const wb = await mkWh('WB', leB)
  const ctx = (await api.get('/api/v1/context')).body().data
  const scope = {
    tenantId: tenant.id,
    userId: admin.id,
    membershipId: ctx.membershipId,
    requestId: 't',
  }
  const post = (
    type: string,
    sourceType: string,
    productId: string,
    quantity: string,
    extra: Record<string, unknown> = {},
    bucket = 'UNRESTRICTED'
  ) =>
    runInTenant(scope, (sc) =>
      postStock(sc, {
        type: type as never,
        idempotencyKey: key(),
        sourceType,
        lines: [
          {
            warehouseId: wa.id,
            locationId: bucket === 'EXPECTED' ? null : wa.bin.id,
            productId,
            bucket: bucket as never,
            quantity,
            ...extra,
          },
        ],
      })
    )
  return { tenant, s, api, leA, leB, dept, cc, un, oil, wax, bolt, milk, wa, wb, scope, post }
}

test.group('Inventário | alertas e relatórios (8.11)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('reposição, ruptura, validade, rotação, cobertura, movimentos, perdas, consumo por centro de custo e inventário valorizado', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const { api } = o
    // Compra de 100 a 10,00; venda de 30; venda de 5 estornada (não conta); falta e sobra de contagem.
    await o.post('RECEIPT', 'PURCHASE_RECEIPT', o.oil.id, '100', { unitCost: '10' })
    await o.post('ISSUE', 'SALES_DELIVERY', o.oil.id, '-30')
    const undone = await o.post('ISSUE', 'SALES_DELIVERY', o.oil.id, '-5')
    await runInTenant(o.scope, (sc) =>
      reverseStockPosting(sc, undone.posting.id, { idempotencyKey: key(), reason: 'Engano' })
    )
    await o.post('ADJUSTMENT', 'STOCK_COUNT', o.oil.id, '-2')
    await o.post('ADJUSTMENT', 'STOCK_COUNT', o.oil.id, '1')
    // Quebra de 3 por documento de saída com origem "perda".
    let d = ok(
      await api.post(`${I}/documents`, {
        docType: 'ISSUE',
        warehouseId: o.wa.id,
        origin: 'LOSS',
        lines: [{ productId: o.oil.id, uomId: o.un.id, quantity: '3', locationId: o.wa.bin.id }],
      })
    )
    d = ok(
      await api.post(`${I}/documents/${d.id}/check`, {
        expectedVersion: d.version,
        lines: d.lines.map((l: any) => ({ lineId: l.id, checkedQuantity: l.quantity })),
      }),
      200
    )
    ok(
      await api.post(`${I}/documents/${d.id}/confirm`, {
        expectedVersion: d.version,
        idempotencyKey: key(),
      }),
      200
    )
    // Requisição interna de 20 para o centro de custo CC1 (pede, aprova, separa e entrega).
    const requester = await roleMember(client, o.s, 'pede', [
      [['inventory.requisitions.request'], 'DEPARTMENT', o.dept.id],
    ])
    const R = `${I}/requisitions`
    let r = ok(
      await requester.post(R, {
        warehouseId: o.wa.id,
        departmentId: o.dept.id,
        costCenterId: o.cc.id,
        purpose: 'Manutenção',
        neededBy: day(5),
        lines: [{ productId: o.oil.id, quantity: '20', sourceLocationId: o.wa.bin.id }],
      })
    )
    const act = async (who: any, action: string, b: Record<string, unknown> = {}) =>
      ok(await who.post(`${R}/${r.id}/${action}`, { expectedVersion: r.version, ...b }), 200)
    r = await act(requester, 'submit')
    r = await act(api, 'approve')
    r = await act(api, 'pick', { lines: [{ lineId: r.lines[0].id, pickedQuantity: '20' }] })
    r = await act(api, 'issue', {
      idempotencyKey: key(),
      lines: [{ lineId: r.lines[0].id, quantity: '20' }],
    })
    assert.equal(r.status, 'COMPLETED')
    // Perno: 3 livres e 10 previstos. Leite: um lote expirado, um a 10 dias e um a 200 dias.
    await o.post('RECEIPT', 'PURCHASE_RECEIPT', o.bolt.id, '3', { unitCost: '2' })
    await o.post('EXPECTED', 'TEST', o.bolt.id, '10', {}, 'EXPECTED')
    for (const [lot, exp, qty] of [
      ['L-VELHO', day(-3), '4'],
      ['L-PERTO', day(10), '6'],
      ['L-LONGE', day(200), '8'],
    ])
      await o.post('RECEIPT', 'PURCHASE_RECEIPT', o.milk.id, qty, {
        lotCode: lot,
        expiryDate: exp,
        unitCost: '5',
      })

    // Alertas: contadores.
    assert.deepEqual(ok(await api.get(`${P}/alerts`), 200), {
      days: 30,
      stockout: 1,
      reorder: 1,
      incoming: 1,
      expired: 1,
      expiring: 1,
    })
    assert.equal(ok(await api.get(`${P}/alerts?days=5`), 200).expiring, 0)

    // Reposição: 100 − 30 − 2 + 1 − 3 − 20 = 46 ≤ 50 → repor 74 até ao máximo de 120.
    const rep = ok(await api.get(`${P}/replenishment`), 200) as any[]
    assert.deepEqual(
      rep.map((x) => [x.product.sku, x.status, x.available, x.suggested]),
      [
        ['OLEO', 'REORDER', '46.000000', '74.000000'],
        ['PARAF', 'STOCKOUT', '0.000000', '10.000000'],
        ['PERNO', 'INCOMING', '3.000000', '0.000000'],
      ]
    )
    assert.equal(rep[2].incoming, '10.000000')
    const out = ok(await api.get(`${P}/replenishment?status=STOCKOUT`), 200) as any[]
    assert.deepEqual(
      out.map((x) => x.product.sku),
      ['PARAF']
    )
    assert.lengthOf(ok(await api.get(`${P}/replenishment?status=OK&q=leite`), 200), 1)

    // Validade: o expirado primeiro; o lote a 200 dias fica de fora dos 30 dias.
    const exp = ok(await api.get(`${P}/expiry`), 200) as any[]
    assert.deepEqual(
      exp.map((x) => [x.lot.code, x.status, x.daysLeft, x.quantity]),
      [
        ['L-VELHO', 'EXPIRED', -3, '4.000000'],
        ['L-PERTO', 'EXPIRING', 10, '6.000000'],
      ]
    )
    assert.lengthOf(ok(await api.get(`${P}/expiry?days=365`), 200), 3)

    // Rotação e cobertura (hoje): consumo 50 (venda 30 + requisição 20), stock médio 23 → 2,17 voltas; 1 dia.
    const range = `from=${today}&to=${today}`
    const turn = ok(await api.get(`${P}/turnover?${range}`), 200)
    const oil = turn.rows.find((x: any) => x.product.sku === 'OLEO')
    assert.deepInclude(oil, {
      opening: '0.000000',
      closing: '46.000000',
      average: '23.000000',
      consumption: '50.000000',
      turnover: '2.17',
      available: '46.000000',
      coverageDays: 1,
    })
    const milk = turn.rows.find((x: any) => x.product.sku === 'LEITE')
    assert.deepInclude(milk, { consumption: '0.000000', turnover: '0.00', coverageDays: null })
    // Ontem não houve nada: abertura e fecho a zero, sem linhas.
    assert.lengthOf(ok(await api.get(`${P}/turnover?from=${day(-1)}&to=${day(-1)}`), 200).rows, 0)

    // Movimentos por classe (a venda estornada anula-se).
    const mov = ok(await api.get(`${P}/movements?${range}&productId=${o.oil.id}`), 200)
    assert.isTrue(mov.values)
    assert.deepEqual(
      mov.rows.map((x: any) => [x.class, x.quantityIn, x.quantityOut, x.value]),
      [
        ['ADJUSTMENT_GAIN', '1.000000', '0.000000', '10.00'],
        ['ADJUSTMENT_LOSS', '0.000000', '2.000000', '20.00'],
        ['CONSUMPTION', '0.000000', '20.000000', '200.00'],
        ['LOSS', '0.000000', '3.000000', '30.00'],
        ['PURCHASE', '100.000000', '0.000000', '1000.00'],
        ['SALE', '0.000000', '30.000000', '300.00'],
      ]
    )
    const all = ok(await api.get(`${P}/movements?${range}`), 200)
    assert.deepInclude(
      all.totals.find((x: any) => x.class === 'PURCHASE'),
      { direction: 'IN', value: '1096.00' } // 1000 + 6 (pernos) + 90 (leite)
    )

    // Perdas e sobras.
    const loss = ok(await api.get(`${P}/losses?${range}`), 200)
    assert.deepEqual(
      loss.rows.map((x: any) => [x.class, x.quantity, x.value]),
      [
        ['ADJUSTMENT_GAIN', '1.000000', '10.00'],
        ['ADJUSTMENT_LOSS', '2.000000', '20.00'],
        ['LOSS', '3.000000', '30.00'],
      ]
    )
    assert.deepEqual(loss.totals, { losses: '50.00', gains: '10.00', net: '40.00' })

    // Consumo por centro de custo.
    const cons = ok(await api.get(`${P}/consumption?${range}`), 200)
    assert.lengthOf(cons.rows, 1)
    assert.deepInclude(cons.rows[0], { quantity: '20.000000', value: '200.00' })
    assert.deepInclude(cons.rows[0].costCenter, { code: 'CC1', name: 'Oficina' })
    assert.deepEqual(
      cons.totals.map((x: any) => [x.costCenter.code, x.value]),
      [['CC1', '200.00']]
    )

    // Inventário valorizado: 46 × 10 + 3 × 2 + 18 × 5 = 556,00; ontem não havia nada.
    const val = ok(await api.get(`${P}/valued?legalEntityId=${o.leA.id}`), 200)
    assert.deepEqual(
      val.rows.map((x: any) => [x.product.sku, x.quantity, x.unitCost, x.value]),
      [
        ['LEITE', '18.000000', '5.000000', '90.00'],
        ['OLEO', '46.000000', '10.000000', '460.00'],
        ['PERNO', '3.000000', '2.000000', '6.00'],
      ]
    )
    assert.deepEqual(val.totals, {
      value: '556.00',
      classes: [{ class: 'MERCADORIAS', value: '556.00' }],
    })
    const before = ok(await api.get(`${P}/valued?legalEntityId=${o.leA.id}&date=${day(-1)}`), 200)
    assert.lengthOf(before.rows, 0)
    assert.equal(before.totals.value, '0.00')
    // Bate com a valorização do 8.9.
    const pools = (await api.get(`${I}/valuation?legalEntityId=${o.leA.id}`)).body()
    assert.equal(pools.meta.totals[0].value, '556.00')

    // Validações do período.
    assert.include(details(await api.get(`${P}/turnover?from=${today}&to=${day(-1)}`)), 'INVALID')
    assert.include(details(await api.get(`${P}/losses?from=2026-13-40&to=${today}`)), 'INVALID')
    assert.equal((await api.get(`${P}/movements?from=${today}`)).status(), 422)
    assert.include(details(await api.get(`${P}/movements?from=2020-01-01&to=${today}`)), 'TOO_LONG')
  })

  test('âmbito: só os armazéns consultáveis; valores só com inventory.valuation.read na entidade', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    await o.post('RECEIPT', 'PURCHASE_RECEIPT', o.oil.id, '10', { unitCost: '10' })
    await o.post('ISSUE', 'SALES_DELIVERY', o.oil.id, '-4')
    const range = `from=${today}&to=${today}`
    // Fiel da entidade A sem acesso a valores: vê quantidades, os valores vêm a null.
    const keeper = await roleMember(client, o.s, 'fiel', [
      [['inventory.read'], 'LEGAL_ENTITY', o.leA.id],
    ])
    const mov = ok(await keeper.get(`${P}/movements?${range}`), 200)
    assert.isFalse(mov.values)
    assert.deepEqual(
      mov.rows.map((x: any) => [x.class, x.quantityIn, x.quantityOut, x.value]),
      [
        ['PURCHASE', '10.000000', '0.000000', null],
        ['SALE', '0.000000', '4.000000', null],
      ]
    )
    assert.isNull(ok(await keeper.get(`${P}/losses?${range}`), 200).totals)
    assert.equal(code(await keeper.get(`${P}/valued?legalEntityId=${o.leA.id}`)), 'OUT_OF_SCOPE')
    assert.equal(ok(await keeper.get(`${P}/alerts`), 200).reorder, 1)
    // Armazém de outra entidade: nem se vê.
    assert.equal((await keeper.get(`${P}/replenishment?warehouseId=${o.wb.id}`)).status(), 404)
    // Quem só vê a entidade B: o stock de A não entra em nada (ruptura só no que nunca teve stock).
    const other = await roleMember(client, o.s, 'outro', [
      [['inventory.read', 'inventory.valuation.read'], 'LEGAL_ENTITY', o.leB.id],
    ])
    assert.lengthOf(ok(await other.get(`${P}/movements?${range}`), 200).rows, 0)
    assert.lengthOf(ok(await other.get(`${P}/turnover?${range}`), 200).rows, 0)
    assert.equal((await other.get(`${P}/expiry?warehouseId=${o.wa.id}`)).status(), 404)
    assert.equal(code(await other.get(`${P}/valued?legalEntityId=${o.leA.id}`)), 'OUT_OF_SCOPE')
    assert.lengthOf(ok(await other.get(`${P}/valued?legalEntityId=${o.leB.id}`), 200).rows, 0)
    const rep = ok(await other.get(`${P}/replenishment`), 200) as any[]
    assert.isTrue(rep.every((x) => x.status === 'STOCKOUT' && x.onHand === '0.000000'))
    // O óleo só tem stock em A: para quem só vê B não é ruptura, simplesmente não entra.
    assert.sameMembers(
      rep.map((x) => x.product.sku),
      ['PARAF', 'PERNO']
    )
    // Sem permissões de inventário: nada.
    const nobody = await roleMember(client, o.s, 'nada', [[['members.read'], 'TENANT']])
    assert.lengthOf(ok(await nobody.get(`${P}/replenishment`), 200), 0)
    assert.deepInclude(ok(await nobody.get(`${P}/alerts`), 200), { stockout: 0, reorder: 0 })
    // Entidade inexistente → 404.
    assert.equal(
      (await o.api.get(`${P}/valued?legalEntityId=00000000-0000-4000-8000-000000000000`)).status(),
      404
    )
  })
})
