import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { runInTenant } from '#modules/tenancy/index'
import { receivePurchase } from '#modules/inventory/index'
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
const N = `${S}/notes`
const owner = () => db.connection('owner')
const ok = (r: any, status = 201) => {
  if (r.status() !== status) throw new Error(`${r.status()} ${JSON.stringify(r.body())}`)
  return r.body().data
}
const code = (r: any) => r.body().error?.code
const paths = (r: any) => (r.body().error?.details ?? []).map((d: any) => d.path)
const today = () => new Date().toISOString().slice(0, 10)
// Valores fiscais ilustrativos de teste, não taxas legais.
const SOURCE = 'Fonte de teste — não é diploma real'

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
  const le = ok(
    await api.post('/api/v1/organization/legal-entities', {
      code: 'LEA',
      legalName: 'Entidade A, Lda.',
      taxId: '5000000931',
      countryCode: 'AO',
      functionalCurrency: 'AOA',
    })
  )
  const preparer = await member(client, s, 'notas', ['sales.notes.manage', 'sales.notes.issue'])
  const issuer = await member(client, s, 'emissor_notas', ['sales.notes.issue'])
  const clerk = await member(client, s, 'cobranca', ['sales.receipts.manage', 'sales.notes.read'])
  const treasurer = await member(client, s, 'tesouraria', ['sales.receipts.confirm'])
  const confirmer = await member(client, s, 'fiscal_conf', ['sales.fiscal.confirm'])
  const wh = ok(
    await api.post('/api/v1/inventory/warehouses', {
      code: 'ARM',
      name: 'Armazém',
      legalEntityId: le.id,
      warehouseType: 'MAIN',
    })
  )
  const uom = ok(
    await api.post('/api/v1/inventory/settings/uoms', {
      code: 'UN',
      name: 'Unidade',
      category: 'UNIT',
    })
  )
  const p = ok(
    await api.post('/api/v1/inventory/products', {
      sku: 'BOMBA',
      name: 'Bomba',
      productType: 'STOCKABLE',
      baseUomId: uom.id,
      currency: 'AOA',
      salePrice: '100',
    })
  )
  const sv = ok(
    await api.post('/api/v1/inventory/products', {
      sku: 'INST',
      name: 'Instalação',
      productType: 'SERVICE',
      baseUomId: uom.id,
      currency: 'AOA',
      salePrice: '500',
    })
  )
  const c1 = ok(
    await api.post(`${S}/customers`, {
      currency: 'AOA',
      paymentTermsDays: 30,
      partner: {
        code: 'CLI-1',
        name: 'Cliente Um',
        partnerType: 'ORGANIZATION',
        taxId: '5417000071',
        countryCode: 'AO',
      },
    })
  )
  const year = Number(today().slice(0, 4))
  let t10 = ok(
    await api.post(`${S}/fiscal/tax-codes`, {
      countryCode: 'AO',
      code: 'T10',
      name: 'Imposto de teste',
      kind: 'TAX',
      taxType: 'VAT',
    })
  )
  t10 = ok(
    await api.post(`${S}/fiscal/tax-codes/${t10.id}/rates`, {
      rate: '10',
      validFrom: `${year - 1}-01-01`,
      legalSource: SOURCE,
    })
  )
  ok(
    await confirmer.post(`${S}/fiscal/tax-rates/${t10.rates[0].id}/confirm`, {
      expectedVersion: t10.rates[0].version,
    }),
    200
  )
  for (const [kind, c, prefix] of [
    ['INVOICE', 'FT', 'FT A/'],
    ['RECEIPT', 'RC', 'RC A/'],
    ['CREDIT_NOTE', 'NC', 'NC A/'],
    ['DEBIT_NOTE', 'ND', 'ND A/'],
  ]) {
    const x = ok(
      await api.post(`${S}/fiscal/series`, {
        legalEntityId: le.id,
        documentKind: kind,
        fiscalCode: c,
        code: c,
        fiscalYear: year,
        prefix,
      })
    )
    ok(await api.post(`${S}/fiscal/series/${x.id}/activate`, { expectedVersion: x.version }), 200)
  }
  ok(
    await api.post('/api/v1/document-series', {
      legalEntityId: le.id,
      documentType: 'SALES_ORDER',
      code: 'EV',
      prefix: 'EV-',
    })
  )
  const me = (
    await owner().rawQuery(
      `select m.id, m.user_id from tenant_memberships m join users u on u.id = m.user_id where m.tenant_id = ? and u.email = ?`,
      [tenant.id, admin.email]
    )
  ).rows[0]
  await runInTenant(
    { tenantId: tenant.id, userId: me.user_id, membershipId: me.id, requestId: 'teste' },
    (scope) =>
      receivePurchase(scope, {
        idempotencyKey: 'stock-inicial-1',
        warehouseId: wh.id,
        orderRef: 'PO-1',
        documentRef: 'GR-1',
        lines: [{ productId: p.id, quantity: '10', unitCost: '50' }],
      })
  )
  // Factura de serviços emitida: qty × 500 + 10 %.
  const invoice = async (qty: string) => {
    let i = ok(
      await api.post(`${S}/invoices`, {
        legalEntityId: le.id,
        customerId: c1.id,
        invoiceDate: today(),
        lines: [{ productId: sv.id, quantity: qty, taxCodeIds: [t10.id] }],
      })
    )
    i = ok(await api.post(`${S}/invoices/${i.id}/issue`, { expectedVersion: i.version }), 200)
    return i
  }
  return {
    tenant,
    api,
    le,
    wh,
    p,
    sv,
    c1,
    t10,
    preparer,
    issuer,
    clerk,
    treasurer,
    invoice,
  }
}

