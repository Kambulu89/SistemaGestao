import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import {
  as,
  cleanDatabase,
  createRole,
  memberWithRoles,
  type Session,
} from '#tests/support/fixtures'
import { ledger, ok } from '#tests/support/accounting'

const P = '/api/v1/procurement'
const O = `${P}/orders`
const R = `${P}/receipts`
const F = `${P}/invoices`
const CN = `${P}/credit-notes`
const PY = `${P}/payables`
const BG = `${P}/budgets`
const A = '/api/v1/accounting'
const ORG = '/api/v1/organization'
const owner = () => db.connection('owner')
const code = (r: any) => r.body().error?.code
const details = (r: any) => (r.body().error?.details ?? []).map((d: any) => d.code)
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
const YEAR = new Date().getFullYear()

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
  const L = await ledger(client)
  const { api, le } = L
  const le2 = ok(
    await api.post(`${ORG}/legal-entities`, {
      code: 'LE2',
      legalName: 'Entidade Dois, Lda.',
      taxId: '5000000002',
      countryCode: 'AO',
      functionalCurrency: 'AOA',
    })
  )
  const acc = async (c: string, nature: string, parentId: string | null, postable = false) =>
    ok(
      await api.post(`${A}/accounts`, {
        chartId: L.chart.id,
        code: c,
        name: `Conta ${c}`,
        level: parentId ? 'ACCOUNT' : 'CLASS',
        nature,
        parentId,
        ...(postable ? { postable: true } : {}),
      })
    )
  const c3 = await acc('3', 'ASSET', null)
  const stockAcc = await acc('32', 'ASSET', c3.id, true)
  const vat = await acc('34', 'ASSET', c3.id, true)
  const c2 = await acc('2', 'LIABILITY', null)
  const grir = await acc('22', 'LIABILITY', c2.id, true)
  const suppliers = await acc('23', 'LIABILITY', c2.id, true)
  const c6 = await acc('6', 'EXPENSE', null)
  const services = await acc('62', 'EXPENSE', c6.id, true)
  const variance = await acc('68', 'EXPENSE', c6.id, true)
  const rule = (source: string, event: string, lines: any[]) =>
    api.post(`${A}/posting-rules`, {
      legalEntityId: le.id,
      code: `${source}_${event}`.slice(0, 20),
      name: `${source} ${event}`,
      source,
      event,
      journalId: L.journal.id,
      autoPost: true,
      validFrom: '2026-01-01',
      lines,
    })
  // Inventário: a recepção lança stock contra "recepções por facturar" (22).
  ok(
    await rule('INVENTORY', 'RECEIPT_PURCHASE', [
      { side: 'DEBIT', accountId: stockAcc.id, amountKey: 'cls_mercadorias' },
      { side: 'CREDIT', accountId: grir.id, amountKey: 'value' },
    ])
  )
  // Compras: a factura salda o 22 pelo valor recebido; diferença, serviços e imposto; fornecedor a crédito.
  ok(
    await rule('PROCUREMENT', 'INVOICE', [
      { side: 'DEBIT', accountId: grir.id, amountKey: 'goodsReceived' },
      { side: 'DEBIT', accountId: variance.id, amountKey: 'priceVarianceUp' },
      { side: 'DEBIT', accountId: services.id, amountKey: 'services' },
      { side: 'DEBIT', accountId: vat.id, amountKey: 'tax' },
      { side: 'CREDIT', accountId: suppliers.id, amountKey: 'payable' },
      { side: 'CREDIT', accountId: variance.id, amountKey: 'priceVarianceDown' },
    ])
  )
  ok(
    await rule('PROCUREMENT', 'CREDIT_NOTE', [
      { side: 'DEBIT', accountId: suppliers.id, amountKey: 'payable' },
      { side: 'DEBIT', accountId: variance.id, amountKey: 'priceVarianceDown' },
      { side: 'CREDIT', accountId: grir.id, amountKey: 'goodsReceived' },
      { side: 'CREDIT', accountId: variance.id, amountKey: 'priceVarianceUp' },
      { side: 'CREDIT', accountId: services.id, amountKey: 'services' },
      { side: 'CREDIT', accountId: vat.id, amountKey: 'tax' },
    ])
  )
  const dept = ok(
    await api.post(`${ORG}/departments`, {
      code: 'MANUT',
      name: 'Manutenção',
      legalEntityId: le.id,
    })
  )
  const cc = ok(
    await api.post(`${ORG}/cost-centers`, { code: 'CC1', name: 'Oficina', legalEntityId: le.id })
  )
  const I = '/api/v1/inventory'
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
  const pump = ok(
    await api.post(`${I}/products`, {
      sku: 'BOMBA',
      name: 'Bomba de água',
      productType: 'STOCKABLE',
      baseUomId: un.id,
      categoryId: cat.id,
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
  const approver = await member(client, L.s, 'aprova', [
    [
      [
        'procurement.suppliers.approve',
        'procurement.requisitions.approve',
        'procurement.orders.approve',
      ],
      'TENANT',
    ],
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
    await approver.post(`${P}/suppliers/${sup.id}/approve`, { expectedVersion: sup.version }),
    200
  )
  for (const [t, c] of [
    ['PURCHASE_REQUISITION', 'RC'],
    ['PURCHASE_ORDER', 'OC'],
    ['PURCHASE_RECEIPT', 'RE'],
    ['PURCHASE_INVOICE', 'FF'],
    ['PURCHASE_CREDIT_NOTE', 'NC'],
  ])
    ok(
      await api.post('/api/v1/document-series', {
        legalEntityId: le.id,
        documentType: t,
        code: c,
        prefix: `${c}-`,
      })
    )
  ok(
    await api.post(`${P}/approval-levels`, {
      code: 'CHEFIA',
      name: 'Chefia',
      sequence: 1,
      minAmount: '0',
    })
  )
  ok(await api.put(`${P}/tolerances`, { pricePct: '5' }), 200)
  const buyer = await member(client, L.s, 'compra', [
    [
      [
        'procurement.orders.manage',
        'procurement.receipts.manage',
        'procurement.invoices.manage',
        'procurement.budgets.read',
      ],
      'LEGAL_ENTITY',
      le.id,
    ],
  ])
  const treasurer = await member(client, L.s, 'tesouraria', [
    [['procurement.payables.pay'], 'LEGAL_ENTITY', le.id],
  ])
  const viewer = await member(client, L.s, 'leitor', [
    [['procurement.payables.read', 'procurement.budgets.read'], 'LEGAL_ENTITY', le.id],
  ])
  const other = await member(client, L.s, 'outra', [
    [
      ['procurement.payables.pay', 'procurement.budgets.manage', 'procurement.budgets.read'],
      'LEGAL_ENTITY',
      le2.id,
    ],
  ])
  const bank = (
    await owner().rawQuery(
      `insert into bank_accounts (tenant_id, legal_entity_id, holder_name, bank_name, account_number, currency, status)
       values (?, ?, 'Entidade Um, Lda.', 'Banco Teste', '000123456789', 'AOA', 'ACTIVE') returning id`,
      [L.s.tenantId, le.id]
    )
  ).rows[0] as { id: string }
  const requisition = async (quantity: string, price: string) => {
    let req = ok(
      await api.post(`${P}/requisitions`, {
        departmentId: dept.id,
        costCenterId: cc.id,
        neededBy: day(20),
        purpose: 'Reparação da estação de bombagem',
        lines: [{ productId: pump.id, quantity, estimatedUnitPrice: price }],
      })
    )
    req = ok(
      await api.post(`${P}/requisitions/${req.id}/submit`, { expectedVersion: req.version }),
      200
    )
    return req
  }
  const approveReq = (req: any) =>
    approver.post(`${P}/requisitions/${req.id}/approve`, { expectedVersion: req.version })
  const balance = async (accountId: string) =>
    (
      (
        await owner().rawQuery(
          `select coalesce(sum(coalesce(l.debit, 0) - coalesce(l.credit, 0)), 0)::numeric(20, 2)::text as b from journal_lines l
             join journal_entries e on e.id = l.entry_id where l.account_id = ? and e.status = 'POSTED'`,
          [accountId]
        )
      ).rows[0] as any
    ).b as string
  return {
    L,
    api,
    le,
    cc,
    pump,
    wh,
    sup,
    approver,
    buyer,
    treasurer,
    viewer,
    other,
    bank,
    requisition,
    approveReq,
    balance,
    accounts: { stockAcc, grir, suppliers, variance, vat },
    rule,
  }
}

test.group('Compras | orçamento, obrigação a pagar e contabilidade (9.10)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('compromisso por centro de custo sem duplo bloqueio; verba com bloqueio; realizado na factura', async ({
    client,
    assert,
  }) => {
    const x = await setup(client)
    const B = x.buyer
    // Verba: só quem gere o orçamento da entidade do centro de custo.
    assert.equal(
      code(await B.post(BG, { costCenterId: x.cc.id, fiscalYear: YEAR, amount: '15000' })),
      'OUT_OF_SCOPE'
    )
    assert.equal(
      code(await x.other.post(BG, { costCenterId: x.cc.id, fiscalYear: YEAR, amount: '15000' })),
      'OUT_OF_SCOPE'
    )
    assert.includeMembers(
      details(
        await x.api.post(BG, {
          costCenterId: x.cc.id,
          fiscalYear: 1990,
          amount: '-1',
          control: 'X',
        })
      ),
      ['INVALID', 'INVALID', 'INVALID']
    )
    let bg = ok(await x.api.post(BG, { costCenterId: x.cc.id, fiscalYear: YEAR, amount: '15000' }))
    assert.deepInclude(bg, { amount: '15000.00', control: 'BLOCK', available: '15000.00' })
    assert.equal(
      code(await x.api.post(BG, { costCenterId: x.cc.id, fiscalYear: YEAR, amount: '1' })),
      'BUDGET_EXISTS'
    )
    // Requisição aprovada compromete 10 × 1 000.
    const r1 = await x.requisition('10', '1000')
    ok(await x.approveReq(r1), 200)
    const budget = async () => ok(await B.get(BG), 200)[0]
    assert.deepInclude(await budget(), {
      committedRequisitions: '10000.00',
      committedOrders: '0.00',
      actual: '0.00',
      available: '5000.00',
    })
    // A ordem encomenda 6 a 1 100: a requisição liberta 6 000, a ordem compromete 6 600 (não 16 600).
    let po = ok(
      await B.post(O, {
        legalEntityId: x.le.id,
        supplierId: x.sup.id,
        warehouseId: x.wh.id,
        costCenterId: x.cc.id,
        lines: [
          {
            requisitionLineId: r1.lines[0].id,
            quantity: '6',
            unitPrice: '1100',
            taxRate: '14',
          },
        ],
      })
    )
    po = ok(await B.post(`${O}/${po.id}/submit`, { expectedVersion: po.version }), 200)
    // Antes de emitida não compromete.
    assert.equal((await budget()).committedOrders, '0.00')
    po = ok(await x.approver.post(`${O}/${po.id}/approve`, { expectedVersion: po.version }), 200)
    po = ok(await B.post(`${O}/${po.id}/issue`, { expectedVersion: po.version }), 200)
    assert.deepInclude(await budget(), {
      committedRequisitions: '4000.00',
      committedOrders: '6600.00',
      available: '4400.00',
    })
    // Outra requisição de 5 000 passaria a verba: com bloqueio, a aprovação é recusada.
    const r2 = await x.requisition('5', '1000')
    const blocked = await x.approveReq(r2)
    assert.equal(code(blocked), 'BUDGET_EXCEEDED')
    assert.include(blocked.body().error.message, '600.00')
    assert.equal(ok(await x.api.get(`${P}/requisitions/${r2.id}`), 200).status, 'PENDING_APPROVAL')
    assert.equal((await budget()).available, '4400.00')
    // Só avisar: passa e o disponível fica negativo.
    bg = ok(
      await x.api.put(`${BG}/${bg.id}`, {
        expectedVersion: bg.version,
        amount: '15000',
        control: 'WARN',
      }),
      200
    )
    ok(await x.approveReq(r2), 200)
    assert.deepInclude(await budget(), {
      committedRequisitions: '9000.00',
      available: '-600.00',
      over: true,
    })
    // Recepção (stock a 1 100) e factura a 1 150 (+4,5%, dentro da tolerância de 5%).
    let rc = ok(
      await B.post(R, { orderId: po.id, lines: [{ orderLineId: po.lines[0].id, quantity: '6' }] })
    )
    rc = ok(await B.post(`${R}/${rc.id}/confirm`, { expectedVersion: rc.version }), 200)
    let inv = ok(
      await B.post(F, {
        orderId: po.id,
        invoiceNumber: 'INV-1',
        invoiceDate: day(0),
        declaredTotal: '7866.00',
        lines: [{ orderLineId: po.lines[0].id, quantity: '6', unitPrice: '1150', taxRate: '14' }],
      })
    )
    inv = ok(await B.post(`${F}/${inv.id}/validate`, { expectedVersion: inv.version }), 200)
    assert.equal(inv.status, 'VALIDATED')
    // A ordem facturada sai do comprometido e entra no realizado (líquido 6 900).
    assert.deepInclude(await budget(), {
      committedRequisitions: '9000.00',
      committedOrders: '0.00',
      actual: '6900.00',
      available: '-900.00',
    })
    // Movimentos por documento (para conferir de onde vem cada valor).
    const mv = ok(await B.get(`${BG}/${bg.id}`), 200)
    assert.sameDeepMembers(
      mv.documents.map((d: any) => [d.kind, d.sourceType, d.amount]),
      [
        ['COMMITMENT', 'REQUISITION', '4000.00'],
        ['COMMITMENT', 'REQUISITION', '5000.00'],
        ['ACTUAL', 'INVOICE', '6900.00'],
      ]
    )
    // O livro é só de acréscimo.
    await assert.rejects(() => owner().rawQuery(`update procurement_commitments set amount = 1`))
    await assert.rejects(() => owner().rawQuery(`delete from procurement_commitments`))
    // Fechar o resto da requisição liberta o compromisso.
    const r1now = ok(await x.api.get(`${P}/requisitions/${r1.id}`), 200)
    ok(
      await x.api.post(`${P}/requisitions/${r1.id}/close`, {
        expectedVersion: r1now.version,
        reason: 'Não são precisas mais',
      }),
      200
    )
    assert.equal((await budget()).committedRequisitions, '5000.00')
    // Leitura com âmbito: de outra entidade não aparece.
    assert.lengthOf(ok(await x.other.get(BG), 200), 0)
    assert.equal((await x.other.get(`${BG}/${bg.id}`)).status(), 404)
  })

  test('obrigação única por factura, notas de crédito, pagamentos e contabilização sem duplicar o inventário', async ({
    client,
    assert,
  }) => {
    const x = await setup(client)
    const B = x.buyer
    let po = ok(
      await B.post(O, {
        legalEntityId: x.le.id,
        supplierId: x.sup.id,
        warehouseId: x.wh.id,
        costCenterId: x.cc.id,
        lines: [
          { productId: x.pump.id, quantity: '6', unitPrice: '1100', taxRate: '14' },
          { description: 'Instalação no local', quantity: '1', unitPrice: '500' },
        ],
      })
    )
    po = ok(await B.post(`${O}/${po.id}/submit`, { expectedVersion: po.version }), 200)
    po = ok(await x.approver.post(`${O}/${po.id}/approve`, { expectedVersion: po.version }), 200)
    po = ok(await B.post(`${O}/${po.id}/issue`, { expectedVersion: po.version }), 200)
    let rc = ok(
      await B.post(R, {
        orderId: po.id,
        lines: [
          { orderLineId: po.lines[0].id, quantity: '6' },
          { orderLineId: po.lines[1].id, quantity: '1' },
        ],
      })
    )
    rc = ok(await B.post(`${R}/${rc.id}/confirm`, { expectedVersion: rc.version }), 200)
    // O inventário lançou 6 600 no stock contra as recepções por facturar.
    assert.equal(await x.balance(x.accounts.stockAcc.id), '6600.00')
    assert.equal(await x.balance(x.accounts.grir.id), '-6600.00')
    let inv = ok(
      await B.post(F, {
        orderId: po.id,
        invoiceNumber: 'INV-2',
        invoiceDate: day(0),
        declaredTotal: '8366.00',
        lines: [
          { orderLineId: po.lines[0].id, quantity: '6', unitPrice: '1150', taxRate: '14' },
          { orderLineId: po.lines[1].id, quantity: '1', unitPrice: '500' },
        ],
      })
    )
    inv = ok(await B.post(`${F}/${inv.id}/validate`, { expectedVersion: inv.version }), 200)
    // Uma obrigação a pagar, com vencimento pelo prazo do fornecedor.
    const list = ok(await x.treasurer.get(PY), 200)
    assert.lengthOf(list, 1)
    let p = ok(await x.treasurer.get(`${PY}/${list[0].id}`), 200)
    assert.deepInclude(p, {
      status: 'OPEN',
      amount: '8366.00',
      creditedAmount: '0.00',
      paidAmount: '0.00',
      balance: '8366.00',
      dueDate: day(30),
      overdue: false,
    })
    assert.equal(p.invoice.id, inv.id)
    // Contabilização da factura: salda as recepções (6 600) e lança só a diferença de preço (300), serviço e imposto.
    const ie = p.accounting.find((e: any) => e.documentType === 'INVOICE')
    assert.deepInclude(ie, { status: 'POSTED', event: 'INVOICE', total: '8366.00' })
    assert.deepInclude(ie.amounts, {
      goodsReceived: '6600.00',
      priceVarianceUp: '300.00',
      priceVarianceDown: '0.00',
      services: '500.00',
      tax: '966.00',
      payable: '8366.00',
    })
    assert.equal(await x.balance(x.accounts.grir.id), '0.00')
    assert.equal(await x.balance(x.accounts.stockAcc.id), '6600.00')
    assert.equal(await x.balance(x.accounts.suppliers.id), '-8366.00')
    // Uma só obrigação por factura (na base também).
    await assert.rejects(() =>
      owner().rawQuery(
        `insert into procurement_payables (tenant_id, legal_entity_id, supplier_id, order_id, invoice_id, currency, amount,
            exchange_rate, due_date) values (?, ?, ?, ?, ?, 'AOA', 1, 1, current_date)`,
        [x.L.s.tenantId, x.le.id, x.sup.id, po.id, inv.id]
      )
    )
    // Nota de crédito (desconto de 100 nas bombas): abate a obrigação; volta pela diferença de preço.
    ok(
      await x.api.post('/api/v1/document-series', {
        legalEntityId: x.le.id,
        documentType: 'PURCHASE_RETURN',
        code: 'DV',
        prefix: 'DV-',
      })
    )
    let n = ok(
      await B.post(CN, {
        invoiceId: inv.id,
        creditNoteNumber: 'NC-1',
        reason: 'Desconto comercial',
        declaredTotal: '114.00',
        lines: [{ invoiceLineId: inv.lines[0].id, kind: 'PRICE', netAmount: '100' }],
      })
    )
    n = ok(await B.post(`${CN}/${n.id}/validate`, { expectedVersion: n.version }), 200)
    p = ok(await x.treasurer.get(`${PY}/${p.id}`), 200)
    assert.deepInclude(p, { creditedAmount: '114.00', balance: '8252.00', status: 'OPEN' })
    const ce = p.accounting.find((e: any) => e.documentType === 'CREDIT_NOTE')
    assert.deepInclude(ce, { status: 'POSTED' })
    assert.deepInclude(ce.amounts, {
      goodsReceived: '0.00',
      priceVarianceUp: '100.00',
      tax: '14.00',
      payable: '114.00',
    })
    assert.equal(await x.balance(x.accounts.suppliers.id), '-8252.00')
    // Pagamentos: validações; só a tesouraria; nunca acima do saldo.
    const pay = (extra: Record<string, unknown>, who = x.treasurer) =>
      who.post(`${PY}/${p.id}/payments`, {
        expectedVersion: p.version,
        bankAccountId: x.bank.id,
        amount: '5000',
        reference: 'TRF-001',
        ...extra,
      })
    assert.equal(code(await pay({}, x.viewer)), 'OUT_OF_SCOPE')
    assert.equal(code(await pay({}, B)), 'NOT_FOUND')
    assert.equal((await x.other.get(`${PY}/${p.id}`)).status(), 404)
    assert.includeMembers(details(await pay({ amount: '9000', paidOn: day(1), reference: '' })), [
      'FUTURE',
      'REQUIRED',
    ])
    assert.include(details(await pay({ amount: '9000' })), 'OVER_BALANCE')
    assert.include(details(await pay({ bankAccountId: x.L.le.id })), 'INVALID')
    // Sem regra PAYMENT: o pagamento fica registado e o evento FALHADO (não bloqueia).
    p = ok(await pay({}), 200)
    assert.deepInclude(p, { status: 'PARTIALLY_PAID', paidAmount: '5000.00', balance: '3252.00' })
    let pe = p.accounting.find((e: any) => e.documentType === 'PAYMENT')
    assert.equal(pe.status, 'FAILED')
    assert.isNotNull(pe.error)
    assert.deepInclude(pe.amounts, {
      payable: '5000.00',
      bank: '5000.00',
      fxLoss: '0.00',
      fxGain: '0.00',
    })
    // Com a regra configurada, repetir lança (sem duplicar os já lançados).
    ok(
      await x.rule('PROCUREMENT', 'PAYMENT', [
        { side: 'DEBIT', accountId: x.accounts.suppliers.id, amountKey: 'payable' },
        { side: 'CREDIT', accountId: x.L.cash.id, amountKey: 'bank' },
      ])
    )
    assert.equal(code(await x.viewer.post(`${PY}/${p.id}/accounting/retry`, {})), 'OUT_OF_SCOPE')
    p = ok(await x.treasurer.post(`${PY}/${p.id}/accounting/retry`, {}), 200)
    pe = p.accounting.find((e: any) => e.documentType === 'PAYMENT')
    assert.equal(pe.status, 'POSTED')
    assert.lengthOf(
      p.accounting.filter((e: any) => e.status === 'POSTED'),
      3
    )
    // Segundo pagamento salda; nada mais a pagar.
    p = ok(await pay({ amount: '3252', reference: 'TRF-002', expectedVersion: p.version }), 200)
    assert.deepInclude(p, { status: 'SETTLED', balance: '0.00', paidAmount: '8252.00' })
    assert.isFalse(p.can.pay)
    assert.include(
      details(await pay({ amount: '1', reference: 'TRF-003', expectedVersion: p.version })),
      'OVER_BALANCE'
    )
    assert.equal(await x.balance(x.accounts.suppliers.id), '0.00')
    assert.equal(await x.balance(x.L.cash.id), '-8252.00')
    // Pagamentos só de acréscimo; a obrigação não se apaga nem reduz o pago.
    await assert.rejects(() => owner().rawQuery(`update procurement_payments set amount = 1`))
    await assert.rejects(() => owner().rawQuery(`update procurement_payables set paid_amount = 0`))
    await assert.rejects(() => owner().rawQuery(`delete from procurement_payables`))
    // Lista: filtro por estado e em atraso.
    assert.lengthOf(ok(await x.viewer.get(`${PY}?status=SETTLED`), 200), 1)
    assert.lengthOf(ok(await x.viewer.get(`${PY}?overdue=true`), 200), 0)
    const actions = (
      await owner().rawQuery(
        `select distinct action from audit_events where action like 'procurement_%' order by action`
      )
    ).rows.map((r: any) => r.action)
    assert.includeMembers(actions, [
      'procurement_payable.paid',
      'procurement_payable.accounting_retried',
    ])
  })
})
