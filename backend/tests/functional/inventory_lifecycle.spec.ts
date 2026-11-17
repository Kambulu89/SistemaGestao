import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import {
  as,
  cleanDatabase,
  createRole,
  memberWithRoles,
  signIn,
  tenantWithAdmin,
} from '#tests/support/fixtures'
import { ledger, ok } from '#tests/support/accounting'

/*
 * Regressão do ciclo completo do inventário (8.12): os blocos 8.3 a 8.11 encadeados sobre o mesmo stock — entrada com
 * confirmações parciais, duplicação e concorrência, venda com reserva, transferência com trânsito e perda, contagem com
 * ajuste — e, no fim, as três reconciliações têm de fechar: movimentos = saldos, livro de custo = stock, inventário =
 * razão. Outra empresa não vê nada disto.
 */

const I = '/api/v1/inventory'
const A = '/api/v1/accounting'
const D = `${I}/documents`
const T = `${I}/transfers`
const C = `${I}/counts`
const N = `${I}/integrations`
const P = `${I}/reports`
const owner = () => db.connection('owner')
const code = (r: any) => r.body().error?.code
let seq = 0
const key = () => `k-${Date.now()}-${++seq}`
const today = new Date().toISOString().slice(0, 10)

test.group('Inventário | regressão do ciclo completo (8.12)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('entrada parcial, duplicação, concorrência, venda com reserva, transferência com perda, contagem e reconciliações', async ({
    client,
    assert,
  }) => {
    const L = await ledger(client)
    const { api } = L
    for (const [t, c] of [
      ['STOCK_RECEIPT', 'ENT'],
      ['STOCK_ISSUE', 'SAI'],
      ['STOCK_TRANSFER', 'TRF'],
      ['STOCK_COUNT', 'INV'],
    ])
      ok(
        await api.post('/api/v1/document-series', {
          legalEntityId: L.le.id,
          documentType: t,
          code: c,
          prefix: `${c}-`,
        })
      )
    const acc = async (accCode: string, nature: string, parentId: string | null) =>
      ok(
        await api.post(`${A}/accounts`, {
          chartId: L.chart.id,
          code: accCode,
          name: `Conta ${accCode}`,
          level: parentId ? 'ACCOUNT' : 'CLASS',
          nature,
          parentId,
          ...(parentId ? { postable: true } : {}),
        })
      )
    const c3 = await acc('3', 'ASSET', null)
    const inv = await acc('32', 'ASSET', c3.id)
    const c2 = await acc('2', 'LIABILITY', null)
    const grir = await acc('22', 'LIABILITY', c2.id)
    const c6 = await acc('6', 'EXPENSE', null)
    const cogs = await acc('61', 'EXPENSE', c6.id)
    const lossAcc = await acc('69', 'EXPENSE', c6.id)
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
    const box = ok(
      await api.post(`${I}/products`, {
        sku: 'CAIXA',
        name: 'Caixa',
        productType: 'STOCKABLE',
        baseUomId: un.id,
        categoryId: cat.id,
        minStock: '20',
        maxStock: '100',
      })
    )
    const wh = async (c: string) =>
      ok(
        await api.post(`${I}/warehouses`, {
          code: c,
          name: `Armazém ${c}`,
          legalEntityId: L.le.id,
          warehouseType: 'MAIN',
        })
      )
    const wa = await wh('WA')
    const wb = await wh('WB')
    // Segunda pessoa: aprova transferências e contagens (quem pede ou conta não aprova).
    const second = await memberWithRoles(client, L.s, [
      (
        await createRole(client, L.s, 'aprova', [
          'inventory.read',
          'inventory.transfers.manage',
          'inventory.transfers.approve',
          'inventory.counts.manage',
          'inventory.counts.approve',
        ])
      ).id,
    ])
    const approver = as(client, second.session)
    const totals = async (w: any) => {
      const rows = ok(
        await api.get(`${I}/stock/balances?productId=${box.id}&warehouseId=${w.id}`),
        200
      ) as any[]
      const sum = (f: string) => rows.reduce((t, r) => t + Number(r[f]), 0)
      return {
        physical: sum('physical'),
        reserved: sum('reserved'),
        available: sum('available'),
        inTransit: sum('inTransit'),
      }
    }
    const postings = async () =>
      Number((await owner().rawQuery('select count(*)::int as n from stock_postings')).rows[0].n)

    // 1. ENTRADA com confirmações parciais: 100 a 12,00; chegam 60, depois 40.
    let doc = ok(
      await api.post(D, {
        docType: 'RECEIPT',
        warehouseId: wa.id,
        origin: 'PURCHASE',
        lines: [{ productId: box.id, uomId: un.id, quantity: '100', unitCost: '12' }],
      })
    )
    const line = doc.lines[0].id
    const check = async (q: string) =>
      ok(
        await api.post(`${D}/${doc.id}/check`, {
          expectedVersion: doc.version,
          lines: [{ lineId: line, checkedQuantity: q }],
        }),
        200
      )
    doc = await check('60')
    assert.deepInclude(await totals(wa), { physical: 0 }) // conferir não mexe no stock
    const k1 = key()
    const v1 = doc.version
    doc = ok(
      await api.post(`${D}/${doc.id}/confirm`, { expectedVersion: v1, idempotencyKey: k1 }),
      200
    )
    assert.equal(doc.status, 'PARTIAL')
    assert.equal(doc.lines[0].remainingQuantity, '40.000000')
    // DUPLICAÇÃO: o mesmo pedido outra vez não lança de novo.
    ok(await api.post(`${D}/${doc.id}/confirm`, { expectedVersion: v1, idempotencyKey: k1 }), 200)
    assert.deepInclude(await totals(wa), { physical: 60 })
    assert.equal(await postings(), 1)
    // CONCORRÊNCIA: o resto confirmado duas vezes em paralelo (chaves diferentes) entra uma só vez.
    doc = await check('40')
    const both = await Promise.all([
      api.post(`${D}/${doc.id}/confirm`, { expectedVersion: doc.version, idempotencyKey: key() }),
      api.post(`${D}/${doc.id}/confirm`, { expectedVersion: doc.version, idempotencyKey: key() }),
    ])
    assert.sameMembers(
      both.map((r) => r.status()),
      [200, 409]
    )
    doc = ok(await api.get(`${D}/${doc.id}`), 200)
    assert.equal(doc.status, 'COMPLETED')
    assert.lengthOf(doc.confirmations, 2)
    assert.deepInclude(await totals(wa), { physical: 100, available: 100 })
    assert.equal(await postings(), 2)
    // Documento finalizado: não se edita nem se anula.
    assert.equal(
      code(await api.post(`${D}/${doc.id}/cancel`, { expectedVersion: doc.version, reason: 'x' })),
      'INVALID_STATE'
    )

    // 2. SAÍDAS: venda com reserva (30), entrega parcial (20) e pedido repetido.
    const sale = (path: string, body: Record<string, unknown>) =>
      api.post(`${N}/${path}`, { warehouseId: wa.id, orderRef: 'SO-1', ...body })
    ok(
      await sale('sale-reservations', {
        idempotencyKey: key(),
        lines: [{ productId: box.id, quantity: '30' }],
      })
    )
    assert.deepInclude(await totals(wa), { physical: 100, reserved: 30, available: 70 })
    const kd = key()
    const delivery = {
      idempotencyKey: kd,
      documentRef: 'GR-1',
      lines: [{ productId: box.id, quantity: '20' }],
    }
    const d1 = ok(await sale('sale-deliveries', delivery))
    assert.equal(ok(await sale('sale-deliveries', delivery), 200).id, d1.id)
    assert.deepInclude(await totals(wa), { physical: 80, reserved: 10, available: 70 })
    // CONCORRÊNCIA no stock: duas entregas de 45 em paralelo quando só há 70 livres — passa uma.
    const race = await Promise.all(
      ['SO-2', 'SO-3'].map((orderRef, i) =>
        api.post(`${N}/sale-deliveries`, {
          warehouseId: wa.id,
          orderRef,
          documentRef: `GR-${i + 2}`,
          idempotencyKey: key(),
          lines: [{ productId: box.id, quantity: '45' }],
        })
      )
    )
    assert.sameMembers(
      race.map((r) => r.status()),
      [201, 409]
    )
    assert.equal(code(race.find((r) => r.status() === 409)!), 'INSUFFICIENT_STOCK')
    assert.deepInclude(await totals(wa), { physical: 35, reserved: 10, available: 25 })

    // 3. TRANSFERÊNCIA WA → WB de 20: reserva na aprovação, trânsito, recepção parcial de 15 e perda de 5.
    const act = async (who: any, base: string, x: any, action: string, b = {}) =>
      ok(await who.post(`${base}/${x.id}/${action}`, { expectedVersion: x.version, ...b }), 200)
    let t = ok(
      await api.post(T, {
        sourceWarehouseId: wa.id,
        destWarehouseId: wb.id,
        lines: [{ productId: box.id, quantity: '20' }],
      })
    )
    t = await act(api, T, t, 'submit')
    // Segregação: quem pediu não aprova.
    assert.equal(
      code(await api.post(`${T}/${t.id}/approve`, { expectedVersion: t.version })),
      'SELF_APPROVAL'
    )
    t = await act(approver, T, t, 'approve')
    assert.deepInclude(await totals(wa), { physical: 35, reserved: 30, available: 5 })
    t = await act(api, T, t, 'pick', { lines: [{ lineId: t.lines[0].id, pickedQuantity: '20' }] })
    const kt = key()
    const vt = t.version
    t = await act(api, T, t, 'dispatch', { idempotencyKey: kt })
    ok(await api.post(`${T}/${t.id}/dispatch`, { expectedVersion: vt, idempotencyKey: kt }), 200)
    assert.deepInclude(await totals(wa), { physical: 15, reserved: 10, available: 5 })
    assert.deepInclude(await totals(wb), { physical: 0, inTransit: 20 })
    t = await act(api, T, t, 'receive', {
      idempotencyKey: key(),
      lines: [{ lineId: t.lines[0].id, quantity: '15' }],
    })
    assert.equal(t.status, 'PARTIAL')
    assert.deepInclude(await totals(wb), { physical: 15, inTransit: 5 })
    t = await act(approver, T, t, 'close', { idempotencyKey: key(), reason: 'Caixas esmagadas' })
    assert.equal(t.status, 'RECEIVED')
    assert.equal(t.lines[0].lostQuantity, '5.000000')
    assert.deepInclude(await totals(wb), { physical: 15, inTransit: 0 })

    // 4. CONTAGEM em WA: o sistema tem 15, contam-se 14; justificação e aprovação por outra pessoa lançam −1.
    let c = ok(await api.post(C, { warehouseId: wa.id, description: 'Contagem de fecho' }))
    c = await act(api, C, c, 'start')
    c = await act(api, C, c, 'count', { lines: [{ lineId: c.lines[0].id, quantity: '14' }] })
    c = await act(api, C, c, 'submit')
    assert.equal(
      code(await api.post(`${C}/${c.id}/approve`, { expectedVersion: c.version })),
      'SELF_APPROVAL'
    )
    let r = ok(await approver.get(`${C}/${c.id}`), 200)
    r = await act(approver, C, r, 'justify', {
      lines: [{ lineId: r.lines[0].id, reasonCode: 'DAMAGE', justification: 'Uma caixa partida' }],
    })
    r = await act(approver, C, r, 'approve')
    assert.equal(r.status, 'APPROVED')
    assert.deepInclude(await totals(wa), { physical: 14, reserved: 10, available: 4 })

    // 5. RECONCILIAÇÃO do stock: movimentos = saldos; livro de custo = saldos de custo = stock (29 × 12,00 = 348,00).
    assert.lengthOf(ok(await api.get(`${I}/stock/reconciliation`), 200).differences, 0)
    let rec = ok(await api.get(`${I}/valuation/reconciliation?legalEntityId=${L.le.id}`), 200)
    assert.lengthOf(rec.internal.differences, 0)
    const pools = (await api.get(`${I}/valuation?legalEntityId=${L.le.id}`)).body()
    assert.deepInclude(pools.data[0], { quantity: '29.000000', value: '348.00' })
    // Os relatórios contam a mesma história.
    const range = `from=${today}&to=${today}`
    const mov = ok(await api.get(`${P}/movements?${range}&productId=${box.id}`), 200)
    const cls = Object.fromEntries(
      mov.rows.map((x: any) => [x.class, [x.quantityIn, x.quantityOut, x.value]])
    )
    assert.deepEqual(cls.PURCHASE, ['100.000000', '0.000000', '1200.00'])
    assert.deepEqual(cls.SALE, ['0.000000', '65.000000', '780.00'])
    assert.deepEqual(cls.TRANSFER_LOSS, ['0.000000', '5.000000', '60.00'])
    assert.deepEqual(cls.ADJUSTMENT_LOSS, ['0.000000', '1.000000', '12.00'])
    assert.deepEqual(ok(await api.get(`${P}/losses?${range}`), 200).totals, {
      losses: '72.00',
      gains: '0.00',
      net: '72.00',
    })
    assert.equal(
      ok(await api.get(`${P}/valued?legalEntityId=${L.le.id}`), 200).totals.value,
      '348.00'
    )
    // Disponível 4 + 15 = 19 ≤ mínimo 20 → repor 81 até ao máximo.
    const rep = ok(await api.get(`${P}/replenishment`), 200)
    assert.deepInclude(rep[0], {
      status: 'REORDER',
      available: '19.000000',
      suggested: '81.000000',
    })

    // 6. CONTABILIDADE: sem regras, todos os eventos falharam sem bloquear nada; com as regras, repetem-se e o razão
    //    fica igual ao inventário.
    const events = async (q = '') => ok(await api.get(`${I}/accounting-events${q}`), 200) as any[]
    const failed = await events('?status=FAILED')
    assert.lengthOf(await events(), failed.length)
    const names = [...new Set(failed.map((e) => e.event))].sort()
    assert.includeMembers(names, ['ADJUSTMENT_LOSS', 'ISSUE_SALE', 'RECEIPT_PURCHASE'])
    ok(
      await api.put(`${I}/valuation/accounts?legalEntityId=${L.le.id}`, {
        mappings: [{ accountingClass: 'MERCADORIAS', accountId: inv.id }],
      }),
      200
    )
    for (const event of names) {
      const entering = failed.find((e) => e.event === event).direction === 'IN'
      const other = event === 'RECEIPT_PURCHASE' ? grir : event === 'ISSUE_SALE' ? cogs : lossAcc
      ok(
        await api.post(`${A}/posting-rules`, {
          legalEntityId: L.le.id,
          code: `R${names.indexOf(event)}`,
          name: event,
          source: 'inventory',
          event,
          journalId: L.journal.id,
          autoPost: true,
          validFrom: '2026-01-01',
          lines: entering
            ? [
                { side: 'DEBIT', accountId: inv.id, amountKey: 'cls_mercadorias' },
                { side: 'CREDIT', accountId: other.id, amountKey: 'value' },
              ]
            : [
                { side: 'DEBIT', accountId: other.id, amountKey: 'value' },
                { side: 'CREDIT', accountId: inv.id, amountKey: 'cls_mercadorias' },
              ],
        })
      )
    }
    const retried = ok(await api.post(`${I}/accounting-events/retry`, {}), 200)
    assert.deepInclude(retried, { failed: 0, posted: failed.length })
    assert.lengthOf(await events('?status=FAILED'), 0)
    // Repetir outra vez não lança nada de novo.
    assert.deepInclude(ok(await api.post(`${I}/accounting-events/retry`, {}), 200), { posted: 0 })
    rec = ok(await api.get(`${I}/valuation/reconciliation?legalEntityId=${L.le.id}`), 200)
    assert.deepInclude(
      rec.accounts.find((x: any) => x.account.code === '32'),
      { inventoryValue: '348.00', ledgerBalance: '348.00', difference: '0.00' }
    )

    // 7. Nada do que ficou lançado se altera na base.
    for (const sql of [
      'update stock_movements set quantity = quantity + 1',
      'delete from stock_postings',
      'update stock_valuation_entries set value = 0',
      'update stock_balances set qty_unrestricted = 999',
    ])
      await assert.rejects(() => owner().rawQuery(sql))

    // 8. ISOLAMENTO: outra empresa não vê nem alcança nada deste ciclo.
    const other = await tenantWithAdmin()
    const sb = await signIn(client, other.admin.email, other.tenant.id)
    const B = as(client, sb)
    for (const url of [
      `${D}/${doc.id}`,
      `${T}/${t.id}`,
      `${C}/${c.id}`,
      `${I}/products/${box.id}`,
      `${I}/warehouses/${wa.id}`,
      `${P}/replenishment?warehouseId=${wa.id}`,
      `${P}/valued?legalEntityId=${L.le.id}`,
      `${I}/valuation/reconciliation?legalEntityId=${L.le.id}`,
    ])
      assert.equal((await B.get(url)).status(), 404, url)
    for (const url of [
      D,
      T,
      C,
      `${I}/products`,
      `${I}/warehouses`,
      `${I}/stock/balances`,
      `${I}/stock/movements`,
      `${I}/valuation`,
      `${N}/events`,
      `${I}/accounting-events`,
      `${P}/replenishment`,
    ])
      assert.lengthOf((await B.get(url)).body().data, 0, url)
    // Com o identificador desta empresa forjado no cabeçalho, a sessão de B continua de fora (o cabeçalho é só um
    // selector: a autorização vem da membership).
    const spoof = as(client, { ...sb, tenantId: L.s.tenantId })
    for (const url of [`${I}/stock/balances`, `${D}/${doc.id}`, `${P}/replenishment`])
      assert.include([403, 404], (await spoof.get(url)).status(), url)
    assert.equal(
      (
        await B.post(`${N}/sale-deliveries`, {
          warehouseId: wa.id,
          orderRef: 'X',
          documentRef: 'X',
          idempotencyKey: key(),
          lines: [{ productId: box.id, quantity: '1' }],
        })
      ).status(),
      404
    )
    assert.deepInclude(await totals(wa), { physical: 14 })
  })
})
