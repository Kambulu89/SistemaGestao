import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { runInTenant } from '#modules/tenancy/index'
import { postStock, reverseStockPosting } from '#modules/inventory/index'
import { as, cleanDatabase, createRole, memberWithRoles } from '#tests/support/fixtures'
import { ledger, ok } from '#tests/support/accounting'

const I = '/api/v1/inventory'
const V = `${I}/valuation`
const A = '/api/v1/accounting'
const owner = () => db.connection('owner')
const code = (r: any) => r.body().error?.code
const details = (r: any) => (r.body().error?.details ?? []).map((d: any) => d.code)
let seq = 0
const key = () => `k-${Date.now()}-${++seq}`
const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10)

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
  for (const [t, c] of [
    ['STOCK_RECEIPT', 'RE'],
    ['STOCK_ISSUE', 'SA'],
  ])
    ok(
      await api.post('/api/v1/document-series', {
        legalEntityId: L.le.id,
        documentType: t,
        code: c,
        prefix: `${c}-`,
      })
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
  const product = async (sku: string, extra: Record<string, unknown> = {}) =>
    ok(
      await api.post(`${I}/products`, {
        sku,
        name: sku,
        productType: 'STOCKABLE',
        baseUomId: un.id,
        categoryId: cat.id,
        ...extra,
      })
    )
  const avg = await product('MEDIO')
  const fifo = await product('FIFO1', { valuationMethod: 'FIFO' })
  const spec = await product('ESPEC', { valuationMethod: 'SPECIFIC', trackLots: true })
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
  const wa2 = await wh('WA2', L.le)
  const wb = await wh('WB', leB)
  const ctx = (await api.get('/api/v1/context')).body().data
  const tenantId = (
    await owner().rawQuery('select tenant_id from legal_entities where id = ?', [L.le.id])
  ).rows[0].tenant_id as string
  const scope = { tenantId, userId: L.adminId, membershipId: ctx.membershipId, requestId: 't' }
  const post = (type: any, lines: any[], extra: Record<string, unknown> = {}) =>
    runInTenant(scope, (s) =>
      postStock(s, { type, idempotencyKey: key(), sourceType: 'TEST', lines, ...extra })
    )
  const ln = (w: any, p: any, q: string, extra: Record<string, unknown> = {}) => ({
    warehouseId: w.id,
    productId: p.id,
    bucket: 'UNRESTRICTED',
    quantity: q,
    ...extra,
  })
  const pool = async (p: any, le = L.le) => {
    const rows = ok(await api.get(`${V}?productId=${p.id}&legalEntityId=${le.id}`), 200) as any[]
    return rows[0] ? { q: rows[0].quantity, v: rows[0].value, u: rows[0].unitCost } : null
  }
  return { ...L, leB, un, cat, avg, fifo, spec, wa, wa2, wb, scope, post, ln, pool }
}

