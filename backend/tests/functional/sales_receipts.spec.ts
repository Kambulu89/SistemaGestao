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

const S = '/api/v1/sales'
const R = `${S}/receipts`
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
  const clerk = await member(client, s, 'cobranca', [
    'sales.receipts.manage',
    'sales.invoices.manage',
    'sales.invoices.issue',
  ])
  const treasurer = await member(client, s, 'tesouraria', ['sales.receipts.confirm'])
  const confirmer = await member(client, s, 'fiscal_conf', ['sales.fiscal.confirm'])
  const uom = ok(
    await api.post('/api/v1/inventory/settings/uoms', {
      code: 'UN',
      name: 'Unidade',
      category: 'UNIT',
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
  const series: Record<string, any> = {}
  for (const [kind, c, prefix] of [
    ['INVOICE', 'FT', 'FT A/'],
    ['INVOICE_RECEIPT', 'FR', 'FR A/'],
    ['RECEIPT', 'RC', 'RC A/'],
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
    series[kind] = ok(
      await api.post(`${S}/fiscal/series/${x.id}/activate`, { expectedVersion: x.version }),
      200
    )
  }
  const bank = (
    await owner().rawQuery(
      `insert into bank_accounts (tenant_id, legal_entity_id, holder_name, bank_name, iban, currency, is_default, status)
       values (?, ?, 'Entidade A', 'Banco de teste', 'AO06000000000000000000000', 'AOA', true, 'ACTIVE') returning id`,
      [tenant.id, le.id]
    )
  ).rows[0]
  const invoice = async (qty: string, kind = 'INVOICE') => {
    let i = ok(
      await clerk.post(`${S}/invoices`, {
        legalEntityId: le.id,
        customerId: c1.id,
        invoiceDate: today(),
        documentKind: kind,
        lines: [{ productId: sv.id, quantity: qty, taxCodeIds: [t10.id] }],
      })
    )
    if (kind === 'INVOICE')
      i = ok(await clerk.post(`${S}/invoices/${i.id}/issue`, { expectedVersion: i.version }), 200)
    return i
  }
  return { tenant, api, le, clerk, treasurer, sv, c1, t10, series, bank, invoice }
}

test.group('Vendas | recibos, factura-recibo e adiantamentos (10.7)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('recebimento só conta depois de confirmado por outra pessoa; afectação parcial/total; adiantamento sem duplicação', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const C = o.clerk
    const a = await o.invoice('2') // 1 100,00
    const b = await o.invoice('1') // 550,00
    const base = {
      legalEntityId: o.le.id,
      customerId: o.c1.id,
      amount: '2000',
      method: 'TRANSFER',
      receivedDate: today(),
    }
    assert.includeMembers(paths(await C.post(R, { ...base, requestKey: 'rec-000001' })), [
      'reference',
    ])
    assert.include(
      paths(await C.post(R, { ...base, reference: 'TRF-1', requestKey: 'rec-000001' })),
      'bankAccountId'
    )
    assert.include(
      paths(
        await C.post(R, {
          ...base,
          reference: 'TRF-1',
          bankAccountId: o.bank.id,
          requestKey: 'rec-000001',
          allocations: [{ invoiceId: a.id, amount: '1200' }],
        })
      ),
      'allocations.0.amount'
    )
    const pay = { ...base, reference: 'TRF-1', bankAccountId: o.bank.id, requestKey: 'rec-000001' }
    assert.include(
      paths(
        await C.post(R, {
          ...pay,
          amount: '1000',
          allocations: [
            { invoiceId: a.id, amount: '1100' },
            { invoiceId: b.id, amount: '550' },
          ],
        })
      ),
      'allocations'
    )
    const draft = await o.invoice('1', 'INVOICE_RECEIPT')
    assert.include(
      paths(await C.post(R, { ...pay, allocations: [{ invoiceId: draft.id, amount: '100' }] })),
      'allocations.0.invoiceId'
    )
    const body = {
      ...base,
      reference: 'TRF-1',
      bankAccountId: o.bank.id,
      requestKey: 'rec-000001',
      allocations: [
        { invoiceId: a.id, amount: '1100' },
        { invoiceId: b.id, amount: '300' },
      ],
    }
    let r = ok(await C.post(R, body))
    assert.deepEqual([r.status, r.number, r.amount], ['PENDING', null, '2000.00'])
    // Repetir o mesmo pedido devolve o mesmo recebimento; a mesma chave com outro conteúdo é recusada.
    assert.equal(ok(await C.post(R, body)).id, r.id)
    assert.equal(code(await C.post(R, { ...body, amount: '1999' })), 'IDEMPOTENCY_MISMATCH')
    // Pendente: as facturas continuam por pagar.
    assert.equal(ok(await C.get(`${S}/invoices/${a.id}`), 200).collectionStatus, 'UNPAID')
    // Quem registou não confirma; sem permissão também não.
    assert.equal(
      (await C.post(`${R}/${r.id}/confirm`, { expectedVersion: r.version })).status(),
      403
    )
    const own = ok(await o.api.post(R, { ...body, requestKey: 'rec-admin-1', allocations: [] }))
    assert.equal(
      code(await o.api.post(`${R}/${own.id}/confirm`, { expectedVersion: own.version })),
      'SELF_CONFIRMATION'
    )
    ok(
      await o.api.post(`${R}/${own.id}/cancel`, { expectedVersion: own.version, reason: 'Teste' }),
      200
    )
    r = ok(await o.treasurer.post(`${R}/${r.id}/confirm`, { expectedVersion: r.version }), 200)
    assert.deepEqual(
      [r.status, r.number, r.allocatedTotal, r.advanceTotal, r.advanceRemaining],
      ['CONFIRMED', 'RC A/1', '1400.00', '600.00', '600.00']
    )
    assert.equal(
      code(await o.treasurer.post(`${R}/${r.id}/confirm`, { expectedVersion: r.version })),
      'INVALID_STATE'
    )
    let ia = ok(await C.get(`${S}/invoices/${a.id}`), 200)
    let ib = ok(await C.get(`${S}/invoices/${b.id}`), 200)
    assert.deepEqual(
      [ia.collectionStatus, ia.paidTotal, ib.collectionStatus, ib.paidTotal],
      ['PAID', '1100.00', 'PARTIAL', '300.00']
    )
    assert.equal(ia.payments[0].number, 'RC A/1')

    // Adiantamento: 250 para B; acima do saldo ou do que falta recusado.
    r = ok(
      await C.post(`${R}/${r.id}/apply-advance`, {
        expectedVersion: r.version,
        invoiceId: b.id,
        amount: '250',
      }),
      200
    )
    assert.equal(r.advanceRemaining, '350.00')
    ib = ok(await C.get(`${S}/invoices/${b.id}`), 200)
    assert.deepEqual([ib.collectionStatus, ib.paidTotal], ['PAID', '550.00'])
    assert.equal(
      code(
        await C.post(`${R}/${r.id}/apply-advance`, {
          expectedVersion: r.version,
          invoiceId: a.id,
          amount: '10',
        })
      ),
      'OVER_PAYMENT'
    )
    assert.equal(
      code(
        await C.post(`${R}/${r.id}/apply-advance`, {
          expectedVersion: r.version,
          invoiceId: b.id,
          amount: '400',
        })
      ),
      'OVER_ADVANCE'
    )
    // Duas utilizações simultâneas de 200 sobre 350: só uma passa.
    const c = await o.invoice('1')
    const res = await Promise.all(
      [0, 1].map(() =>
        C.post(`${R}/${r.id}/apply-advance`, {
          expectedVersion: r.version,
          invoiceId: c.id,
          amount: '200',
        })
      )
    )
    assert.sameMembers(
      res.map((x) => (x.status() === 200 ? 200 : 'x')),
      [200, 'x']
    )
    r = ok(await C.get(`${R}/${r.id}`), 200)
    assert.equal(r.advanceRemaining, '150.00')
    assert.lengthOf(r.applications, 2)
    // A base não deixa desfazer nem duplicar.
    await assert.rejects(() =>
      owner().rawQuery(`delete from sales_receipt_allocations where receipt_id = ?`, [r.id])
    )
    await assert.rejects(() =>
      owner().rawQuery(`update sales_receipts set amount = 1 where id = ?`, [r.id])
    )
    await assert.rejects(() =>
      owner().rawQuery(`update sales_receipts set advance_used = 0 where id = ?`, [r.id])
    )
    await assert.rejects(() =>
      owner().rawQuery(`update sales_invoices set paid_total = 0 where id = ?`, [a.id])
    )
    await assert.rejects(() =>
      owner().rawQuery(`delete from sales_advance_applications where receipt_id = ?`, [r.id])
    )
    // Recusado pela tesouraria: não afecta nada.
    let x = ok(
      await C.post(R, {
        legalEntityId: o.le.id,
        customerId: o.c1.id,
        amount: '100',
        method: 'CASH',
        receivedDate: today(),
        requestKey: 'rec-000002',
        allocations: [{ invoiceId: c.id, amount: '100' }],
      })
    )
    x = ok(
      await o.treasurer.post(`${R}/${x.id}/reject`, {
        expectedVersion: x.version,
        reason: 'Não entrou no banco',
      }),
      200
    )
    assert.equal(x.status, 'REJECTED')
    assert.equal(ok(await C.get(`${S}/invoices/${c.id}`), 200).paidTotal, '200.00')
    assert.lengthOf(ok(await C.get(`${R}?advances=true`), 200), 1)
    const audits = await owner().rawQuery(
      `select action from audit_events where entity_type = 'sales_receipt' and entity_id = ?`,
      [r.id]
    )
    assert.includeMembers(
      audits.rows.map((y: any) => y.action),
      ['sales_receipt.registered', 'sales_receipt.confirmed', 'sales_receipt.advance_applied']
    )
  })

  test('factura-recibo: só se emite na confirmação do recebimento, pelo total; falha não gasta número', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const C = o.clerk
    let fr = await o.invoice('1', 'INVOICE_RECEIPT') // 550,00 em rascunho
    assert.equal(
      code(await C.post(`${S}/invoices/${fr.id}/issue`, { expectedVersion: fr.version })),
      'FR_NEEDS_PAYMENT'
    )
    const base = {
      purpose: 'INVOICE_RECEIPT',
      invoiceId: fr.id,
      legalEntityId: o.le.id,
      customerId: o.c1.id,
      method: 'CASH',
      receivedDate: today(),
    }
    assert.equal(
      code(await C.post(R, { ...base, amount: '500', requestKey: 'fr-000001' })),
      'AMOUNT_MISMATCH'
    )
    let r = ok(await C.post(R, { ...base, amount: '550', requestKey: 'fr-000001' }))
    assert.equal(
      code(await C.post(R, { ...base, amount: '550', requestKey: 'fr-000002' })),
      'FR_PENDING'
    )
    assert.equal(ok(await C.get(`${S}/invoices/${fr.id}`), 200).status, 'DRAFT')
    r = ok(await o.treasurer.post(`${R}/${r.id}/confirm`, { expectedVersion: r.version }), 200)
    assert.isNull(r.number)
    assert.equal(r.invoice.number, 'FR A/1')
    fr = ok(await C.get(`${S}/invoices/${fr.id}`), 200)
    assert.deepEqual(
      [fr.status, fr.documentKind, fr.number, fr.collectionStatus, fr.paidTotal],
      ['ISSUED', 'INVOICE_RECEIPT', 'FR A/1', 'PAID', '550.00']
    )
    assert.equal(fr.payments[0].kind, 'INVOICE_RECEIPT')
    // O rascunho mudou depois do registo: a confirmação falha por inteiro e o número não se gasta.
    let fr2 = await o.invoice('1', 'INVOICE_RECEIPT')
    let r2 = ok(
      await C.post(R, { ...base, invoiceId: fr2.id, amount: '550', requestKey: 'fr-000003' })
    )
    fr2 = ok(
      await C.patch(`${S}/invoices/${fr2.id}`, {
        expectedVersion: fr2.version,
        lines: [{ productId: o.sv.id, quantity: '2', taxCodeIds: [o.t10.id] }],
      }),
      200
    )
    assert.equal(
      code(await o.treasurer.post(`${R}/${r2.id}/confirm`, { expectedVersion: r2.version })),
      'AMOUNT_MISMATCH'
    )
    assert.equal(ok(await C.get(`${S}/invoices/${fr2.id}`), 200).status, 'DRAFT')
    const nums = await owner().rawQuery(
      `select count(*)::int as n from fiscal_numbers where series_id = ?`,
      [o.series.INVOICE_RECEIPT.id]
    )
    assert.equal(nums.rows[0].n, 1)
    r2 = ok(
      await C.post(`${R}/${r2.id}/cancel`, { expectedVersion: r2.version, reason: 'Valor mudou' }),
      200
    )
    let r3 = ok(
      await C.post(R, { ...base, invoiceId: fr2.id, amount: '1100', requestKey: 'fr-000004' })
    )
    r3 = ok(await o.treasurer.post(`${R}/${r3.id}/confirm`, { expectedVersion: r3.version }), 200)
    assert.equal(r3.invoice.number, 'FR A/2')
  })
})
