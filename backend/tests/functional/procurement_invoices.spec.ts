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
const F = `${P}/invoices`
const O = `${P}/orders`
const R = `${P}/receipts`
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
      taxId: '5000000961',
      countryCode: 'AO',
      functionalCurrency: 'AOA',
    })
  )
  const le2 = ok(
    await api.post(`${ORG}/legal-entities`, {
      code: 'LEB',
      legalName: 'Entidade B, Lda.',
      taxId: '5000000962',
      countryCode: 'AO',
      functionalCurrency: 'AOA',
    })
  )
  const I = '/api/v1/inventory'
  const un = ok(
    await api.post(`${I}/settings/uoms`, { code: 'UN', name: 'Unidade', category: 'UNIT' })
  )
  const pump = ok(
    await api.post(`${I}/products`, {
      sku: 'BOMBA',
      name: 'Bomba de água',
      productType: 'STOCKABLE',
      baseUomId: un.id,
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
  const homolog = await member(client, s, 'homolog', [
    [['procurement.suppliers.approve'], 'TENANT'],
  ])
  let sup = ok(
    await api.post(`${P}/suppliers`, {
      supplierType: 'GOODS',
      currency: 'AOA',
      paymentTermsDays: 30,
      partner: {
        code: 'FORN-1',
        name: 'Fornecedor 1',
        partnerType: 'ORGANIZATION',
        taxId: '5417000061',
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
  for (const [t, c] of [
    ['PURCHASE_ORDER', 'OC'],
    ['PURCHASE_RECEIPT', 'RE'],
  ])
    ok(
      await api.post('/api/v1/document-series', {
        legalEntityId: le.id,
        documentType: t,
        code: c,
        prefix: `${c}-`,
      })
    )
  const buyer = await member(client, s, 'compra', [
    [
      ['procurement.orders.manage', 'procurement.receipts.manage', 'procurement.invoices.manage'],
      'LEGAL_ENTITY',
      le.id,
    ],
  ])
  const approver = await member(client, s, 'aprova', [
    [['procurement.orders.approve', 'procurement.invoices.approve'], 'LEGAL_ENTITY', le.id],
  ])
  const both = await member(client, s, 'ambos', [
    [['procurement.invoices.manage', 'procurement.invoices.approve'], 'LEGAL_ENTITY', le.id],
  ])
  const viewer = await member(client, s, 'leitor', [
    [['procurement.invoices.read'], 'LEGAL_ENTITY', le.id],
  ])
  const other = await member(client, s, 'outra', [
    [['procurement.invoices.manage'], 'LEGAL_ENTITY', le2.id],
  ])
  /** Ordem emitida (bomba 10 × 1 000 −10% +14%; instalação 1 × 5 000) com 6 bombas e a instalação recebidas. */
  const received = async (extra: Record<string, unknown> = {}, lines?: any[]) => {
    let o = ok(
      await buyer.post(O, {
        legalEntityId: le.id,
        supplierId: sup.id,
        warehouseId: wh.id,
        lines: lines ?? [
          {
            productId: pump.id,
            quantity: '10',
            unitPrice: '1000',
            discountRate: '10',
            taxRate: '14',
          },
          { description: 'Instalação no local', quantity: '1', unitPrice: '5000' },
        ],
        ...extra,
      })
    )
    o = ok(await buyer.post(`${O}/${o.id}/submit`, { expectedVersion: o.version }), 200)
    o = ok(await approver.post(`${O}/${o.id}/approve`, { expectedVersion: o.version }), 200)
    o = ok(await buyer.post(`${O}/${o.id}/issue`, { expectedVersion: o.version }), 200)
    const rl = o.lines.map((l: any, i: number) => ({
      orderLineId: l.id,
      quantity: i === 0 ? '6' : l.quantity,
    }))
    let r = ok(await buyer.post(R, { orderId: o.id, lines: rl }))
    r = ok(await buyer.post(`${R}/${r.id}/confirm`, { expectedVersion: r.version }), 200)
    return { o, r }
  }
  const series = () =>
    api.post('/api/v1/document-series', {
      legalEntityId: le.id,
      documentType: 'PURCHASE_INVOICE',
      code: 'FF',
      prefix: 'FF-',
    })
  return { api, le, le2, pump, wh, sup, buyer, approver, both, viewer, other, received, series }
}

test.group('Compras | facturas de fornecedor (9.8)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('factura conforme valida directamente; duplicados recusados; acima do recebido pede excepção', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const B = o.buyer
    const { o: po } = await o.received()
    const [Lp, Ls] = po.lines.map((l: any) => l.id)
    const inv = ok(await B.get(`${F}/orders/${po.id}`), 200)
    assert.deepInclude(inv, { invoiceable: true, currency: 'AOA', paymentTermsDays: 30 })
    assert.deepEqual(
      inv.lines.map((l: any) => [l.received, l.toInvoice]),
      [
        ['6.000000', '6.000000'],
        ['1.000000', '1.000000'],
      ]
    )
    const body = (extra: Record<string, unknown> = {}) => ({
      orderId: po.id,
      invoiceNumber: 'INV-001',
      invoiceDate: day(0),
      declaredTotal: '11156.00',
      lines: [
        { orderLineId: Lp, quantity: '6', unitPrice: '1000', discountRate: '10', taxRate: '14' },
        { orderLineId: Ls, quantity: '1', unitPrice: '5000' },
      ],
      ...extra,
    })
    // Validações e âmbito.
    assert.include(details(await B.post(F, body({ currency: 'USD' }))), 'CURRENCY_MISMATCH')
    assert.include(details(await B.post(F, body({ invoiceDate: day(1) }))), 'FUTURE')
    assert.include(details(await B.post(F, body({ dueDate: day(-5) }))), 'INVALID')
    assert.include(
      details(
        await B.post(
          F,
          body({ lines: [{ orderLineId: o.pump.id, quantity: '1', unitPrice: '1' }] })
        )
      ),
      'NOT_FOUND'
    )
    assert.include(details(await B.post(F, body({ invoiceNumber: '' }))), 'REQUIRED')
    assert.equal((await o.other.post(F, body())).status(), 404)
    assert.equal(code(await o.viewer.post(F, body())), 'OUT_OF_SCOPE')
    let a = ok(await B.post(F, body()))
    assert.deepInclude(a, {
      status: 'DRAFT',
      number: null,
      totalNet: '10400.00',
      totalTax: '756.00',
      totalAmount: '11156.00',
      dueDate: (() => {
        const d = new Date(`${day(0)}T00:00:00Z`)
        d.setUTCDate(d.getUTCDate() + 30)
        return d.toISOString().slice(0, 10)
      })(),
    })
    // A mesma factura do mesmo fornecedor (com espaços e minúsculas) é recusada.
    const dup = await B.post(F, body({ invoiceNumber: ' inv-001 ' }))
    assert.equal(dup.status(), 409)
    assert.equal(code(dup), 'DUPLICATE_INVOICE')
    // Recusada logo pelo número, mesmo sem o resto preenchido.
    assert.equal(
      code(await B.post(F, { orderId: po.id, invoiceNumber: 'INV-001' })),
      'DUPLICATE_INVOICE'
    )
    // Validar: sem série recusa (nada muda); com série valida directamente.
    assert.equal(
      code(await B.post(`${F}/${a.id}/validate`, { expectedVersion: a.version })),
      'NO_SERIES'
    )
    a = ok(await B.get(`${F}/${a.id}`), 200)
    assert.equal(a.status, 'DRAFT')
    ok(await o.series())
    a = ok(await B.post(`${F}/${a.id}/validate`, { expectedVersion: a.version }), 200)
    assert.deepInclude(a, {
      status: 'VALIDATED',
      exchangeRate: '1.0000000000',
      totalFunctional: '11156.00',
      divergences: [],
    })
    assert.match(a.number, /^FF-0*1$/)
    assert.deepEqual(a.lines[0].match, {
      ordered: '10.000000',
      received: '6.000000',
      invoicedBefore: '0.000000',
      orderNet: '9000.00',
      orderTaxRate: '14.000',
      codes: [],
    })
    let order = ok(await B.get(`${O}/${po.id}`), 200)
    assert.equal(order.invoiceStatus, 'PARTIALLY_INVOICED')
    assert.deepEqual(
      order.lines.map((l: any) => l.invoicedQuantity),
      ['6.000000', '1.000000']
    )
    // Validada é fixa na base.
    await assert.rejects(() =>
      owner().rawQuery(`update purchase_invoices set declared_total = 1 where id = ?`, [a.id])
    )
    await assert.rejects(() =>
      owner().rawQuery(`update purchase_invoice_lines set quantity = 1 where invoice_id = ?`, [
        a.id,
      ])
    )
    await assert.rejects(() =>
      owner().rawQuery(`delete from purchase_invoices where id = ?`, [a.id])
    )
    assert.equal(
      code(await B.post(`${F}/${a.id}/validate`, { expectedVersion: a.version })),
      'INVALID_STATE'
    )
    // Mais uma bomba do que o recebido: excepção pendente; recusada volta a rascunho; anulada liberta o número.
    let b = ok(
      await B.post(
        F,
        body({
          invoiceNumber: 'INV-002',
          declaredTotal: '1026.00',
          lines: [
            {
              orderLineId: Lp,
              quantity: '1',
              unitPrice: '1000',
              discountRate: '10',
              taxRate: '14',
            },
          ],
        })
      )
    )
    b = ok(await B.post(`${F}/${b.id}/validate`, { expectedVersion: b.version }), 200)
    assert.equal(b.status, 'PENDING_EXCEPTION')
    assert.deepEqual(
      b.divergences.map((d: any) => d.code),
      ['QTY_OVER_RECEIVED']
    )
    assert.equal(
      code(await B.post(`${F}/${b.id}/approve`, { expectedVersion: b.version, reason: 'x' })),
      'OUT_OF_SCOPE'
    )
    assert.include(
      details(await o.approver.post(`${F}/${b.id}/reject`, { expectedVersion: b.version })),
      'REQUIRED'
    )
    b = ok(
      await o.approver.post(`${F}/${b.id}/reject`, {
        expectedVersion: b.version,
        reason: 'Aguardar a recepção',
      }),
      200
    )
    assert.equal(b.status, 'DRAFT')
    assert.deepInclude(b.exceptions[0], { decision: 'REJECT', reason: 'Aguardar a recepção' })
    b = ok(
      await B.post(`${F}/${b.id}/cancel`, {
        expectedVersion: b.version,
        reason: 'Registada antes do tempo',
      }),
      200
    )
    assert.equal(b.status, 'CANCELLED')
    ok(
      await B.post(
        F,
        body({
          invoiceNumber: 'INV-002',
          declaredTotal: '1026.00',
          lines: [
            {
              orderLineId: Lp,
              quantity: '1',
              unitPrice: '1000',
              discountRate: '10',
              taxRate: '14',
            },
          ],
        })
      )
    )
    // Lista: por estado e com divergências; o leitor vê.
    assert.lengthOf(ok(await o.viewer.get(`${F}?status=VALIDATED`), 200), 1)
    assert.lengthOf(ok(await o.viewer.get(`${F}?divergent=true`), 200), 1)
    await assert.rejects(() => owner().rawQuery(`delete from purchase_invoice_exceptions`))
    const actions = await owner().rawQuery(
      `select distinct action from audit_events where action like 'purchase_invoice.%' order by action`
    )
    assert.deepEqual(
      actions.rows.map((x: any) => x.action),
      [
        'purchase_invoice.cancelled',
        'purchase_invoice.created',
        'purchase_invoice.divergent',
        'purchase_invoice.exception_rejected',
        'purchase_invoice.validated',
      ]
    )
    order = ok(await B.get(`${O}/${po.id}`), 200)
    assert.deepEqual(
      order.lines.map((l: any) => l.invoicedQuantity),
      ['6.000000', '1.000000']
    )
  })

  test('tolerâncias, divergências de preço/imposto/encargo/total, excepção segregada, divergências que mudam, moeda estrangeira', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const B = o.buyer
    ok(await o.series())
    // Tolerâncias: só com procurement.settings.
    assert.equal((await B.put(`${P}/tolerances`, { pricePct: '2' })).status(), 403)
    assert.include(details(await o.api.put(`${P}/tolerances`, { pricePct: '101' })), 'INVALID')
    const tol = ok(
      await o.api.put(`${P}/tolerances`, {
        pricePct: '2',
        priceAmount: '0',
        qtyPct: '0',
        totalAmount: '1',
      }),
      200
    )
    assert.deepEqual(tol, {
      pricePct: '2.000',
      priceAmount: '0.00',
      qtyPct: '0.000',
      totalAmount: '1.00',
    })
    assert.deepEqual(ok(await o.viewer.get(`${P}/tolerances`), 200), tol)
    const { o: po } = await o.received()
    const [Lp, Ls] = po.lines.map((l: any) => l.id)
    // Dentro das tolerâncias: 913,50 contra 900 (+1,5%) e o total declarado 0,50 abaixo → valida directamente.
    let a = ok(
      await B.post(F, {
        orderId: po.id,
        invoiceNumber: 'A-1',
        invoiceDate: day(0),
        declaredTotal: '6247.84',
        lines: [
          { orderLineId: Lp, quantity: '6', unitPrice: '1015', discountRate: '10', taxRate: '14' },
        ],
      })
    )
    assert.equal(a.totalAmount, '6248.34')
    a = ok(await B.post(`${F}/${a.id}/validate`, { expectedVersion: a.version }), 200)
    assert.equal(a.status, 'VALIDATED')
    // Fora: preço +6%, imposto diferente, encargo sem linha e total declarado com 10,00 de diferença.
    let b = ok(
      await o.both.post(F, {
        orderId: po.id,
        invoiceNumber: 'A-2',
        invoiceDate: day(0),
        declaredTotal: '7681.00',
        lines: [
          { orderLineId: Ls, quantity: '1', unitPrice: '5300', taxRate: '7' },
          { description: 'Transporte', quantity: '1', unitPrice: '2000' },
        ],
      })
    )
    assert.equal(b.totalAmount, '7671.00')
    b = ok(await o.both.post(`${F}/${b.id}/validate`, { expectedVersion: b.version }), 200)
    assert.equal(b.status, 'PENDING_EXCEPTION')
    assert.deepEqual(b.divergences.map((d: any) => d.code).sort(), [
      'PRICE_OVER_ORDER',
      'TAX_MISMATCH',
      'TOTAL_MISMATCH',
      'UNMATCHED_LINE',
    ])
    assert.deepEqual(b.lines[0].match.codes.sort(), ['PRICE_OVER_ORDER', 'TAX_MISMATCH'])
    await assert.rejects(() =>
      owner().rawQuery(`update purchase_invoices set declared_total = 7671 where id = ?`, [b.id])
    )
    // Quem pediu não decide; decisão com motivo; segregação também na base.
    assert.equal(b.can.decideBlockedBy, 'SELF_APPROVAL')
    assert.equal(
      code(await o.both.post(`${F}/${b.id}/approve`, { expectedVersion: b.version, reason: 'x' })),
      'SELF_APPROVAL'
    )
    assert.include(
      details(await o.approver.post(`${F}/${b.id}/approve`, { expectedVersion: b.version })),
      'REQUIRED'
    )
    b = ok(
      await o.approver.post(`${F}/${b.id}/approve`, {
        expectedVersion: b.version,
        reason: 'Transporte e revisão de preço acordados por e-mail',
      }),
      200
    )
    assert.equal(b.status, 'VALIDATED')
    assert.deepInclude(b.exceptions[0], { decision: 'APPROVE' })
    await assert.rejects(() =>
      owner().rawQuery(
        `insert into purchase_invoice_exceptions (tenant_id, invoice_id, decision, divergences, reason, requested_by, decided_by)
         select tenant_id, id, 'APPROVE', '[]', 'x', submitted_by, submitted_by from purchase_invoices where id = ?`,
        [b.id]
      )
    )
    // Divergências que mudam: pedida com 1 bomba acima do recebido; entretanto chega mais 1 → autorizar é recusado.
    let c = ok(
      await B.post(F, {
        orderId: po.id,
        invoiceNumber: 'A-3',
        invoiceDate: day(0),
        declaredTotal: '1026.00',
        lines: [
          { orderLineId: Lp, quantity: '1', unitPrice: '1000', discountRate: '10', taxRate: '14' },
        ],
      })
    )
    c = ok(await B.post(`${F}/${c.id}/validate`, { expectedVersion: c.version }), 200)
    assert.deepEqual(
      c.divergences.map((d: any) => d.code),
      ['QTY_OVER_RECEIVED']
    )
    let r = ok(await B.post(R, { orderId: po.id, lines: [{ orderLineId: Lp, quantity: '1' }] }))
    r = ok(await B.post(`${R}/${r.id}/confirm`, { expectedVersion: r.version }), 200)
    assert.equal(
      code(
        await o.approver.post(`${F}/${c.id}/approve`, { expectedVersion: c.version, reason: 'ok' })
      ),
      'DIVERGENCES_CHANGED'
    )
    c = ok(
      await o.approver.post(`${F}/${c.id}/reject`, {
        expectedVersion: c.version,
        reason: 'Revalidar',
      }),
      200
    )
    c = ok(await B.post(`${F}/${c.id}/validate`, { expectedVersion: c.version }), 200)
    assert.equal(c.status, 'VALIDATED')
    const order = ok(await B.get(`${O}/${po.id}`), 200)
    assert.deepEqual(
      order.lines.map((l: any) => l.invoicedQuantity),
      ['7.000000', '1.000000']
    )
    // Devolvida ao fornecedor (recusada) é final.
    let d = ok(
      await B.post(F, {
        orderId: po.id,
        invoiceNumber: 'A-4',
        invoiceDate: day(0),
        declaredTotal: '1.00',
        lines: [{ description: 'Despesa não acordada', quantity: '1', unitPrice: '1' }],
      })
    )
    d = ok(
      await B.post(`${F}/${d.id}/refuse`, {
        expectedVersion: d.version,
        reason: 'Não encomendado',
      }),
      200
    )
    assert.deepInclude(d, { status: 'REJECTED', rejectReason: 'Não encomendado' })
    assert.equal(
      code(
        await B.post(F, {
          orderId: po.id,
          invoiceNumber: 'a-4',
          invoiceDate: day(0),
          declaredTotal: '1',
          lines: [{ description: 'Outra', quantity: '1', unitPrice: '1' }],
        })
      ),
      'DUPLICATE_INVOICE'
    )
    // Moeda estrangeira: câmbio da data da factura e total funcional.
    ok(
      await o.api.post('/api/v1/exchange-rates', {
        fromCurrency: 'USD',
        toCurrency: 'AOA',
        rate: '900',
        validOn: day(-1),
      })
    )
    const { o: usd } = await o.received({ currency: 'USD' }, [
      { productId: o.pump.id, quantity: '6', unitPrice: '10' },
    ])
    let e = ok(
      await B.post(F, {
        orderId: usd.id,
        invoiceNumber: 'U-1',
        invoiceDate: day(0),
        declaredTotal: '60',
        lines: [{ orderLineId: usd.lines[0].id, quantity: '6', unitPrice: '10' }],
      })
    )
    e = ok(await B.post(`${F}/${e.id}/validate`, { expectedVersion: e.version }), 200)
    assert.deepInclude(e, {
      currency: 'USD',
      exchangeRate: '900.0000000000',
      totalFunctional: '54000.00',
    })
  })
})