test.group('Inventário | valorização (8.9)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('custo médio ponderado com arredondamento, FIFO contabilístico, custo específico por lote e estorno', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    // Custo médio: 10 a 100 + 5 a 130 → 15 a 110.
    await o.post('RECEIPT', [o.ln(o.wa, o.avg, '10', { unitCost: '100' })])
    await o.post('RECEIPT', [o.ln(o.wa, o.avg, '5', { unitCost: '130' })])
    assert.deepEqual(await o.pool(o.avg), { q: '15.000000', v: '1650.00', u: '110.000000' })
    await o.post('ISSUE', [o.ln(o.wa, o.avg, '-4')])
    assert.deepEqual(await o.pool(o.avg), { q: '11.000000', v: '1210.00', u: '110.000000' })
    // Arredondamento: 3 unidades por 100,00 saem em 33,33 + 33,34 + 33,33 = 100,00 (nada se perde).
    await o.post('RECEIPT', [o.ln(o.wa2, o.avg, '3', { value: '100.00' })])
    // A 2.ª armazém é da mesma entidade: o saldo de custo é da entidade (14 por 1310,00).
    assert.deepEqual(await o.pool(o.avg), { q: '14.000000', v: '1310.00', u: '93.571429' })
    for (let i = 0; i < 14; i++) await o.post('ISSUE', [o.ln(i < 11 ? o.wa : o.wa2, o.avg, '-1')])
    assert.isNull(await o.pool(o.avg)) // saldo vazio: sem valor residual
    const out = await owner().rawQuery(
      `select coalesce(sum(value), 0)::text as v from stock_valuation_entries where product_id = ? and quantity < 0`,
      [o.avg.id]
    )
    assert.equal(out.rows[0].v, '-1750.00') // saiu exactamente o que entrou (1650 + 100)
    // Uma entrada sem custo vale ao último custo conhecido (100,00 / 3 por unidade).
    await o.post('RECEIPT', [o.ln(o.wa, o.avg, '2')])
    assert.equal((await o.pool(o.avg))!.v, '66.67')

    // FIFO: 10 a 5 e 10 a 7; saem 15 = 10×5 + 5×7 = 85; resta 5 a 7.
    await o.post('RECEIPT', [o.ln(o.wa, o.fifo, '10', { unitCost: '5' })])
    await o.post('RECEIPT', [o.ln(o.wa, o.fifo, '10', { unitCost: '7' })])
    const f = await o.post('ISSUE', [o.ln(o.wa, o.fifo, '-15')])
    assert.deepEqual(await o.pool(o.fifo), { q: '5.000000', v: '35.00', u: '7.000000' })
    let detail = ok(await o.api.get(`${V}/products/${o.fifo.id}?legalEntityId=${o.le.id}`), 200)
    assert.deepEqual(
      detail.layers.map((l: any) => [l.unitCost, l.remainingQuantity]),
      [
        ['7.000000', '5.000000'],
        ['5.000000', '0.000000'],
      ]
    )
    // Estorno da saída: as camadas voltam ao que eram (sem recalcular nada).
    await runInTenant(o.scope, (s) =>
      reverseStockPosting(s, f.posting.id, { idempotencyKey: key(), reason: 'Erro' })
    )
    assert.deepEqual(await o.pool(o.fifo), { q: '20.000000', v: '120.00', u: '6.000000' })
    detail = ok(await o.api.get(`${V}/products/${o.fifo.id}?legalEntityId=${o.le.id}`), 200)
    assert.sameMembers(
      detail.layers.map((l: any) => l.remainingValue),
      ['50.00', '70.00']
    )
    assert.includeMembers(
      detail.ledger.map((e: any) => e.source),
      ['GIVEN', 'LAYER', 'REVERSAL']
    )

    // Custo específico: cada lote tem o seu custo; a saída leva o custo do lote que sai (FEFO escolhe o lote).
    await o.post('RECEIPT', [
      o.ln(o.wa, o.spec, '5', { lotCode: 'BARATO', expiryDate: day(90), unitCost: '10' }),
      o.ln(o.wa, o.spec, '5', { lotCode: 'CARO', expiryDate: day(30), unitCost: '20' }),
    ])
    await o.post('ISSUE', [o.ln(o.wa, o.spec, '-2')]) // FEFO → CARO
    assert.deepEqual(await o.pool(o.spec), { q: '8.000000', v: '110.00', u: '13.750000' })

    // O livro é só de acréscimo; saldos e camadas não se escrevem directamente.
    for (const sql of [
      'delete from stock_valuation_entries',
      'update stock_cost_pools set value = 1',
      'update stock_cost_layers set remaining_value = 1',
    ])
      await assert.rejects(() => owner().rawQuery(sql))
    // Reconciliação interna sem diferenças.
    const rec = ok(await o.api.get(`${V}/reconciliation?legalEntityId=${o.le.id}`), 200)
    assert.lengthOf(rec.internal.differences, 0)
  })

  test('transferência entre entidades, devoluções ao custo do original, ajustes de custo e reconciliação com o razão', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    await o.post('RECEIPT', [o.ln(o.wa, o.avg, '10', { unitCost: '100' })])
    // Intragrupo: sai da entidade 1 ao custo médio e entra na 2 pelo mesmo valor.
    await o.post('TRANSFER_OUT', [
      o.ln(o.wa, o.avg, '-4'),
      { warehouseId: o.wb.id, productId: o.avg.id, bucket: 'IN_TRANSIT', quantity: '4' },
    ])
    assert.deepEqual(await o.pool(o.avg), { q: '6.000000', v: '600.00', u: '100.000000' })
    assert.deepEqual(await o.pool(o.avg, o.leB), { q: '4.000000', v: '400.00', u: '100.000000' })
    // A recepção no destino (mesma entidade) não muda o valor.
    await o.post('TRANSFER_IN', [
      { warehouseId: o.wb.id, productId: o.avg.id, bucket: 'IN_TRANSIT', quantity: '-4' },
      o.ln(o.wb, o.avg, '4'),
    ])
    assert.equal((await o.pool(o.avg, o.leB))!.v, '400.00')

    // Devolução ao fornecedor ao custo da compra original (não ao médio).
    const doc = async (
      docType: string,
      origin: string,
      quantity: string,
      extra: Record<string, unknown> = {}
    ) => {
      let d = ok(
        await o.api.post(`${I}/documents`, {
          docType,
          warehouseId: o.wa.id,
          origin,
          lines: [{ productId: o.avg.id, uomId: o.un.id, quantity, ...(extra.line as object) }],
          ...(extra.head as object),
        })
      )
      d = ok(
        await o.api.post(`${I}/documents/${d.id}/check`, {
          expectedVersion: d.version,
          lines: [{ lineId: d.lines[0].id, checkedQuantity: quantity }],
        }),
        200
      )
      return ok(
        await o.api.post(`${I}/documents/${d.id}/confirm`, {
          expectedVersion: d.version,
          idempotencyKey: key(),
        }),
        200
      )
    }
    const buy = await doc('RECEIPT', 'PURCHASE', '6', { line: { unitCost: '200' } })
    assert.deepEqual(await o.pool(o.avg), { q: '12.000000', v: '1800.00', u: '150.000000' })
    // Só uma devolução indica o original; e tem de ser do tipo contrário.
    const bad = await o.api.post(`${I}/documents`, {
      docType: 'ISSUE',
      warehouseId: o.wa.id,
      origin: 'LOSS',
      returnOfDocumentId: buy.id,
      lines: [{ productId: o.avg.id, uomId: o.un.id, quantity: '1' }],
    })
    assert.include(details(bad), 'NOT_RETURN')
    const back = await doc('ISSUE', 'RETURN', '2', { head: { returnOfDocumentId: buy.id } })
    assert.deepEqual(back.returnOf, { id: buy.id, number: buy.number })
    assert.deepEqual(await o.pool(o.avg), { q: '10.000000', v: '1400.00', u: '140.000000' })
    // Venda e devolução do cliente ao custo a que saiu.
    const sale = await doc('ISSUE', 'SALE', '5')
    assert.deepEqual(await o.pool(o.avg), { q: '5.000000', v: '700.00', u: '140.000000' })
    await o.post('RECEIPT', [o.ln(o.wa, o.avg, '5', { unitCost: '300' })]) // o médio sobe para 220
    await doc('RECEIPT', 'RETURN', '1', { head: { returnOfDocumentId: sale.id } })
    assert.deepEqual(await o.pool(o.avg), { q: '11.000000', v: '2340.00', u: '212.727273' })

    // Ajuste de custo (preço definitivo): soma ao stock existente; o passado não muda.
    const manager = await memberWithRoles(client, o.s, [
      (
        await createRole(client, o.s, 'valor', [
          'inventory.valuation.read',
          'inventory.valuation.manage',
        ])
      ).id,
    ])
    const M = as(client, manager.session)
    const before = await owner().rawQuery('select count(*)::int as n from stock_valuation_entries')
    const adj = {
      legalEntityId: o.le.id,
      productId: o.avg.id,
      amount: '60.00',
      reason: 'Factura definitiva',
      idempotencyKey: key(),
    }
    ok(await M.post(`${V}/adjustments`, adj))
    ok(await M.post(`${V}/adjustments`, adj)) // repetição: nada de novo
    assert.equal((await o.pool(o.avg))!.v, '2400.00')
    const after = await owner().rawQuery('select count(*)::int as n from stock_valuation_entries')
    assert.equal(after.rows[0].n, before.rows[0].n + 1)
    assert.include(
      details(await M.post(`${V}/adjustments`, { ...adj, amount: '-9999', idempotencyKey: key() })),
      'NEGATIVE_VALUE'
    )
    await o.post('RECEIPT', [o.ln(o.wa, o.fifo, '1', { unitCost: '5' })])
    assert.include(
      details(
        await M.post(`${V}/adjustments`, { ...adj, productId: o.fifo.id, idempotencyKey: key() })
      ),
      'REQUIRED'
    )
    assert.equal(
      code(
        await M.post(`${V}/adjustments`, {
          ...adj,
          productId: o.spec.id,
          layerId: undefined,
          idempotencyKey: key(),
        })
      ),
      'NO_STOCK'
    )
    // Sem a permissão na entidade: não ajusta nem vê.
    const reader = await memberWithRoles(client, o.s, [
      (await createRole(client, o.s, 'leitor', ['inventory.valuation.read'])).id,
    ])
    const R = as(client, reader.session)
    assert.equal(
      code(await R.post(`${V}/adjustments`, { ...adj, idempotencyKey: key() })),
      'OUT_OF_SCOPE'
    )
    const onlyB = await memberWithRoles(client, o.s, [])
    const rB = await createRole(client, o.s, 'leitor_b', ['inventory.valuation.read'])
    ok(
      await o.api.post(`/api/v1/members/${onlyB.memberId}/roles`, {
        roleId: rB.id,
        scopeType: 'LEGAL_ENTITY',
        scopeId: o.leB.id,
      }),
      200
    )
    const B = as(client, onlyB.session)
    assert.sameMembers(
      (ok(await B.get(V), 200) as any[]).map((x) => x.legalEntity.code),
      ['LE2']
    )
    assert.equal((await B.get(`${V}/products/${o.avg.id}?legalEntityId=${o.le.id}`)).status(), 404)

    // Reconciliação com a contabilidade: classe MERCADORIAS → conta 32; o razão tem 2000,00 lançados.
    const c3 = ok(
      await o.api.post(`${A}/accounts`, {
        chartId: o.chart.id,
        code: '3',
        name: 'Existências',
        level: 'CLASS',
        nature: 'ASSET',
        parentId: null,
      })
    )
    const c32 = ok(
      await o.api.post(`${A}/accounts`, {
        chartId: o.chart.id,
        code: '32',
        name: 'Mercadorias',
        level: 'ACCOUNT',
        nature: 'ASSET',
        parentId: c3.id,
        postable: true,
      })
    )
    ok(
      await M.put(`${V}/accounts?legalEntityId=${o.le.id}`, {
        mappings: [{ accountingClass: 'MERCADORIAS', accountId: c32.id }],
      }),
      200
    )
    const entry = ok(
      await o.api.post(`${A}/entries`, {
        legalEntityId: o.le.id,
        journalId: o.journal.id,
        entryDate: '2026-03-10',
        description: 'Compra de mercadorias',
        lines: [
          { accountId: c32.id, debit: '2000' },
          { accountId: o.cash.id, credit: '2000' },
        ],
      })
    )
    const sub = ok(
      await o.api.post(`${A}/entries/${entry.id}/submit`, { expectedVersion: entry.version }),
      200
    )
    const rev = await memberWithRoles(client, o.s, [
      (
        await createRole(client, o.s, 'revisor', [
          'accounting.read',
          'accounting.approve',
          'accounting.post',
        ])
      ).id,
    ])
    const RV = as(client, rev.session)
    const appr = ok(
      await RV.post(`${A}/entries/${entry.id}/approve`, { expectedVersion: sub.version }),
      200
    )
    ok(await RV.post(`${A}/entries/${entry.id}/post`, { expectedVersion: appr.version }), 200)
    const rec = ok(await M.get(`${V}/reconciliation?legalEntityId=${o.le.id}`), 200)
    const m = rec.accounts.find((x: any) => x.account.code === '32')
    assert.deepInclude(m, {
      inventoryValue: '2405.00',
      ledgerBalance: '2000.00',
      difference: '405.00',
    })
    assert.deepEqual(m.classes, ['MERCADORIAS'])
    assert.lengthOf(rec.internal.differences, 0)
    // À data de ontem o razão já tinha o lançamento de Março; uma data anterior a ele dá saldo zero.
    const old = ok(await M.get(`${V}/reconciliation?legalEntityId=${o.le.id}&date=2026-01-31`), 200)
    assert.equal(old.accounts[0].ledgerBalance, '0.00')
    // Auditoria dos ajustes e da configuração.
    const audits = await owner().rawQuery(
      `select distinct action from audit_events where action like 'inventory.valuation.%'`
    )
    assert.sameMembers(
      audits.rows.map((x: any) => x.action),
      ['inventory.valuation.adjusted', 'inventory.valuation.accounts_set']
    )
    // O método de valorização fica fixo depois de movimentos; o específico exige lotes.
    const p = ok(await o.api.get(`${I}/products/${o.avg.id}`), 200)
    assert.include(
      details(
        await o.api.patch(`${I}/products/${o.avg.id}`, {
          expectedVersion: p.version,
          valuationMethod: 'FIFO',
        })
      ),
      'TRACKING_LOCKED'
    )
    const noLots = await o.api.post(`${I}/products`, {
      sku: 'SEMLOT',
      name: 'Sem lotes',
      productType: 'STOCKABLE',
      baseUomId: o.un.id,
      valuationMethod: 'SPECIFIC',
    })
    assert.include(details(noLots), 'SPECIFIC_NEEDS_LOTS')
  })
})
