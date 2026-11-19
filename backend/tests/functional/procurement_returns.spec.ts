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
const RT = `${P}/returns`
const CN = `${P}/credit-notes`
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
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

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
  return { api: as(client, m.session), session: m.session }
}

function upload(client: any, s: Session, subjectType: string, subjectId: string) {
  return client
    .post('/api/v1/attachments')
    .header('cookie', s.cookie)
    .header('x-xsrf-token', s.xsrf)
    .header('x-tenant-id', s.tenantId)
    .field('subjectType', subjectType)
    .field('subjectId', subjectId)
    .file('file', PNG, { filename: 'bomba-partida.png', contentType: 'image/png' })
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
    await homolog.api.post(`${P}/suppliers/${sup.id}/approve`, { expectedVersion: sup.version }),
    200
  )
  for (const [t, c] of [
    ['PURCHASE_ORDER', 'OC'],
    ['PURCHASE_RECEIPT', 'RE'],
    ['PURCHASE_INVOICE', 'FF'],
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
      [
        'procurement.orders.manage',
        'procurement.receipts.manage',
        'procurement.invoices.manage',
        'procurement.returns.manage',
      ],
      'LEGAL_ENTITY',
      le.id,
    ],
  ])
  const approver = await member(client, s, 'aprova', [
    [['procurement.orders.approve'], 'LEGAL_ENTITY', le.id],
  ])
  const viewer = await member(client, s, 'leitor', [
    [['procurement.returns.read', 'procurement.invoices.read'], 'LEGAL_ENTITY', le.id],
  ])
  const other = await member(client, s, 'outra', [
    [['procurement.returns.manage', 'procurement.invoices.manage'], 'LEGAL_ENTITY', le2.id],
  ])
  const B = buyer.api
  /** Ordem emitida (bomba 10 × 1 000 −10% +14%; instalação 1 × 5 000) com bombas e instalação recebidas. */
  const received = async (pumps: string, refused?: string) => {
    let o = ok(
      await B.post(O, {
        legalEntityId: le.id,
        supplierId: sup.id,
        warehouseId: wh.id,
        lines: [
          {
            productId: pump.id,
            quantity: '10',
            unitPrice: '1000',
            discountRate: '10',
            taxRate: '14',
          },
          { description: 'Instalação no local', quantity: '1', unitPrice: '5000' },
        ],
      })
    )
    o = ok(await B.post(`${O}/${o.id}/submit`, { expectedVersion: o.version }), 200)
    o = ok(await approver.api.post(`${O}/${o.id}/approve`, { expectedVersion: o.version }), 200)
    o = ok(await B.post(`${O}/${o.id}/issue`, { expectedVersion: o.version }), 200)
    let r = ok(
      await B.post(R, {
        orderId: o.id,
        lines: [
          {
            orderLineId: o.lines[0].id,
            quantity: pumps,
            ...(refused ? { rejectedQuantity: refused, rejectReason: 'Carcaça rachada' } : {}),
          },
          { orderLineId: o.lines[1].id, quantity: '1' },
        ],
      })
    )
    r = ok(await B.post(`${R}/${r.id}/confirm`, { expectedVersion: r.version }), 200)
    return { o, r }
  }
  const stock = async () =>
    (
      (
        await owner().rawQuery(
          `select coalesce(sum(qty_unrestricted), 0)::text as q from stock_balances where product_id = ?`,
          [pump.id]
        )
      ).rows[0] as any
    ).q as string
  const orderLine = async (id: string) =>
    (
      await owner().rawQuery(
        `select received_quantity::text as r, cancelled_quantity::text as c, invoiced_quantity::text as i
           from purchase_order_lines where id = ?`,
        [id]
      )
    ).rows[0] as { r: string; c: string; i: string }
  const series = (t: string, c: string) =>
    api.post('/api/v1/document-series', {
      legalEntityId: le.id,
      documentType: t,
      code: c,
      prefix: `${c}-`,
    })
  return {
    api,
    le,
    pump,
    wh,
    sup,
    buyer,
    B,
    viewer,
    other,
    received,
    stock,
    orderLine,
    series,
  }
}

