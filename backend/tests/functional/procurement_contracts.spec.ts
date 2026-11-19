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
const C = `${P}/contracts`
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
      taxId: '5000000941',
      countryCode: 'AO',
      functionalCurrency: 'AOA',
    })
  )
  const le2 = ok(
    await api.post(`${ORG}/legal-entities`, {
      code: 'LEB',
      legalName: 'Entidade B, Lda.',
      taxId: '5000000942',
      countryCode: 'AO',
      functionalCurrency: 'AOA',
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
  const cable = ok(
    await api.post('/api/v1/inventory/products', {
      sku: 'CABO',
      name: 'Cabo eléctrico',
      productType: 'STOCKABLE',
      baseUomId: un.id,
    })
  )
  const wh = ok(
    await api.post('/api/v1/inventory/warehouses', {
      code: 'ARM-A',
      name: 'Armazém A',
      legalEntityId: le.id,
      warehouseType: 'MAIN',
    })
  )
  const homolog = await member(client, s, 'homolog', [
    [['procurement.suppliers.approve'], 'TENANT'],
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
          taxId: `541700004${n}`,
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
    return ok(
      await homolog.post(`${P}/suppliers/${sup.id}/approve`, { expectedVersion: sup.version }),
      200
    )
  }
  const s1 = await supplier(1)
  const s2 = await supplier(2)
  const buyer = await member(client, s, 'compra', [
    [['procurement.contracts.manage', 'procurement.orders.manage'], 'LEGAL_ENTITY', le.id],
  ])
  const approver = await member(client, s, 'aprova', [
    [['procurement.contracts.approve', 'procurement.orders.approve'], 'LEGAL_ENTITY', le.id],
  ])
  const viewer = await member(client, s, 'leitor', [
    [['procurement.contracts.read'], 'LEGAL_ENTITY', le.id],
  ])
  const other = await member(client, s, 'outra', [
    [['procurement.contracts.manage'], 'LEGAL_ENTITY', le2.id],
  ])
  const series = async (documentType: string, seriesCode: string) =>
    ok(
      await api.post('/api/v1/document-series', {
        legalEntityId: le.id,
        documentType,
        code: seriesCode,
        prefix: `${seriesCode}-`,
      })
    )
  const body = (extra: Record<string, unknown> = {}) => ({
    legalEntityId: le.id,
    supplierId: s1.id,
    title: 'Fornecimento de bombas',
    object: 'Fornecimento e entrega de bombas de água para as estações.',
    startDate: day(-10),
    endDate: day(20),
    maxAmount: '100000.00',
    paymentTermsDays: 45,
    autoRenew: true,
    renewalMonths: 12,
    renewalNoticeDays: 30,
    prices: [{ productId: pump.id, unitPrice: '1000' }],
    slas: [{ metric: 'DELIVERY_DAYS', target: '7', penalty: '1% por dia de atraso' }],
    ...extra,
  })
  /** Contrato activo (criado, submetido e aprovado). */
  const active = async (extra: Record<string, unknown> = {}) => {
    let c = ok(await buyer.post(C, body(extra)))
    c = ok(await buyer.post(`${C}/${c.id}/submit`, { expectedVersion: c.version }), 200)
    return ok(await approver.post(`${C}/${c.id}/approve`, { expectedVersion: c.version }), 200)
  }
  return {
    api,
    le,
    le2,
    un,
    pump,
    cable,
    wh,
    s1,
    s2,
    buyer,
    approver,
    viewer,
    other,
    series,
    body,
    active,
  }
}

test.group('Compras | contratos (9.6)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('contrato: validações, aprovação segregada numerada, adenda e renovação aprovadas por outra pessoa, suspensão', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const B = o.buyer
    const A = o.approver
    // Validações e âmbito.
    assert.include(details(await B.post(C, o.body({ endDate: day(-20) }))), 'BEFORE_START')
    assert.include(details(await B.post(C, o.body({ maxAmount: '0' }))), 'INVALID')
    assert.include(details(await B.post(C, o.body({ renewalMonths: null }))), 'REQUIRED')
    assert.include(
      details(await B.post(C, o.body({ slas: [{ metric: 'OTHER', target: '1' }] }))),
      'REQUIRED'
    )
    assert.include(
      details(
        await B.post(
          C,
          o.body({
            prices: [
              { productId: o.pump.id, unitPrice: '1' },
              { productId: o.pump.id, unitPrice: '2' },
            ],
          })
        )
      ),
      'DUPLICATE'
    )
    assert.equal(code(await o.other.post(C, o.body())), 'OUT_OF_SCOPE')
    assert.equal(code(await o.viewer.post(C, o.body())), 'OUT_OF_SCOPE')
    let c = ok(await B.post(C, o.body()))
    assert.deepInclude(c, {
      status: 'DRAFT',
      number: null,
      currency: 'AOA',
      maxAmount: '100000.00',
      consumedAmount: '0.00',
      remainingAmount: '100000.00',
    })
    assert.deepInclude(c.prices[0], { description: 'Bomba de água', unitPrice: '1000.000000' })
    assert.equal(c.prices[0].uom.code, 'UN')
    assert.deepInclude(c.slas[0], {
      metric: 'DELIVERY_DAYS',
      target: '7.000',
      penalty: '1% por dia de atraso',
    })
    assert.equal((await o.other.get(`${C}/${c.id}`)).status(), 404)
    // Pedir aprovação; recusa com motivo; edição; nova aprovação sem série e com série.
    c = ok(await B.post(`${C}/${c.id}/submit`, { expectedVersion: c.version }), 200)
    assert.equal(c.status, 'PENDING_APPROVAL')
    assert.equal(
      code(await B.post(`${C}/${c.id}/approve`, { expectedVersion: c.version })),
      'OUT_OF_SCOPE'
    )
    assert.equal(
      code(await B.put(`${C}/${c.id}`, { ...o.body(), expectedVersion: c.version })),
      'INVALID_STATE'
    )
    assert.include(
      details(await A.post(`${C}/${c.id}/reject`, { expectedVersion: c.version })),
      'REQUIRED'
    )
    c = ok(
      await A.post(`${C}/${c.id}/reject`, { expectedVersion: c.version, reason: 'Rever o máximo' }),
      200
    )
    assert.deepInclude(c, { status: 'REJECTED', rejectReason: 'Rever o máximo' })
    c = ok(
      await B.put(`${C}/${c.id}`, {
        ...o.body({ maxAmount: '120000' }),
        expectedVersion: c.version,
      }),
      200
    )
    assert.deepInclude(c, { status: 'DRAFT', maxAmount: '120000.00' })
    c = ok(await B.post(`${C}/${c.id}/submit`, { expectedVersion: c.version }), 200)
    assert.equal(
      code(await A.post(`${C}/${c.id}/approve`, { expectedVersion: c.version })),
      'NO_SERIES'
    )
    await o.series('PURCHASE_CONTRACT', 'CT')
    c = ok(await A.post(`${C}/${c.id}/approve`, { expectedVersion: c.version }), 200)
    assert.deepInclude(c, { status: 'ACTIVE', effectiveStatus: 'ACTIVE', renewalDue: true })
    assert.match(c.number, /^CT-0*1$/)
    assert.isNotNull(c.approvedBy)
    // A renovar (fim dentro do aviso) aparece no filtro; o leitor vê.
    const due = ok(await o.viewer.get(`${C}?renewalDue=true`), 200)
    assert.deepEqual(
      due.map((x: any) => x.id),
      [c.id]
    )
    // Aprovado: só por adenda; a base recusa alterar directamente.
    assert.equal(
      code(await B.put(`${C}/${c.id}`, { ...o.body(), expectedVersion: c.version })),
      'INVALID_STATE'
    )
    await assert.rejects(() =>
      owner().rawQuery(`update purchase_contracts set max_amount = 1 where id = ?`, [c.id])
    )
    await assert.rejects(() =>
      owner().rawQuery(`update purchase_contract_prices set unit_price = 1 where contract_id = ?`, [
        c.id,
      ])
    )
    await assert.rejects(() =>
      owner().rawQuery(`update purchase_contracts set number = 'X' where id = ?`, [c.id])
    )
    await assert.rejects(() =>
      owner().rawQuery(`delete from purchase_contracts where id = ?`, [c.id])
    )
    // Adenda: novo máximo e nova tabela de preços; uma pendente de cada vez; decide outra pessoa.
    assert.include(
      details(
        await B.post(`${C}/${c.id}/amendments`, { expectedVersion: c.version, maxAmount: '150000' })
      ),
      'REQUIRED'
    )
    assert.include(
      details(
        await B.post(`${C}/${c.id}/amendments`, { expectedVersion: c.version, reason: 'Nada' })
      ),
      'NOTHING'
    )
    c = ok(
      await B.post(`${C}/${c.id}/amendments`, {
        expectedVersion: c.version,
        reason: 'Mais estações abrangidas',
        maxAmount: '150000',
        prices: [
          { productId: o.pump.id, unitPrice: '950' },
          { productId: o.cable.id, unitPrice: '200' },
        ],
      })
    )
    const am = c.amendments[0]
    assert.deepInclude(am, { amendmentNo: 1, kind: 'CHANGE', status: 'PENDING', canDecide: false })
    assert.equal(c.maxAmount, '120000.00')
    assert.isFalse(c.can.amend)
    assert.equal(
      code(
        await B.post(`${C}/${c.id}/amendments`, {
          expectedVersion: c.version,
          reason: 'x',
          maxAmount: '1000000',
        })
      ),
      'AMENDMENT_PENDING'
    )
    assert.equal(
      code(
        await B.post(`${P}/contract-amendments/${am.id}/approve`, { expectedVersion: am.version })
      ),
      'OUT_OF_SCOPE'
    )
    c = ok(
      await A.post(`${P}/contract-amendments/${am.id}/approve`, { expectedVersion: am.version }),
      200
    )
    assert.deepInclude(c, { maxAmount: '150000.00', amendmentCount: 1 })
    assert.deepEqual(
      c.prices.map((p: any) => [p.product.sku, p.unitPrice]),
      [
        ['BOMBA', '950.000000'],
        ['CABO', '200.000000'],
      ]
    )
    assert.deepInclude(c.amendments[0], { status: 'APPROVED' })
    assert.equal(c.amendments[0].previous.header.maxAmount, '120000.00')
    assert.equal(c.amendments[0].previous.prices[0].unitPrice, '1000.000000')
    // A adenda decidida não muda.
    await assert.rejects(() =>
      owner().rawQuery(`update purchase_contract_amendments set reason = 'x' where id = ?`, [am.id])
    )
    // Renovação: o fim estende-se pelos meses de renovação; recusada primeiro, depois aprovada.
    c = ok(
      await B.post(`${C}/${c.id}/amendments`, {
        expectedVersion: c.version,
        kind: 'RENEWAL',
        reason: 'Renovação anual',
      })
    )
    let rn = c.amendments[0]
    assert.equal(rn.proposed.header.endDate > day(300), true)
    rn = c.amendments[0]
    c = ok(
      await A.post(`${P}/contract-amendments/${rn.id}/reject`, {
        expectedVersion: rn.version,
        reason: 'Renegociar',
      }),
      200
    )
    assert.equal(c.amendments[0].status, 'REJECTED')
    assert.include(
      details(
        await B.post(`${C}/${c.id}/amendments`, {
          expectedVersion: c.version,
          kind: 'RENEWAL',
          reason: 'x',
          endDate: day(5),
        })
      ),
      'NOT_EXTENDED'
    )
    c = ok(
      await B.post(`${C}/${c.id}/amendments`, {
        expectedVersion: c.version,
        kind: 'RENEWAL',
        reason: 'Renovação anual',
      })
    )
    rn = c.amendments[0]
    const newEnd = rn.proposed.header.endDate
    c = ok(
      await A.post(`${P}/contract-amendments/${rn.id}/approve`, { expectedVersion: rn.version }),
      200
    )
    assert.deepInclude(c, { endDate: newEnd, amendmentCount: 2, renewalDue: false })
    // Suspensão (motivo) e reactivação.
    assert.include(
      details(await B.post(`${C}/${c.id}/suspend`, { expectedVersion: c.version })),
      'REQUIRED'
    )
    c = ok(
      await B.post(`${C}/${c.id}/suspend`, {
        expectedVersion: c.version,
        reason: 'Auditoria ao fornecedor',
      }),
      200
    )
    assert.deepInclude(c, { status: 'SUSPENDED', suspendReason: 'Auditoria ao fornecedor' })
    c = ok(await B.post(`${C}/${c.id}/reactivate`, { expectedVersion: c.version }), 200)
    assert.equal(c.status, 'ACTIVE')
    assert.includeMembers(
      c.history.map((e: any) => e.kind),
      [
        'CREATED',
        'SUBMITTED',
        'REJECTED',
        'UPDATED',
        'APPROVED',
        'AMENDMENT_PROPOSED',
        'AMENDED',
        'RENEWAL_PROPOSED',
        'AMENDMENT_REJECTED',
        'RENEWED',
        'SUSPENDED',
        'REACTIVATED',
      ]
    )
    await assert.rejects(() => owner().rawQuery(`delete from purchase_contract_events`))
  })

  test('consumo pelas ordens: encaixe e preço, saldo na aprovação e na emissão, devolução no fecho e na anulação, terminação', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const B = o.buyer
    const A = o.approver
    await o.series('PURCHASE_CONTRACT', 'CT')
    await o.series('PURCHASE_ORDER', 'OC')
    let c = await o.active({ maxAmount: '10000' })
    const po = (extra: Record<string, unknown> = {}, qty = '6', price = '1000') => ({
      legalEntityId: o.le.id,
      supplierId: o.s1.id,
      warehouseId: o.wh.id,
      contractId: c.id,
      lines: [{ productId: o.pump.id, quantity: qty, unitPrice: price, taxRate: '14' }],
      ...extra,
    })
    // Encaixe: fornecedor, moeda, vigência e preço.
    assert.include(details(await B.post(O, po({ supplierId: o.s2.id }))), 'CONTRACT_OTHER_SUPPLIER')
    assert.include(details(await B.post(O, po({ currency: 'USD' }))), 'CONTRACT_OTHER_CURRENCY')
    assert.include(details(await B.post(O, po({ orderDate: day(-30) }))), 'CONTRACT_OUT_OF_TERM')
    assert.include(details(await B.post(O, po({}, '6', '1100'))), 'PRICE_ABOVE_CONTRACT')
    const flow = async (body: Record<string, unknown>) => {
      let x = ok(await B.post(O, body))
      x = ok(await B.post(`${O}/${x.id}/submit`, { expectedVersion: x.version }), 200)
      x = ok(await A.post(`${O}/${x.id}/approve`, { expectedVersion: x.version }), 200)
      return ok(await B.post(`${O}/${x.id}/issue`, { expectedVersion: x.version }), 200)
    }
    // Ordem 1: 6 × 1 000 (+14% de imposto) consome o líquido (6 000,00).
    const po1 = await flow(po())
    assert.equal(po1.contract.number, c.number)
    c = ok(await B.get(`${C}/${c.id}`), 200)
    assert.deepInclude(c, { consumedAmount: '6000.00', remainingAmount: '4000.00' })
    // Ordem 2 acima do saldo: recusada ao pedir aprovação; com 4 cabe.
    let po2 = ok(await B.post(O, po({}, '5')))
    assert.equal(
      code(await B.post(`${O}/${po2.id}/submit`, { expectedVersion: po2.version })),
      'CONTRACT_EXCEEDED'
    )
    po2 = ok(
      await B.put(`${O}/${po2.id}`, {
        ...po({}, '4'),
        lines: [{ id: po2.lines[0].id, quantity: '4', unitPrice: '1000', taxRate: '14' }],
        expectedVersion: po2.version,
      }),
      200
    )
    po2 = ok(await B.post(`${O}/${po2.id}/submit`, { expectedVersion: po2.version }), 200)
    // Entretanto outra ordem aprovada antes esgota o saldo na emissão (garantia de vez com o contrato bloqueado).
    let po3 = ok(await B.post(O, po({}, '1')))
    po3 = ok(await B.post(`${O}/${po3.id}/submit`, { expectedVersion: po3.version }), 200)
    po3 = ok(await A.post(`${O}/${po3.id}/approve`, { expectedVersion: po3.version }), 200)
    po2 = ok(await A.post(`${O}/${po2.id}/approve`, { expectedVersion: po2.version }), 200)
    po2 = ok(await B.post(`${O}/${po2.id}/issue`, { expectedVersion: po2.version }), 200)
    assert.equal(
      code(await B.post(`${O}/${po3.id}/issue`, { expectedVersion: po3.version })),
      'CONTRACT_EXCEEDED'
    )
    c = ok(await B.get(`${C}/${c.id}`), 200)
    assert.deepInclude(c, { consumedAmount: '10000.00', remainingAmount: '0.00' })
    await assert.rejects(() =>
      owner().rawQuery(`update purchase_contracts set consumed_amount = 10000.01 where id = ?`, [
        c.id,
      ])
    )
    // Ordem 1 recebida em parte (o 9.7 grava-a): fechar o resto devolve 4 000,00.
    await owner().rawQuery(
      `update purchase_order_lines set received_quantity = 2 where order_id = ?`,
      [po1.id]
    )
    await owner().rawQuery(
      `update purchase_orders set receipt_status = 'PARTIALLY_RECEIVED' where id = ?`,
      [po1.id]
    )
    const p1 = ok(await B.get(`${O}/${po1.id}`), 200)
    ok(
      await B.post(`${O}/${po1.id}/close`, {
        expectedVersion: p1.version,
        reason: 'Resto por outro fornecedor',
      }),
      200
    )
    c = ok(await B.get(`${C}/${c.id}`), 200)
    assert.equal(c.consumedAmount, '6000.00')
    // Agora a ordem 3 já cabe e emite-se.
    ok(await B.post(`${O}/${po3.id}/issue`, { expectedVersion: po3.version }), 200)
    c = ok(await B.get(`${C}/${c.id}`), 200)
    assert.equal(c.consumedAmount, '7000.00')
    assert.deepEqual(c.orders.map((x: any) => x.consumed).sort(), ['1000.00', '2000.00', '4000.00'])
    await assert.rejects(() => owner().rawQuery(`delete from purchase_contract_consumptions`))
    // Terminar: ordens novas recusadas; anular uma ordem antiga ainda devolve.
    assert.equal(
      code(await B.post(`${C}/${c.id}/terminate`, { expectedVersion: c.version })),
      'VALIDATION_ERROR'
    )
    c = ok(
      await B.post(`${C}/${c.id}/terminate`, {
        expectedVersion: c.version,
        reason: 'Fim da relação',
      }),
      200
    )
    assert.equal(c.status, 'TERMINATED')
    assert.include(details(await B.post(O, po({}, '1'))), 'CONTRACT_NOT_ACTIVE')
    const p2 = ok(await B.get(`${O}/${po2.id}`), 200)
    ok(
      await B.post(`${O}/${po2.id}/cancel`, {
        expectedVersion: p2.version,
        reason: 'Já não é preciso',
      }),
      200
    )
    c = ok(await B.get(`${C}/${c.id}`), 200)
    assert.equal(c.consumedAmount, '3000.00')
    await assert.rejects(() =>
      owner().rawQuery(`update purchase_contracts set status = 'ACTIVE' where id = ?`, [c.id])
    )
    // A ordem emitida guarda o contrato.
    await assert.rejects(() =>
      owner().rawQuery(`update purchase_orders set contract_id = null where id = ?`, [po3.id])
    )
    // Caducado (fim no passado): filtro e consumo recusado.
    const old = await o.active({
      startDate: day(-60),
      endDate: day(-1),
      autoRenew: false,
      renewalMonths: null,
    })
    assert.equal(old.effectiveStatus, 'EXPIRED')
    const expired = ok(await B.get(`${C}?status=EXPIRED`), 200)
    assert.deepEqual(
      expired.map((x: any) => x.id),
      [old.id]
    )
    assert.include(details(await B.post(O, po({ contractId: old.id }))), 'CONTRACT_OUT_OF_TERM')
  })
})
