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

/*
 * QA do Prompt 09 (9.12): o ciclo completo das compras sobre os mesmos documentos —
 * Requisição → Aprovação → Cotação → Adjudicação → OC → Recepção única → Factura validada → Obrigação financeira única —
 * com os ataques pedidos (aprovações, pedidos duplicados, preço/quantidade, recepção repetida, facturas duplicadas,
 * conferência e pagamentos em paralelo), a rastreabilidade de cada passo e o isolamento entre empresas.
 */

const P = '/api/v1/procurement'
const O = `${P}/orders`
const R = `${P}/receipts`
const F = `${P}/invoices`
const PY = `${P}/payables`
const ORG = '/api/v1/organization'
const owner = () => db.connection('owner')
const ok = (r: any, status = 201) => {
  if (r.status() !== status) throw new Error(`${r.status()} ${JSON.stringify(r.body())}`)
  return r.body().data
}
const code = (r: any) => r.body().error?.code
const details = (r: any) => (r.body().error?.details ?? []).map((d: any) => d.code)
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
const statuses = (rs: any[]) => rs.map((r) => r.status()).sort()

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

test.group('Compras | QA do ciclo completo (9.12)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('requisição → cotação → adjudicação → ordem → recepção única → factura → obrigação única, com ataques e isolamento', async ({
    client,
    assert,
  }) => {
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
    const dept = ok(
      await api.post(`${ORG}/departments`, {
        code: 'MAN',
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
        code: 'ARM',
        name: 'Armazém',
        legalEntityId: le.id,
        warehouseType: 'MAIN',
      })
    )
    const chief = await member(client, s, 'chefe', [
      [
        [
          'procurement.suppliers.approve',
          'procurement.requisitions.approve',
          'procurement.rfqs.approve',
          'procurement.orders.approve',
          'procurement.invoices.approve',
        ],
        'TENANT',
      ],
    ])
    const buyer = await member(client, s, 'compra', [
      [
        [
          'procurement.rfqs.manage',
          'procurement.rfqs.approve',
          'procurement.orders.manage',
          'procurement.receipts.manage',
          'procurement.invoices.manage',
        ],
        'LEGAL_ENTITY',
        le.id,
      ],
    ])
    const treasurer = await member(client, s, 'tesouraria', [
      [['procurement.payables.pay'], 'LEGAL_ENTITY', le.id],
    ])
    const supplier = async (n: number) => {
      let sup = ok(
        await api.post(`${P}/suppliers`, {
          supplierType: 'GOODS',
          currency: 'AOA',
          paymentTermsDays: 30,
          partner: {
            code: `FORN-${n}`,
            name: `Fornecedor ${n}`,
            partnerType: 'ORGANIZATION',
            taxId: `541700006${n}`,
            countryCode: 'AO',
          },
        })
      )
      sup = ok(
        await api.post(`${P}/suppliers/${sup.id}/submit`, {
          expectedVersion: sup.version,
          items: [],
        }),
        200
      )
      // Homologação segregada: quem regista não homologa.
      assert.equal(
        code(await api.post(`${P}/suppliers/${sup.id}/approve`, { expectedVersion: sup.version })),
        'SELF_APPROVAL'
      )
      return ok(
        await chief.post(`${P}/suppliers/${sup.id}/approve`, { expectedVersion: sup.version }),
        200
      )
    }
    const s1 = await supplier(1)
    const s2 = await supplier(2)
    for (const [t, c] of [
      ['PURCHASE_REQUISITION', 'RC'],
      ['RFQ', 'PC'],
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
    ok(
      await api.post(`${P}/approval-levels`, {
        code: 'CHEFIA',
        name: 'Chefia',
        sequence: 1,
        minAmount: '0',
      })
    )
    ok(
      await api.post(`${P}/budgets`, {
        costCenterId: cc.id,
        fiscalYear: new Date().getFullYear(),
        amount: '50000',
      })
    )
    const budget = async () => ok(await api.get(`${P}/budgets`), 200)[0]

    // 1. Requisição: aprovação segregada; aprovar duas vezes não volta a aprovar.
    let req = ok(
      await api.post(`${P}/requisitions`, {
        departmentId: dept.id,
        costCenterId: cc.id,
        neededBy: day(20),
        purpose: 'Substituição das bombas da estação',
        lines: [{ productId: pump.id, quantity: '10', estimatedUnitPrice: '1000' }],
      })
    )
    req = ok(
      await api.post(`${P}/requisitions/${req.id}/submit`, { expectedVersion: req.version }),
      200
    )
    assert.equal(
      code(await api.post(`${P}/requisitions/${req.id}/approve`, { expectedVersion: req.version })),
      'SELF_APPROVAL'
    )
    const twice = await Promise.all([
      chief.post(`${P}/requisitions/${req.id}/approve`, { expectedVersion: req.version }),
      chief.post(`${P}/requisitions/${req.id}/approve`, { expectedVersion: req.version }),
    ])
    assert.deepEqual(statuses(twice), [200, 409])
    req = ok(await api.get(`${P}/requisitions/${req.id}`), 200)
    assert.equal(req.status, 'APPROVED')
    assert.equal((await budget()).committedRequisitions, '10000.00')

    // 2. Cotação com dois fornecedores; a proposta repetida substitui a anterior (uma activa por fornecedor).
    let r = ok(
      await buyer.post(`${P}/rfqs`, {
        legalEntityId: le.id,
        title: 'Bombas',
        closesAt: new Date(Date.now() + 86_400_000).toISOString(),
        supplierIds: [s1.id, s2.id],
        lines: [{ requisitionLineId: req.lines[0].id }],
      })
    )
    r = ok(await buyer.post(`${P}/rfqs/${r.id}/issue`, { expectedVersion: r.version }), 200)
    const quote = (sup: any, price: string) =>
      buyer.post(`${P}/rfqs/${r.id}/quotes`, {
        supplierId: sup.id,
        validUntil: day(30),
        lines: [{ rfqLineId: r.lines[0].id, quantity: '10', unitPrice: price, taxRate: '14' }],
      })
    ok(await quote(s1, '1100'))
    ok(await quote(s2, '1050'))
    r = ok(await quote(s2, '1000'))
    assert.lengthOf(
      r.quotes.filter((q: any) => q.supplier.id === s2.id && q.status === 'ACTIVE'),
      1
    )
    r = ok(await buyer.post(`${P}/rfqs/${r.id}/open`, { expectedVersion: r.version }), 200)
    const best = r.quotes.find((q: any) => q.supplier.id === s2.id && q.status === 'ACTIVE')
    // 3. Adjudicação ao mais barato; quem submete não aprova; ordens geradas uma só vez (pedidos em paralelo).
    let a = ok(
      await buyer.post(`${P}/rfqs/${r.id}/awards`, {
        weights: { price: 100, delivery: 0, quality: 0, payment: 0 },
        justification: 'Melhor preço.',
        lines: [{ quoteLineId: best.lines[0].id, quantity: '10' }],
      })
    )
    a = ok(await buyer.post(`${P}/rfq-awards/${a.id}/submit`, { expectedVersion: a.version }), 200)
    assert.equal(
      code(await buyer.post(`${P}/rfq-awards/${a.id}/approve`, { expectedVersion: a.version })),
      'SELF_APPROVAL'
    )
    a = ok(await chief.post(`${P}/rfq-awards/${a.id}/approve`, { expectedVersion: a.version }), 200)
    const gen = await Promise.all([
      buyer.post(`${P}/rfq-awards/${a.id}/orders`),
      buyer.post(`${P}/rfq-awards/${a.id}/orders`),
    ])
    assert.deepEqual(statuses(gen), [201, 409])
    const orderId = gen.find((x) => x.status() === 201)!.body().data.ids[0]

    // 4. Ordem: armazém e centro de custo; aprovação segregada; emissões em paralelo emitem uma vez.
    let po = ok(await buyer.get(`${O}/${orderId}`), 200)
    assert.equal(po.supplier.id, s2.id)
    po = ok(
      await buyer.put(`${O}/${po.id}`, {
        supplierId: s2.id,
        warehouseId: wh.id,
        costCenterId: cc.id,
        lines: po.lines.map((l: any) => ({
          id: l.id,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          discountRate: l.discountRate,
          taxRate: l.taxRate,
          description: l.description,
        })),
        expectedVersion: po.version,
      }),
      200
    )
    // Preço/quantidade: a ordem não encomenda mais do que a requisição tem em aberto.
    const over = await buyer.post(O, {
      legalEntityId: le.id,
      supplierId: s1.id,
      lines: [{ requisitionLineId: req.lines[0].id, quantity: '11', unitPrice: '1' }],
    })
    assert.equal(over.status(), 422)
    assert.include(details(over), 'OVER_OPEN')
    po = ok(await buyer.post(`${O}/${po.id}/submit`, { expectedVersion: po.version }), 200)
    assert.equal(
      code(await buyer.post(`${O}/${po.id}/approve`, { expectedVersion: po.version })),
      'OUT_OF_SCOPE'
    )
    po = ok(await chief.post(`${O}/${po.id}/approve`, { expectedVersion: po.version }), 200)
    const issued = await Promise.all([
      buyer.post(`${O}/${po.id}/issue`, { expectedVersion: po.version }),
      buyer.post(`${O}/${po.id}/issue`, { expectedVersion: po.version }),
    ])
    assert.deepEqual(statuses(issued), [200, 409])
    po = ok(await buyer.get(`${O}/${po.id}`), 200)
    assert.match(po.number, /^OC-/)
    assert.equal(ok(await api.get(`${P}/requisitions/${req.id}`), 200).status, 'ORDERED')
    // A verba passa da requisição para a ordem, sem contar duas vezes.
    assert.deepInclude(await budget(), {
      committedRequisitions: '0.00',
      committedOrders: '10000.00',
      available: '40000.00',
    })

    // 5. Recepção única: dois rascunhos de 6 (há 10 por receber) confirmados em paralelo — entra um.
    const draft = async () =>
      ok(
        await buyer.post(R, {
          orderId: po.id,
          lines: [{ orderLineId: po.lines[0].id, quantity: '6' }],
        })
      )
    const [d1, d2] = [await draft(), await draft()]
    const conf = await Promise.all([
      buyer.post(`${R}/${d1.id}/confirm`, { expectedVersion: d1.version }),
      buyer.post(`${R}/${d2.id}/confirm`, { expectedVersion: d2.version }),
    ])
    assert.deepEqual(statuses(conf), [200, 422])
    const okConf = conf.find((x) => x.status() === 200)!.body().data
    assert.include(details(conf.find((x) => x.status() === 422)!), 'OVER_RECEIPT')
    // Repetir a confirmação não volta a lançar stock.
    assert.equal(
      code(await buyer.post(`${R}/${okConf.id}/confirm`, { expectedVersion: okConf.version })),
      'INVALID_STATE'
    )
    const postings = (
      await owner().rawQuery(
        `select count(*)::int as n, coalesce(sum(m.quantity), 0)::text as q from stock_postings p
           join stock_movements m on m.posting_id = p.id where p.source_type = 'PURCHASE_RECEIPT'`
      )
    ).rows[0] as any
    assert.deepEqual([postings.n, postings.q], [1, '6.000000'])

    // 6. Facturas duplicadas em paralelo: entra uma; validações em paralelo validam uma vez.
    const invBody = (n: string, q: string) => ({
      orderId: po.id,
      invoiceNumber: n,
      invoiceDate: day(0),
      declaredTotal: String(Number(q) * 1140),
      lines: [{ orderLineId: po.lines[0].id, quantity: q, unitPrice: '1000', taxRate: '14' }],
    })
    const dup = await Promise.all([
      buyer.post(F, invBody('INV-1', '6')),
      buyer.post(F, invBody('inv-1', '6')),
    ])
    assert.deepEqual(statuses(dup), [201, 409])
    assert.equal(code(dup.find((x) => x.status() === 409)!), 'DUPLICATE_INVOICE')
    const inv = dup.find((x) => x.status() === 201)!.body().data
    const val = await Promise.all([
      buyer.post(`${F}/${inv.id}/validate`, { expectedVersion: inv.version }),
      buyer.post(`${F}/${inv.id}/validate`, { expectedVersion: inv.version }),
    ])
    assert.deepEqual(statuses(val), [200, 409])
    // Conferência: mais do que o recebido pede excepção; a mesma pessoa não a autoriza.
    let extra = ok(await buyer.post(F, invBody('INV-2', '1')))
    extra = ok(
      await buyer.post(`${F}/${extra.id}/validate`, { expectedVersion: extra.version }),
      200
    )
    assert.equal(extra.status, 'PENDING_EXCEPTION')
    assert.deepEqual(
      extra.divergences.map((x: any) => x.code),
      ['QTY_OVER_RECEIVED']
    )
    ok(
      await buyer.post(`${F}/${extra.id}/refuse`, {
        expectedVersion: extra.version,
        reason: 'Não recebido',
      }),
      200
    )

    // 7. Obrigação financeira única; pagamentos em paralelo nunca passam o saldo.
    const payables = ok(await treasurer.get(PY), 200)
    assert.lengthOf(payables, 1)
    let p = ok(await treasurer.get(`${PY}/${payables[0].id}`), 200)
    assert.deepInclude(p, { amount: '6840.00', balance: '6840.00', status: 'OPEN' })
    const bank = (
      await owner().rawQuery(
        `insert into bank_accounts (tenant_id, legal_entity_id, holder_name, bank_name, account_number, currency, status)
         values (?, ?, 'Entidade A', 'Banco', '000111', 'AOA', 'ACTIVE') returning id`,
        [tenant.id, le.id]
      )
    ).rows[0] as { id: string }
    const pay = (ref: string) =>
      treasurer.post(`${PY}/${p.id}/payments`, {
        expectedVersion: p.version,
        bankAccountId: bank.id,
        amount: '4000',
        reference: ref,
      })
    const pays = await Promise.all([pay('TRF-1'), pay('TRF-2')])
    assert.include([409, 422], pays.map((x) => x.status()).sort()[1])
    assert.equal(pays.filter((x) => x.status() === 200).length, 1)
    p = ok(await treasurer.get(`${PY}/${p.id}`), 200)
    assert.deepInclude(p, { paidAmount: '4000.00', balance: '2840.00', status: 'PARTIALLY_PAID' })
    p = ok(
      await treasurer.post(`${PY}/${p.id}/payments`, {
        expectedVersion: p.version,
        bankAccountId: bank.id,
        amount: '2840',
        reference: 'TRF-3',
      }),
      200
    )
    assert.deepInclude(p, { status: 'SETTLED', balance: '0.00' })

    // 8. Rastreabilidade: da obrigação à requisição, e a auditoria de cada documento.
    assert.equal(p.invoice.id, inv.id)
    assert.equal(p.order.id, po.id)
    po = ok(await buyer.get(`${O}/${po.id}`), 200)
    assert.equal(po.award.id, a.id)
    assert.equal(po.award.rfqNumber, r.number)
    assert.equal(po.lines[0].requisition.lineId, req.lines[0].id)
    assert.deepInclude(po, {
      receiptStatus: 'PARTIALLY_RECEIVED',
      invoiceStatus: 'PARTIALLY_INVOICED',
    })
    const rc = ok(await buyer.get(`${R}/${okConf.id}`), 200)
    assert.equal(rc.order.id, po.id)
    const audited = (
      await owner().rawQuery(
        `select distinct entity_type from audit_events where tenant_id = ? and entity_id = any(?::uuid[])`,
        [tenant.id, [req.id, r.id, a.id, po.id, okConf.id, inv.id, p.id]]
      )
    ).rows.map((x: any) => x.entity_type)
    assert.includeMembers(audited, [
      'purchase_requisition',
      'rfq',
      'rfq_award',
      'purchase_order',
      'purchase_receipt',
      'purchase_invoice',
      'procurement_payable',
    ])
    // A verba fica realizada (6 000) e o resto da ordem comprometido (4 000).
    assert.deepInclude(await budget(), { committedOrders: '4000.00', actual: '6000.00' })

    // 9. Multiempresa: outra empresa não vê nenhum registo do ciclo; o cabeçalho forjado não abre a porta.
    const other = await tenantWithAdmin()
    const sb = await signIn(client, other.admin.email, other.tenant.id)
    const Bx = as(client, sb)
    for (const url of [
      `${P}/requisitions/${req.id}`,
      `${P}/rfqs/${r.id}`,
      `${P}/rfq-awards/${a.id}`,
      `${O}/${po.id}`,
      `${R}/${okConf.id}`,
      `${F}/${inv.id}`,
      `${PY}/${p.id}`,
      `${P}/suppliers/${s2.id}`,
    ])
      assert.equal((await Bx.get(url)).status(), 404, url)
    for (const url of [`${P}/requisitions`, `${P}/rfqs`, O, R, F, PY])
      assert.lengthOf((await Bx.get(url)).body().data, 0, url)
    const spoof = as(client, { ...sb, tenantId: s.tenantId })
    for (const url of [`${O}/${po.id}`, `${F}/${inv.id}`, `${PY}/${p.id}`, O])
      assert.include([403, 404], (await spoof.get(url)).status(), url)
  })

  test('corridas: notas de crédito e verbas duplicadas em simultâneo dão 409, nunca 500', async ({
    client,
    assert,
  }) => {
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
    const chief = await member(client, s, 'chefe', [
      [['procurement.suppliers.approve', 'procurement.orders.approve'], 'TENANT'],
    ])
    let sup = ok(
      await api.post(`${P}/suppliers`, {
        supplierType: 'SERVICES',
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
      await api.post(`${P}/suppliers/${sup.id}/submit`, {
        expectedVersion: sup.version,
        items: [],
      }),
      200
    )
    sup = ok(
      await chief.post(`${P}/suppliers/${sup.id}/approve`, { expectedVersion: sup.version }),
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
    // Serviço recebido e facturado (sem stock).
    let po = ok(
      await api.post(O, {
        legalEntityId: le.id,
        supplierId: sup.id,
        lines: [{ description: 'Manutenção anual', quantity: '1', unitPrice: '10000' }],
      })
    )
    po = ok(await api.post(`${O}/${po.id}/submit`, { expectedVersion: po.version }), 200)
    po = ok(await chief.post(`${O}/${po.id}/approve`, { expectedVersion: po.version }), 200)
    po = ok(await api.post(`${O}/${po.id}/issue`, { expectedVersion: po.version }), 200)
    let rc = ok(
      await api.post(R, { orderId: po.id, lines: [{ orderLineId: po.lines[0].id, quantity: '1' }] })
    )
    rc = ok(await api.post(`${R}/${rc.id}/confirm`, { expectedVersion: rc.version }), 200)
    let inv = ok(
      await api.post(F, {
        orderId: po.id,
        invoiceNumber: 'INV-1',
        invoiceDate: day(0),
        declaredTotal: '10000',
        lines: [{ orderLineId: po.lines[0].id, quantity: '1', unitPrice: '10000' }],
      })
    )
    inv = ok(await api.post(`${F}/${inv.id}/validate`, { expectedVersion: inv.version }), 200)
    const cc = ok(
      await api.post(`${ORG}/cost-centers`, { code: 'CC1', name: 'Oficina', legalEntityId: le.id })
    )
    for (let round = 1; round <= 5; round++) {
      const note = () =>
        api.post(`${P}/credit-notes`, {
          invoiceId: inv.id,
          creditNoteNumber: `NC-${round}`,
          reason: 'Desconto',
          declaredTotal: '10',
          lines: [{ invoiceLineId: inv.lines[0].id, kind: 'PRICE', netAmount: '10' }],
        })
      const notes = await Promise.all([note(), note()])
      assert.deepEqual(statuses(notes), [201, 409], `notas, ronda ${round}`)
      assert.equal(code(notes.find((x) => x.status() === 409)!), 'DUPLICATE_CREDIT_NOTE')
      const budget = () =>
        api.post(`${P}/budgets`, { costCenterId: cc.id, fiscalYear: 2020 + round, amount: '1000' })
      const budgets = await Promise.all([budget(), budget()])
      assert.deepEqual(statuses(budgets), [201, 409], `verbas, ronda ${round}`)
      assert.equal(code(budgets.find((x) => x.status() === 409)!), 'BUDGET_EXISTS')
    }
    // Uma só de cada na base.
    const n = (
      await owner().rawQuery(
        `select (select count(*)::int from purchase_credit_notes) as notes, (select count(*)::int from procurement_budgets) as budgets`
      )
    ).rows[0] as any
    assert.deepEqual([n.notes, n.budgets], [5, 5])
  })
})
