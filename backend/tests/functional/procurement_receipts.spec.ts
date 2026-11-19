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

const P = '/api/v1/procurement'
const R = `${P}/receipts`
const O = `${P}/orders`
const ORG = '/api/v1/organization'
const owner = () => db.connection('owner')
const ok = (r: any, status = 201) => {
  if (r.status() !== status) throw new Error(`${r.status()} ${JSON.stringify(r.body())}`)
  return r.body().data
}
const code = (r: any) => r.body().error?.code
const details = (r: any) => (r.body().error?.details ?? []).map((d: any) => d.code)
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)

async function member(
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
  const le = ok(
    await api.post(`${ORG}/legal-entities`, {
      code: 'LEA',
      legalName: 'Entidade A, Lda.',
      taxId: '5000000951',
      countryCode: 'AO',
      functionalCurrency: 'AOA',
    })
  )
  const le2 = ok(
    await api.post(`${ORG}/legal-entities`, {
      code: 'LEB',
      legalName: 'Entidade B, Lda.',
      taxId: '5000000952',
      countryCode: 'AO',
      functionalCurrency: 'AOA',
    })
  )
  const I = '/api/v1/inventory'
  const un = ok(
    await api.post(`${I}/settings/uoms`, { code: 'UN', name: 'Unidade', category: 'UNIT' })
  )
  const cx = ok(
    await api.post(`${I}/settings/uoms`, { code: 'CX', name: 'Caixa', category: 'UNIT' })
  )
  const pump = ok(
    await api.post(`${I}/products`, {
      sku: 'BOMBA',
      name: 'Bomba de água',
      productType: 'STOCKABLE',
      baseUomId: un.id,
      trackLots: true,
      trackExpiry: true,
    })
  )
  const cable = ok(
    await api.post(`${I}/products`, {
      sku: 'CABO',
      name: 'Cabo eléctrico',
      productType: 'STOCKABLE',
      baseUomId: un.id,
      purchaseUomId: cx.id,
      conversions: [{ uomId: cx.id, factor: '12' }],
    })
  )
  const wh = ok(
    await api.post(`${I}/warehouses`, {
      code: 'ARM-A',
      name: 'Armazém A',
      legalEntityId: le.id,
      warehouseType: 'MAIN',
    })
  )
  ok(await api.post(`${I}/warehouses/${wh.id}/locations`, { code: 'ZA' }))
  const homolog = await member(client, s, 'homolog', [
    [['procurement.suppliers.approve'], 'TENANT'],
  ])
  let sup = ok(
    await api.post(`${P}/suppliers`, {
      supplierType: 'GOODS',
      currency: 'AOA',
      partner: {
        code: 'FORN-1',
        name: 'Fornecedor 1',
        partnerType: 'ORGANIZATION',
        taxId: '5417000051',
        countryCode: 'AO',
      },
    })
  )
  sup = ok(
    await api.post(`${P}/suppliers/${sup.id}/submit`, { expectedVersion: sup.version, items: [] }),
    200
  )
  sup = ok(
    await homolog.post(`${P}/suppliers/${sup.id}/approve`, { expectedVersion: sup.version }),
    200
  )
  ok(
    await api.post('/api/v1/document-series', {
      legalEntityId: le.id,
      documentType: 'PURCHASE_ORDER',
      code: 'OC',
      prefix: 'OC-',
    })
  )
  const buyer = await member(client, s, 'compra', [
    [['procurement.orders.manage', 'procurement.receipts.manage'], 'LEGAL_ENTITY', le.id],
  ])
  const approver = await member(client, s, 'aprova', [
    [['procurement.orders.approve'], 'LEGAL_ENTITY', le.id],
  ])
  const store = await member(client, s, 'armazem', [
    [['procurement.receipts.manage'], 'LEGAL_ENTITY', le.id],
  ])
  const viewer = await member(client, s, 'leitor', [
    [['procurement.receipts.read'], 'LEGAL_ENTITY', le.id],
  ])
  const other = await member(client, s, 'outra', [
    [['procurement.receipts.manage'], 'LEGAL_ENTITY', le2.id],
  ])
  /** Ordem aprovada e emitida. */
  const issued = async (body: Record<string, unknown>) => {
    let o = ok(
      await buyer.post(O, { legalEntityId: le.id, supplierId: sup.id, warehouseId: wh.id, ...body })
    )
    o = ok(await buyer.post(`${O}/${o.id}/submit`, { expectedVersion: o.version }), 200)
    o = ok(await approver.post(`${O}/${o.id}/approve`, { expectedVersion: o.version }), 200)
    return ok(await buyer.post(`${O}/${o.id}/issue`, { expectedVersion: o.version }), 200)
  }
  const stock = async (productId: string) =>
    (
      await owner().rawQuery(
        `select coalesce(sum(qty_unrestricted), 0)::text as q from stock_balances where product_id = ?`,
        [productId]
      )
    ).rows[0].q as string
  const series = () =>
    api.post('/api/v1/document-series', {
      legalEntityId: le.id,
      documentType: 'PURCHASE_RECEIPT',
      code: 'RE',
      prefix: 'RE-',
    })
  return {
    api,
    le,
    le2,
    un,
    cx,
    pump,
    cable,
    wh,
    sup,
    buyer,
    approver,
    store,
    viewer,
    other,
    issued,
    stock,
    series,
  }
}

