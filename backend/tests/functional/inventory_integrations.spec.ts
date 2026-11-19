import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { runInTenant } from '#modules/tenancy/index'
import { receivePurchase } from '#modules/inventory/index'
import { as, cleanDatabase, createRole, memberWithRoles } from '#tests/support/fixtures'
import { ledger, ok } from '#tests/support/accounting'

const I = '/api/v1/inventory'
const N = `${I}/integrations`
const A = '/api/v1/accounting'
const owner = () => db.connection('owner')
const code = (r: any) => r.body().error?.code
const details = (r: any) => (r.body().error?.details ?? []).map((d: any) => d.code)
let seq = 0
const key = () => `k-${Date.now()}-${++seq}`

async function setup(client: any) {
  const L = await ledger(client)
  const { api } = L
  const leB = ok(
    await api.post('/api/v1/organization/legal-entities', {
      code: 'LE2',
      legalName: 'Entidade Dois, Lda.',
      taxId: '5000000002',
      countryCode: 'AO',
      functionalCurrency: 'AOA',
    })
  )
  const acc = async (accCode: string, nature: string, parentId: string | null, postable = false) =>
    ok(
      await api.post(`${A}/accounts`, {
        chartId: L.chart.id,
        code: accCode,
        name: `Conta ${accCode}`,
        level: parentId ? 'ACCOUNT' : 'CLASS',
        nature,
        parentId,
        ...(postable ? { postable: true } : {}),
      })
    )
  const c3 = await acc('3', 'ASSET', null)
  const inv = await acc('32', 'ASSET', c3.id, true)
  const c2 = await acc('2', 'LIABILITY', null)
  const grir = await acc('22', 'LIABILITY', c2.id, true)
  const c6 = await acc('6', 'EXPENSE', null)
  const cogs = await acc('61', 'EXPENSE', c6.id, true)
  const rule = (event: string, lines: any[]) =>
    api.post(`${A}/posting-rules`, {
      legalEntityId: L.le.id,
      code: event.slice(0, 20),
      name: event,
      source: 'inventory',
      event,
      journalId: L.journal.id,
      autoPost: true,
      validFrom: '2026-01-01',
      lines,
    })
  // Recepção de compra: existências (classe MERCADORIAS) a débito; fornecedores/recepções a crédito.
  ok(
    await rule('RECEIPT_PURCHASE', [
      { side: 'DEBIT', accountId: inv.id, amountKey: 'cls_mercadorias' },
      { side: 'CREDIT', accountId: grir.id, amountKey: 'value' },
    ])
  )
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
  const prod = ok(
    await api.post(`${I}/products`, {
      sku: 'CAIXA',
      name: 'Caixa',
      productType: 'STOCKABLE',
      baseUomId: un.id,
      categoryId: cat.id,
    })
  )
  const wh = async (c: string, le: any) =>
    ok(
      await api.post(`${I}/warehouses`, {
        code: c,
        name: c,
        legalEntityId: le.id,
        warehouseType: 'MAIN',
      })
    )
  const wa = await wh('WA', L.le)
  const wb = await wh('WB', leB)
  // Integrador só da entidade 1.
  const integrator = await memberWithRoles(client, L.s, [])
  const ri = await createRole(client, L.s, 'integra', [
    'inventory.read',
    'inventory.integrations.post',
  ])
  ok(
    await api.post(`/api/v1/members/${integrator.memberId}/roles`, {
      roleId: ri.id,
      scopeType: 'LEGAL_ENTITY',
      scopeId: L.le.id,
    }),
    200
  )
  const ctx = (await api.get('/api/v1/context')).body().data
  const tenantId = (
    await owner().rawQuery('select tenant_id from legal_entities where id = ?', [L.le.id])
  ).rows[0].tenant_id as string
  const scope = { tenantId, userId: L.adminId, membershipId: ctx.membershipId, requestId: 't' }
  const glBalance = async (accountId: string) => {
    const r = await owner().rawQuery(
      `select coalesce(sum(debit_functional - credit_functional), 0)::numeric(20,2)::text as b from journal_lines l
         join journal_entries e on e.id = l.entry_id where l.account_id = ? and e.status = 'POSTED'`,
      [accountId]
    )
    return r.rows[0].b as string
  }
  const events = async (q = '') => ok(await api.get(`${I}/accounting-events${q}`), 200) as any[]
  const totals = async () => {
    const rows = ok(
      await api.get(`${I}/stock/balances?productId=${prod.id}&warehouseId=${wa.id}`),
      200
    ) as any[]
    return { physical: Number(rows[0]?.physical ?? 0), reserved: Number(rows[0]?.reserved ?? 0) }
  }
  return {
    ...L,
    leB,
    inv,
    grir,
    cogs,
    rule,
    un,
    prod,
    wa,
    wb,
    integrator,
    scope,
    glBalance,
    events,
    totals,
    I: as(client, integrator.session),
  }
}

