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
const O = `${S}/orders`
const owner = () => db.connection('owner')
const ok = (r: any, status = 201) => {
  if (r.status() !== status) throw new Error(`${r.status()} ${JSON.stringify(r.body())}`)
  return r.body().data
}
const code = (r: any) => r.body().error?.code
const paths = (r: any) => (r.body().error?.details ?? []).map((d: any) => d.path)
const today = () => new Date().toISOString().slice(0, 10)
const plus = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)

async function member(
  client: any,
  admin: Session,
  roleCode: string,
  permissions: string[],
  scope: { scopeType: string; scopeId?: string } = { scopeType: 'TENANT' }
) {
  const m = await memberWithRoles(client, admin, [])
  const role = await createRole(client, admin, roleCode, permissions)
  ok(
    await as(client, admin).post(`/api/v1/members/${m.memberId}/roles`, {
      roleId: role.id,
      ...scope,
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
  const manager = await member(client, s, 'vendas', ['sales.orders.manage'], {
    scopeType: 'LEGAL_ENTITY',
    scopeId: le.id,
  })
  const approver = await member(client, s, 'aprova_enc', ['sales.orders.approve'])
  const fulfil = await member(client, s, 'expedicao', ['sales.orders.fulfil'])
  const reader = await member(client, s, 'ver_enc', ['sales.orders.read'])
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
  const p1 = ok(
    await api.post('/api/v1/inventory/products', {
      sku: 'BOMBA',
      name: 'Bomba',
      productType: 'STOCKABLE',
      baseUomId: uom.id,
      currency: 'AOA',
      salePrice: '100',
    })
  )
  const s1 = ok(
    await api.post('/api/v1/inventory/products', {
      sku: 'INST',
      name: 'Instalação',
      productType: 'SERVICE',
      baseUomId: uom.id,
      currency: 'AOA',
      salePrice: '500',
    })
  )
  for (const [t, c] of [
    ['SALES_ORDER', 'EV'],
    ['SALES_QUOTE', 'OR'],
  ])
    ok(
      await api.post('/api/v1/document-series', {
        legalEntityId: le.id,
        documentType: t,
        code: c,
        prefix: `${c}-`,
      })
    )
  const customer = (n: number) =>
    api.post(`${S}/customers`, {
      currency: 'AOA',
      paymentTermsDays: 30,
      partner: {
        code: `CLI-${n}`,
        name: `Cliente ${n}`,
        partnerType: 'ORGANIZATION',
        taxId: `541700007${n}`,
        countryCode: 'AO',
      },
    })
  let c1 = ok(await customer(1))
  c1 = ok(
    await api.post(`${S}/customers/${c1.id}/credit`, {
      expectedVersion: c1.version,
      creditLimit: '1000',
      reason: 'Limite inicial',
    }),
    200
  )
  const c2 = ok(await customer(2))
  const me = (
    await owner().rawQuery(
      `select m.id, m.user_id from tenant_memberships m join users u on u.id = m.user_id where m.tenant_id = ? and u.email = ?`,
      [tenant.id, admin.email]
    )
  ).rows[0]
  const context = {
    tenantId: tenant.id,
    userId: me.user_id,
    membershipId: me.id,
    requestId: 'teste',
  }
  await runInTenant(context, (scope) =>
    receivePurchase(scope, {
      idempotencyKey: 'stock-inicial-1',
      warehouseId: wh.id,
      orderRef: 'PO-1',
      documentRef: 'GR-1',
      lines: [{ productId: p1.id, quantity: '8', unitCost: '50' }],
    })
  )
  return { tenant, api, le, wh, p1, s1, c1, c2, manager, approver, fulfil, reader, context }
}

const lineOf = (o: any, sku: string) => o.lines.find((l: any) => l.product.sku === sku)

test.group('Vendas | encomendas (10.4)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('estados separados, limite de crédito, reserva e expedição parcial pelo Inventário, serviços sem stock', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const M = o.manager
    const lines = [
      { productId: o.p1.id, quantity: '5', taxRate: '14' },
      { productId: o.s1.id, quantity: '1', taxRate: '0', taxExemptionReason: 'Isenção de teste' },
    ]
    let so = ok(
      await M.post(O, { legalEntityId: o.le.id, customerId: o.c1.id, orderDate: today(), lines })
    )
    assert.deepEqual([so.netTotal, so.taxTotal, so.grossTotal], ['1000.00', '70.00', '1070.00'])
    assert.deepEqual(
      so.lines.map((l: any) => l.isStock),
      [true, false]
    )
    assert.equal(
      code(
        await o.fulfil.post(O, {
          legalEntityId: o.le.id,
          customerId: o.c1.id,
          orderDate: today(),
          lines,
        })
      ),
      'OUT_OF_SCOPE'
    )
    // Sem armazém, uma linha de stock não se submete.
    assert.include(
      paths(await M.post(`${O}/${so.id}/submit`, { expectedVersion: so.version })),
      'warehouseId'
    )
    so = ok(
      await M.patch(`${O}/${so.id}`, {
        expectedVersion: so.version,
        warehouseId: o.wh.id,
        requestedDate: plus(7),
      }),
      200
    )
    // Limite de crédito 1 000 < 1 070: aguarda aprovação (sem número).
    so = ok(await M.post(`${O}/${so.id}/submit`, { expectedVersion: so.version }), 200)
    assert.deepEqual(
      [so.status, so.approvalStatus, so.approvalReasons],
      ['DRAFT', 'PENDING', ['CREDIT']]
    )
    assert.equal(so.creditCheck.exposure, '1070.00')
    assert.equal(so.creditCheck.limit, '1000.00')
    assert.isNull(so.number)
    assert.equal(
      code(await M.patch(`${O}/${so.id}`, { expectedVersion: so.version, notes: 'x' })),
      'INVALID_STATE'
    )
    assert.equal(
      (await M.post(`${O}/${so.id}/approve`, { expectedVersion: so.version })).status(),
      403
    )
    so = ok(await o.approver.post(`${O}/${so.id}/approve`, { expectedVersion: so.version }), 200)
    assert.deepEqual(
      [so.status, so.approvalStatus, so.reservationStatus, so.deliveryStatus, so.invoicingStatus],
      ['CONFIRMED', 'APPROVED', 'NONE', 'NONE', 'NONE']
    )
    assert.match(so.number, /^EV-0*1$/)

    // Reserva pelo Inventário (só a linha de stock).
    assert.equal(
      (await M.post(`${O}/${so.id}/reserve`, { expectedVersion: so.version })).status(),
      403
    )
    so = ok(await o.fulfil.post(`${O}/${so.id}/reserve`, { expectedVersion: so.version }), 200)
    assert.equal(lineOf(so, 'BOMBA').reservedQty, '5.000000')
    assert.equal(so.reservationStatus, 'FULL')
    assert.equal(
      code(await o.fulfil.post(`${O}/${so.id}/reserve`, { expectedVersion: so.version })),
      'NOTHING_TO_RESERVE'
    )
    const reserved = await owner().rawQuery(
      `select coalesce(sum(qty_reserved), 0)::text as q from stock_balances where product_id = ?`,
      [o.p1.id]
    )
    assert.equal(Number(reserved.rows[0].q), 5)

    // Expedição parcial (3 + serviço), idempotente pela chave; excesso recusado.
    const body = (q: string) => ({
      expectedVersion: so.version,
      requestKey: 'entrega-0001',
      deliveryDate: today(),
      lines: [
        { lineId: lineOf(so, 'BOMBA').id, quantity: q },
        { lineId: lineOf(so, 'INST').id, quantity: '1' },
      ],
    })
    so = ok(await o.fulfil.post(`${O}/${so.id}/deliver`, body('3')), 200)
    assert.deepEqual(
      [
        lineOf(so, 'BOMBA').deliveredQty,
        lineOf(so, 'BOMBA').reservedQty,
        lineOf(so, 'INST').deliveredQty,
      ],
      ['3.000000', '2.000000', '1.000000']
    )
    assert.equal(so.deliveryStatus, 'PARTIAL')
    assert.lengthOf(so.deliveries, 1)
    assert.match(so.deliveries[0].reference, /^EV-0*1\/E1$/)
    const replay = ok(
      await o.fulfil.post(`${O}/${so.id}/deliver`, { ...body('3'), expectedVersion: 1 }),
      200
    )
    assert.lengthOf(replay.deliveries, 1)
    assert.equal(
      code(await o.fulfil.post(`${O}/${so.id}/deliver`, body('2'))),
      'IDEMPOTENCY_MISMATCH'
    )
    const over = await o.fulfil.post(`${O}/${so.id}/deliver`, {
      expectedVersion: so.version,
      requestKey: 'entrega-0002',
      deliveryDate: today(),
      lines: [{ lineId: lineOf(so, 'BOMBA').id, quantity: '3' }],
    })
    assert.include(paths(over), 'lines.0.quantity')
    const onHand = await owner().rawQuery(
      `select coalesce(sum(qty_unrestricted), 0)::text as q from stock_balances where product_id = ?`,
      [o.p1.id]
    )
    assert.equal(Number(onHand.rows[0].q), 5)

    // Libertar 1 e fechar o resto com motivo (liberta a reserva que sobra).
    so = ok(
      await o.fulfil.post(`${O}/${so.id}/release`, {
        expectedVersion: so.version,
        lines: [{ lineId: lineOf(so, 'BOMBA').id, quantity: '1' }],
      }),
      200
    )
    assert.equal(lineOf(so, 'BOMBA').reservedQty, '1.000000')
    assert.equal(
      code(
        await M.post(`${O}/${so.id}/cancel`, { expectedVersion: so.version, reason: 'Desistiu' })
      ),
      'INVALID_STATE'
    )
    so = ok(
      await M.post(`${O}/${so.id}/close`, {
        expectedVersion: so.version,
        reason: 'Cliente só quer 3',
      }),
      200
    )
    assert.deepEqual([so.status, so.deliveryStatus], ['CLOSED', 'PARTIAL'])
    assert.deepEqual(
      [lineOf(so, 'BOMBA').closedQty, lineOf(so, 'BOMBA').reservedQty],
      ['2.000000', '0.000000']
    )
    const left = await owner().rawQuery(
      `select coalesce(sum(qty_reserved), 0)::text as q from stock_balances where product_id = ?`,
      [o.p1.id]
    )
    assert.equal(Number(left.rows[0].q), 0)

    // A base protege o confirmado e as expedições.
    await assert.rejects(() =>
      owner().rawQuery(`update sales_order_lines set net_unit_price = 1 where order_id = ?`, [
        so.id,
      ])
    )
    await assert.rejects(() =>
      owner().rawQuery(`delete from sales_order_deliveries where order_id = ?`, [so.id])
    )
    await assert.rejects(() =>
      owner().rawQuery(`update sales_orders set status = 'CONFIRMED' where id = ?`, [so.id])
    )
    assert.equal(ok(await o.reader.get(`${O}/${so.id}`), 200).number, so.number)
    const audits = await owner().rawQuery(
      `select action from audit_events where entity_type = 'sales_order' and entity_id = ?`,
      [so.id]
    )
    assert.includeMembers(
      audits.rows.map((x: any) => x.action),
      [
        'sales_order.created',
        'sales_order.submitted',
        'sales_order.approved',
        'sales_order.reserved',
        'sales_order.delivered',
        'sales_order.released',
        'sales_order.closed',
      ]
    )
  })

  test('conversão única de orçamento aceite, crédito com encomendas em aberto, stock insuficiente e expedições simultâneas', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    // Orçamento aceite (preço de catálogo 100 × 4 + 14 %).
    let q = ok(
      await o.api.post(`${S}/quotes`, {
        legalEntityId: o.le.id,
        customerId: o.c2.id,
        quoteDate: today(),
        validUntil: plus(10),
        lines: [{ productId: o.p1.id, quantity: '4', taxRate: '14' }],
      })
    )
    q = ok(await o.api.post(`${S}/quotes/${q.id}/submit`, { expectedVersion: q.version }), 200)
    q = ok(
      await o.api.post(`${S}/quotes/${q.id}/send`, { expectedVersion: q.version, channel: 'HAND' }),
      200
    )
    q = ok(
      await o.api.post(`${S}/quotes/${q.id}/accept`, {
        expectedVersion: q.version,
        versionNo: 1,
        decidedByName: 'Ana',
        customerReference: 'PO-9',
      }),
      200
    )
    const [first, second] = await Promise.all([
      o.manager.post(`${O}/from-quote`, { quoteId: q.id, warehouseId: o.wh.id }),
      o.manager.post(`${O}/from-quote`, { quoteId: q.id, warehouseId: o.wh.id }),
    ])
    assert.sameMembers([first.status(), second.status()], [201, 409])
    let so = (first.status() === 201 ? first : second).body().data
    assert.deepEqual(
      [so.quote.number, so.grossTotal, so.customerReference],
      [q.number, '456.00', 'PO-9']
    )
    assert.equal(lineOf(so, 'BOMBA').quoteLineNo, 1)
    assert.equal(ok(await o.api.get(`${S}/quotes/${q.id}`), 200).status, 'CONVERTED')
    assert.equal(
      code(await o.manager.patch(`${O}/${so.id}`, { expectedVersion: so.version, lines: [] })),
      'LINES_FROM_QUOTE'
    )
    so = ok(await o.manager.post(`${O}/${so.id}/submit`, { expectedVersion: so.version }), 200)
    assert.deepEqual([so.status, so.approvalStatus], ['CONFIRMED', 'NOT_REQUIRED'])

    // Stock insuficiente (8 em armazém, 4 desta + 6 pedidos noutra).
    let other = ok(
      await o.manager.post(O, {
        legalEntityId: o.le.id,
        customerId: o.c2.id,
        warehouseId: o.wh.id,
        orderDate: today(),
        lines: [{ productId: o.p1.id, quantity: '6', taxRate: '14' }],
      })
    )
    other = ok(
      await o.manager.post(`${O}/${other.id}/submit`, { expectedVersion: other.version }),
      200
    )
    so = ok(await o.fulfil.post(`${O}/${so.id}/reserve`, { expectedVersion: so.version }), 200)
    assert.equal(
      code(await o.fulfil.post(`${O}/${other.id}/reserve`, { expectedVersion: other.version })),
      'OVER_RESERVED'
    )
    other = ok(
      await o.fulfil.post(`${O}/${other.id}/reserve`, {
        expectedVersion: other.version,
        lines: [{ lineId: other.lines[0].id, quantity: '4' }],
      }),
      200
    )
    assert.equal(other.reservationStatus, 'PARTIAL')
    // Anular uma confirmada sem entregas liberta a reserva.
    other = ok(
      await o.manager.post(`${O}/${other.id}/cancel`, {
        expectedVersion: other.version,
        reason: 'Cliente desistiu',
      }),
      200
    )
    assert.equal(other.status, 'CANCELLED')
    assert.equal(other.lines[0].reservedQty, '0.000000')

    // Duas expedições simultâneas de 3 sobre 4 em aberto: uma passa.
    const deliver = (key: string) =>
      o.fulfil.post(`${O}/${so.id}/deliver`, {
        expectedVersion: so.version,
        requestKey: key,
        deliveryDate: today(),
        lines: [{ lineId: so.lines[0].id, quantity: '3' }],
      })
    const res = await Promise.all([deliver('paralela-01'), deliver('paralela-02')])
    assert.sameMembers(
      res.map((r) => r.status()).map((s) => (s === 200 ? 200 : 'x')),
      [200, 'x']
    )
    so = ok(await o.reader.get(`${O}/${so.id}`), 200)
    assert.equal(so.lines[0].deliveredQty, '3.000000')

    // Crédito: o c2 passa a ter limite 500; a encomenda em aberto (1 × 114 por facturar) conta na exposição.
    let c2 = ok(await o.api.get(`${S}/customers/${o.c2.id}`), 200)
    c2 = ok(
      await o.api.post(`${S}/customers/${c2.id}/credit`, {
        expectedVersion: c2.version,
        creditLimit: '500',
        reason: 'Revisão',
      }),
      200
    )
    let third = ok(
      await o.manager.post(O, {
        legalEntityId: o.le.id,
        customerId: o.c2.id,
        warehouseId: o.wh.id,
        orderDate: today(),
        lines: [{ productId: o.p1.id, quantity: '4', taxRate: '14' }],
      })
    )
    third = ok(
      await o.manager.post(`${O}/${third.id}/submit`, { expectedVersion: third.version }),
      200
    )
    assert.equal(third.creditCheck.openOrders, '456.00')
    assert.equal(third.creditCheck.exposure, '912.00')
    assert.deepEqual(third.approvalReasons, ['CREDIT'])
    // Devolvida: volta a ser editável; anulada em rascunho.
    third = ok(
      await o.approver.post(`${O}/${third.id}/reject`, {
        expectedVersion: third.version,
        reason: 'Crédito esgotado',
      }),
      200
    )
    assert.equal(third.approvalStatus, 'REJECTED')
    assert.isTrue(ok(await o.manager.get(`${O}/${third.id}`), 200).can.edit)
    // Cliente bloqueado: não se expede.
    c2 = ok(
      await o.api.post(`${S}/customers/${c2.id}/status`, {
        expectedVersion: c2.version,
        status: 'BLOCKED',
        reason: 'Dívida vencida',
      }),
      200
    )
    assert.equal(
      code(
        await o.fulfil.post(`${O}/${so.id}/deliver`, {
          expectedVersion: so.version,
          requestKey: 'bloqueado-01',
          deliveryDate: today(),
          lines: [{ lineId: so.lines[0].id, quantity: '1' }],
        })
      ),
      'CUSTOMER_BLOCKED'
    )
  })
})