const returnBody = (receiptId: string, lines: any[], extra: Record<string, unknown> = {}) => ({
  receiptId,
  reasonCode: 'DAMAGED',
  description: 'Duas bombas chegaram com a carcaça partida',
  remedy: 'CREDIT',
  lines,
  ...extra,
})

test.group('Compras | devoluções, não conformidades e notas de crédito (9.9)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('devolução a crédito: evidência, saída ao custo da recepção, ordem acertada; nota de crédito abate o facturado', async ({
    client,
    assert,
  }) => {
    const x = await setup(client)
    const B = x.B
    const { o: po, r: rc } = await x.received('6')
    const [Lp, Ls] = po.lines.map((l: any) => l.id)
    const rlp = rc.lines.find((l: any) => l.orderLineId === Lp)
    const rls = rc.lines.find((l: any) => l.orderLineId === Ls)
    assert.equal(await x.stock(), '6.000000')
    // Factura das 6 bombas e da instalação, validada (conforme).
    let inv = ok(
      await B.post(F, {
        orderId: po.id,
        invoiceNumber: 'INV-9',
        invoiceDate: day(0),
        declaredTotal: '11156.00',
        lines: [
          { orderLineId: Lp, quantity: '6', unitPrice: '1000', discountRate: '10', taxRate: '14' },
          { orderLineId: Ls, quantity: '1', unitPrice: '5000' },
        ],
      })
    )
    inv = ok(await B.post(`${F}/${inv.id}/validate`, { expectedVersion: inv.version }), 200)
    assert.equal(inv.status, 'VALIDATED')

    // O que a recepção tem por devolver.
    const ret = ok(await B.get(`${RT}/receipts/${rc.id}`), 200)
    assert.isTrue(ret.returnable)
    assert.deepEqual(
      ret.lines.map((l: any) => [l.stocked, l.acceptedLeft, l.refusedLeft]),
      [
        [true, '6.000000', '0.000000'],
        [false, '1.000000', '0.000000'],
      ]
    )
    // Validações: acima do aceite, séries/localização num serviço, motivo em falta, futura.
    const bad = await B.post(
      RT,
      returnBody(
        rc.id,
        [
          { receiptLineId: rlp.id, quantity: '7' },
          { receiptLineId: rls.id, quantity: '1', serials: ['X1'], bucket: 'BLOCKED' },
        ],
        { reasonCode: 'NOPE', returnDate: day(1) }
      )
    )
    assert.equal(bad.status(), 422)
    assert.includeMembers(details(bad), ['REQUIRED', 'FUTURE'])
    assert.equal(
      code(await B.post(RT, returnBody(rc.id, [{ receiptLineId: rlp.id, quantity: '7' }]))),
      'VALIDATION_ERROR'
    )
    assert.includeMembers(
      details(
        await B.post(
          RT,
          returnBody(rc.id, [
            { receiptLineId: rlp.id, quantity: '7' },
            { receiptLineId: rls.id, quantity: '1', serials: ['X1'], bucket: 'BLOCKED' },
          ])
        )
      ),
      ['OVER_RETURN', 'NOT_STOCKED']
    )
    // Sem permissão de gerir devoluções / de outra entidade.
    assert.equal(
      code(
        await x.viewer.api.post(RT, returnBody(rc.id, [{ receiptLineId: rlp.id, quantity: '1' }]))
      ),
      'OUT_OF_SCOPE'
    )
    assert.equal(
      (
        await x.other.api.post(RT, returnBody(rc.id, [{ receiptLineId: rlp.id, quantity: '1' }]))
      ).status(),
      404
    )

    // Rascunho: 2 bombas danificadas, a crédito. O rascunho reserva: outra devolução só leva 4.
    let d = ok(await B.post(RT, returnBody(rc.id, [{ receiptLineId: rlp.id, quantity: '2' }])))
    assert.deepInclude(d, { status: 'DRAFT', creditStatus: 'NOT_REQUIRED', remedy: 'CREDIT' })
    assert.equal(d.can.confirmBlockedBy, 'EVIDENCE_REQUIRED')
    assert.include(
      details(await B.post(RT, returnBody(rc.id, [{ receiptLineId: rlp.id, quantity: '5' }]))),
      'OVER_RETURN'
    )
    // A recepção com devoluções já não se estorna.
    const rcNow = ok(await B.get(`${R}/${rc.id}`), 200)
    assert.isFalse(rcNow.can.reverse)
    assert.equal(rcNow.returns.length, 1)
    assert.equal(
      code(
        await B.post(`${R}/${rc.id}/reverse`, { expectedVersion: rcNow.version, reason: 'Erro' })
      ),
      'RECEIPT_RETURNED'
    )
    // Sem evidência não confirma; sem série também não.
    assert.equal(
      code(await B.post(`${RT}/${d.id}/confirm`, { expectedVersion: d.version })),
      'EVIDENCE_REQUIRED'
    )
    ok(await upload(client, x.buyer.session, 'purchase_return', d.id))
    // Leitor não junta evidências.
    assert.notEqual((await upload(client, x.viewer.session, 'purchase_return', d.id)).status(), 201)
    d = ok(await B.get(`${RT}/${d.id}`), 200)
    assert.deepInclude(d, { evidenceCount: 1 })
    assert.isNull(d.can.confirmBlockedBy)
    assert.equal(
      code(await B.post(`${RT}/${d.id}/confirm`, { expectedVersion: d.version })),
      'NO_SERIES'
    )
    ok(await x.series('PURCHASE_RETURN', 'DV'))
    d = ok(await B.post(`${RT}/${d.id}/confirm`, { expectedVersion: d.version }), 200)
    assert.deepInclude(d, { status: 'CONFIRMED', creditStatus: 'PENDING' })
    assert.match(d.number, /^DV-/)
    assert.isNotNull(d.postingId)
    assert.deepInclude(d.lines[0], {
      source: 'ACCEPTED',
      baseQuantity: '2.000000',
      creditQuantity: '2.000000',
      creditedQuantity: '0.000000',
      bucket: 'UNRESTRICTED',
    })
    // Stock sai e é valorizado ao custo de entrada (900,00).
    assert.equal(await x.stock(), '4.000000')
    const val = (
      await owner().rawQuery(
        `select sum(value)::text as v, min(source) as s from stock_valuation_entries where posting_id = ?`,
        [d.postingId]
      )
    ).rows[0] as any
    assert.deepEqual([val.v, val.s], ['-1800.00', 'RETURN'])
    const ev = (
      await owner().rawQuery(
        `select kind, document_ref, order_ref from inventory_integration_events where id = ?`,
        [d.integrationEventId]
      )
    ).rows[0] as any
    assert.deepEqual(
      [ev.kind, ev.document_ref, ev.order_ref],
      ['PURCHASE_RETURN', d.number, po.number]
    )
    // Ordem: recebido 4, cancelado 2 (a crédito não se espera substituição), facturado 6 (por creditar).
    assert.deepEqual(await x.orderLine(Lp), { r: '4.000000', c: '2.000000', i: '6.000000' })
    // Não se confirma duas vezes; a base recusa alterar e apagar; não se juntam evidências depois.
    assert.equal(
      code(await B.post(`${RT}/${d.id}/confirm`, { expectedVersion: d.version })),
      'INVALID_STATE'
    )
    assert.equal(
      code(await B.post(`${RT}/${d.id}/cancel`, { expectedVersion: d.version, reason: 'x' })),
      'INVALID_STATE'
    )
    await assert.rejects(() =>
      owner().rawQuery(`update purchase_returns set description = 'Outra' where id = ?`, [d.id])
    )
    await assert.rejects(() =>
      owner().rawQuery(`update purchase_return_lines set quantity = 1 where return_id = ?`, [d.id])
    )
    await assert.rejects(() =>
      owner().rawQuery(`delete from purchase_returns where id = ?`, [d.id])
    )
    assert.notEqual((await upload(client, x.buyer.session, 'purchase_return', d.id)).status(), 201)

    // Nota de crédito: o que a factura tem por creditar e a devolução pendente.
    const cr = ok(await B.get(`${CN}/invoices/${inv.id}`), 200)
    assert.isTrue(cr.creditable)
    assert.deepEqual(
      cr.pendingReturns.map((p: any) => [p.returnNumber, p.pending]),
      [[d.number, '2.000000']]
    )
    const pumpInv = inv.lines.find((l: any) => l.orderLineId === Lp)
    const servInv = inv.lines.find((l: any) => l.orderLineId === Ls)
    const note = (extra: Record<string, unknown> = {}) => ({
      invoiceId: inv.id,
      returnId: d.id,
      creditNoteNumber: 'NC-77',
      creditNoteDate: day(0),
      reason: 'Bombas danificadas devolvidas',
      declaredTotal: '2052.00',
      lines: [
        { invoiceLineId: pumpInv.id, kind: 'QUANTITY', quantity: '2', returnLineId: d.lines[0].id },
      ],
      ...extra,
    })
    assert.include(details(await B.post(CN, note({ declaredTotal: '2000.00' }))), 'TOTAL_MISMATCH')
    assert.include(
      details(
        await B.post(
          CN,
          note({
            lines: [
              {
                invoiceLineId: pumpInv.id,
                kind: 'QUANTITY',
                quantity: '3',
                returnLineId: d.lines[0].id,
              },
            ],
          })
        )
      ),
      'OVER_PENDING'
    )
    assert.include(
      details(
        await B.post(
          CN,
          note({ lines: [{ invoiceLineId: servInv.id, kind: 'PRICE', netAmount: '6000' }] })
        )
      ),
      'OVER_INVOICED'
    )
    assert.include(details(await B.post(CN, note({ creditNoteDate: day(-40) }))), 'BEFORE_INVOICE')
    assert.equal(code(await x.viewer.api.post(CN, note())), 'OUT_OF_SCOPE')
    let n = ok(await B.post(CN, note()))
    assert.deepInclude(n, {
      status: 'DRAFT',
      totalNet: '1800.00',
      totalTax: '252.00',
      totalAmount: '2052.00',
      currency: 'AOA',
    })
    assert.equal(
      code(await B.post(`${CN}/${n.id}/validate`, { expectedVersion: n.version })),
      'NO_SERIES'
    )
    ok(await x.series('PURCHASE_CREDIT_NOTE', 'NCF'))
    n = ok(await B.post(`${CN}/${n.id}/validate`, { expectedVersion: n.version }), 200)
    assert.deepInclude(n, { status: 'VALIDATED', totalFunctional: '2052.00' })
    assert.match(n.number, /^NCF-/)
    // Facturado abatido; devolução creditada; factura com o saldo.
    assert.deepEqual(await x.orderLine(Lp), { r: '4.000000', c: '2.000000', i: '4.000000' })
    d = ok(await B.get(`${RT}/${d.id}`), 200)
    assert.deepInclude(d, { creditStatus: 'CREDITED' })
    assert.equal(d.lines[0].creditedQuantity, '2.000000')
    assert.equal(d.creditNotes[0].number, n.number)
    inv = ok(await B.get(`${F}/${inv.id}`), 200)
    assert.deepInclude(inv, { creditedTotal: '2052.00', balance: '9104.00' })
    assert.deepEqual(inv.lines.find((l: any) => l.id === pumpInv.id).credited, {
      quantity: '2.000000',
      total: '2052.00',
    })
    // A mesma nota outra vez (outra grafia) é recusada; já não há crédito pendente na devolução.
    assert.equal(
      code(await B.post(CN, note({ creditNoteNumber: ' nc-77 ' }))),
      'DUPLICATE_CREDIT_NOTE'
    )
    assert.include(details(await B.post(CN, note({ creditNoteNumber: 'NC-78' }))), 'NOT_FOUND')
    // Ajuste de valor no serviço (desconto posterior): só valor, a facturação da ordem não muda.
    let adj = ok(
      await B.post(CN, {
        invoiceId: inv.id,
        creditNoteNumber: 'NC-79',
        reason: 'Desconto comercial na instalação',
        declaredTotal: '500.00',
        lines: [{ invoiceLineId: servInv.id, kind: 'PRICE', netAmount: '500' }],
      })
    )
    adj = ok(await B.post(`${CN}/${adj.id}/validate`, { expectedVersion: adj.version }), 200)
    assert.equal(adj.status, 'VALIDATED')
    assert.equal((await x.orderLine(Ls)).i, '1.000000')
    inv = ok(await B.get(`${F}/${inv.id}`), 200)
    assert.deepInclude(inv, { creditedTotal: '2552.00', balance: '8604.00' })
    // Validada não muda; o rascunho anula-se com motivo.
    await assert.rejects(() =>
      owner().rawQuery(`update purchase_credit_notes set reason = 'x' where id = ?`, [n.id])
    )
    await assert.rejects(() =>
      owner().rawQuery(`delete from purchase_credit_note_lines where credit_note_id = ?`, [n.id])
    )
    let c = ok(
      await B.post(CN, {
        invoiceId: inv.id,
        creditNoteNumber: 'NC-80',
        reason: 'Engano',
        declaredTotal: '100.00',
        lines: [{ invoiceLineId: servInv.id, kind: 'PRICE', netAmount: '100' }],
      })
    )
    c = ok(
      await B.post(`${CN}/${c.id}/cancel`, { expectedVersion: c.version, reason: 'Duplicada' }),
      200
    )
    assert.equal(c.status, 'CANCELLED')
    // Leitura com âmbito; de outra entidade não existe.
    assert.equal(ok(await x.viewer.api.get(`${CN}/${n.id}`), 200).number, n.number)
    assert.equal((await x.other.api.get(`${CN}/${n.id}`)).status(), 404)
    assert.equal((await x.other.api.get(`${RT}/${d.id}`)).status(), 404)
    const list = ok(await B.get(`${CN}?invoiceId=${inv.id}&status=VALIDATED`), 200)
    assert.lengthOf(list, 2)
    const actions = (
      await owner().rawQuery(
        `select distinct action from audit_events where action like 'purchase_return.%' or action like 'purchase_credit_note.%'
          order by action`
      )
    ).rows.map((r: any) => r.action)
    assert.deepEqual(actions, [
      'purchase_credit_note.cancelled',
      'purchase_credit_note.created',
      'purchase_credit_note.validated',
      'purchase_return.confirmed',
      'purchase_return.created',
    ])
  })

  test('substituição e recusada: a ordem volta a esperar; a recusada não mexe no stock; ordem fechada só a crédito', async ({
    client,
    assert,
  }) => {
    const x = await setup(client)
    const B = x.B
    ok(await x.series('PURCHASE_RETURN', 'DV'))
    const { o: po, r: rc } = await x.received('6', '2')
    const [Lp] = po.lines.map((l: any) => l.id)
    const rlp = rc.lines.find((l: any) => l.orderLineId === Lp)
    assert.deepEqual(await x.orderLine(Lp), { r: '6.000000', c: '0.000000', i: '0.000000' })
    // A recusada sai sem stock: não aceita estado de stock; e só até ao recusado.
    assert.includeMembers(
      details(
        await B.post(
          RT,
          returnBody(
            rc.id,
            [{ receiptLineId: rlp.id, source: 'REFUSED', quantity: '3', bucket: 'BLOCKED' }],
            { remedy: 'REPLACEMENT' }
          )
        )
      ),
      ['OVER_RETURN', 'NOT_STOCKED']
    )
    let d = ok(
      await B.post(
        RT,
        returnBody(
          rc.id,
          [
            { receiptLineId: rlp.id, source: 'ACCEPTED', quantity: '1' },
            { receiptLineId: rlp.id, source: 'REFUSED', quantity: '2' },
          ],
          { remedy: 'REPLACEMENT', reasonCode: 'QUALITY', carrierRef: 'GT-55' }
        )
      )
    )
    ok(await upload(client, x.buyer.session, 'purchase_return', d.id))
    d = ok(await B.post(`${RT}/${d.id}/confirm`, { expectedVersion: d.version }), 200)
    assert.deepInclude(d, { status: 'CONFIRMED', creditStatus: 'NOT_REQUIRED' })
    assert.deepEqual(
      d.lines.map((l: any) => [l.source, l.stocked, l.baseQuantity, l.creditQuantity]),
      [
        ['ACCEPTED', true, '1.000000', '0.000000'],
        ['REFUSED', false, null, '0.000000'],
      ]
    )
    // Só a aceite saiu do stock; a ordem volta a esperar 1 (substituição).
    assert.equal(await x.stock(), '5.000000')
    assert.deepEqual(await x.orderLine(Lp), { r: '5.000000', c: '0.000000', i: '0.000000' })
    const moved = (
      await owner().rawQuery(
        `select sum(quantity)::text as q from stock_movements where posting_id = ?`,
        [d.postingId]
      )
    ).rows[0] as any
    assert.equal(moved.q, '-1.000000')
    const back = ok(await B.get(`${R}/orders/${po.id}`), 200)
    assert.equal(back.lines[0].open, '5.000000')
    // Nada mais por devolver da recusada; o aceite restante continua devolvível.
    const left = ok(await B.get(`${RT}/receipts/${rc.id}`), 200)
    assert.deepEqual(
      [left.lines[0].acceptedLeft, left.lines[0].refusedLeft],
      ['5.000000', '0.000000']
    )
    // Ordem fechada: substituição recusada; a crédito, sim.
    let order = ok(await B.get(`${O}/${po.id}`), 200)
    ok(
      await B.post(`${O}/${po.id}/close`, {
        expectedVersion: order.version,
        reason: 'O fornecedor não tem mais',
      }),
      200
    )
    let e = ok(
      await B.post(
        RT,
        returnBody(rc.id, [{ receiptLineId: rlp.id, quantity: '1' }], { remedy: 'REPLACEMENT' })
      )
    )
    ok(await upload(client, x.buyer.session, 'purchase_return', e.id))
    assert.equal(
      code(await B.post(`${RT}/${e.id}/confirm`, { expectedVersion: e.version })),
      'ORDER_CLOSED'
    )
    e = ok(
      await B.put(`${RT}/${e.id}`, {
        ...returnBody(rc.id, [{ receiptLineId: rlp.id, quantity: '1' }]),
        expectedVersion: e.version,
      }),
      200
    )
    e = ok(await B.post(`${RT}/${e.id}/confirm`, { expectedVersion: e.version }), 200)
    // Não estava facturado: nada por creditar.
    assert.deepInclude(e, { status: 'CONFIRMED', creditStatus: 'NOT_REQUIRED' })
    const after = await x.orderLine(Lp)
    assert.equal(after.r, '4.000000')
    assert.equal(await x.stock(), '4.000000')
    order = ok(await B.get(`${O}/${po.id}`), 200)
    assert.equal(order.receiptStatus, 'RECEIVED')
    // A anulação do rascunho liberta a quantidade.
    let f = ok(await B.post(RT, returnBody(rc.id, [{ receiptLineId: rlp.id, quantity: '4' }])))
    assert.include(
      details(await B.post(RT, returnBody(rc.id, [{ receiptLineId: rlp.id, quantity: '1' }]))),
      'OVER_RETURN'
    )
    f = ok(
      await B.post(`${RT}/${f.id}/cancel`, {
        expectedVersion: f.version,
        reason: 'Afinal estão boas',
      }),
      200
    )
    assert.equal(f.status, 'CANCELLED')
    ok(await B.post(RT, returnBody(rc.id, [{ receiptLineId: rlp.id, quantity: '1' }])))
    const listed = ok(await B.get(`${RT}?receiptId=${rc.id}&status=CONFIRMED`), 200)
    assert.lengthOf(listed, 2)
  })
})
