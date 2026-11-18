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
  grants: [string[], string, string?][],
  extraRoleId?: string
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
  if (extraRoleId)
    ok(
      await as(client, admin).post(`/api/v1/members/${m.memberId}/roles`, {
        roleId: extraRoleId,
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
    await api.post(`${ORG}/legal-entities`, {
      code: 'LEA',
      legalName: 'Entidade A, Lda.',
      taxId: '5000000931',
      countryCode: 'AO',
      functionalCurrency: 'AOA',
    })
  )
  const le2 = ok(
    await api.post(`${ORG}/legal-entities`, {
      code: 'LEB',
      legalName: 'Entidade B, Lda.',
      taxId: '5000000932',
      countryCode: 'AO',
      functionalCurrency: 'AOA',
    })
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
  const wh = ok(
    await api.post('/api/v1/inventory/warehouses', {
      code: 'ARM-A',
      name: 'Armazém A',
      legalEntityId: le.id,
      warehouseType: 'MAIN',
    })
  )
  const wh2 = ok(
    await api.post('/api/v1/inventory/warehouses', {
      code: 'ARM-B',
      name: 'Armazém B',
      legalEntityId: le2.id,
      warehouseType: 'MAIN',
    })
  )
  const un = ok(
    await api.post('/api/v1/inventory/settings/uoms', {
      code: 'UN',
      name: 'Unidade',
      category: 'UNIT',
    })
  )
  const pump = ok(
    await api.post('/api/v1/inventory/products', {
      sku: 'BOMBA',
      name: 'Bomba de água',
      productType: 'STOCKABLE',
      baseUomId: un.id,
    })
  )
  const homolog = await member(client, s, 'homolog', [
    [['procurement.suppliers.approve', 'procurement.requisitions.approve'], 'TENANT'],
  ])
  const supplier = async (n: number, approve = true) => {
    let sup = ok(
      await api.post(`${P}/suppliers`, {
        supplierType: 'GOODS',
        currency: 'AOA',
        paymentTermsDays: 45,
        partner: {
          code: `FORN-${n}`,
          name: `Fornecedor ${n}`,
          partnerType: 'ORGANIZATION',
          taxId: `541700003${n}`,
          countryCode: 'AO',
        },
      })
    )
    if (!approve) return sup
    sup = ok(
      await api.post(`${P}/suppliers/${sup.id}/submit`, {
        expectedVersion: sup.version,
        items: [],
      }),
      200
    )
    return ok(
      await homolog.post(`${P}/suppliers/${sup.id}/approve`, { expectedVersion: sup.version }),
      200
    )
  }
  const s1 = await supplier(1)
  const draftSup = await supplier(2, false)
  ok(
    await api.post('/api/v1/document-series', {
      legalEntityId: le.id,
      documentType: 'PURCHASE_REQUISITION',
      code: 'RC',
      prefix: 'RC-',
    })
  )
  // Etapas: chefia sempre; direcção a partir de 1 000 000,00 AOA, só com o perfil de director.
  const director = await createRole(client, s, 'director', ['procurement.orders.approve'])
  ok(
    await api.post(`${P}/approval-levels`, {
      code: 'CHEFIA',
      name: 'Chefia',
      sequence: 1,
      minAmount: '0',
    })
  )
  ok(
    await api.post(`${P}/approval-levels`, {
      code: 'DIR',
      name: 'Direcção',
      sequence: 2,
      minAmount: '1000000.00',
      approverRoleId: director.id,
    })
  )
  let req = ok(
    await api.post(`${P}/requisitions`, {
      departmentId: dept.id,
      neededBy: day(20),
      purpose: 'Reparação da estação de bombagem',
      lines: [{ productId: pump.id, quantity: '10', estimatedUnitPrice: '1000' }],
    })
  )
  req = ok(
    await api.post(`${P}/requisitions/${req.id}/submit`, { expectedVersion: req.version }),
    200
  )
  req = ok(
    await homolog.post(`${P}/requisitions/${req.id}/approve`, { expectedVersion: req.version }),
    200
  )
  const buyer = await member(client, s, 'compra', [
    [
      ['procurement.orders.manage', 'procurement.rfqs.manage', 'procurement.rfqs.approve'],
      'LEGAL_ENTITY',
      le.id,
    ],
  ])
  const chief = await member(client, s, 'chefe', [
    [['procurement.orders.approve', 'procurement.rfqs.approve'], 'LEGAL_ENTITY', le.id],
  ])
  const chief2 = await member(client, s, 'chefe2', [
    [['procurement.orders.approve'], 'LEGAL_ENTITY', le.id],
  ])
  const boss = await member(client, s, 'dir', [], director.id)
  const viewer = await member(client, s, 'leitor', [
    [['procurement.orders.read'], 'LEGAL_ENTITY', le.id],
  ])
  const other = await member(client, s, 'outra', [
    [['procurement.orders.manage'], 'LEGAL_ENTITY', le2.id],
  ])
  const reqLine = req.lines[0].id as string
  const reqOf = async () => ok(await api.get(`${P}/requisitions/${req.id}`), 200)
  return {
    api,
    le,
    le2,
    cc,
    wh,
    wh2,
    pump,
    s1,
    draftSup,
    req,
    reqLine,
    reqOf,
    buyer,
    chief,
    chief2,
    boss,
    viewer,
    other,
    homolog,
  }
}

test.group('Compras | ordens de compra (9.5)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('ordem manual: linhas com desconto e imposto, aprovação com recusa e nova ronda, emissão numerada, revisão e fecho do resto', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const B = o.buyer
    const body = (extra: Record<string, unknown> = {}) => ({
      legalEntityId: o.le.id,
      supplierId: o.s1.id,
      costCenterId: o.cc.id,
      expectedDate: day(15),
      deliveryTerms: 'Entrega no armazém de Viana',
      lines: [
        {
          requisitionLineId: o.reqLine,
          quantity: '6',
          unitPrice: '1000',
          discountRate: '10',
          taxRate: '14',
        },
        { description: 'Transporte', quantity: '1', unitPrice: '5000' },
      ],
      ...extra,
    })
    // Validações e âmbito.
    assert.include(details(await B.post(O, body({ supplierId: o.draftSup.id }))), 'NOT_QUALIFIED')
    assert.equal(code(await o.other.post(O, body())), 'OUT_OF_SCOPE')
    assert.equal(code(await o.viewer.post(O, body())), 'OUT_OF_SCOPE')
    assert.include(details(await B.post(O, body({ warehouseId: o.wh2.id }))), 'NOT_FOUND')
    assert.include(details(await B.post(O, body({ expectedDate: day(-1) }))), 'INVALID')
    assert.include(
      details(
        await B.post(
          O,
          body({ lines: [{ requisitionLineId: o.reqLine, quantity: '11', unitPrice: '1' }] })
        )
      ),
      'OVER_OPEN'
    )
    assert.include(
      details(
        await B.post(
          O,
          body({
            lines: [{ description: 'X x x', quantity: '1', unitPrice: '1', discountRate: '101' }],
          })
        )
      ),
      'INVALID'
    )
    let po = ok(await B.post(O, body()))
    assert.deepInclude(po, {
      approvalStatus: 'DRAFT',
      receiptStatus: 'NOT_RECEIVED',
      invoiceStatus: 'NOT_INVOICED',
      number: null,
      currency: 'AOA',
      paymentTermsDays: 45,
      totalGross: '11000.00',
      totalDiscount: '600.00',
      totalNet: '10400.00',
      totalTax: '756.00',
      totalAmount: '11156.00',
    })
    assert.deepInclude(po.lines[0], {
      description: 'Bomba de água',
      grossAmount: '6000.00',
      discountAmount: '600.00',
      netAmount: '5400.00',
      taxAmount: '756.00',
      totalAmount: '6156.00',
    })
    assert.equal(po.lines[0].requisition.number, o.req.number)
    assert.equal(po.costCenter.code, 'CC1')
    // Produto armazenável exige armazém; outra entidade não vê.
    assert.equal(
      code(await B.post(`${O}/${po.id}/submit`, { expectedVersion: po.version })),
      'VALIDATION_ERROR'
    )
    assert.include(
      details(await B.post(`${O}/${po.id}/submit`, { expectedVersion: po.version })),
      'WAREHOUSE_REQUIRED'
    )
    assert.equal((await o.other.get(`${O}/${po.id}`)).status(), 404)
    po = ok(
      await B.put(`${O}/${po.id}`, {
        ...body({ warehouseId: o.wh.id }),
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
    assert.equal(po.warehouse.code, 'ARM-A')
    assert.equal(po.lines[0].requisition.number, o.req.number)
    // Pedir aprovação: uma etapa (valor abaixo da direcção); quem gere não decide.
    po = ok(await B.post(`${O}/${po.id}/submit`, { expectedVersion: po.version }), 200)
    assert.deepInclude(po, { approvalStatus: 'PENDING_APPROVAL', totalFunctional: '11156.00' })
    assert.deepEqual(
      po.approval.map((a: any) => [a.code, a.decision, a.current]),
      [['CHEFIA', null, true]]
    )
    assert.equal(
      code(await B.post(`${O}/${po.id}/approve`, { expectedVersion: po.version })),
      'OUT_OF_SCOPE'
    )
    assert.equal(
      code(await B.put(`${O}/${po.id}`, { ...body(), expectedVersion: po.version })),
      'INVALID_STATE'
    )
    // Recusa com motivo → volta a editar-se; nova ronda de aprovação.
    assert.include(
      details(await o.chief.post(`${O}/${po.id}/reject`, { expectedVersion: po.version })),
      'REQUIRED'
    )
    po = ok(
      await o.chief.post(`${O}/${po.id}/reject`, {
        expectedVersion: po.version,
        reason: 'Negociar o transporte',
      }),
      200
    )
    assert.deepInclude(po, { approvalStatus: 'REJECTED', rejectReason: 'Negociar o transporte' })
    const keep = (l: any) => ({
      id: l.id,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discountRate: l.discountRate,
      taxRate: l.taxRate,
      description: l.description,
    })
    po = ok(
      await B.put(`${O}/${po.id}`, {
        ...body({ warehouseId: o.wh.id }),
        lines: [keep(po.lines[0]), { ...keep(po.lines[1]), unitPrice: '4000' }],
        expectedVersion: po.version,
      }),
      200
    )
    assert.deepInclude(po, { approvalStatus: 'DRAFT', totalAmount: '10156.00' })
    po = ok(await B.post(`${O}/${po.id}/submit`, { expectedVersion: po.version }), 200)
    assert.equal(po.approval[0].decision, null)
    po = ok(await o.chief.post(`${O}/${po.id}/approve`, { expectedVersion: po.version }), 200)
    assert.equal(po.approvalStatus, 'APPROVED')
    // Emitir: precisa da série; dá o número; afecta a requisição.
    assert.equal(
      code(await B.post(`${O}/${po.id}/issue`, { expectedVersion: po.version })),
      'NO_SERIES'
    )
    ok(
      await o.api.post('/api/v1/document-series', {
        legalEntityId: o.le.id,
        documentType: 'PURCHASE_ORDER',
        code: 'OC',
        prefix: 'OC-',
      })
    )
    po = ok(await B.post(`${O}/${po.id}/issue`, { expectedVersion: po.version }), 200)
    assert.match(po.number, /^OC-0*1$/)
    assert.deepInclude(po, { issuedRevision: 0, revision: 0 })
    assert.equal(po.lines[0].allocatedQuantity, '6.000000')
    let req = await o.reqOf()
    assert.equal(req.status, 'PARTIALLY_ORDERED')
    assert.equal(req.lines[0].orderedQuantity, '6.000000')
    assert.equal(
      code(await B.post(`${O}/${po.id}/issue`, { expectedVersion: po.version })),
      'INVALID_STATE'
    )
    // A base fixa a ordem emitida.
    await assert.rejects(() =>
      owner().rawQuery(`update purchase_order_lines set unit_price = 1 where order_id = ?`, [po.id])
    )
    await assert.rejects(() =>
      owner().rawQuery(`update purchase_orders set number = 'X' where id = ?`, [po.id])
    )
    await assert.rejects(() =>
      owner().rawQuery(
        `update purchase_orders set total_amount = 1, total_net = 1, total_gross = 1, total_discount = 0, total_tax = 0 where id = ?`,
        [po.id]
      )
    )
    await assert.rejects(() =>
      owner().rawQuery(`delete from purchase_orders where id = ?`, [po.id])
    )
    // Revisão: motivo; volta a rascunho na revisão 1 com a versão emitida guardada.
    assert.include(
      details(await B.post(`${O}/${po.id}/revise`, { expectedVersion: po.version })),
      'REQUIRED'
    )
    po = ok(
      await B.post(`${O}/${po.id}/revise`, {
        expectedVersion: po.version,
        reason: 'Mais duas bombas',
      }),
      200
    )
    assert.deepInclude(po, {
      approvalStatus: 'DRAFT',
      revision: 1,
      issuedRevision: 0,
      number: po.number,
    })
    assert.deepEqual(
      po.revisions.map((r: any) => [r.revision, r.reason, r.totalAmount]),
      [[0, 'Mais duas bombas', '10156.00']]
    )
    const snap = await owner().rawQuery(
      `select snapshot from purchase_order_revisions where order_id = ?`,
      [po.id]
    )
    assert.equal(snap.rows[0].snapshot.lines[0].quantity, '6.000000')
    await assert.rejects(() => owner().rawQuery(`update purchase_order_revisions set reason = 'x'`))
    po = ok(
      await B.put(`${O}/${po.id}`, {
        ...body({ warehouseId: o.wh.id }),
        lines: [{ ...keep(po.lines[0]), quantity: '8' }, keep(po.lines[1])],
        expectedVersion: po.version,
      }),
      200
    )
    po = ok(await B.post(`${O}/${po.id}/submit`, { expectedVersion: po.version }), 200)
    po = ok(await o.chief.post(`${O}/${po.id}/approve`, { expectedVersion: po.version }), 200)
    po = ok(await B.post(`${O}/${po.id}/issue`, { expectedVersion: po.version }), 200)
    assert.deepInclude(po, { issuedRevision: 1, revision: 1 })
    assert.match(po.number, /^OC-0*1$/)
    assert.equal(po.lines[0].allocatedQuantity, '8.000000')
    req = await o.reqOf()
    assert.equal(req.lines[0].orderedQuantity, '8.000000')
    // Recepção parcial (o 9.7 grava-a): não se anula; fecha-se o resto, que volta à requisição.
    await owner().rawQuery(
      `update purchase_order_lines set received_quantity = 3 where order_id = ? and line_no = 1`,
      [po.id]
    )
    await owner().rawQuery(
      `update purchase_orders set receipt_status = 'PARTIALLY_RECEIVED' where id = ?`,
      [po.id]
    )
    po = ok(await B.get(`${O}/${po.id}`), 200)
    assert.isFalse(po.can.cancel)
    assert.isTrue(po.can.close)
    assert.equal(
      code(await B.post(`${O}/${po.id}/cancel`, { expectedVersion: po.version, reason: 'x' })),
      'INVALID_STATE'
    )
    po = ok(
      await B.post(`${O}/${po.id}/close`, {
        expectedVersion: po.version,
        reason: 'O resto vem por outra via',
      }),
      200
    )
    assert.deepInclude(po, {
      closed: true,
      receiptStatus: 'RECEIVED',
      closeReason: 'O resto vem por outra via',
    })
    assert.deepInclude(po.lines[0], {
      cancelledQuantity: '5.000000',
      allocatedQuantity: '3.000000',
      openQuantity: '0.000000',
    })
    assert.deepInclude(po.lines[1], { cancelledQuantity: '1.000000' })
    req = await o.reqOf()
    assert.equal(req.lines[0].orderedQuantity, '3.000000')
    assert.isFalse(po.can.revise)
    // Histórico e auditoria.
    assert.includeMembers(
      po.history.map((e: any) => e.kind),
      [
        'CREATED',
        'UPDATED',
        'SUBMITTED',
        'REJECTED',
        'APPROVED',
        'ISSUED',
        'REVISED',
        'REISSUED',
        'CLOSED',
      ]
    )
    const actions = await owner().rawQuery(
      `select distinct action from audit_events where action like 'purchase_order.%' order by action`
    )
    assert.includeMembers(
      actions.rows.map((x: any) => x.action),
      [
        'purchase_order.approved',
        'purchase_order.closed',
        'purchase_order.created',
        'purchase_order.issued',
        'purchase_order.rejected',
        'purchase_order.revised',
        'purchase_order.submitted',
        'purchase_order.updated',
      ]
    )
  })

  test('da adjudicação aprovada: uma ordem por fornecedor em USD, aprovação em duas etapas segregadas, anulação devolve', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const B = o.buyer
    ok(
      await o.api.post('/api/v1/document-series', {
        legalEntityId: o.le.id,
        documentType: 'RFQ',
        code: 'PC',
        prefix: 'PC-',
      })
    )
    ok(
      await o.api.post('/api/v1/document-series', {
        legalEntityId: o.le.id,
        documentType: 'PURCHASE_ORDER',
        code: 'OC',
        prefix: 'OC-',
      })
    )
    // Pedido de cotação da requisição, proposta em USD, adjudicação aprovada por outra pessoa.
    let r = ok(
      await B.post(`${P}/rfqs`, {
        legalEntityId: o.le.id,
        title: 'Bombas',
        closesAt: new Date(Date.now() + 86_400_000).toISOString(),
        supplierIds: [o.s1.id],
        lines: [{ requisitionLineId: o.reqLine }],
      })
    )
    r = ok(await B.post(`${P}/rfqs/${r.id}/issue`, { expectedVersion: r.version }), 200)
    r = ok(
      await B.post(`${P}/rfqs/${r.id}/quotes`, {
        supplierId: o.s1.id,
        currency: 'USD',
        validUntil: day(30),
        deliveryDays: 12,
        paymentTermsDays: 60,
        supplierReference: 'Q-77',
        lines: [{ rfqLineId: r.lines[0].id, quantity: '10', unitPrice: '1200', taxRate: '14' }],
      })
    )
    r = ok(await B.post(`${P}/rfqs/${r.id}/open`, { expectedVersion: r.version }), 200)
    ok(
      await o.api.post('/api/v1/exchange-rates', {
        fromCurrency: 'USD',
        toCurrency: 'AOA',
        rate: '900',
        validOn: day(-1),
      })
    )
    let a = ok(
      await B.post(`${P}/rfqs/${r.id}/awards`, {
        weights: { price: 100, delivery: 0, quality: 0, payment: 0 },
        justification: 'Única proposta e dentro do orçamento.',
        lines: [{ quoteLineId: r.quotes[0].lines[0].id, quantity: '10' }],
      })
    )
    assert.equal(code(await B.post(`${P}/rfq-awards/${a.id}/orders`)), 'INVALID_STATE')
    a = ok(await B.post(`${P}/rfq-awards/${a.id}/submit`, { expectedVersion: a.version }), 200)
    a = ok(
      await o.chief.post(`${P}/rfq-awards/${a.id}/approve`, { expectedVersion: a.version }),
      200
    )
    assert.equal(code(await o.viewer.post(`${P}/rfq-awards/${a.id}/orders`)), 'OUT_OF_SCOPE')
    const { ids } = ok(await B.post(`${P}/rfq-awards/${a.id}/orders`))
    assert.lengthOf(ids, 1)
    assert.equal(code(await B.post(`${P}/rfq-awards/${a.id}/orders`)), 'AWARD_ALREADY_ORDERED')
    let po = ok(await B.get(`${O}/${ids[0]}`), 200)
    assert.deepInclude(po, {
      currency: 'USD',
      paymentTermsDays: 60,
      supplierReference: 'Q-77',
      expectedDate: day(12),
      totalAmount: '13680.00',
    })
    assert.equal(po.award.rfqNumber, r.number)
    assert.isNotNull(po.lines[0].awardLineId)
    assert.equal(po.lines[0].requisition.lineId, o.reqLine)
    // Armazém e aprovação: 13 680 USD × 900 = 12 312 000,00 AOA → chefia e direcção.
    const lines = po.lines.map((l: any) => ({
      id: l.id,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discountRate: l.discountRate,
      taxRate: l.taxRate,
      description: l.description,
    }))
    po = ok(
      await B.put(`${O}/${po.id}`, {
        supplierId: o.s1.id,
        warehouseId: o.wh.id,
        expectedDate: po.expectedDate,
        paymentTermsDays: 60,
        lines,
        expectedVersion: po.version,
      }),
      200
    )
    po = ok(await B.post(`${O}/${po.id}/submit`, { expectedVersion: po.version }), 200)
    assert.deepInclude(po, { totalFunctional: '12312000.00', exchangeRate: '900.0000000000' })
    assert.deepEqual(
      po.approval.map((x: any) => x.code),
      ['CHEFIA', 'DIR']
    )
    // A chefia decide a 1.ª etapa; a mesma pessoa não decide duas etapas; a 2.ª exige o perfil de director.
    assert.lengthOf(ok(await o.chief2.get(`${O}?awaitingMe=true`), 200), 1)
    po = ok(await o.chief.post(`${O}/${po.id}/approve`, { expectedVersion: po.version }), 200)
    assert.equal(po.approvalStatus, 'PENDING_APPROVAL')
    assert.equal(
      code(await o.chief.post(`${O}/${po.id}/approve`, { expectedVersion: po.version })),
      'SAME_APPROVER'
    )
    assert.equal(
      code(await o.chief2.post(`${O}/${po.id}/approve`, { expectedVersion: po.version })),
      'ROLE_REQUIRED'
    )
    assert.deepEqual(
      ok(await o.boss.get(`${O}?awaitingMe=true`), 200).map((x: any) => x.id),
      [po.id]
    )
    po = ok(await o.boss.post(`${O}/${po.id}/approve`, { expectedVersion: po.version }), 200)
    assert.equal(po.approvalStatus, 'APPROVED')
    // Decisões só de acréscimo.
    await assert.rejects(() => owner().rawQuery(`delete from purchase_order_approvals`))
    po = ok(await B.post(`${O}/${po.id}/issue`, { expectedVersion: po.version }), 200)
    assert.equal((await o.reqOf()).lines[0].orderedQuantity, '10.000000')
    assert.equal((await o.reqOf()).status, 'ORDERED')
    // Anular sem recepções: devolve a afectação; a adjudicação pode voltar a dar ordem.
    assert.include(
      details(await B.post(`${O}/${po.id}/cancel`, { expectedVersion: po.version })),
      'REQUIRED'
    )
    po = ok(
      await B.post(`${O}/${po.id}/cancel`, {
        expectedVersion: po.version,
        reason: 'Fornecedor sem stock',
      }),
      200
    )
    assert.deepInclude(po, { approvalStatus: 'CANCELLED', cancelReason: 'Fornecedor sem stock' })
    assert.isFalse(po.can.issue)
    assert.equal((await o.reqOf()).lines[0].orderedQuantity, '0.000000')
    await assert.rejects(() =>
      owner().rawQuery(`update purchase_orders set notes = 'x' where id = ?`, [po.id])
    )
    const again = ok(await B.post(`${P}/rfq-awards/${a.id}/orders`))
    assert.lengthOf(again.ids, 1)
    // Lista: filtros por estado; leitor vê; outra entidade não.
    const list = ok(await o.viewer.get(`${O}?approvalStatus=CANCELLED`), 200)
    assert.deepEqual(
      list.map((x: any) => x.id),
      [po.id]
    )
    assert.lengthOf(ok(await o.other.get(O), 200), 0)
  })
})
