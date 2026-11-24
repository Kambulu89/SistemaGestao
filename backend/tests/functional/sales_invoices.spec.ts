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
const I = `${S}/invoices`
const owner = () => db.connection('owner')
const ok = (r: any, status = 201) => {
  if (r.status() !== status) throw new Error(`${r.status()} ${JSON.stringify(r.body())}`)
  return r.body().data
}
const code = (r: any) => r.body().error?.code
const paths = (r: any) => (r.body().error?.details ?? []).map((d: any) => d.path)
const today = () => new Date().toISOString().slice(0, 10)
const plus = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`)
  x.setUTCDate(x.getUTCDate() + n)
  return x.toISOString().slice(0, 10)
}
// Valores fiscais ilustrativos de teste, não taxas legais.
const SOURCE = 'Fonte de teste — não é diploma real'

async function member(
  client: any,
  admin: Session,
  roleCode: string,
  permissions: string[],
  scope: Record<string, string> = { scopeType: 'TENANT' }
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
  const manager = await member(client, s, 'facturas', ['sales.invoices.manage'], {
    scopeType: 'LEGAL_ENTITY',
    scopeId: le.id,
  })
  const issuer = await member(client, s, 'emissor', ['sales.invoices.issue'])
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
        addressLine: 'Rua 1',
        city: 'Luanda',
      },
    })
  )
  // Imposto a 10 % e isento a 0 % com motivo, confirmados por outra pessoa; série fiscal em simulação.
  const year = Number(today().slice(0, 4))
  const tax = async (taxCode: string, rate: string) => {
    let c = ok(
      await api.post(`${S}/fiscal/tax-codes`, {
        countryCode: 'AO',
        code: taxCode,
        name: `Imposto ${taxCode}`,
        kind: 'TAX',
        taxType: 'VAT',
      })
    )
    c = ok(
      await api.post(`${S}/fiscal/tax-codes/${c.id}/rates`, {
        rate,
        validFrom: `${year - 1}-01-01`,
        legalSource: SOURCE,
      })
    )
    ok(
      await confirmer.post(`${S}/fiscal/tax-rates/${c.rates[0].id}/confirm`, {
        expectedVersion: c.rates[0].version,
      }),
      200
    )
    return c
  }
  const t10 = await tax('T10', '10')
  const t0 = await tax('T0', '0')
  const ex = ok(
    await api.post(`${S}/fiscal/exemptions`, {
      countryCode: 'AO',
      code: 'X01',
      description: 'Isenção de teste',
      legalSource: SOURCE,
    })
  )
  ok(
    await confirmer.post(`${S}/fiscal/exemptions/${ex.id}/confirm`, {
      expectedVersion: ex.version,
    }),
    200
  )
  let series = ok(
    await api.post(`${S}/fiscal/series`, {
      legalEntityId: le.id,
      documentKind: 'INVOICE',
      fiscalCode: 'FT',
      code: 'A',
      fiscalYear: year,
      prefix: 'FT A/',
    })
  )
  series = ok(
    await api.post(`${S}/fiscal/series/${series.id}/activate`, { expectedVersion: series.version }),
    200
  )
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
      lines: [{ productId: p.id, quantity: '10', unitCost: '50' }],
    })
  )
  return { tenant, api, le, wh, p, sv, c1, t10, t0, series, manager, issuer, year }
}

test.group('Vendas | facturas (10.6)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('factura de serviços: impostos do motor, emissão numerada em simulação, fotografia do cliente e imutabilidade', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const M = o.manager
    const head = { legalEntityId: o.le.id, customerId: o.c1.id, invoiceDate: today() }
    // Produto de stock sem encomenda: recusado.
    assert.include(
      paths(
        await M.post(I, {
          ...head,
          lines: [{ productId: o.p.id, quantity: '1', taxCodeIds: [o.t10.id] }],
        })
      ),
      'lines.0.productId'
    )
    // 0 % sem motivo de isenção: recusado.
    assert.include(
      paths(
        await M.post(I, {
          ...head,
          lines: [{ productId: o.sv.id, quantity: '1', taxCodeIds: [o.t0.id] }],
        })
      ),
      'lines.0.exemptionCode'
    )
    let inv = ok(
      await M.post(I, {
        ...head,
        lines: [
          { productId: o.sv.id, quantity: '2', taxCodeIds: [o.t10.id], manualDiscountPct: '20' },
          {
            productId: o.sv.id,
            quantity: '1',
            taxCodeIds: [o.t0.id],
            exemptionCode: 'x01',
            description: 'Deslocação',
          },
        ],
      })
    )
    // 2 × 400 = 800 + 10 % = 80; 500 isento.
    assert.deepEqual(
      [inv.netTotal, inv.taxTotal, inv.grossTotal, inv.payableTotal],
      ['1300.00', '80.00', '1380.00', '1380.00']
    )
    assert.deepEqual(
      [inv.status, inv.number, inv.fiscalStatus, inv.collectionStatus],
      ['DRAFT', null, null, null]
    )
    assert.equal(inv.lines[0].discountPct, '20.0000')
    assert.equal(inv.lines[1].exemptionCode, 'X01')
    assert.equal(inv.lines[0].uom, 'UN')
    // Desconto sem limite: não se emite sem passar por orçamento ou encomenda aprovados.
    assert.equal(
      (await M.post(`${I}/${inv.id}/issue`, { expectedVersion: inv.version })).status(),
      403
    )
    assert.equal(
      code(await o.issuer.post(`${I}/${inv.id}/issue`, { expectedVersion: inv.version })),
      'PRICING_APPROVAL_REQUIRED'
    )
    inv = ok(
      await M.patch(`${I}/${inv.id}`, {
        expectedVersion: inv.version,
        lines: [
          { productId: o.sv.id, quantity: '2', taxCodeIds: [o.t10.id] },
          { productId: o.sv.id, quantity: '1', taxCodeIds: [o.t0.id], exemptionCode: 'X01' },
        ],
      }),
      200
    )
    assert.equal(inv.grossTotal, '1600.00')
    inv = ok(await o.issuer.post(`${I}/${inv.id}/issue`, { expectedVersion: inv.version }), 200)
    assert.deepEqual(
      [inv.status, inv.number, inv.fiscalStatus, inv.collectionStatus, inv.simulation],
      ['ISSUED', 'FT A/1', 'PENDING', 'UNPAID', true]
    )
    assert.equal(inv.dueDate, plus(today(), 30))
    assert.equal(inv.exchangeRate, '1.0000000000')
    assert.equal(inv.customerSnapshot.name, 'Cliente Um')
    assert.equal(inv.customerSnapshot.taxId, '5417000071')
    assert.lengthOf(inv.documentHash, 64)
    // Emitida: nunca outro número, nem alterações, nem pela base.
    assert.equal(
      code(await o.issuer.post(`${I}/${inv.id}/issue`, { expectedVersion: inv.version })),
      'ALREADY_ISSUED'
    )
    assert.equal(
      code(await M.patch(`${I}/${inv.id}`, { expectedVersion: inv.version, notes: 'x' })),
      'INVALID_STATE'
    )
    assert.equal(
      code(
        await M.post(`${I}/${inv.id}/discard`, { expectedVersion: inv.version, reason: 'Erro' })
      ),
      'INVALID_STATE'
    )
    await assert.rejects(() =>
      owner().rawQuery(`update sales_invoice_lines set net_amount = 1 where invoice_id = ?`, [
        inv.id,
      ])
    )
    await assert.rejects(() =>
      owner().rawQuery(
        `update sales_invoices set gross_total = 1, net_total = 1, tax_total = 0, payable_total = 1 where id = ?`,
        [inv.id]
      )
    )
    await assert.rejects(() =>
      owner().rawQuery(`update sales_invoices set status = 'DRAFT' where id = ?`, [inv.id])
    )
    await assert.rejects(() =>
      owner().rawQuery(`delete from sales_invoices where id = ?`, [inv.id])
    )
    // O cliente muda de nome depois: a factura mantém os dados com que foi emitida.
    const c = ok(await o.api.get(`${S}/customers/${o.c1.id}`), 200)
    ok(
      await o.api.patch(`${S}/customers/${c.id}`, {
        expectedVersion: c.version,
        partner: { name: 'Cliente Novo Nome', expectedVersion: c.partner.version },
      }),
      200
    )
    assert.equal(ok(await M.get(`${I}/${inv.id}`), 200).customerSnapshot.name, 'Cliente Um')

    // Emissões simultâneas: números seguidos, sem saltos.
    const drafts = []
    for (let n = 0; n < 5; n++)
      drafts.push(
        ok(
          await M.post(I, {
            ...head,
            lines: [{ productId: o.sv.id, quantity: '1', taxCodeIds: [o.t10.id] }],
          })
        )
      )
    const issued = await Promise.all(
      drafts.map((d) => o.issuer.post(`${I}/${d.id}/issue`, { expectedVersion: d.version }))
    )
    assert.sameMembers(
      issued.map((r) => ok(r, 200).number),
      ['FT A/2', 'FT A/3', 'FT A/4', 'FT A/5', 'FT A/6']
    )
    // Descartar rascunho com motivo; data futura e moeda sem câmbio recusadas.
    const d = ok(await M.post(I, { ...head, lines: [] }))
    assert.equal(
      code(await o.issuer.post(`${I}/${d.id}/issue`, { expectedVersion: d.version })),
      'NO_LINES'
    )
    assert.equal(
      ok(
        await M.post(`${I}/${d.id}/discard`, { expectedVersion: d.version, reason: 'Duplicada' }),
        200
      ).status,
      'DISCARDED'
    )
    const fut = ok(
      await M.post(I, {
        ...head,
        invoiceDate: plus(today(), 3),
        lines: [{ productId: o.sv.id, quantity: '1', taxCodeIds: [o.t10.id] }],
      })
    )
    assert.include(
      paths(await o.issuer.post(`${I}/${fut.id}/issue`, { expectedVersion: fut.version })),
      'invoiceDate'
    )
    const usd = ok(
      await M.post(I, {
        ...head,
        currency: 'USD',
        lines: [
          { productId: o.sv.id, quantity: '1', manualUnitPrice: '10', taxCodeIds: [o.t10.id] },
        ],
      })
    )
    assert.equal(
      code(await o.issuer.post(`${I}/${usd.id}/issue`, { expectedVersion: usd.version })),
      'PRICING_APPROVAL_REQUIRED'
    )
    const audits = await owner().rawQuery(
      `select action from audit_events where entity_type = 'sales_invoice' and entity_id = ?`,
      [inv.id]
    )
    assert.includeMembers(
      audits.rows.map((x: any) => x.action),
      ['sales_invoice.created', 'sales_invoice.updated', 'sales_invoice.issued']
    )
  })

  test('factura da encomenda: só o entregue por facturar, regista o facturado sem duplicar, emissões concorrentes', async ({
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
    so = ok(await o.api.post(`${S}/orders/${so.id}/reserve`, { expectedVersion: so.version }), 200)
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
    const draft = ok(await o.manager.get(`${I}/order-draft/${so.id}`), 200)
    assert.deepEqual(
      draft.lines.map((l: any) => [l.invoiceable, l.suggestedTaxCodeIds]),
      [
        ['3.000000', [o.t10.id]],
        ['1.000000', [o.t10.id]],
      ]
    )
    const fromOrder = (lines: any[]) =>
      o.manager.post(I, { orderId: so.id, invoiceDate: today(), lines })
    assert.equal(
      code(await fromOrder([{ orderLineId: pl.id, quantity: '4', taxCodeIds: [o.t10.id] }])),
      'VALIDATION_ERROR'
    )
    let inv = ok(
      await fromOrder([
        { orderLineId: pl.id, quantity: '3', taxCodeIds: [o.t10.id] },
        { orderLineId: sl.id, quantity: '1', taxCodeIds: [o.t10.id] },
      ])
    )
    assert.deepEqual(
      [inv.order.number, inv.netTotal, inv.grossTotal, inv.lines[0].priceSource],
      [so.number, '800.00', '880.00', 'ORDER']
    )
    inv = ok(await o.issuer.post(`${I}/${inv.id}/issue`, { expectedVersion: inv.version }), 200)
    so = ok(await o.api.get(`${S}/orders/${so.id}`), 200)
    assert.deepEqual(
      [so.lines[0].invoicedQty, so.lines[1].invoicedQty, so.invoicingStatus],
      ['3.000000', '1.000000', 'PARTIAL']
    )
    // Nada mais por facturar até à próxima entrega.
    assert.equal(
      code(await fromOrder([{ orderLineId: pl.id, quantity: '1', taxCodeIds: [o.t10.id] }])),
      'VALIDATION_ERROR'
    )
    so = ok(
      await o.api.post(`${S}/orders/${so.id}/deliver`, {
        expectedVersion: so.version,
        requestKey: 'entrega-0002',
        deliveryDate: today(),
        lines: [{ lineId: pl.id, quantity: '2' }],
      }),
      200
    )
    // Dois rascunhos sobre as mesmas 2 unidades: só um se emite; o outro não gasta número.
    const a = ok(await fromOrder([{ orderLineId: pl.id, quantity: '2', taxCodeIds: [o.t10.id] }]))
    const b = ok(await fromOrder([{ orderLineId: pl.id, quantity: '2', taxCodeIds: [o.t10.id] }]))
    const res = await Promise.all(
      [a, b].map((x) => o.issuer.post(`${I}/${x.id}/issue`, { expectedVersion: x.version }))
    )
    assert.sameMembers(
      res.map((r) => r.status()).map((s) => (s === 200 ? 200 : 'x')),
      [200, 'x']
    )
    const ok1 = res.find((r) => r.status() === 200)!.body().data
    assert.equal(ok1.number, 'FT A/2')
    const nums = await owner().rawQuery(
      `select array_agg(number order by number) as n from fiscal_numbers where series_id = ?`,
      [o.series.id]
    )
    assert.deepEqual(nums.rows[0].n, [1, 2])
    so = ok(await o.api.get(`${S}/orders/${so.id}`), 200)
    assert.deepEqual(
      [so.lines[0].invoicedQty, so.deliveryStatus, so.invoicingStatus, so.status],
      ['5.000000', 'FULL', 'FULL', 'CLOSED']
    )
    assert.lengthOf(ok(await o.manager.get(`${I}?orderId=${so.id}&status=ISSUED`), 200), 2)
  })
})