test.group('Vendas | notas de crédito e débito, devoluções e reembolsos (10.8)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('nota de crédito/débito: referência à factura, elegível por linha, imposto original, crédito e reembolso confirmado', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const a = await o.invoice('2') // 1 100,00
    const line = a.lines[0].id
    const base = {
      kind: 'CREDIT',
      invoiceId: a.id,
      reasonCode: 'DAMAGE',
      reason: 'Instalação incompleta',
      noteDate: today(),
    }
    // Validações: motivo do outro tipo, quantidade acima do facturado, valor acima do líquido.
    assert.include(
      paths(
        await o.preparer.post(N, {
          ...base,
          reasonCode: 'INTEREST',
          lines: [{ invoiceLineId: line, mode: 'QUANTITY', quantity: '1' }],
        })
      ),
      'reasonCode'
    )
    assert.include(
      paths(
        await o.preparer.post(N, {
          ...base,
          lines: [{ invoiceLineId: line, mode: 'QUANTITY', quantity: '3' }],
        })
      ),
      'lines.0.quantity'
    )
    assert.include(
      paths(
        await o.preparer.post(N, {
          ...base,
          lines: [{ invoiceLineId: line, mode: 'VALUE', amount: '1000.01' }],
        })
      ),
      'lines.0.amount'
    )
    // Factura em rascunho não se corrige.
    const draft = ok(
      await o.api.post(`${S}/invoices`, {
        legalEntityId: o.le.id,
        customerId: o.c1.id,
        invoiceDate: today(),
        lines: [{ productId: o.sv.id, quantity: '1', taxCodeIds: [o.t10.id] }],
      })
    )
    assert.equal(
      code(
        await o.preparer.post(N, {
          ...base,
          invoiceId: draft.id,
          lines: [{ invoiceLineId: draft.lines[0].id, mode: 'QUANTITY', quantity: '1' }],
        })
      ),
      'INVOICE_NOT_ISSUED'
    )

    // Crédito de 1 unidade: 500 + 10 % = 550, com o imposto da linha original.
    let nc = ok(
      await o.preparer.post(N, {
        ...base,
        lines: [{ invoiceLineId: line, mode: 'QUANTITY', quantity: '1' }],
      })
    )
    assert.deepEqual(
      [nc.status, nc.netTotal, nc.taxTotal, nc.payableTotal, nc.lines[0].taxes[0].rate],
      ['DRAFT', '500.00', '50.00', '550.00', a.lines[0].taxes[0].rate]
    )
    assert.deepEqual([nc.invoice.number, nc.customerSnapshot], [a.number, a.customerSnapshot])
    // Quem preparou não emite a nota de crédito.
    assert.equal(
      code(await o.preparer.post(`${N}/${nc.id}/issue`, { expectedVersion: nc.version })),
      'SELF_ISSUE'
    )
    nc = ok(await o.issuer.post(`${N}/${nc.id}/issue`, { expectedVersion: nc.version }), 200)
    assert.deepEqual(
      [nc.status, nc.number, nc.fiscalStatus, nc.appliedTotal, nc.availableCredit],
      ['ISSUED', 'NC A/1', 'PENDING', '550.00', '0.00']
    )
    let inv = ok(await o.api.get(`${S}/invoices/${a.id}`), 200)
    assert.deepEqual(
      [
        inv.status,
        inv.creditedTotal,
        inv.openTotal,
        inv.collectionStatus,
        inv.correctionNotes.length,
      ],
      ['CORRECTED', '550.00', '550.00', 'PARTIAL', 1]
    )
    // A factura original não mudou (conteúdo imutável).
    assert.deepEqual(
      [inv.payableTotal, inv.number, inv.documentHash],
      [a.payableTotal, a.number, a.documentHash]
    )
    // Elegível: resta 1 unidade e 500,00; creditar 2 unidades é recusado.
    const el = ok(await o.preparer.get(`${N}/eligible/${a.id}`), 200)
    assert.deepEqual([el.lines[0].remainingQty, el.lines[0].remainingNet], ['1.000000', '500.00'])
    assert.include(
      paths(
        await o.preparer.post(N, {
          ...base,
          lines: [{ invoiceLineId: line, mode: 'QUANTITY', quantity: '2' }],
        })
      ),
      'lines.0.quantity'
    )
    // Duas notas pelo mesmo resto emitidas em simultâneo: uma passa, a outra é recusada.
    const d1 = ok(
      await o.preparer.post(N, {
        ...base,
        lines: [{ invoiceLineId: line, mode: 'QUANTITY', quantity: '1' }],
      })
    )
    const d2 = ok(
      await o.preparer.post(N, {
        ...base,
        lines: [{ invoiceLineId: line, mode: 'QUANTITY', quantity: '1' }],
      })
    )
    const both = await Promise.all([
      o.issuer.post(`${N}/${d1.id}/issue`, { expectedVersion: d1.version }),
      o.issuer.post(`${N}/${d2.id}/issue`, { expectedVersion: d2.version }),
    ])
    assert.deepEqual(both.map((r) => r.status()).sort(), [200, 422])
    inv = ok(await o.api.get(`${S}/invoices/${a.id}`), 200)
    assert.deepEqual(
      [inv.creditedTotal, inv.openTotal, inv.collectionStatus],
      ['1100.00', '0.00', 'PAID']
    )
    // Número sem saltos: a nota recusada não gastou número.
    const numbers = (
      await owner().rawQuery(
        `select number from sales_notes where tenant_id = ? and number is not null order by fiscal_number`,
        [o.tenant.id]
      )
    ).rows.map((x: any) => x.number)
    assert.deepEqual(numbers, ['NC A/1', 'NC A/2'])

    // Nota de débito sobre outra factura: aumenta a dívida.
    const b = await o.invoice('1') // 550,00
    let nd = ok(
      await o.preparer.post(N, {
        kind: 'DEBIT',
        invoiceId: b.id,
        reasonCode: 'ADDITIONAL_CHARGE',
        reason: 'Deslocação adicional',
        noteDate: today(),
        lines: [{ invoiceLineId: b.lines[0].id, mode: 'VALUE', amount: '100' }],
      })
    )
    assert.equal(
      code(
        await o.preparer.post(N, {
          kind: 'DEBIT',
          invoiceId: b.id,
          reasonCode: 'ADDITIONAL_CHARGE',
          reason: 'Deslocação adicional',
          noteDate: today(),
          lines: [{ invoiceLineId: b.lines[0].id, mode: 'QUANTITY', quantity: '1' }],
        })
      ),
      'VALIDATION_ERROR'
    )
    nd = ok(await o.preparer.post(`${N}/${nd.id}/issue`, { expectedVersion: nd.version }), 200)
    assert.deepEqual([nd.number, nd.payableTotal], ['ND A/1', '110.00'])
    inv = ok(await o.api.get(`${S}/invoices/${b.id}`), 200)
    assert.deepEqual(
      [inv.debitedTotal, inv.openTotal, inv.status],
      ['110.00', '660.00', 'CORRECTED']
    )

    // Factura paga: recibo de 660 confirmado; depois uma nota de crédito fica toda como crédito do cliente.
    let rc = ok(
      await o.clerk.post(`${S}/receipts`, {
        requestKey: 'rec-000001',
        legalEntityId: o.le.id,
        customerId: o.c1.id,
        amount: '660',
        method: 'CASH',
        receivedDate: today(),
        allocations: [{ invoiceId: b.id, amount: '660' }],
      })
    )
    rc = ok(
      await o.treasurer.post(`${S}/receipts/${rc.id}/confirm`, { expectedVersion: rc.version }),
      200
    )
    inv = ok(await o.api.get(`${S}/invoices/${b.id}`), 200)
    assert.deepEqual([inv.collectionStatus, inv.openTotal], ['PAID', '0.00'])
    let nb = ok(
      await o.preparer.post(N, {
        kind: 'CREDIT',
        invoiceId: b.id,
        reasonCode: 'PRICE_CORRECTION',
        reason: 'Preço acordado era inferior',
        noteDate: today(),
        lines: [{ invoiceLineId: b.lines[0].id, mode: 'VALUE', amount: '200' }],
      })
    )
    nb = ok(await o.issuer.post(`${N}/${nb.id}/issue`, { expectedVersion: nb.version }), 200)
    assert.deepEqual(
      [nb.payableTotal, nb.appliedTotal, nb.availableCredit],
      ['220.00', '0.00', '220.00']
    )
    // Crédito usado noutra factura (compensação) e o resto reembolsado.
    const c = await o.invoice('1') // 550,00
    nb = ok(
      await o.preparer.post(`${N}/${nb.id}/apply-credit`, {
        expectedVersion: nb.version,
        invoiceId: c.id,
        amount: '100',
      }),
      200
    )
    assert.deepEqual([nb.appliedTotal, nb.availableCredit], ['100.00', '120.00'])
    inv = ok(await o.api.get(`${S}/invoices/${c.id}`), 200)
    assert.deepEqual([inv.collectionStatus, inv.openTotal], ['PARTIAL', '450.00'])
    const R = `${N}/${nb.id}/refunds`
    const refund = { requestKey: 'ref-000001', amount: '120', method: 'CASH', refundDate: today() }
    assert.equal(code(await o.clerk.post(R, { ...refund, amount: '150' })), 'OVER_REFUND')
    assert.include(paths(await o.clerk.post(R, { ...refund, method: 'TRANSFER' })), 'reference')
    nb = ok(await o.clerk.post(R, refund))
    assert.equal(ok(await o.clerk.post(R, refund)).refunds.length, 1) // idempotente
    assert.equal(code(await o.clerk.post(R, { ...refund, amount: '100' })), 'IDEMPOTENCY_MISMATCH')
    // O pendente reserva o crédito: nada mais se reembolsa nem se aplica.
    assert.equal(
      code(await o.clerk.post(R, { ...refund, requestKey: 'ref-000002', amount: '1' })),
      'OVER_REFUND'
    )
    assert.deepEqual(
      [nb.refundedTotal, nb.pendingRefunds, nb.availableCredit],
      ['0.00', '120.00', '0.00']
    )
    const f = nb.refunds[0]
    nb = ok(
      await o.treasurer.post(`${S}/refunds/${f.id}/confirm`, { expectedVersion: f.version }),
      200
    )
    assert.deepEqual(
      [nb.refundedTotal, nb.refunds[0].status, nb.availableCredit],
      ['120.00', 'CONFIRMED', '0.00']
    )

    // Imutabilidade na base: nota emitida, linhas, aplicações, totais da factura que nunca descem.
    for (const sql of [
      `update sales_notes set net_total = 1 where id = '${nc.id}'`,
      `update sales_notes set status = 'DRAFT' where id = '${nc.id}'`,
      `delete from sales_note_lines where note_id = '${nc.id}'`,
      `delete from sales_note_applications where note_id = '${nc.id}'`,
      `update sales_invoices set credited_total = 0 where id = '${a.id}'`,
      `update sales_refunds set amount = 1 where id = '${f.id}'`,
    ])
      await assert.rejects(() => owner().rawQuery(sql))
    const audits = await owner().rawQuery(
      `select action from audit_events where tenant_id = ? and entity_id = ? order by created_at`,
      [o.tenant.id, nb.id]
    )
    assert.includeMembers(
      audits.rows.map((x: any) => x.action),
      [
        'sales_note.created',
        'sales_note.issued',
        'sales_note.credit_applied',
        'sales_refund.registered',
        'sales_refund.confirmed',
      ]
    )
  })

  test('devolução física distinta da nota: entra no stock, deixa de ser facturável, crédito ligado à devolução', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    let so = ok(
      await o.api.post(`${S}/orders`, {
        legalEntityId: o.le.id,
        customerId: o.c1.id,
        warehouseId: o.wh.id,
        orderDate: today(),
        lines: [
          { productId: o.p.id, quantity: '5', taxRate: '10' },
          { productId: o.sv.id, quantity: '1', taxRate: '10' },
        ],
      })
    )
    so = ok(await o.api.post(`${S}/orders/${so.id}/submit`, { expectedVersion: so.version }), 200)
    const [pl, sl] = so.lines
    so = ok(
      await o.api.post(`${S}/orders/${so.id}/deliver`, {
        expectedVersion: so.version,
        requestKey: 'entrega-0001',
        deliveryDate: today(),
        lines: [
          { lineId: pl.id, quantity: '3' },
          { lineId: sl.id, quantity: '1' },
        ],
      }),
      200
    )
    let inv = ok(
      await o.api.post(`${S}/invoices`, {
        orderId: so.id,
        invoiceDate: today(),
        lines: [
          { orderLineId: pl.id, quantity: '3', taxCodeIds: [o.t10.id] },
          { orderLineId: sl.id, quantity: '1', taxCodeIds: [o.t10.id] },
        ],
      })
    )
    inv = ok(
      await o.api.post(`${S}/invoices/${inv.id}/issue`, { expectedVersion: inv.version }),
      200
    )
    const stock = async () =>
      (
        await owner().rawQuery(
          `select coalesce(sum(qty_unrestricted), 0)::text as q from stock_balances where tenant_id = ? and product_id = ?`,
          [o.tenant.id, o.p.id]
        )
      ).rows[0].q
    assert.equal(Number(await stock()), 7)
    const R = `${S}/orders/${so.id}/returns`
    const ret = {
      requestKey: 'devol-0001',
      returnDate: today(),
      reason: 'Bomba com defeito',
      lines: [{ lineId: pl.id, quantity: '1' }],
    }
    so = ok(await o.api.get(`${S}/orders/${so.id}`), 200)
    assert.equal(
      code(
        await o.api.post(R, {
          ...ret,
          expectedVersion: so.version,
          lines: [{ lineId: sl.id, quantity: '1' }],
        })
      ),
      'VALIDATION_ERROR'
    )
    assert.include(
      paths(
        await o.api.post(R, {
          ...ret,
          expectedVersion: so.version,
          lines: [{ lineId: pl.id, quantity: '4' }],
        })
      ),
      'lines.0.quantity'
    )
    so = ok(await o.api.post(R, { ...ret, expectedVersion: so.version }), 200)
    assert.deepEqual(
      [so.lines[0].returnedQty, so.returns.length, so.returns[0].reference],
      ['1.000000', 1, `${so.number}/D1`]
    )
    // Repetir o mesmo pedido não devolve duas vezes; outro corpo com a mesma chave é recusado.
    so = ok(await o.api.post(R, { ...ret, expectedVersion: so.version }), 200)
    assert.equal(so.returns.length, 1)
    assert.equal(
      code(await o.api.post(R, { ...ret, expectedVersion: so.version, reason: 'Outro motivo' })),
      'IDEMPOTENCY_MISMATCH'
    )
    assert.equal(Number(await stock()), 8)
    // A devolução não mexe na factura: a correcção fiscal é a nota.
    let fi = ok(await o.api.get(`${S}/invoices/${inv.id}`), 200)
    assert.deepEqual([fi.status, fi.creditedTotal], ['ISSUED', '0.00'])

    // Nota ligada à devolução: não credita por devolução mais do que voltou.
    const el = ok(await o.preparer.get(`${N}/eligible/${inv.id}`), 200)
    assert.deepEqual(
      el.returns.map((r: any) => r.reference),
      [`${so.number}/D1`]
    )
    const body = {
      kind: 'CREDIT',
      invoiceId: inv.id,
      returnId: so.returns[0].id,
      reasonCode: 'RETURN',
      reason: 'Devolução de bomba com defeito',
      noteDate: today(),
    }
    const invLine = inv.lines.find((l: any) => l.orderLineId === pl.id).id
    assert.include(
      paths(
        await o.preparer.post(N, {
          ...body,
          lines: [{ invoiceLineId: invLine, mode: 'QUANTITY', quantity: '2' }],
        })
      ),
      'lines.0.quantity'
    )
    let nc = ok(
      await o.preparer.post(N, {
        ...body,
        lines: [{ invoiceLineId: invLine, mode: 'QUANTITY', quantity: '1' }],
      })
    )
    nc = ok(await o.issuer.post(`${N}/${nc.id}/issue`, { expectedVersion: nc.version }), 200)
    assert.deepEqual(
      [nc.returnDoc.reference, nc.netTotal, nc.payableTotal],
      [`${so.number}/D1`, '100.00', '110.00']
    )
    fi = ok(await o.api.get(`${S}/invoices/${inv.id}`), 200)
    assert.deepEqual([fi.status, fi.creditedTotal, fi.openTotal], ['CORRECTED', '110.00', '770.00'])

    // Devolução antes de facturar: o devolvido deixa de ser facturável e a encomenda fecha.
    so = ok(await o.api.get(`${S}/orders/${so.id}`), 200)
    assert.equal(so.lines[0].returnCreditedQty, '1.000000')
    so = ok(
      await o.api.post(`${S}/orders/${so.id}/deliver`, {
        expectedVersion: so.version,
        requestKey: 'entrega-0002',
        deliveryDate: today(),
        lines: [{ lineId: pl.id, quantity: '2' }],
      }),
      200
    )
    so = ok(
      await o.api.post(R, {
        ...ret,
        requestKey: 'devol-0002',
        expectedVersion: so.version,
        lines: [{ lineId: pl.id, quantity: '1' }],
      }),
      200
    )
    const d = ok(await o.api.get(`${S}/invoices/order-draft/${so.id}`), 200)
    assert.deepEqual(
      d.lines.map((l: any) => l.invoiceable),
      ['1.000000']
    )
    let inv2 = ok(
      await o.api.post(`${S}/invoices`, {
        orderId: so.id,
        invoiceDate: today(),
        lines: [{ orderLineId: pl.id, quantity: '1', taxCodeIds: [o.t10.id] }],
      })
    )
    inv2 = ok(
      await o.api.post(`${S}/invoices/${inv2.id}/issue`, { expectedVersion: inv2.version }),
      200
    )
    so = ok(await o.api.get(`${S}/orders/${so.id}`), 200)
    assert.deepEqual(
      [so.invoicingStatus, so.status, so.lines[0].returnedQty],
      ['FULL', 'CLOSED', '2.000000']
    )
    // Base: devoluções e linhas só de acréscimo; nunca mais devolvido do que expedido.
    for (const sql of [
      `delete from sales_returns where order_id = '${so.id}'`,
      `update sales_return_lines set quantity = 9`,
      `update sales_order_lines set returned_qty = 99 where id = '${pl.id}'`,
    ])
      await assert.rejects(() => owner().rawQuery(sql))
  })
})