test.group('Compras | recepções (9.7)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('recepções parciais: conferência, recusa, unidade de compra, entrada única no inventário, estorno', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const S = o.store
    let po = await o.issued({
      orderDate: day(-3),
      expectedDate: day(-1),
      lines: [
        {
          productId: o.pump.id,
          quantity: '10',
          unitPrice: '1000',
          discountRate: '10',
          taxRate: '14',
        },
        { productId: o.cable.id, quantity: '2', unitPrice: '6000' },
        { description: 'Instalação no local', quantity: '1', unitPrice: '5000' },
      ],
    })
    const [Lp, Lc, Ls] = po.lines.map((l: any) => l.id)
    assert.equal(po.lines[1].uom.code, 'CX')
    // Entregas previstas: atrasadas (data de ontem), com o que falta.
    const exp = ok(await o.viewer.get(`${R}/expected?state=OVERDUE`), 200)
    assert.deepEqual(
      exp.map((x: any) => [x.lineNo, x.open, x.state]),
      [
        [1, '10.000000', 'OVERDUE'],
        [2, '2.000000', 'OVERDUE'],
        [3, '1.000000', 'OVERDUE'],
      ]
    )
    // O que a ordem tem por receber (rastreio, armazenável, localizações).
    const rec = ok(await S.get(`${R}/orders/${po.id}`), 200)
    assert.isTrue(rec.receivable)
    assert.deepEqual(
      rec.lines.map((l: any) => [l.stocked, l.tracking.lots]),
      [
        [true, true],
        [true, false],
        [false, false],
      ]
    )
    // Validações e âmbito.
    const body = (extra: Record<string, unknown> = {}, lines?: any[]) => ({
      orderId: po.id,
      deliveryNote: 'GR-123',
      lines: lines ?? [
        {
          orderLineId: Lp,
          quantity: '6',
          rejectedQuantity: '1',
          rejectReason: 'Caixa danificada',
          lotCode: 'L-01',
          expiryDate: day(200),
          locationId: rec.locations[0]?.id,
        },
        { orderLineId: Lc, quantity: '1' },
        { orderLineId: Ls, quantity: '1' },
      ],
      ...extra,
    })
    assert.equal((await o.other.post(R, body())).status(), 404)
    assert.equal(code(await o.viewer.post(R, body())), 'OUT_OF_SCOPE')
    assert.include(details(await S.post(R, body({ receiptDate: day(1) }))), 'FUTURE')
    assert.include(
      details(
        await S.post(
          R,
          body({}, [{ orderLineId: Lp, quantity: '11', lotCode: 'L', expiryDate: day(9) }])
        )
      ),
      'OVER_RECEIPT'
    )
    assert.include(
      details(await S.post(R, body({}, [{ orderLineId: Ls, quantity: '1', lotCode: 'X' }]))),
      'NOT_STOCKED'
    )
    assert.include(
      details(
        await S.post(R, body({}, [{ orderLineId: Lp, quantity: '1', rejectedQuantity: '1' }]))
      ),
      'REQUIRED'
    )
    assert.include(
      details(await S.post(R, body({}, [{ orderLineId: Lp, quantity: '0' }]))),
      'REQUIRED'
    )
    let r1 = ok(await S.post(R, body()))
    assert.deepInclude(r1, { status: 'DRAFT', number: null, deliveryNote: 'GR-123' })
    assert.deepEqual(
      r1.lines.map((l: any) => [l.stocked, l.quantity, l.rejectedQuantity]),
      [
        [true, '6.000000', '1.000000'],
        [true, '1.000000', '0.000000'],
        [false, '1.000000', '0.000000'],
      ]
    )
    // Confirmar: série; número; entrada única no inventário (unidade base e custo funcional).
    assert.equal(
      code(await S.post(`${R}/${r1.id}/confirm`, { expectedVersion: r1.version })),
      'NO_SERIES'
    )
    ok(await o.series())
    r1 = ok(await S.post(`${R}/${r1.id}/confirm`, { expectedVersion: r1.version }), 200)
    assert.equal(r1.status, 'CONFIRMED')
    assert.match(r1.number, /^RE-0*1$/)
    assert.isNotNull(r1.postingId)
    assert.deepEqual(
      r1.lines.map((l: any) => [l.baseQuantity, l.unitCost]),
      [
        ['6.000000', '900.000000'],
        ['12.000000', '500.000000'],
        [null, null],
      ]
    )
    assert.equal(await o.stock(o.pump.id), '6.000000')
    assert.equal(await o.stock(o.cable.id), '12.000000')
    const events = await owner().rawQuery(
      `select kind, document_ref from inventory_integration_events where order_ref = ?`,
      [po.number]
    )
    assert.deepEqual(events.rows, [{ kind: 'PURCHASE_RECEIPT', document_ref: r1.number }])
    const lot = await owner().rawQuery(`select code from stock_lots where product_id = ?`, [
      o.pump.id,
    ])
    assert.deepEqual(
      lot.rows.map((x: any) => x.code),
      ['L-01']
    )
    po = ok(await o.buyer.get(`${O}/${po.id}`), 200)
    assert.equal(po.receiptStatus, 'PARTIALLY_RECEIVED')
    assert.deepEqual(
      po.lines.map((l: any) => l.receivedQuantity),
      ['6.000000', '1.000000', '1.000000']
    )
    // Repetir a confirmação não duplica nada.
    assert.equal(
      code(await S.post(`${R}/${r1.id}/confirm`, { expectedVersion: r1.version })),
      'INVALID_STATE'
    )
    assert.equal(await o.stock(o.pump.id), '6.000000')
    await assert.rejects(() =>
      owner().rawQuery(`update purchase_receipt_lines set quantity = 1 where receipt_id = ?`, [
        r1.id,
      ])
    )
    await assert.rejects(() =>
      owner().rawQuery(`update purchase_receipts set number = 'X' where id = ?`, [r1.id])
    )
    await assert.rejects(() =>
      owner().rawQuery(`delete from purchase_receipts where id = ?`, [r1.id])
    )
    // Segunda recepção completa a ordem (a recusada não conta como recebida).
    let r2 = ok(
      await S.post(
        R,
        body({}, [
          { orderLineId: Lp, quantity: '4', lotCode: 'L-02', expiryDate: day(300) },
          { orderLineId: Lc, quantity: '1' },
        ])
      )
    )
    r2 = ok(await S.post(`${R}/${r2.id}/confirm`, { expectedVersion: r2.version }), 200)
    po = ok(await o.buyer.get(`${O}/${po.id}`), 200)
    assert.equal(po.receiptStatus, 'RECEIVED')
    assert.equal(await o.stock(o.pump.id), '10.000000')
    assert.equal(await o.stock(o.cable.id), '24.000000')
    assert.include(
      details(
        await S.post(
          R,
          body({}, [{ orderLineId: Lp, quantity: '1', lotCode: 'L', expiryDate: day(9) }])
        )
      ),
      'OVER_RECEIPT'
    )
    assert.lengthOf(ok(await o.viewer.get(`${R}/expected`), 200), 0)
    // Estorno: motivo; estorna o lançamento; devolve à ordem.
    assert.include(
      details(await S.post(`${R}/${r2.id}/reverse`, { expectedVersion: r2.version })),
      'REQUIRED'
    )
    r2 = ok(
      await S.post(`${R}/${r2.id}/reverse`, { expectedVersion: r2.version, reason: 'Guia errada' }),
      200
    )
    assert.deepInclude(r2, { status: 'REVERSED', reversalReason: 'Guia errada' })
    assert.isNotNull(r2.reversalPostingId)
    assert.equal(await o.stock(o.pump.id), '6.000000')
    assert.equal(await o.stock(o.cable.id), '12.000000')
    po = ok(await o.buyer.get(`${O}/${po.id}`), 200)
    assert.equal(po.receiptStatus, 'PARTIALLY_RECEIVED')
    assert.equal(
      code(await S.post(`${R}/${r2.id}/reverse`, { expectedVersion: r2.version, reason: 'x' })),
      'INVALID_STATE'
    )
    // Já facturado (o 9.8 grava-o): não se estorna.
    await owner().rawQuery(`update purchase_order_lines set invoiced_quantity = 6 where id = ?`, [
      Lp,
    ])
    r1 = ok(await S.get(`${R}/${r1.id}`), 200)
    assert.isFalse(r1.can.reverse)
    assert.equal(
      code(await S.post(`${R}/${r1.id}/reverse`, { expectedVersion: r1.version, reason: 'x' })),
      'RECEIPT_INVOICED'
    )
    // Rascunho anulado com motivo.
    let r3 = ok(await S.post(R, body({}, [{ orderLineId: Lc, quantity: '1' }])))
    r3 = ok(
      await S.post(`${R}/${r3.id}/cancel`, { expectedVersion: r3.version, reason: 'Duplicada' }),
      200
    )
    assert.equal(r3.status, 'CANCELLED')
    const list = ok(await o.viewer.get(`${R}?orderId=${po.id}`), 200)
    assert.deepEqual(list.map((x: any) => x.status).sort(), ['CANCELLED', 'CONFIRMED', 'REVERSED'])
    const actions = await owner().rawQuery(
      `select distinct action from audit_events where action like 'purchase_receipt.%' order by action`
    )
    assert.deepEqual(
      actions.rows.map((x: any) => x.action),
      [
        'purchase_receipt.cancelled',
        'purchase_receipt.confirmed',
        'purchase_receipt.created',
        'purchase_receipt.reversed',
      ]
    )
    await assert.rejects(() => owner().rawQuery(`delete from purchase_receipt_events`))
  })

  test('custo em moeda estrangeira, recepções concorrentes sem passar o encomendado, serviços sem stock, ordem em revisão', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const S = o.store
    ok(await o.series())
    ok(
      await o.api.post('/api/v1/exchange-rates', {
        fromCurrency: 'USD',
        toCurrency: 'AOA',
        rate: '900',
        validOn: day(-1),
      })
    )
    const po = await o.issued({
      currency: 'USD',
      lines: [{ productId: o.cable.id, quantity: '2', unitPrice: '120', taxRate: '14' }],
    })
    const line = po.lines[0].id
    // Duas recepções de 2 caixas em rascunho; só a primeira cabe.
    let a = ok(await S.post(R, { orderId: po.id, lines: [{ orderLineId: line, quantity: '2' }] }))
    let b = ok(await S.post(R, { orderId: po.id, lines: [{ orderLineId: line, quantity: '2' }] }))
    a = ok(await S.post(`${R}/${a.id}/confirm`, { expectedVersion: a.version }), 200)
    // 120 USD × 900 = 108 000 AOA a caixa de 12 → 9 000,00 por unidade.
    assert.equal(a.lines[0].unitCost, '9000.000000')
    assert.include(
      details(await S.post(`${R}/${b.id}/confirm`, { expectedVersion: b.version })),
      'OVER_RECEIPT'
    )
    assert.equal(await o.stock(o.cable.id), '24.000000')
    b = ok(await S.get(`${R}/${b.id}`), 200)
    assert.equal(b.status, 'DRAFT')
    // Serviços (sem armazém nem produto): só aceitação, sem movimento de stock.
    let sv = ok(
      await o.buyer.post(O, {
        legalEntityId: o.le.id,
        supplierId: o.sup.id,
        lines: [{ description: 'Consultoria técnica', quantity: '3', unitPrice: '10000' }],
      })
    )
    sv = ok(await o.buyer.post(`${O}/${sv.id}/submit`, { expectedVersion: sv.version }), 200)
    sv = ok(await o.approver.post(`${O}/${sv.id}/approve`, { expectedVersion: sv.version }), 200)
    sv = ok(await o.buyer.post(`${O}/${sv.id}/issue`, { expectedVersion: sv.version }), 200)
    let acc = ok(
      await S.post(R, { orderId: sv.id, lines: [{ orderLineId: sv.lines[0].id, quantity: '3' }] })
    )
    assert.isNull(acc.warehouse)
    acc = ok(await S.post(`${R}/${acc.id}/confirm`, { expectedVersion: acc.version }), 200)
    assert.deepInclude(acc, { status: 'CONFIRMED', postingId: null })
    assert.equal(ok(await o.buyer.get(`${O}/${sv.id}`), 200).receiptStatus, 'RECEIVED')
    // Ordem em revisão (ainda não reemitida) não aceita recepções.
    let rv = await o.issued({ lines: [{ productId: o.cable.id, quantity: '1', unitPrice: '100' }] })
    rv = ok(
      await o.buyer.post(`${O}/${rv.id}/revise`, { expectedVersion: rv.version, reason: 'Preço' }),
      200
    )
    assert.equal(
      code(
        await S.post(R, { orderId: rv.id, lines: [{ orderLineId: rv.lines[0].id, quantity: '1' }] })
      ),
      'NOT_RECEIVABLE'
    )
    assert.isFalse(ok(await S.get(`${R}/orders/${rv.id}`), 200).receivable)
  })
})