test.group('Inventário | integrações e contabilização (8.10)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('recepção de compra contabilizada; sem regra fica falhada e repete-se; idempotência ponta a ponta', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const receipt = (k: string, extra: Record<string, unknown> = {}) => ({
      idempotencyKey: k,
      warehouseId: o.wa.id,
      orderRef: 'PO-100',
      documentRef: 'REC-1',
      counterpartyRef: 'FORN-7',
      lines: [{ productId: o.prod.id, quantity: '10', unitCost: '25.5' }],
      ...extra,
    })
    // Validações e âmbito.
    assert.include(
      details(
        await o.I.post(`${N}/purchase-receipts`, {
          ...receipt(key()),
          lines: [{ productId: o.prod.id, quantity: '1' }],
        })
      ),
      'REQUIRED'
    )
    assert.include(
      details(
        await o.I.post(`${N}/purchase-receipts`, { ...receipt(key()), documentRef: undefined })
      ),
      'REQUIRED'
    )
    assert.equal(
      (
        await o.I.post(`${N}/purchase-receipts`, { ...receipt(key()), warehouseId: o.wb.id })
      ).status(),
      404 // armazém de outra entidade: nem se vê
    )
    // Quem vê o armazém mas não integra: recusado.
    const viewer = await memberWithRoles(client, o.s, [
      (await createRole(client, o.s, 'so_ve', ['inventory.read'])).id,
    ])
    assert.equal(
      code(await as(client, viewer.session).post(`${N}/purchase-receipts`, receipt(key()))),
      'OUT_OF_SCOPE'
    )
    assert.equal((await o.I.post(`${N}/unknown`, receipt(key()))).status(), 404)
    // Recepção: stock e custo entram; o evento contabilístico é lançado (existências 255,00 a débito).
    const k1 = key()
    const r1 = ok(await o.I.post(`${N}/purchase-receipts`, receipt(k1)))
    assert.deepInclude(r1, {
      kind: 'PURCHASE_RECEIPT',
      orderRef: 'PO-100',
      documentRef: 'REC-1',
      replayed: false,
    })
    assert.deepEqual(await o.totals(), { physical: 10, reserved: 0 })
    let ev = await o.events()
    assert.lengthOf(ev, 1)
    assert.deepInclude(ev[0], {
      event: 'RECEIPT_PURCHASE',
      direction: 'IN',
      status: 'POSTED',
      total: '255.00',
      sourceRef: 'REC-1',
    })
    assert.equal(ev[0].amounts.cls_mercadorias, '255.00')
    assert.isNotNull(ev[0].entry.number)
    assert.equal(await o.glBalance(o.inv.id), '255.00')
    assert.equal(await o.glBalance(o.grir.id), '-255.00')
    // Repetição: mesmo resultado, nada novo; mesma chave com outro pedido: recusada.
    const again = await o.I.post(`${N}/purchase-receipts`, receipt(k1))
    again.assertStatus(200)
    assert.deepInclude(again.body().data, { id: r1.id, replayed: true })
    assert.equal(
      code(await o.I.post(`${N}/purchase-receipts`, receipt(k1, { orderRef: 'PO-999' }))),
      'IDEMPOTENCY_MISMATCH'
    )
    assert.lengthOf(await o.events(), 1)
    assert.equal(await o.glBalance(o.inv.id), '255.00')
    // O contrato para Compras (na transacção do módulo) faz o mesmo e é idempotente com a mesma chave.
    const k2 = key()
    const viaModule = await runInTenant(o.scope, (s) =>
      receivePurchase(s, receipt(k2, { documentRef: 'REC-2' }))
    )
    assert.equal(viaModule.sourceModule, 'PURCHASES')
    const replay = await runInTenant(o.scope, (s) =>
      receivePurchase(s, receipt(k2, { documentRef: 'REC-2' }))
    )
    assert.isTrue(replay.replayed)
    assert.equal(await o.glBalance(o.inv.id), '510.00')

    // Venda sem regra: a entrega acontece, o evento fica FALHADO com o motivo; depois da regra, repete-se e lança.
    ok(
      await o.I.post(`${N}/sale-deliveries`, {
        idempotencyKey: key(),
        warehouseId: o.wa.id,
        orderRef: 'SO-1',
        documentRef: 'GR-1',
        lines: [{ productId: o.prod.id, quantity: '4' }],
      })
    )
    assert.deepEqual(await o.totals(), { physical: 16, reserved: 0 })
    ev = await o.events('?status=FAILED')
    assert.lengthOf(ev, 1)
    assert.deepInclude(ev[0], { event: 'ISSUE_SALE', direction: 'OUT', total: '102.00' })
    assert.match(ev[0].error, /Não há regra activa/)
    // Repetir exige a gestão da contabilização.
    assert.equal(code(await o.I.post(`${I}/accounting-events/retry`, {})), 'OUT_OF_SCOPE')
    ok(
      await o.rule('ISSUE_SALE', [
        { side: 'DEBIT', accountId: o.cogs.id, amountKey: 'value' },
        { side: 'CREDIT', accountId: o.inv.id, amountKey: 'cls_mercadorias' },
      ])
    )
    const res = ok(await o.api.post(`${I}/accounting-events/retry`, {}), 200)
    assert.deepEqual(res, { posted: 1, drafted: 0, failed: 0 })
    assert.deepEqual(ok(await o.api.post(`${I}/accounting-events/retry`, {}), 200), {
      posted: 0,
      drafted: 0,
      failed: 0,
    })
    assert.equal(await o.glBalance(o.inv.id), '408.00')
    assert.equal(await o.glBalance(o.cogs.id), '102.00')
    // Reconciliação do 8.9 com a classe ligada à conta 32: sem diferença.
    ok(
      await o.api.put(`${I}/valuation/accounts?legalEntityId=${o.le.id}`, {
        mappings: [{ accountingClass: 'MERCADORIAS', accountId: o.inv.id }],
      }),
      200
    )
    const rec = ok(await o.api.get(`${I}/valuation/reconciliation?legalEntityId=${o.le.id}`), 200)
    assert.deepInclude(rec.accounts[0], {
      inventoryValue: '408.00',
      ledgerBalance: '408.00',
      difference: '0.00',
    })
    // Ajuste de custo também é contabilizado (falha sem regra; o evento fica para repetir).
    ok(
      await o.api.post(`${I}/valuation/adjustments`, {
        legalEntityId: o.le.id,
        productId: o.prod.id,
        amount: '16.00',
        reason: 'Portes da compra',
        idempotencyKey: key(),
      })
    )
    assert.deepInclude((await o.events('?event=COST_ADJUSTMENT_UP'))[0], {
      status: 'FAILED',
      total: '16.00',
    })
    // A base protege o conteúdo dos eventos e o registo das integrações.
    await assert.rejects(() => owner().rawQuery(`update inventory_accounting_events set total = 1`))
    await assert.rejects(() =>
      owner().rawQuery(
        `update inventory_accounting_events set status = 'FAILED' where status = 'POSTED'`
      )
    )
    await assert.rejects(() => owner().rawQuery('delete from inventory_integration_events'))
    const audits = await owner().rawQuery(
      `select distinct action from audit_events where action like 'inventory.integration.%'`
    )
    assert.sameMembers(
      audits.rows.map((x: any) => x.action),
      ['inventory.integration.purchase_receipt', 'inventory.integration.sale_delivery']
    )
  })

  test('vendas: reserva, entrega que consome a reserva, libertação, devolução ao custo de saída e estado da encomenda', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    ok(
      await o.I.post(`${N}/purchase-receipts`, {
        idempotencyKey: key(),
        warehouseId: o.wa.id,
        orderRef: 'PO-1',
        documentRef: 'R-1',
        lines: [{ productId: o.prod.id, quantity: '10', unitCost: '20' }],
      })
    )
    const S = (path: string, extra: Record<string, unknown>) =>
      o.I.post(`${N}/${path}`, {
        idempotencyKey: key(),
        warehouseId: o.wa.id,
        orderRef: 'SO-9',
        ...extra,
      })
    // Reserva acima do disponível: recusada; reserva de 6.
    assert.equal(
      code(await S('sale-reservations', { lines: [{ productId: o.prod.id, quantity: '11' }] })),
      'OVER_RESERVED'
    )
    ok(await S('sale-reservations', { lines: [{ productId: o.prod.id, quantity: '6' }] }))
    assert.deepEqual(await o.totals(), { physical: 10, reserved: 6 })
    // Entrega de 4: sai do stock e consome 4 da reserva da encomenda.
    const d = ok(
      await S('sale-deliveries', {
        documentRef: 'GR-1',
        lines: [{ productId: o.prod.id, quantity: '4' }],
      })
    )
    assert.equal(d.summary.lines[0].reservedUsed, '4.000000')
    assert.deepEqual(await o.totals(), { physical: 6, reserved: 2 })
    // Libertar mais do que está reservado: recusado; libertar o resto (sem linhas).
    assert.include(
      details(await S('sale-releases', { lines: [{ productId: o.prod.id, quantity: '3' }] })),
      'OVER_RELEASE'
    )
    ok(await S('sale-releases', {}))
    assert.deepEqual(await o.totals(), { physical: 6, reserved: 0 })
    assert.equal(code(await S('sale-releases', {})), 'NOTHING_RESERVED')
    // Devolução: até ao que saiu; entra ao custo a que saiu (20,00), mesmo depois de uma compra mais cara.
    ok(
      await o.I.post(`${N}/purchase-receipts`, {
        idempotencyKey: key(),
        warehouseId: o.wa.id,
        orderRef: 'PO-2',
        documentRef: 'R-2',
        lines: [{ productId: o.prod.id, quantity: '6', unitCost: '40' }],
      })
    )
    assert.include(
      details(
        await S('sale-returns', {
          documentRef: 'DV-1',
          lines: [{ productId: o.prod.id, quantity: '5' }],
        })
      ),
      'OVER_RETURN'
    )
    ok(
      await S('sale-returns', {
        documentRef: 'DV-1',
        lines: [{ productId: o.prod.id, quantity: '1' }],
      })
    )
    const ledgerRet = await owner().rawQuery(
      `select e.source, e.value::text as v from stock_valuation_entries e join stock_postings s on s.id = e.posting_id
        where s.source_type = 'SALES_RETURN'`
    )
    assert.deepEqual(ledgerRet.rows, [{ source: 'RETURN', v: '20.00' }])
    // Estado da encomenda e registo.
    const st = ok(await o.I.get(`${N}/sales-orders?warehouseId=${o.wa.id}&orderRef=SO-9`), 200)
    assert.deepInclude(st.lines[0], {
      reserved: '0.000000',
      delivered: '4.000000',
      returned: '1.000000',
    })
    const log = ok(await o.I.get(`${N}/events?orderRef=SO-9`), 200) as any[]
    assert.sameMembers(
      log.map((e: any) => e.kind),
      ['SALE_RESERVATION', 'SALE_DELIVERY', 'SALE_RELEASE', 'SALE_RETURN']
    )
    // Movimentos com a origem e a referência.
    const moves = ok(
      await o.api.get(`${I}/stock/movements?productId=${o.prod.id}&type=ISSUE`),
      200
    ) as any[]
    assert.deepInclude(moves[0].source, { type: 'SALES_DELIVERY', ref: 'GR-1' })
    // Eventos contabilísticos: devolução de cliente como RECEIPT_RETURN; quem só lê a valorização de LE2 não os vê.
    assert.lengthOf(await o.events('?event=RECEIPT_RETURN'), 1)
    const onlyB = await memberWithRoles(client, o.s, [])
    const rB = await createRole(client, o.s, 'val_b', ['inventory.valuation.read'])
    ok(
      await o.api.post(`/api/v1/members/${onlyB.memberId}/roles`, {
        roleId: rB.id,
        scopeType: 'LEGAL_ENTITY',
        scopeId: o.leB.id,
      }),
      200
    )
    assert.lengthOf(ok(await as(client, onlyB.session).get(`${I}/accounting-events`), 200), 0)
    // Concorrência: duas entregas simultâneas com a mesma chave → um só lançamento.
    const k = key()
    const body = {
      idempotencyKey: k,
      warehouseId: o.wa.id,
      orderRef: 'SO-10',
      documentRef: 'GR-9',
      lines: [{ productId: o.prod.id, quantity: '1' }],
    }
    const [a, b] = await Promise.all([
      o.I.post(`${N}/sale-deliveries`, body),
      o.I.post(`${N}/sale-deliveries`, body),
    ])
    assert.sameMembers([a.status(), b.status()], [200, 201])
    const n = await owner().rawQuery(
      `select count(*)::int as n from stock_postings where source_ref = 'GR-9'`
    )
    assert.equal(n.rows[0].n, 1)
  })
})
